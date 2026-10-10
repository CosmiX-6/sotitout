import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { buildDayBrief, buildEndOfDay, projectStatuses, renderDayBrief, renderEndOfDay, renderProjects, rollover, } from "../core/briefing.js";
import { addDays, ymd } from "../core/dates.js";
import { matchProject, parseDue } from "../core/extract.js";
import { chatNameFromFile, parseWhatsAppChat, whatsappToMessages } from "../providers/whatsapp.js";
/** What a tool call needs. `emails`/`events` are an in-memory cache for the life of the server. */
export class Session {
    store;
    emails = [];
    events = [];
    now;
    constructor(store, now = () => new Date()) {
        this.store = store;
        this.now = now;
    }
}
const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v, max = 4000) => (v == null ? "" : String(v).slice(0, max));
const arr = (v) => (Array.isArray(v) ? v : []);
const bool = (v) => v === true || v === "true";
const strList = (v) => (Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : []).map((x) => str(x, 200).trim()).filter(Boolean);
const isoOrUndef = (v) => {
    const d = new Date(str(v, 64));
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
};
/** Accepts "2026-10-16", "Friday", "tomorrow", "10/16" … */
function dueOf(v, now) {
    const s = str(v, 100).trim();
    if (!s)
        return undefined;
    const m = s.match(/^\d{4}-\d{2}-\d{2}/);
    return m ? m[0] : parseDue(s, now);
}
export function toMessage(o, i, now) {
    if (!isObj(o))
        return undefined;
    const id = str(o.id, 200) || `m${i}-${now.getTime()}`;
    return {
        id,
        provider: str(o.source, 40) || "connector",
        threadId: str(o.thread_id, 200) || id,
        from: str(o.from, 300),
        to: strList(o.to),
        subject: str(o.subject, 300),
        body: str(o.body, 2000),
        receivedAt: isoOrUndef(o.received_at) ?? now.toISOString(),
        isUnread: bool(o.unread),
        isSent: bool(o.sent),
    };
}
export function toEvent(o, i) {
    if (!isObj(o))
        return undefined;
    const allDay = bool(o.all_day);
    const start = allDay ? str(o.start, 10) : isoOrUndef(o.start);
    const end = allDay ? str(o.end, 10) || start : isoOrUndef(o.end);
    if (!start || !end || (allDay && !/^\d{4}-\d{2}-\d{2}$/.test(start)))
        return undefined;
    return { id: str(o.id, 200) || `e${i}-${start}`, title: str(o.title, 300) || "(no title)", start, end: end, allDay, location: str(o.location, 200) || undefined };
}
/** Events touching `day` (YYYY-MM-DD). All-day events have an exclusive end date. */
function eventsOn(events, day) {
    return events.filter((e) => {
        if (!e.allDay)
            return ymd(new Date(e.start)) === day;
        const start = e.start.slice(0, 10);
        const end = e.end.slice(0, 10) > start ? e.end.slice(0, 10) : ymd(addDays(new Date(`${start}T00:00:00`), 1));
        return start <= day && day < end;
    });
}
function findProject(s, ref) {
    const r = str(ref, 200).trim().toLowerCase();
    if (!r)
        return undefined;
    return s.store.state.projects.find((p) => p.id === r || p.name.toLowerCase() === r) ??
        s.store.state.projects.find((p) => p.name.toLowerCase().includes(r));
}
function upsertMessages(s, msgs) {
    const key = (m) => `${m.provider}:${m.id}`;
    const map = new Map(s.emails.map((m) => [key(m), m]));
    for (const m of msgs)
        map.set(key(m), m);
    s.emails = [...map.values()].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)).slice(0, 600);
}
/** Ingest and list the tasks that pattern matching created, so the caller can add only what it missed. */
function ingestAndReport(s, msgs, now, verb, kind = "") {
    const before = new Set(s.store.state.tasks.map((t) => t.id));
    const added = s.store.ingestEmails(msgs, now);
    const fresh = s.store.state.tasks.filter((t) => !before.has(t.id));
    const lines = fresh.slice(0, 25).map((t) => `  + ${t.title}${t.due ? ` (due ${t.due})` : ""}`);
    return [`${verb} ${msgs.length} ${kind}message(s); ${added} new task(s) extracted.`, ...lines].join("\n");
}
const shortTask = (t) => `${t.id}  [${t.status}${t.due ? `, due ${t.due}` : ""}${t.carriedCount ? `, carried ${t.carriedCount}x` : ""}]  ${t.title}`;
/* ---------- tool definitions ---------- */
const obj = (properties, required = []) => ({ type: "object", properties, required });
const text = (description) => ({ type: "string", description });
const list = (description, item) => ({ type: "array", description, items: item });
const MESSAGE_ITEM = obj({
    id: text("Stable id from the source system (message id, ts, …)"),
    source: text("gmail | outlook | slack | whatsapp | …"),
    thread_id: text("Conversation/thread id"),
    from: text("Sender name and address"),
    to: { type: "array", items: { type: "string" } },
    subject: text("Subject, or channel/chat name for chat apps"),
    body: text("Plain-text body, trimmed to the relevant ~500 characters"),
    received_at: text("ISO 8601 timestamp"),
    unread: { type: "boolean", description: "Still unread / waiting on the user" },
    sent: { type: "boolean", description: "Sent by the user" },
}, ["id", "from", "received_at"]);
export const tools = [
    {
        name: "ingest_messages",
        description: "Load emails or chat messages fetched from the user's connectors. SotItOut scans them for requests and deadlines, " +
            "creates tasks, and uses them for 'needs a reply' and follow-up detection. Safe to call repeatedly; tasks are de-duplicated by id.",
        inputSchema: obj({ messages: list("Messages to ingest", MESSAGE_ITEM) }, ["messages"]),
        mutates: true,
        handler(a, s) {
            const now = s.now();
            const msgs = arr(a.messages).map((m, i) => toMessage(m, i, now)).filter((m) => !!m);
            upsertMessages(s, msgs);
            return ingestAndReport(s, msgs, now, "Ingested");
        },
    },
    {
        name: "ingest_events",
        description: "Load calendar events (today and tomorrow are enough) fetched from the user's calendar connector.",
        inputSchema: obj({
            events: list("Events", obj({
                id: text("Event id"), title: text("Title"),
                start: text("ISO 8601 with offset, or YYYY-MM-DD when all_day"),
                end: text("ISO 8601 with offset, or YYYY-MM-DD when all_day"),
                all_day: { type: "boolean" }, location: text("Location or meeting link"),
            }, ["title", "start", "end"])),
        }, ["events"]),
        handler(a, s) {
            const evs = arr(a.events).map(toEvent);
            const ok = evs.filter((e) => !!e);
            const map = new Map(s.events.map((e) => [e.id, e]));
            ok.forEach((e) => map.set(e.id, e));
            s.events = [...map.values()];
            const bad = evs.length - ok.length;
            return `Loaded ${ok.length} event(s)${bad ? `; skipped ${bad} with unreadable dates` : ""}.`;
        },
    },
    {
        name: "sync_tasks",
        description: "Mirror tasks owned by another system (Jira issues assigned to the user, Microsoft To Do, Asana, Linear…). " +
            "Pass the COMPLETE set of currently-open items: ones missing from it are marked done. Never call with a partial or failed fetch.",
        inputSchema: obj({
            source: { type: "string", enum: ["jira", "todo"], description: "Which system these came from" },
            tasks: list("All open tasks", obj({
                id: text("Key or id, e.g. ATL-41"), title: text("Summary"), due: text("Due date"),
                high_priority: { type: "boolean" }, project: text("Project key/name, used for matching"),
            }, ["id", "title"])),
        }, ["source", "tasks"]),
        mutates: true,
        handler(a, s) {
            const source = a.source === "todo" ? "todo" : a.source === "jira" ? "jira" : undefined;
            if (!source)
                throw new Error('source must be "jira" or "todo"');
            const now = s.now();
            const items = arr(a.tasks).filter(isObj).map((t) => {
                const raw = str(t.id, 100);
                return {
                    id: raw.startsWith(`${source}:`) ? raw : `${source}:${raw}`,
                    title: `${source === "jira" && !str(t.title).startsWith(raw) ? `${raw} ` : ""}${str(t.title, 300)}`.trim(),
                    due: dueOf(t.due, now), highPriority: bool(t.high_priority), source: source,
                    projectHint: str(t.project, 200),
                };
            });
            const r = s.store.syncExternal(source, items, now);
            return `${source}: ${items.length} open; ${r.added} new, ${r.completed} marked done.`;
        },
    },
    {
        name: "add_tasks",
        description: "Add tasks you (Claude) identified in messages or that the user dictated. Prefer this over ingest_messages when you can judge " +
            "what is truly an action item. Give an id (e.g. 'gmail:<messageId>') to make it idempotent; existing ids are left untouched.",
        inputSchema: obj({
            tasks: list("Tasks", obj({
                id: text("Optional stable id"), title: text("Imperative title, include who asked"),
                due: text("Due date: YYYY-MM-DD or a phrase like 'Friday'"), project: text("Project name"),
                high_priority: { type: "boolean" }, estimate_min: { type: "number" },
            }, ["title"])),
        }, ["tasks"]),
        mutates: true,
        handler(a, s) {
            const now = s.now();
            let added = 0;
            for (const t of arr(a.tasks).filter(isObj)) {
                const id = str(t.id, 200) ? `x:${str(t.id, 200)}` : undefined;
                if (id && s.store.state.tasks.some((x) => x.id === id))
                    continue;
                const title = str(t.title, 300).trim();
                if (!title)
                    continue;
                const project = findProject(s, t.project)?.id ?? matchProject(title, "", s.store.state.projects);
                const est = Number(t.estimate_min);
                s.store.addTask({
                    ...(id ? { id } : {}), title, projectId: project, due: dueOf(t.due, now),
                    highPriority: bool(t.high_priority) || undefined, estimateMin: est > 0 && est <= 480 ? est : undefined,
                }, now);
                added++;
            }
            return `Added ${added} task(s).`;
        },
    },
    {
        name: "import_whatsapp",
        description: "Read WhatsApp chats the user exported (Chat → Export chat → Without media) from local .txt files and ingest them as messages. " +
            "WhatsApp has no connector; this is the supported route.",
        inputSchema: obj({
            paths: { type: "array", items: { type: "string" }, description: "Absolute paths to exported .txt files" },
            me: text("The user's own name exactly as it appears in the chat"),
            days: { type: "number", description: "How many days back to read (default 3)" },
        }, ["paths", "me"]),
        mutates: true,
        async handler(a, s) {
            const now = s.now();
            const days = Math.min(Math.max(Number(a.days) || 3, 1), 30);
            const since = addDays(now, -days);
            const all = [];
            const notes = [];
            for (const p of strList(a.paths).slice(0, 50)) {
                if (!isAbsolute(p) || !/\.txt$/i.test(p)) {
                    notes.push(`${p}: skipped (need an absolute path to a .txt export)`);
                    continue;
                }
                try {
                    if ((await stat(p)).size > 25 * 1024 * 1024) {
                        notes.push(`${p}: skipped (over 25 MB)`);
                        continue;
                    }
                    const msgs = whatsappToMessages(chatNameFromFile(p), parseWhatsAppChat(await readFile(p, "utf8")), str(a.me, 100), since);
                    all.push(...msgs);
                }
                catch (e) {
                    notes.push(`${p}: ${e.message}`);
                }
            }
            upsertMessages(s, all);
            return [ingestAndReport(s, all, now, "Imported", "WhatsApp "), ...notes].join("\n");
        },
    },
    {
        name: "day_brief",
        description: "Render the user's day: time, meetings, free blocks, who needs a reply, ranked priorities and a suggested plan. Present it as-is, then add your own short take.",
        inputSchema: obj({}),
        handler(_a, s) {
            const now = s.now();
            return renderDayBrief(buildDayBrief(s.store.state, eventsOn(s.events, ymd(now)), s.emails, now));
        },
    },
    {
        name: "project_status",
        description: "Render every project's health (on-track / at-risk / blocked / done), deadlines, open and overdue counts and the next task.",
        inputSchema: obj({}),
        handler(_a, s) {
            const now = s.now();
            return renderProjects(projectStatuses(s.store.state, s.emails, now), now);
        },
    },
    {
        name: "end_of_day",
        description: "Render the end-of-day wrap-up: done today, carrying over, sent messages awaiting a reply, tomorrow's meetings and top tasks. " +
            "Pass close_day=true ONLY after the user confirms, to record carry-over (raises the priority of tasks that keep slipping).",
        inputSchema: obj({ close_day: { type: "boolean" } }),
        mutates: true,
        handler(a, s) {
            const now = s.now();
            const tomorrow = ymd(addDays(now, 1));
            let out = renderEndOfDay(buildEndOfDay(s.store.state, s.emails, eventsOn(s.events, tomorrow), now), now);
            if (bool(a.close_day))
                out += `\n\nDay closed: ${rollover(s.store.state, now)} task(s) marked as carried over.`;
            return out;
        },
    },
    {
        name: "list_tasks",
        description: "List tasks with their ids, so they can be updated. Defaults to open tasks.",
        inputSchema: obj({ status: { type: "string", enum: ["open", "done", "dismissed", "all"] } }),
        handler(a, s) {
            const st = str(a.status) || "open";
            const ts = s.store.state.tasks.filter((t) => st === "all" || t.status === st);
            return ts.length ? ts.map(shortTask).join("\n") : "No tasks.";
        },
    },
    {
        name: "update_task",
        description: "Mark a task done/dismissed/open or change its title, due date or project.",
        inputSchema: obj({
            id: text("Task id from list_tasks"), status: { type: "string", enum: ["open", "done", "dismissed"] },
            title: text("New title"), due: text("New due date, or 'none' to clear"), project: text("Project name"),
        }, ["id"]),
        mutates: true,
        handler(a, s) {
            const t = s.store.state.tasks.find((x) => x.id === str(a.id, 300));
            if (!t)
                throw new Error(`No task with id ${str(a.id, 80)}`);
            const now = s.now();
            if (a.status) {
                if (!["open", "done", "dismissed"].includes(str(a.status)))
                    throw new Error("Bad status");
                s.store.setTaskStatus(t.id, str(a.status), now);
            }
            if (a.title)
                t.title = str(a.title, 300);
            if (a.due)
                t.due = str(a.due).toLowerCase() === "none" ? undefined : dueOf(a.due, now);
            if (a.project)
                t.projectId = findProject(s, a.project)?.id;
            return shortTask(t);
        },
    },
    {
        name: "add_project",
        description: "Create a project. Keywords are matched against message subjects and task titles to file work under it.",
        inputSchema: obj({
            name: text("Project name"), keywords: { type: "array", items: { type: "string" } },
            deadline: text("YYYY-MM-DD or a phrase"), notes: text("Free text"),
        }, ["name"]),
        mutates: true,
        handler(a, s) {
            const name = str(a.name, 120).trim();
            if (!name)
                throw new Error("name is required");
            if (findProject(s, name)?.name.toLowerCase() === name.toLowerCase())
                throw new Error(`Project "${name}" already exists`);
            const p = s.store.addProject({ name, keywords: strList(a.keywords), deadline: dueOf(a.deadline, s.now()), notes: str(a.notes, 1000) || undefined });
            return `Created project "${p.name}"${p.deadline ? ` (deadline ${p.deadline})` : ""}.`;
        },
    },
    {
        name: "update_project",
        description: "Change a project's status (active/blocked/done), deadline, notes or keywords.",
        inputSchema: obj({
            project: text("Project name or id"), status: { type: "string", enum: ["active", "blocked", "done"] },
            deadline: text("New deadline, or 'none'"), notes: text("Replace notes"), keywords: { type: "array", items: { type: "string" } },
        }, ["project"]),
        mutates: true,
        handler(a, s) {
            const p = findProject(s, a.project);
            if (!p)
                throw new Error(`No project matching "${str(a.project, 80)}"`);
            if (a.status) {
                if (!["active", "blocked", "done"].includes(str(a.status)))
                    throw new Error("Bad status");
                p.status = str(a.status);
            }
            if (a.deadline)
                p.deadline = str(a.deadline).toLowerCase() === "none" ? undefined : dueOf(a.deadline, s.now());
            if (a.notes !== undefined)
                p.notes = str(a.notes, 1000) || undefined;
            if (a.keywords)
                p.keywords = strList(a.keywords);
            return `${p.name}: ${p.status}${p.deadline ? `, deadline ${p.deadline}` : ""}.`;
        },
    },
    {
        name: "settings",
        description: "Show or change working hours, default task length and VIP senders (whose messages get a priority boost). Omit all arguments to just read.",
        inputSchema: obj({
            work_start: text("HH:MM"), work_end: text("HH:MM"),
            default_task_minutes: { type: "number" }, vip_senders: { type: "array", items: { type: "string" } },
        }),
        mutates: true,
        handler(a, s) {
            const cfg = s.store.state.settings;
            const hhmm = /^([01]?\d|2[0-3]):[0-5]\d$/;
            if (a.work_start) {
                if (!hhmm.test(str(a.work_start)))
                    throw new Error("work_start must be HH:MM");
                cfg.workStart = str(a.work_start);
            }
            if (a.work_end) {
                if (!hhmm.test(str(a.work_end)))
                    throw new Error("work_end must be HH:MM");
                cfg.workEnd = str(a.work_end);
            }
            const m = Number(a.default_task_minutes);
            if (m > 0 && m <= 480)
                cfg.defaultTaskMinutes = m;
            if (a.vip_senders)
                cfg.vipSenders = strList(a.vip_senders);
            return JSON.stringify(cfg, null, 2);
        },
    },
];
