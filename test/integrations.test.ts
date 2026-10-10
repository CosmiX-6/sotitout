import assert from "node:assert/strict";
import { test } from "node:test";
import { awaitingReply } from "../src/core/briefing.ts";
import { emptyState, Store } from "../src/core/store.ts";
import { JiraProvider, normalizeSite } from "../src/providers/jira.ts";
import { MicrosoftProvider, parseGraphEvent, parseGraphMail, parseTodo } from "../src/providers/microsoft.ts";
import { cleanSlackText, SlackProvider } from "../src/providers/slack.ts";
import { chatNameFromFile, parseWhatsAppChat, WhatsAppProvider, whatsappToMessages } from "../src/providers/whatsapp.ts";

const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });

/* ---------- WhatsApp ---------- */
const ANDROID = `12/31/23, 9:41 PM - Messages and calls are end-to-end encrypted. No one outside of this chat can read them.
12/31/23, 9:41 PM - Priya: Hi! Can you send the deck by Friday?
Also include the pricing slide.
12/31/23, 9:45 PM - Me: Sure
12/31/23, 9:46 PM - Priya: <Media omitted>
1/2/24, 8:05 AM - Priya added Sam
1/2/24, 8:06 AM - Sam: Reminder: invoices are due 1/15`;

const IOS = `[31/12/2023, 21:41:05] Priya: ‎image omitted
[31/12/2023, 21:42:10] Priya: Please confirm the venue tomorrow`;

test("WhatsApp: Android export with 12h time, continuation lines, system lines and media", () => {
  const m = parseWhatsAppChat(ANDROID);
  assert.deepEqual(m.map((x) => x.sender), ["Priya", "Me", "Sam"]);
  assert.equal(m[0].text, "Hi! Can you send the deck by Friday?\nAlso include the pricing slide.");
  assert.equal(m[0].at.getHours(), 21);
  assert.equal(m[2].at.getMonth(), 0); // m/d/yy inferred because "12/31" has a second number > 12
  assert.equal(m[2].at.getDate(), 2);
});

test("WhatsApp: iOS bracket format, 24h time, d/m inferred, narrow no-break spaces tolerated", () => {
  const m = parseWhatsAppChat(IOS);
  assert.equal(m.length, 1);
  assert.equal(m[0].at.getDate(), 31);
  assert.equal(m[0].at.getMonth(), 11);
  const nnbsp = parseWhatsAppChat("[1/2/24, 9:05:07 PM] Al: ping me");
  assert.equal(nnbsp[0].at.getHours(), 21);
});

test("WhatsApp: ambiguous dates use the fallback order; 12 AM/PM edge cases", () => {
  assert.equal(parseWhatsAppChat("3/4/24, 12:10 AM - A: hello there", "dmy")[0].at.getMonth(), 3);
  assert.equal(parseWhatsAppChat("3/4/24, 12:10 AM - A: hello there", "mdy")[0].at.getMonth(), 2);
  assert.equal(parseWhatsAppChat("3/4/24, 12:10 AM - A: hello there")[0].at.getHours(), 0);
  assert.equal(parseWhatsAppChat("3/4/24, 12:10 PM - A: hello there")[0].at.getHours(), 12);
});

test("WhatsApp: converts to messages, flags last inbound as unread, drops old and keeps ids stable", () => {
  const msgs = parseWhatsAppChat(ANDROID);
  const all = whatsappToMessages("Team", msgs, "me", new Date(2000, 0, 1));
  assert.equal(all.find((x) => x.from === "Me")!.isSent, true);
  assert.deepEqual(all.filter((x) => x.isUnread).map((x) => x.from), ["Sam"]);
  assert.equal(all[0].threadId, "wa:Team");
  assert.equal(whatsappToMessages("Team", msgs, "me", new Date(2024, 0, 1)).length, 1);
  assert.deepEqual(all.map((x) => x.id), whatsappToMessages("Team", parseWhatsAppChat(ANDROID), "me", new Date(2000, 0, 1)).map((x) => x.id));
  assert.equal(chatNameFromFile("/tmp/WhatsApp Chat with Priya Shah.txt"), "Priya Shah");
});

test("WhatsApp provider reads each file and feeds task extraction", async () => {
  const p = new WhatsAppProvider(["/x/WhatsApp Chat with Team.txt"], "Me", async () => ANDROID);
  const out = await p.fetchEmails(new Date(2000, 0, 1));
  assert.equal(out.length, 3);
  const store = new Store("/nonexistent/never-saved.json");
  assert.equal(store.ingestEmails(out, new Date(2024, 0, 3)), 2); // deck by Friday + invoices due 1/15
  assert.ok(store.state.tasks.some((t) => t.due === "2024-01-15"));
});

/* ---------- chat follow-ups ---------- */
test("chat follow-ups only chase sent messages that asked a question", () => {
  const base = { provider: "whatsapp", threadId: "wa:x", from: "me", to: ["x"], subject: "x", isUnread: false, isSent: true };
  const old = new Date(Date.now() - 2 * 86_400_000).toISOString();
  const r = awaitingReply(
    [{ ...base, id: "1", body: "Can you confirm?", receivedAt: old }, { ...base, id: "2", body: "Thanks!", receivedAt: old }],
    new Date(),
  );
  assert.deepEqual(r.map((x) => x.id), ["1"]);
});

/* ---------- Jira / external task sync ---------- */
const issue = (key: string, o: Record<string, unknown> = {}) => ({
  key, fields: { summary: `Do ${key}`, duedate: null, priority: { name: "Medium" }, project: { key: "ATL", name: "Atlas" }, ...o },
});

test("Jira: pages through results, maps priority/due/project, sends basic auth", async () => {
  const calls: { auth: string; body: { nextPageToken?: string } }[] = [];
  const f = (async (_u: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ auth: (init.headers as Record<string, string>).authorization, body });
    return body.nextPageToken
      ? json({ issues: [issue("ATL-2", { priority: { name: "Highest" }, duedate: "2026-10-20" })], isLast: true })
      : json({ issues: [issue("ATL-1")], nextPageToken: "p2", isLast: false });
  }) as unknown as typeof fetch;
  const tasks = await new JiraProvider({ site: "acme.atlassian.net", email: "a@b.c", token: "t" }, f).fetchTasks();
  assert.deepEqual(tasks.map((t) => t.id), ["jira:ATL-1", "jira:ATL-2"]);
  assert.equal(tasks[1].highPriority, true);
  assert.equal(tasks[1].due, "2026-10-20");
  assert.equal(calls[0].auth, `Basic ${Buffer.from("a@b.c:t").toString("base64")}`);
  assert.equal(calls.length, 2);
});

test("Jira: bad credentials and non-https sites are rejected", async () => {
  const f = (async () => json({}, 401)) as unknown as typeof fetch;
  await assert.rejects(new JiraProvider({ site: "https://x.atlassian.net", email: "a", token: "b" }, f).fetchTasks(), /rejected the credentials/);
  assert.throws(() => normalizeSite("http://x.atlassian.net"), /https/);
});

test("syncExternal adds, refreshes, completes vanished tasks, reopens, and respects dismissals", () => {
  const store = new Store("/nonexistent/never-saved.json");
  store.state.projects.push({ id: "p", name: "Atlas", keywords: [], status: "active" });
  const now = new Date(2026, 9, 12);
  const mk = (key: string, due?: string) => ({ id: `jira:${key}`, title: `${key} x`, due, source: "jira" as const, projectHint: "ATL Atlas" });

  assert.deepEqual(store.syncExternal("jira", [mk("A-1"), mk("A-2")], now), { added: 2, completed: 0 });
  assert.equal(store.state.tasks[0].projectId, "p");

  store.setTaskStatus("jira:A-2", "dismissed", now);
  const r = store.syncExternal("jira", [mk("A-2"), mk("A-3", "2026-10-30")], now); // A-1 vanished
  assert.deepEqual(r, { added: 1, completed: 1 });
  assert.equal(store.state.tasks.find((t) => t.id === "jira:A-1")!.status, "done");
  assert.equal(store.state.tasks.find((t) => t.id === "jira:A-2")!.status, "dismissed");

  store.syncExternal("jira", [mk("A-1"), mk("A-3")], now); // A-1 reopened upstream
  assert.equal(store.state.tasks.find((t) => t.id === "jira:A-1")!.status, "open");
  // other sources are never touched
  store.addTask({ title: "manual" }, now);
  store.syncExternal("jira", [], now);
  assert.equal(store.state.tasks.find((t) => t.title === "manual")!.status, "open");
});

/* ---------- Microsoft Graph ---------- */
test("Graph: mail, event and To Do mapping", () => {
  const m = parseGraphMail({
    id: "1", conversationId: "c", subject: "Hi", receivedDateTime: "2026-10-12T08:00:00Z", isRead: false,
    from: { emailAddress: { name: "Ann", address: "a@x.com" } }, toRecipients: [{ emailAddress: { address: "me@x.com" } }],
    body: { content: "Please send it" },
  }, false);
  assert.equal(m.from, "Ann <a@x.com>");
  assert.equal(m.isUnread, true);
  assert.equal(parseGraphMail({ id: "2", receivedDateTime: "2026-10-12T08:00:00Z", isRead: false }, true).isUnread, false);

  const e = parseGraphEvent({ id: "e", subject: "Sync", start: { dateTime: "2026-10-12T09:00:00.0000000" }, end: { dateTime: "2026-10-12T09:30:00.0000000" } })!;
  assert.equal(e.start, "2026-10-12T09:00:00.000Z");
  const allDay = parseGraphEvent({ id: "d", isAllDay: true, start: { dateTime: "2026-10-12T00:00:00.0000000" }, end: { dateTime: "2026-10-13T00:00:00.0000000" } })!;
  assert.equal(allDay.start, "2026-10-12");
  assert.equal(parseGraphEvent({ id: "c", isCancelled: true, start: { dateTime: "x" }, end: { dateTime: "x" } }), undefined);

  const t = parseTodo({ id: "t1", title: "Call bank", importance: "high", dueDateTime: { dateTime: "2026-10-14T00:00:00.0000000" } });
  assert.deepEqual([t.id, t.due, t.highPriority, t.source], ["todo:t1", "2026-10-14", true, "todo"]);
});

test("Graph provider: sends bearer + UTC preference, merges inbox and sent, walks To Do lists", async () => {
  const urls: string[] = [];
  const prefers: (string | undefined)[] = [];
  const f = (async (u: string, init: RequestInit) => {
    urls.push(decodeURIComponent(u));
    const h = init.headers as Record<string, string>;
    assert.equal(h.authorization, "Bearer T");
    prefers.push(h.prefer);
    if (u.includes("/mailFolders/inbox")) return json({ value: [{ id: "i", receivedDateTime: "2026-10-12T08:00:00Z", isRead: false }] });
    if (u.includes("/mailFolders/sentitems")) return json({ value: [{ id: "s", receivedDateTime: "2026-10-11T08:00:00Z" }] });
    if (u.includes("/todo/lists/L1/tasks")) return json({ value: [{ id: "t", title: "x" }] });
    if (u.includes("/todo/lists")) return json({ value: [{ id: "L1" }] });
    if (u.includes("/calendarView")) return json({ value: [] });
    throw new Error(`unexpected ${u}`);
  }) as unknown as typeof fetch;
  const p = new MicrosoftProvider(async () => "T", f);
  const mail = await p.fetchEmails(new Date("2026-10-10T00:00:00Z"));
  assert.deepEqual(mail.map((m) => [m.id, m.isSent]), [["i", false], ["s", true]]);
  assert.ok(urls[0].includes("receivedDateTime ge 2026-10-10T00:00:00.000Z"));
  await p.fetchEvents(new Date(), new Date());
  assert.equal(prefers.at(-1), 'outlook.timezone="UTC"');
  assert.equal((await p.fetchTasks()).length, 1);
});

/* ---------- Slack ---------- */
test("Slack: text cleanup", () => {
  const names = new Map([["U2", "Dana"]]);
  assert.equal(
    cleanSlackText("hey <@U2> see <https://x.io|the doc> in <#C1|ops> &amp; <https://y.io>", names),
    "hey @Dana see the doc (https://x.io) in #ops & https://y.io",
  );
});

test("Slack: DMs (latest inbound = unread) and mentions, deduped", async () => {
  const ts = (s: number) => String(Math.floor(Date.now() / 1000) - s);
  const f = (async (u: string) => {
    const path = new URL(u).pathname.split("/").pop();
    if (path === "auth.test") return json({ ok: true, user_id: "UME" });
    if (path === "users.info") return json({ ok: true, user: { real_name: new URL(u).searchParams.get("user") === "U9" ? "Dana" : "Me" } });
    if (path === "users.conversations") return json({ ok: true, channels: [{ id: "D1", is_im: true, user: "U9" }] });
    if (path === "conversations.history")
      return json({ ok: true, messages: [{ ts: ts(60), user: "U9", text: "Can you review this today?" }, { ts: ts(600), user: "UME", text: "on it" }] });
    if (path === "search.messages")
      return json({ ok: true, messages: { matches: [
        { ts: ts(300), user: "U9", text: "<@UME> ping", channel: { id: "C5", name: "ops" } },
        { ts: ts(60), user: "U9", text: "dupe", channel: { id: "D1", name: "x" } },
      ] } });
    throw new Error(`unexpected ${u}`);
  }) as unknown as typeof fetch;
  const out = await new SlackProvider("xoxp", f).fetchEmails(new Date(Date.now() - 86_400_000));
  const dm = out.filter((m) => m.threadId === "D1");
  assert.equal(dm.length, 2);
  assert.deepEqual(dm.map((m) => [m.isUnread, m.isSent]), [[true, false], [false, true]]);
  assert.equal(dm[0].subject, "DM with Dana");
  const mention = out.find((m) => m.threadId === "C5")!;
  assert.deepEqual([mention.subject, mention.isUnread, mention.body], ["#ops (mention)", true, "@Me ping"]);
  assert.equal(out.length, 3);
});

test("Slack: API errors surface the Slack error code", async () => {
  const f = (async () => json({ ok: false, error: "invalid_auth" })) as unknown as typeof fetch;
  await assert.rejects(new SlackProvider("bad", f).fetchEmails(new Date()), /invalid_auth/);
});

void emptyState;
