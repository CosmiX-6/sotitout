import { addDays, atTime, clock, dayLabel, diffDays, minutesBetween, parseYmd, ymd } from "./dates.js";
import { isAutomated, matchProject } from "./extract.js";
/* ---------- priority ---------- */
export function scoreTask(task, project, today, vips) {
    let score = 0;
    const reasons = [];
    if (task.due) {
        const d = diffDays(task.due, today);
        if (d < 0) {
            score += 100 + 10 * Math.min(-d, 5);
            reasons.push(`overdue by ${-d}d`);
        }
        else if (d === 0) {
            score += 80;
            reasons.push("due today");
        }
        else if (d === 1) {
            score += 50;
            reasons.push("due tomorrow");
        }
        else if (d <= 3) {
            score += 30;
            reasons.push(`due in ${d}d`);
        }
        else if (d <= 7) {
            score += 10;
            reasons.push(`due in ${d}d`);
        }
    }
    if (task.carriedCount > 0) {
        score += 8 * Math.min(task.carriedCount, 5);
        reasons.push(`carried over ${task.carriedCount}x`);
    }
    if (task.highPriority) {
        score += 45;
        reasons.push("flagged urgent");
    }
    if (task.sourceFrom && vips.some((v) => task.sourceFrom.toLowerCase().includes(v.toLowerCase()))) {
        score += 15;
        reasons.push("VIP sender");
    }
    if (project?.deadline) {
        const d = diffDays(project.deadline, today);
        if (d <= 3) {
            score += 20;
            reasons.push(`project deadline ${d < 0 ? "passed" : d === 0 ? "today" : `in ${d}d`}`);
        }
    }
    if (project?.status === "blocked") {
        score -= 20;
        reasons.push("project blocked");
    }
    return { task, score, reasons };
}
export function rankTasks(state, now) {
    const today = ymd(now);
    const byId = new Map(state.projects.map((p) => [p.id, p]));
    return state.tasks
        .filter((t) => t.status === "open")
        .map((t) => scoreTask(t, t.projectId ? byId.get(t.projectId) : undefined, today, state.settings.vipSenders))
        .sort((a, b) => b.score - a.score || a.task.createdAt.localeCompare(b.task.createdAt));
}
/* ---------- schedule ---------- */
const timedEvents = (events) => events.filter((e) => !e.allDay);
export function freeBlocks(events, day, state, notBefore) {
    const { workStart, workEnd, minBlockMinutes } = state.settings;
    let cursor = atTime(day, workStart);
    const end = atTime(day, workEnd);
    if (notBefore && notBefore > cursor)
        cursor = notBefore;
    const busy = timedEvents(events)
        .map((e) => ({ start: new Date(e.start), end: new Date(e.end) }))
        .sort((a, b) => a.start.getTime() - b.start.getTime());
    const blocks = [];
    for (const b of busy) {
        if (b.end <= cursor)
            continue;
        if (b.start >= end)
            break;
        if (b.start > cursor && minutesBetween(cursor, b.start) >= minBlockMinutes) {
            blocks.push({ start: cursor, end: b.start });
        }
        if (b.end > cursor)
            cursor = b.end;
    }
    if (cursor < end && minutesBetween(cursor, end) >= minBlockMinutes)
        blocks.push({ start: cursor, end });
    return blocks;
}
/** Greedy fill of ranked tasks into free blocks. */
export function planDay(ranked, blocks, defaultMin) {
    const plan = [];
    const overflow = [];
    const cursors = blocks.map((b) => new Date(b.start));
    for (const st of ranked) {
        const dur = st.task.estimateMin ?? defaultMin;
        const i = blocks.findIndex((b, bi) => minutesBetween(cursors[bi], b.end) >= dur);
        if (i === -1) {
            overflow.push(st);
            continue;
        }
        const start = new Date(cursors[i]);
        const end = new Date(start.getTime() + dur * 60_000);
        plan.push({ start, end, task: st.task });
        cursors[i] = end;
    }
    plan.sort((a, b) => a.start.getTime() - b.start.getTime());
    return { plan, overflow };
}
/* ---------- email triage ---------- */
export function needsReply(emails, state, now) {
    const cutoff = now.getTime() - 48 * 3_600_000;
    const vip = (e) => state.settings.vipSenders.some((v) => e.from.toLowerCase().includes(v.toLowerCase()));
    return emails
        .filter((e) => !e.isSent && e.isUnread && !isAutomated(e) && new Date(e.receivedAt).getTime() >= cutoff)
        .sort((a, b) => Number(vip(b)) - Number(vip(a)) || b.receivedAt.localeCompare(a.receivedAt))
        .slice(0, 5);
}
/** Sent mail older than a day with no later reply in the same thread. */
export function awaitingReply(emails, now) {
    const lastInbound = new Map();
    for (const e of emails) {
        if (!e.isSent && (lastInbound.get(e.threadId) ?? "") < e.receivedAt)
            lastInbound.set(e.threadId, e.receivedAt);
    }
    const weekAgo = now.getTime() - 7 * 86_400_000;
    const dayAgo = now.getTime() - 86_400_000;
    return emails
        .filter((e) => {
        if (!e.isSent)
            return false;
        // Chat messages are mostly statements; only chase the ones that asked something.
        if ((e.provider === "slack" || e.provider === "whatsapp") && !e.body.includes("?"))
            return false;
        const t = new Date(e.receivedAt).getTime();
        return t >= weekAgo && t <= dayAgo && (lastInbound.get(e.threadId) ?? "") < e.receivedAt;
    })
        .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
}
export function buildDayBrief(state, events, emails, now) {
    const ranked = rankTasks(state, now);
    const blocks = freeBlocks(events, now, state, now);
    const { plan, overflow } = planDay(ranked, blocks, state.settings.defaultTaskMinutes);
    const upcoming = timedEvents(events)
        .filter((e) => new Date(e.end) > now)
        .sort((a, b) => a.start.localeCompare(b.start));
    const meetingMinutes = timedEvents(events).reduce((sum, e) => sum + minutesBetween(new Date(e.start), new Date(e.end)), 0);
    const warnings = [];
    const overdue = ranked.filter((r) => r.reasons.some((x) => x.startsWith("overdue")));
    if (overdue.length)
        warnings.push(`${overdue.length} overdue task${overdue.length > 1 ? "s" : ""}`);
    if (meetingMinutes >= 300)
        warnings.push(`Meeting-heavy day (${(meetingMinutes / 60).toFixed(1)}h booked)`);
    if (blocks.length === 0)
        warnings.push("No free focus time left today");
    if (overflow.length)
        warnings.push(`${overflow.length} task${overflow.length > 1 ? "s" : ""} won't fit today`);
    const atRisk = projectStatuses(state, emails, now).filter((p) => p.health === "at-risk");
    if (atRisk.length)
        warnings.push(`At-risk: ${atRisk.map((p) => p.project.name).join(", ")}`);
    return {
        now,
        dateLabel: dayLabel(now),
        timeLabel: clock(now),
        allDay: events.filter((e) => e.allDay),
        remainingEvents: upcoming,
        nextEvent: upcoming.find((e) => new Date(e.start) > now) ?? upcoming[0],
        meetingMinutes,
        freeBlocks: blocks,
        unreadCount: emails.filter((e) => e.isUnread && !e.isSent).length,
        needsReply: needsReply(emails, state, now),
        priorities: ranked.slice(0, 5),
        plan,
        overflow,
        warnings,
    };
}
export function projectStatuses(state, emails, now) {
    const today = ymd(now);
    const ranked = rankTasks(state, now);
    return state.projects.map((project) => {
        const mine = state.tasks.filter((t) => t.projectId === project.id && t.status !== "dismissed");
        const open = mine.filter((t) => t.status === "open");
        const done = mine.filter((t) => t.status === "done");
        const overdue = open.filter((t) => t.due && t.due < today);
        const dues = [project.deadline, ...open.map((t) => t.due)].filter((d) => !!d).sort();
        const nextDeadline = dues.find((d) => d >= today) ?? dues[0];
        const daysToDeadline = project.deadline ? diffDays(project.deadline, today) : undefined;
        const lastEmail = emails
            .filter((e) => matchProject(e.subject, e.body, [project]))
            .map((e) => e.receivedAt)
            .sort()
            .pop();
        let health = "on-track";
        if (project.status === "done" || (mine.length > 0 && open.length === 0 && done.length > 0))
            health = "done";
        else if (project.status === "blocked")
            health = "blocked";
        else if (overdue.length > 0 ||
            (daysToDeadline !== undefined && daysToDeadline < 0) ||
            (daysToDeadline !== undefined && daysToDeadline <= 3 && open.length > 0)) {
            health = "at-risk";
        }
        return {
            project,
            health,
            open: open.length,
            done: done.length,
            overdue: overdue.length,
            nextDeadline,
            daysToDeadline,
            nextTask: ranked.find((r) => r.task.projectId === project.id)?.task,
            lastEmailAt: lastEmail,
        };
    });
}
export function buildEndOfDay(state, emails, tomorrowEvents, now) {
    const today = ymd(now);
    const ranked = rankTasks(state, addDays(now, 0));
    return {
        doneToday: state.tasks.filter((t) => t.status === "done" && t.completedAt && ymd(new Date(t.completedAt)) === today),
        carryOver: ranked,
        followUps: awaitingReply(emails, now),
        tomorrowEvents: tomorrowEvents.sort((a, b) => a.start.localeCompare(b.start)),
        tomorrowTop: ranked.slice(0, 5),
    };
}
/** Mark every still-open task as carried into tomorrow. Idempotent per calendar day. */
export function rollover(state, now) {
    const today = ymd(now);
    let n = 0;
    for (const t of state.tasks) {
        if (t.status === "open" && t.lastCarriedOn !== today) {
            t.carriedCount += 1;
            t.lastCarriedOn = today;
            n++;
        }
    }
    return n;
}
/* ---------- rendering ---------- */
const range = (a, b) => `${clock(a)}–${clock(b)}`;
const evLine = (e) => `${range(new Date(e.start), new Date(e.end))}  ${e.title}${e.location ? ` @ ${e.location}` : ""}`;
const taskLine = (s) => `${s.task.title}${s.reasons.length ? `  [${s.reasons.join(", ")}]` : ""}`;
const dueText = (d, today) => !d ? "no date" : today && diffDays(d, today) < 0 ? `${d} (PAST DUE)` : d;
export function renderDayBrief(b) {
    const L = [`# ${b.dateLabel} — ${b.timeLabel}`, ""];
    if (b.warnings.length)
        L.push(...b.warnings.map((w) => `! ${w}`), "");
    L.push("## Your day");
    b.allDay.forEach((e) => L.push(`  all day  ${e.title}`));
    if (b.remainingEvents.length === 0)
        L.push("  No more meetings today.");
    b.remainingEvents.forEach((e) => L.push(`  ${evLine(e)}`));
    if (b.nextEvent) {
        const mins = minutesBetween(b.now, new Date(b.nextEvent.start));
        if (mins > 0)
            L.push(`  Next up: "${b.nextEvent.title}" in ${mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`}`);
    }
    L.push(`  Free focus blocks: ${b.freeBlocks.length ? b.freeBlocks.map((x) => range(x.start, x.end)).join(", ") : "none"}`, "");
    L.push("## Inbox", `  ${b.unreadCount} unread.`);
    if (b.needsReply.length) {
        L.push("  Likely need a reply:");
        b.needsReply.forEach((e) => L.push(`   - [${e.provider}] ${e.from.replace(/<.*>/, "").trim()}: ${e.subject}`));
    }
    L.push("");
    L.push("## Priorities");
    if (b.priorities.length === 0)
        L.push("  Nothing open. Enjoy it.");
    b.priorities.forEach((s, i) => L.push(`  ${i + 1}. ${taskLine(s)}`));
    L.push("");
    L.push("## Suggested plan");
    if (b.plan.length === 0)
        L.push("  No tasks fit in today's free time.");
    b.plan.forEach((p) => L.push(`  ${range(p.start, p.end)}  ${p.task.title}`));
    if (b.overflow.length)
        L.push(`  Won't fit today: ${b.overflow.map((o) => o.task.title).join(" | ")}`);
    return L.join("\n");
}
export function renderProjects(list, now) {
    const today = ymd(now);
    const L = ["# Projects", ""];
    const order = ["at-risk", "blocked", "on-track", "done"];
    const sorted = [...list].sort((a, b) => order.indexOf(a.health) - order.indexOf(b.health));
    if (sorted.length === 0)
        L.push("  No projects yet.");
    for (const s of sorted) {
        L.push(`## ${s.project.name} — ${s.health.toUpperCase()}`);
        L.push(`  ${s.done} done, ${s.open} open${s.overdue ? `, ${s.overdue} overdue` : ""}`);
        if (s.project.deadline) {
            const d = s.daysToDeadline;
            L.push(`  Deadline: ${s.project.deadline} (${d < 0 ? `${-d}d ago` : d === 0 ? "today" : `in ${d}d`})`);
        }
        else if (s.nextDeadline)
            L.push(`  Next date: ${dueText(s.nextDeadline, today)}`);
        if (s.nextTask)
            L.push(`  Do next: ${s.nextTask.title}`);
        if (s.project.notes)
            L.push(`  Notes: ${s.project.notes}`);
        L.push("");
    }
    return L.join("\n");
}
export function renderEndOfDay(e, now) {
    const L = [`# End of day — ${dayLabel(now)}`, ""];
    L.push(`## Done today (${e.doneToday.length})`);
    if (!e.doneToday.length)
        L.push("  Nothing marked done.");
    e.doneToday.forEach((t) => L.push(`  ✓ ${t.title}`));
    L.push("", `## Carrying over (${e.carryOver.length})`);
    if (!e.carryOver.length)
        L.push("  Clean slate.");
    e.carryOver.slice(0, 10).forEach((s) => L.push(`  → ${taskLine(s)}`));
    L.push("", `## Follow-ups (${e.followUps.length})`);
    if (!e.followUps.length)
        L.push("  No sent emails waiting on a reply.");
    e.followUps.forEach((m) => L.push(`  ? [${m.provider}] Sent "${m.subject}" to ${m.to.join(", ") || "chat"} on ${m.receivedAt.slice(0, 10)} — no reply yet`));
    L.push("", "## Tomorrow");
    if (!e.tomorrowEvents.length)
        L.push("  No meetings scheduled.");
    e.tomorrowEvents.forEach((ev) => L.push(`  ${evLine(ev)}`));
    e.tomorrowTop.forEach((s, i) => L.push(`  ${i + 1}. ${taskLine(s)}`));
    return L.join("\n");
}
export { parseYmd };
