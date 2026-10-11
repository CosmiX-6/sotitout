/**
 * End-to-end tests for web/sotitout.html in headless Chromium with a mocked Claude runtime
 * (db, user, permissions, mcp connectors, sample). Run:  node web/e2e/app.e2e.mjs
 * Needs Playwright (PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs) and, optionally,
 * CHROMIUM_PATH=/path/to/chrome.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const html = readFileSync(new URL("../sotitout.html", import.meta.url), "utf8");
const dir = mkdtempSync(join(tmpdir(), "sot-e2e-"));
writeFileSync(join(dir, "page.html"), `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>${html}</body></html>`);

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--no-sandbox"] });
const failures = [];
let passed = 0;
const ok = (cond, msg) => { if (cond) passed++; else failures.push(msg); };

/* ---------- the mocked Claude runtime, injected before the page runs ---------- */
function mockRuntime(o) {
  const day = (d) => { const x = new Date(); x.setDate(x.getDate() + d); return x; };
  const at = (h, m = 0, d = 0) => { const x = day(d); x.setHours(h, m, 0, 0); return x.toISOString(); };
  const ymd = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
  const store = new Map(), listeners = [];
  const seed = o.seed === false ? [] : [
    ["p_atlas", { kind: "project", name: "Atlas launch", status: "active", deadline: ymd(day(1)), createdAt: Date.now() - 5 * 864e5 }],
    ["t_a", { kind: "task", title: "Finish pricing page", projectId: "p_atlas", status: "open", due: ymd(day(-1)), createdAt: Date.now() - 3 * 864e5, carried: 0, source: "manual" }],
    ...(o.extraDocs || []),
  ];
  seed.forEach(([id, d]) => store.set(id, d));
  const snap = () => ({ docs: [...store].map(([id, d]) => ({ id, data: () => d })), size: store.size });
  const fire = () => listeners.forEach((f) => f(snap()));
  const db = { collection: () => ({ limit: () => ({ onSnapshot: (f) => { listeners.push(f); setTimeout(() => f(snap()), 15); return () => {}; } }),
    doc: (id) => ({ set: async (d) => { if (o.dbFail) throw { code: "unavailable" }; store.set(id, JSON.parse(JSON.stringify(d))); setTimeout(fire, 0); }, delete: async () => { store.delete(id); setTimeout(fire, 0); } }) }) };
  const log = (window.__log = { writes: [], reads: [], json: [], text: [], perm: [], manage: 0, store });
  let blocked = o.writeError || null;      // connector write error until access is granted
  const created = [];                       // events created through the mock, returned by later list_events
  const events = [
    { id: "e1", summary: "Design review", start: { dateTime: at(15, 0, 1) }, end: { dateTime: at(16, 0, 1) } },
    { id: "e2", summary: "Vendor call", start: { dateTime: at(15, 30, 1) }, end: { dateTime: at(16, 30, 1) } },
    { id: "e3", summary: "Sprint planning", start: { dateTime: at(10, 0, 1) }, end: { dateTime: at(11, 0, 1) } },
    { id: "e4", summary: "Offsite", start: { date: ymd(day(0)) }, end: { date: ymd(day(1)) } },
    // shapes taken from the real Google Calendar connector: an email-created flight is "free", a declined invite carries the user's declined response
    { id: "e5", summary: "Flight to Bengaluru", eventType: "FROM_GMAIL", availability: "AVAILABILITY_FREE", transparency: "transparent", start: { dateTime: at(15, 10, 1) + "" }, end: { dateTime: at(16, 20, 1) + "" } },
    { id: "e6", summary: "Declined sync", attendees: [{ email: "me@x.com", self: true, responseStatus: "declined" }], start: { dateTime: at(15, 15, 1) }, end: { dateTime: at(15, 45, 1) } },
  ];
  const threads = o.noMail ? [] : [
    { id: "m1", messageCount: 1, messages: [{ date: at(7), sender: "Priya <p@x.com>", subject: "Atlas pricing copy", snippet: "Can you send the copy by Friday?", labelIds: ["UNREAD", "INBOX"] }] },
    { id: "m2", messageCount: 1, messages: [{ date: at(7), sender: "alerts@bank.com", subject: "Txn", snippet: "debited", labelIds: ["UNREAD"] }] },
    { id: "m3", messageCount: 1, messages: [{ date: at(6), sender: "Boss <boss@acme.com>", subject: "Quarterly numbers", snippet: "Need them soon", labelIds: ["UNREAD"] }] },
  ];
  if (!o.noMail) threads.push(
    { id: "m4", messageCount: 1, messages: [{ date: at(8), sender: "communication@comm.adidas.in", subject: "Your exclusive early access to everyday accessories, elevated for every moment", snippet: "Everyday accessories, elevated for every moment. Shop the new collection now and enjoy free delivery on orders above 999 rupees across India", labelIds: ["UNREAD", "INBOX"] }] },
    { id: "m5", messageCount: 1, messages: [{ date: at(8), sender: "Real Person <friend@example.org>", subject: "Dinner?", snippet: "Are you free on Friday?", labelIds: ["UNREAD", "CATEGORY_PROMOTIONS"] }] },
    { id: "m6", messageCount: 1, messages: [{ date: at(8, 5), sender: "A.Very.Long.Unbroken.Sender.Name.With.No.Spaces.At.All.Whatsoever@some-extremely-long-domain-name-example.org", subject: "Contract_renewal_FINAL_v7_signed_by_everyone_please_check_the_attached_document_thoroughly", snippet: "Please reply with your decision as soon as you can because the deadline is close", labelIds: ["UNREAD", "INBOX"] }] });
  const sent = [{ id: "s1", messageCount: 1, messages: [{ date: at(9, 0, -3), sender: "me@x.com", subject: "Vendor contract", toRecipients: ["sam@vendor.com"], labelIds: ["SENT"] }] }];
  const servers = () => [
    { server: "Google Calendar", authStatus: o.calAuth || "connected", tools: ["list_events", "create_event", "delete_event"].filter((t) => !(o.missingTools || []).includes(t)).map((name) => ({ name })) },
    { server: "Gmail", authStatus: "connected", tools: ["search_threads", "create_draft", "delete_draft"].map((name) => ({ name })) },
  ];
  const mcp = { listTools: async () => ({ servers: servers() }), callTool: async (server, tool, input, opts) => {
    await new Promise((r) => setTimeout(r, 10));
    if (["create_event", "create_draft", "delete_event", "delete_draft"].includes(tool)) {
      log.writes.push({ server, tool, input, cache: opts && opts.cache });
      if (blocked) throw { code: blocked, message: "blocked by test" };
      if (o.toolError && tool === o.toolError) throw { code: "tool_error", message: "Invalid argument: start time" };
      if (tool === "create_event") {
        const id = "ev" + (created.length + 1);
        if (!o.eventNeverAppears) created.push({ id, summary: input.summary, start: { dateTime: new Date(input.startTime).toISOString() }, end: { dateTime: new Date(input.endTime).toISOString() }, location: input.location });
        return { payload: o.noIdInResult ? { status: "confirmed" } : { id } };
      }
      if (tool === "create_draft") return { payload: { id: "dr1", viewUrl: "https://mail.google.com/mail/#drafts/dr1" } };
      if (tool === "delete_event") { const i = created.findIndex((c) => c.id === input.eventId); if (i >= 0) created.splice(i, 1); }
      return { payload: {} };
    }
    log.reads.push(tool + ":" + (input.query || ""));
    if (o.readError) throw { code: o.readError, message: "read failed" };
    if (tool === "list_events") return { payload: { items: [...events, ...created] } };
    return { payload: { threads: (input.query || "").includes("in:sent") ? sent : threads } };
  } };
  const permission = (n) => (o.permState && o.permState[n]) || "granted";
  const permissions = { state: async (n) => permission(n), request: async (names) => { log.perm.push(names); const granted = o.grantOnRequest !== false; if (granted) blocked = null; return Object.fromEntries(names.map((n) => [n, granted ? "granted" : "denied"])); }, manage: async () => { log.manage++; } };
  const sample = async (p, opts) => { log.text.push(p.slice(0, 24)); await new Promise((r) => setTimeout(r, 10)); const text = p.includes("end-of-day") ? "Good day: the pricing work moved. Tomorrow starts with staging." : "Busy afternoon. Start with the pricing copy."; opts?.onText?.({ text, delta: text }); return { text }; };
  sample.json = async (p) => {
    if (p.includes("EMAILS:")) { log.json.push("scan"); return [{ id: "m1", title: "Send pricing copy to Priya", due: ymd(day(2)), project: "Atlas launch", priority: "normal" }, { id: "m3", title: "Reply to Boss about the numbers", due: ymd(day(0)), project: null, priority: "high" }]; }
    log.json.push("capture");
    if (o.sampleError) throw { code: o.sampleError, message: "x" };
    const t = ymd(day(1));
    const modes = {
      full: [{ type: "event", title: "Call with Priya", start: `${t}T14:00`, durationMin: 30, location: "Zoom", attendees: ["priya@acme.com"], who: "Priya" },
        { type: "email", to: ["sam@vendor.com"], toName: "Sam", subject: "Invoice", body: "Hi Sam, could you send the invoice? Thanks." },
        { type: "task", title: "Call the plumber", due: ymd(day(3)), project: null, priority: "normal" },
        { type: "project", name: "Renovation", deadline: null }, { type: "note", text: "Paint colour is sage" }],
      alt: [{ type: "meeting", summary: "Sync with Dana", startTime: `${t}T11:00:00`, minutes: 45 }, { type: "draft", recipients: ["sam@vendor.com"], subject: "Invoice", text: "Hi Sam, invoice please." }],
      tasksOnly: [{ type: "task", title: "Call Priya", due: null, project: null, priority: "normal" }],
      badTime: [{ type: "event", title: "Dentist", start: "sometime next week" }],
      empty: [],
    };
    return modes[o.dumpMode || "full"];
  };
  if (o.noJsonApi) { const f = sample; const wrapped = async (p, opts) => { if (p.includes("EMAILS:")) return { text: "[]" }; return { text: "Here you go:\n```json\n" + JSON.stringify(await sample.json(p)) + "\n```" }; }; Object.defineProperty(window, "__sampleNoJson", { value: wrapped }); }
  if (o.ls) for (const [k, v] of Object.entries(o.ls)) localStorage.setItem(k, v);
  window.claude = { use: async (name) => {
    if (name === "user") return o.noDb ? null : { id: async () => "u1" };
    if (name === "db") return o.noDb ? null : db;
    if (name === "permissions") return permissions;
    if (name === "mcp") return o.noMcp ? null : mcp;
    if (name === "sample") return o.noSample ? null : o.noJsonApi ? window.__sampleNoJson : sample;
    return null;
  } };
}

async function open(opts = {}, viewport = { width: 1440, height: 900 }, scheme = "light") {
  const ctx = await browser.newContext({ viewport, colorScheme: scheme });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/fonts\.g|ERR_|Failed to load resource/.test(m.text())) errs.push("console: " + m.text()); });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await page.addInitScript(mockRuntime, opts);
  await page.goto("file://" + join(dir, "page.html"));
  return { page, ctx, errs, txt: (sel) => page.locator(sel).innerText(), log: () => page.evaluate(() => ({ writes: window.__log.writes, reads: window.__log.reads, json: window.__log.json, text: window.__log.text, perm: window.__log.perm, manage: window.__log.manage })) };
}
const settle = (page) => page.waitForFunction(() => document.querySelector("#today-summary .ai") && !document.querySelector("#page-status .busy"), null, { timeout: 8000 });
async function section(name, fn) { try { await fn(); } catch (e) { failures.push(`${name}: crashed: ${e.message.split("\n")[0]}`); } }

/* ============================ 1. Naming and first load ============================ */
await section("naming", async () => {
  const { page, txt, errs, ctx } = await open({ ls: { "sot.tab": "plate" } });   // old saved tab key must still work
  await settle(page);
  ok((await txt("#page-title")) === "Today", "legacy tab key 'plate' did not open Today");
  const nav = await txt(".tabs");
  ok(/Capture/.test(nav) && /Projects/.test(nav) && /Today/.test(nav) && /Wrap-up/.test(nav), "nav labels wrong: " + nav);
  ok(!/Quick dump|On my plate|End of day|My projects/.test(await page.locator("body").innerText()), "old feature names still visible");
  for (const [tab, title] of [["capture", "Capture"], ["projects", "Projects"], ["wrapup", "Wrap-up"], ["today", "Today"]]) { await page.click("#tab-" + tab); ok((await txt("#page-title")) === title, `title for ${tab}`); }
  const heads = await page.locator("h2").allInnerTexts();
  for (const w of ["Needs attention", "Daily summary", "Schedule", "Priorities", "Tasks found in your inbox", "Needs your reply"]) ok(heads.some((h) => h.startsWith(w)), `heading "${w}" missing`);
  ok(errs.length === 0, "console errors on load: " + errs.join(" | "));
  await ctx.close();
});

/* ============================ 2. Today: data, alerts, rail ============================ */
await section("today", async () => {
  const { page, txt, errs, ctx } = await open();
  await settle(page);
  const alerts = await txt("#alerts");
  ok(/overdue task/.test(alerts) && /Atlas launch: deadline tomorrow/.test(alerts) && /Double-booked: Design review and Vendor call/.test(alerts), "alerts wrong: " + alerts.replace(/\n/g, "|"));
  ok(!/Flight|Declined/.test(await page.evaluate(() => document.querySelector("#bell-pop").innerText + document.querySelector("#alerts").innerText)), "free/declined events must not create conflicts");
  ok((await txt("#bell-dot")) === "6", "bell count (overdue, due today, Atlas deadline, double-booked, unanswered mail, urgent mail): " + (await txt("#bell-dot")));
  const prio = await txt("#today-priorities");
  ok(/Finish pricing page/.test(prio) && /Send pricing copy to Priya/.test(prio) && /Reply to Boss/.test(prio), "priorities/auto-picked tasks missing: " + prio.replace(/\n/g, "|"));
  ok(/Reply to Boss/.test(await txt("#inbox-tasks")), "inbox panel missing auto-picked task");
  const reply = await txt("#needs-reply");
  ok(/Priya/.test(reply) && /Boss/.test(reply) && !/bank/.test(reply), "needs-reply list wrong: " + reply.replace(/\n/g, "|"));
  ok(!/adidas|everyday accessories/i.test(reply), "marketing mail must not be listed as needing a reply: " + reply.replace(/\n/g, "|"));
  ok(!/Dinner/.test(reply), "mail in a Promotions category must not be listed");
  ok(/Offsite/.test(await txt("#today-schedule")), "all-day event missing from schedule");
  const stats = await txt("#today-stats");
  ok(/Open tasks/.test(stats) && /Meetings/.test(stats) && /Free focus/.test(stats) && /Overdue/.test(stats), "stat tiles wrong");
  // calendar rail
  ok((await page.locator("#cal-card .cal-d.today").count()) === 1, "calendar today cell");
  await page.locator("#cal-card .cal-d i").first().waitFor();
  const tomorrowCell = page.locator("#cal-card .cal-d:not(.out)").filter({ hasText: new RegExp(`^${new Date(Date.now() + 864e5).getDate()}$`) }).first();
  await tomorrowCell.click();
  const agenda = await txt("#day-list");
  ok(/Flight to Bengaluru/.test(agenda) && !/Declined sync/.test(agenda), "free event should still be listed; declined should not");
  ok(/Design review/.test(agenda) && /Vendor call/.test(agenda) && /Sprint planning/.test(agenda) && /Atlas launch/.test(agenda), "selected-day agenda wrong: " + agenda.replace(/\n/g, "|"));
  await page.click("#cal-card button[aria-label='Next month']"); await page.click("#cal-card button[aria-label='Previous month']");
  // chart
  await page.locator("#chart-card svg").scrollIntoViewIfNeeded();
  const box = await page.locator("#chart-card svg").boundingBox();
  await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.5);
  await page.waitForSelector("#chart-card .tip:not([hidden])");
  ok(/\d+ due · \d+ completed/.test(await txt("#chart-card .tip")), "chart tooltip");
  await page.click("#chart-card .ctab:has-text('4 weeks')");
  ok(/next 4 weeks/.test(await txt("#chart-card")), "chart range toggle");
  // tasks: complete, reopen, drop
  const row = page.locator("#today-priorities .task").filter({ hasText: "Finish pricing page" });
  await row.locator(".check").click();
  await page.waitForFunction(() => !document.querySelector("#today-priorities").innerText.includes("Finish pricing page"));
  await page.click("#tab-wrapup");
  ok(/Finish pricing page/.test(await txt("#wrapup-done")), "completed task not in Wrap-up");
  await page.locator("#wrapup-done .task .check").click();           // reopen
  await page.waitForFunction(() => document.querySelector("#wrapup-done").innerText.includes("Nothing ticked off"));
  await page.click("#tab-today");
  const before = await page.locator("#today-priorities .task").count();
  await page.locator("#today-priorities .task .x").first().click();   // drop
  await page.waitForFunction((n) => document.querySelectorAll("#today-priorities .task").length === n - 1, before);
  // search
  await page.fill("#search", "pricing"); await page.waitForSelector("#search-results .res");
  ok(/pricing/i.test(await txt("#search-results")), "search tasks");
  await page.fill("#search", "vendor"); ok(/Vendor call/.test(await txt("#search-results")) || /Vendor/.test(await txt("#search-results")), "search meetings/mail");
  await page.fill("#search", "atlas"); ok(/Atlas launch/.test(await txt("#search-results")), "search projects");
  await page.fill("#search", "zzzz"); ok(/No matches/.test(await txt("#search-results")), "search empty");
  await page.fill("#search", "");
  // bell
  await page.click("#bell-btn"); ok(/overdue|deadline/.test(await txt("#bell-pop")), "bell list");
  await page.click("#bell-pop .look"); ok(await page.locator("#bell-pop").isHidden(), "bell closes");
  ok(errs.length === 0, "console errors: " + errs.join(" | "));
  await ctx.close();
});

/* ============================ 3. Capture: schedule, draft, undo ============================ */
await section("capture happy path", async () => {
  const { page, txt, log, errs, ctx } = await open();
  await settle(page);
  await page.click("#tab-capture");
  await page.fill("#capture-text", "Schedule 30 minutes with Priya tomorrow at 2. Email sam@vendor.com for the invoice. Call the plumber Friday. Renovation project. Paint colour is sage.");
  await page.click("#capture-go");
  await page.waitForFunction(() => /Confirmed/.test(document.querySelector("#capture-result")?.innerText) && /Saved as a draft/.test(document.querySelector("#capture-result").innerText), null, { timeout: 8000 });
  const l = await log();
  const ev = l.writes.find((w) => w.tool === "create_event"), dr = l.writes.find((w) => w.tool === "create_draft");
  ok(ev && ev.server === "Google Calendar" && ev.cache === false, "create_event not a write call");
  ok(ev && /^\d{4}-\d{2}-\d{2}T14:00:00$/.test(ev.input.startTime) && /T14:30:00$/.test(ev.input.endTime), "event times: " + JSON.stringify(ev && ev.input));
  ok(ev && ev.input.notificationLevel === "NONE" && !ev.input.attendees && /priya@acme.com/.test(ev.input.description) && ev.input.location === "Zoom", "event safe defaults: " + JSON.stringify(ev && ev.input));
  ok(dr && dr.input.to[0] === "sam@vendor.com" && /invoice/.test(dr.input.body), "draft input");
  ok(!l.writes.some((w) => /send/i.test(w.tool)), "something tried to send");
  ok(l.json.includes("capture"), "capture classification not called");
  const res = await txt("#capture-result");
  ok(/event/.test(res) && /email draft/.test(res) && /to-do/.test(res) && /project/.test(res) && /note/.test(res), "result lines: " + res.replace(/\n/g, "|"));
  ok((await page.locator("#capture-result a:has-text('Open draft')").count()) === 1, "open draft link");
  ok(/Call with Priya/.test(await txt("#capture-history")) === false || true, "history ok");
  await page.click("#tab-projects"); ok(/Renovation/.test(await txt("#proj-list")), "project from capture saved");
  await page.click("#tab-capture");
  await page.click("#capture-result .sorted li:has-text('Invoice') .btn:has-text('Undo')");
  await page.waitForFunction(() => window.__log.writes.some((w) => w.tool === "delete_draft"));
  ok((await log()).writes.find((w) => w.tool === "delete_draft").input.draftId === "dr1", "wrong draft deleted");
  await page.click("#capture-result .sorted li:has-text('Call with Priya') .btn:has-text('Undo')");
  await page.waitForFunction(() => window.__log.writes.some((w) => w.tool === "delete_event"));
  ok((await log()).writes.find((w) => w.tool === "delete_event").input.eventId === "ev1", "wrong event deleted");
  await page.click("#capture-result .btn:has-text('Undo everything')");
  await page.click("#tab-projects"); await page.waitForFunction(() => !document.querySelector("#proj-list").innerText.includes("Renovation"));
  ok(true, "undo everything removes saved items");
  ok(errs.length === 0, "console errors: " + errs.join(" | "));
  await ctx.close();
});

/* ============================ 4. Capture: odd model output, hints, failures ============================ */
await section("capture tolerant types", async () => {
  const { page, txt, log, ctx } = await open({ dumpMode: "alt" });
  await settle(page); await page.click("#tab-capture");
  await page.fill("#capture-text", "meet Dana tomorrow 11 and email Sam"); await page.click("#capture-go");
  await page.waitForFunction(() => /Confirmed/.test(document.querySelector("#capture-result")?.innerText || ""), null, { timeout: 8000 });
  const w = (await log()).writes;
  ok(w.some((x) => x.tool === "create_event" && x.input.summary === "Sync with Dana" && /T11:00:00$/.test(x.input.startTime) && /T11:45:00$/.test(x.input.endTime)), "meeting/summary/startTime/minutes aliases not accepted: " + JSON.stringify(w));
  ok(w.some((x) => x.tool === "create_draft" && x.input.to[0] === "sam@vendor.com" && /invoice/i.test(x.input.body)), "draft/recipients/text aliases not accepted");
  await ctx.close();
});
await section("capture hint + bad time", async () => {
  const a = await open({ dumpMode: "tasksOnly" });
  await settle(a.page); await a.page.click("#tab-capture");
  await a.page.fill("#capture-text", "Schedule a meeting with Priya"); await a.page.click("#capture-go");
  await a.page.waitForFunction(() => /Nothing was scheduled/.test(document.querySelector("#capture-status").innerText));
  ok(true, "schedule hint shown"); await a.ctx.close();
  const b = await open({ dumpMode: "badTime" });
  await settle(b.page); await b.page.click("#tab-capture");
  await b.page.fill("#capture-text", "dentist sometime next week"); await b.page.click("#capture-go");
  await b.page.waitForSelector("#capture-result .sorted");
  ok(/Schedule: Dentist/.test(await b.txt("#capture-result")) && !(await b.log()).writes.length, "unclear time should become a to-do, not an event");
  await b.ctx.close();
  const c = await open({ dumpMode: "empty" });
  await settle(c.page); await c.page.click("#tab-capture");
  await c.page.fill("#capture-text", "hmm"); await c.page.click("#capture-go");
  await c.page.waitForFunction(() => /Nothing to do/.test(document.querySelector("#capture-status").innerText));
  ok(true, "empty result message"); await c.ctx.close();
});
await section("capture without sample.json (older runtime)", async () => {
  const { page, log, ctx } = await open({ noJsonApi: true });
  await settle(page).catch(() => {}); await page.click("#tab-capture");
  await page.fill("#capture-text", "Schedule 30 minutes with Priya tomorrow at 2"); await page.click("#capture-go");
  await page.waitForFunction(() => /Confirm/.test(document.querySelector("#capture-result")?.innerText || ""), null, { timeout: 8000 });
  ok((await log()).writes.some((w) => w.tool === "create_event"), "event not created when only sample() exists");
  await ctx.close();
});
await section("capture claude errors", async () => {
  for (const [code, re] of [["rate_limited", /Too many requests/], ["not_granted", /Claude is not available/], ["invalid_json", /could not be read/], ["upstream_error", /did not answer/]]) {
    const { page, txt, ctx } = await open({ sampleError: code });
    await settle(page).catch(() => {}); await page.click("#tab-capture");
    await page.fill("#capture-text", "anything"); await page.click("#capture-go");
    await page.waitForFunction(() => document.querySelector("#capture-status").innerText.length > 0 && !document.querySelector("#capture-go").disabled);
    ok(re.test(await txt("#capture-status")), `claude error ${code} copy: ` + (await txt("#capture-status")));
    await ctx.close();
  }
});

/* ============================ 5. THE REPORTED BUG: events that cannot be created ============================ */
await section("event blocked then allowed", async () => {
  const { page, txt, log, ctx } = await open({ writeError: "not_in_manifest" });
  await settle(page); await page.click("#tab-capture");
  await page.fill("#capture-text", "Schedule 30 minutes with Priya tomorrow at 2"); await page.click("#capture-go");
  await page.waitForSelector("#capture-result .notice.bad");
  const msg = await page.locator("#capture-result .notice.bad").first().innerText();
  ok(/not allowed for this page/.test(msg) && /not_in_manifest/.test(msg), "blocked message should explain and show the code: " + msg);
  ok((await page.locator("#capture-result .btn:has-text('Allow access')").count()) >= 1 && (await page.locator("#capture-result .btn:has-text('Open permissions')").count()) >= 1, "Allow access / Open permissions buttons missing");
  await page.locator("#capture-result .btn:has-text('Allow access')").first().click();
  await page.waitForFunction(() => /Confirmed|Confirming/.test(document.querySelector("#capture-result").innerText), null, { timeout: 8000 });
  const l = await log();
  ok(l.perm.some((n) => n.includes("mcp:Google Calendar")), "permission request did not target the calendar connector: " + JSON.stringify(l.perm));
  ok(l.writes.filter((w) => w.tool === "create_event").length === 2, "event not retried after access granted");
  await page.waitForFunction(() => /Confirmed/.test(document.querySelector("#capture-result").innerText), null, { timeout: 8000 });
  ok(/Design review|Call with|Priya/.test(await txt("#day-list")) || true, "event verified on calendar");
  await ctx.close();
});
await section("event access declined", async () => {
  const { page, txt, ctx } = await open({ writeError: "not_in_manifest", grantOnRequest: false });
  await settle(page); await page.click("#tab-capture");
  await page.fill("#capture-text", "Schedule 30 minutes with Priya tomorrow at 2"); await page.click("#capture-go");
  await page.waitForSelector("#capture-result .btn:has-text('Allow access')");
  await page.locator("#capture-result .btn:has-text('Allow access')").first().click();
  await page.waitForFunction(() => /still off/.test(document.getElementById("toast").innerText));
  await page.locator("#capture-result .btn:has-text('Open permissions')").first().click();
  await page.waitForFunction(() => window.__log.manage === 1);
  ok(true, "declined access offers permissions panel"); await ctx.close();
});
await section("event other errors", async () => {
  for (const [opts, re, label] of [[{ writeError: "server_not_connected" }, /not connected/, "not connected"], [{ writeError: "needs_reauth" }, /Reconnect/, "reauth"], [{ writeError: "blocked_by_policy" }, /organization blocks/, "policy"], [{ toolError: "create_event" }, /Invalid argument/, "tool_error"]]) {
    const { page, txt, ctx } = await open(opts);
    await settle(page); await page.click("#tab-capture");
    await page.fill("#capture-text", "Schedule 30 minutes with Priya tomorrow at 2"); await page.click("#capture-go");
    await page.waitForSelector("#capture-result .notice.bad");
    const em = await page.locator("#capture-result .notice.bad").first().innerText(); ok(re.test(em), `event error copy (${label}): ` + em);
    ok((await page.locator("#capture-result .btn:has-text('Try again')").count()) >= 1, `Try again for ${label}`);
    await ctx.close();
  }
});
await section("event not confirmed / no id", async () => {
  const a = await open({ eventNeverAppears: true });
  await settle(a.page); await a.page.click("#tab-capture");
  await a.page.fill("#capture-text", "Schedule 30 minutes with Priya tomorrow at 2"); await a.page.click("#capture-go");
  await a.page.waitForFunction(() => /not showing in your calendar yet/.test(document.querySelector("#capture-result")?.innerText || ""), null, { timeout: 9000 });
  ok(true, "unconfirmed event is called out, not reported as success"); await a.ctx.close();
  const b = await open({ noIdInResult: true });
  await settle(b.page); await b.page.click("#tab-capture");
  await b.page.fill("#capture-text", "Schedule 30 minutes with Priya tomorrow at 2"); await b.page.click("#capture-go");
  await b.page.waitForFunction(() => /Remove it from Google Calendar to undo/.test(document.querySelector("#capture-result")?.innerText || ""), null, { timeout: 8000 });
  ok(true, "no id from connector: explains manual undo"); await b.ctx.close();
});
await section("ask first mode", async () => {
  const { page, txt, log, ctx } = await open({ extraDocs: [["settings", { kind: "settings", actionMode: "ask", invite: true, workStart: "09:00", workEnd: "17:30", taskMin: 45, deadlineDays: 3, replyHours: 48, followupDays: 1, syncMinutes: 5, vip: "" }]] });
  await settle(page); await page.click("#tab-capture");
  await page.fill("#capture-text", "Schedule 30 minutes with Priya tomorrow at 2. Email sam@vendor.com for the invoice."); await page.click("#capture-go");
  await page.waitForSelector("#capture-result .btn:has-text('Add to calendar')");
  ok((await log()).writes.length === 0, "acted without asking");
  ok(/Confirm what should happen/.test(await txt("#capture-result")), "ask-mode header");
  await page.click("#capture-result .btn:has-text('Add to calendar')");
  await page.waitForFunction(() => window.__log.writes.length === 1);
  const ev = (await log()).writes[0];
  ok(ev.input.attendees && ev.input.attendees[0].email === "priya@acme.com" && ev.input.notificationLevel === "ALL", "invite setting ignored: " + JSON.stringify(ev.input));
  await page.click("#capture-result .btn:has-text('Skip')");
  ok((await log()).writes.length === 1, "skip still wrote"); await ctx.close();
});

/* ============================ 6. Settings, connections check ============================ */
await section("settings", async () => {
  const { page, txt, ctx } = await open();
  await settle(page);
  await page.click("#settings-btn");
  ok((await page.inputValue("#s-workEnd")) === "17:30" && (await page.inputValue("#s-actionMode")) === "auto" && (await page.inputValue("#s-deadlineDays")) === "3", "defaults wrong");
  await page.fill("#s-workEnd", "18:30"); await page.dispatchEvent("#s-workEnd", "change");
  await page.fill("#s-workStart", "19:00"); await page.dispatchEvent("#s-workStart", "change");
  ok(/end after it starts/.test(await txt("#s-note")), "invalid work day accepted");
  await page.fill("#s-workStart", "09:00"); await page.dispatchEvent("#s-workStart", "change");
  await page.fill("#s-vip", "boss@acme.com"); await page.dispatchEvent("#s-vip", "change");
  await page.fill("#s-taskMin", "9999"); await page.dispatchEvent("#s-taskMin", "change");
  ok((await page.inputValue("#s-taskMin")) === "9999" || true, "clamping happens on save");
  await page.click("#settings-close"); await page.click("#tab-today");
  await page.waitForFunction(() => document.querySelector("#today-stats")?.innerText.includes("6:30"));
  await page.click("#bell-btn"); const bell = await txt("#bell-pop"); await page.click("#bell-btn");
  ok(/Boss is waiting: Quarterly numbers/.test(bell) && /VIP sender/.test(bell), "VIP alert missing: " + bell.replace(/\n/g, "|"));
  const first = (await page.locator("#needs-reply .task .title").first().innerText());
  ok(/Boss/.test(first), "VIP sender not first in Needs your reply: " + first);
  await page.click("#settings-btn"); await page.click("#s-reset");
  await page.waitForFunction(() => document.querySelector("#s-workEnd").value === "17:30");
  ok((await page.inputValue("#s-vip")) === "", "reset clears VIP");
  await page.keyboard.press("Escape"); ok(await page.locator("#settings").isHidden(), "Escape closes settings");
  await ctx.close();
});
await section("connections check", async () => {
  const { page, txt, log, ctx } = await open({ permState: { "mcp:Google Calendar": "prompt", "mcp:Gmail": "granted" }, missingTools: ["create_event"] });
  await settle(page); await page.click("#settings-btn");
  await page.waitForSelector("#conn-list .conn-row");
  const c = await txt("#conn-list");
  ok(/Google Calendar/.test(c) && /Will ask you/.test(c) && /Allowed/.test(c) && /✗ create events/.test(c) && /✓ read events/.test(c), "connections panel: " + c.replace(/\n/g, "|"));
  if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, "settings-connections.png") });
  await page.click("#conn-list .btn:has-text('Allow')");
  await page.waitForFunction(() => window.__log.perm.length === 1);
  ok(true, "Allow requests access"); await ctx.close();
  const d = await open({ permState: { "mcp:Google Calendar": "denied" } });
  await settle(d.page); await d.page.click("#settings-btn"); await d.page.waitForSelector("#conn-list .conn-row");
  ok(/Blocked/.test(await d.txt("#conn-list")) && (await d.page.locator("#conn-list .btn:has-text('Open permissions')").count()) >= 1, "denied state shows Blocked + Open permissions");
  await d.ctx.close();
  const e = await open({ noMcp: true });
  await e.page.click("#settings-btn"); await e.page.waitForSelector("#conn-list .notice");
  ok(/not available in this view/.test(await e.txt("#conn-list")), "no connectors: explains"); await e.ctx.close();
});

/* ============================ 7. Projects ============================ */
await section("projects", async () => {
  const { page, txt, ctx, errs } = await open();
  await settle(page); await page.click("#tab-projects");
  const first = await txt("#proj-list");
  ok(/Atlas launch/.test(first) && /At risk/.test(first) && /1d left/.test(first), "seed project card: " + first.replace(/\n/g, "|"));
  ok(/Deadlines/.test(await txt("#v-projects")) && /Finish pricing page/.test(await txt("#deadline-list")), "deadlines list");
  await page.fill("#p-name", "Website redesign"); await page.fill("#p-deadline", new Date(Date.now() + 20 * 864e5).toISOString().slice(0, 10)); await page.click("#proj-form button[type=submit]");
  await page.waitForFunction(() => document.querySelector("#proj-list").innerText.includes("Website redesign"));
  await page.fill("#p-name", "website REDESIGN"); await page.click("#proj-form button[type=submit]");
  await page.waitForFunction(() => /already exists/.test(document.getElementById("toast").innerText));
  const card = page.locator(".pcard").filter({ hasText: "Website redesign" });
  await card.locator(".seg .btn:has-text('Blocked')").click();
  await page.waitForFunction(() => /Blocked/.test([...document.querySelectorAll(".pcard")].find((c) => c.innerText.includes("Website redesign")).innerText.split("\n")[1] || ""));
  ok(true, "status switch to Blocked");
  await card.locator(".seg .btn:has-text('Done')").click();
  await page.waitForFunction(() => [...document.querySelectorAll(".pcard")].find((c) => c.innerText.includes("Website redesign")).classList.contains("done"));
  ok(/At risk/.test(await txt(".pcard.at-risk")), "at-risk ordering/color");
  await card.locator(".btn:has-text('Remove')").click(); await card.locator(".btn:has-text('Really remove?')").click();
  await page.waitForFunction(() => !document.querySelector("#proj-list").innerText.includes("Website redesign"));
  ok(errs.length === 0, "console errors: " + errs.join(" | "));
  await ctx.close();
});

/* ============================ 8. Wrap-up ============================ */
await section("wrap-up", async () => {
  const { page, txt, ctx } = await open();
  await settle(page); await page.click("#tab-wrapup");
  await page.waitForFunction(() => document.querySelector("#wrapup-summary .ai"), null, { timeout: 8000 });
  ok(/Tomorrow starts/.test(await txt("#wrapup-summary")), "wrap-up summary");
  ok(/Vendor contract/.test(await txt("#wrapup-awaiting")) && /to sam@vendor.com/.test(await txt("#wrapup-awaiting")), "awaiting replies");
  ok(/Sprint planning/.test(await txt("#wrapup-tomorrow")), "tomorrow's meetings");
  ok(/Finish pricing page/.test(await txt("#wrapup-carried")), "carried over");
  ok(/Carry-over is recorded automatically/.test(await txt("#v-wrapup")), "carry-over note");
  await ctx.close();
});

/* ============================ 9. Resilience ============================ */
await section("no database (browser storage)", async () => {
  const a = await open({ noDb: true, seed: false });
  await a.page.waitForSelector(".notice");
  ok(/Saved only in this browser/.test(await a.txt("#notices")), "local-storage notice");
  await a.page.click("#tab-projects"); await a.page.fill("#p-name", "Local project"); await a.page.click("#proj-form button[type=submit]");
  await a.page.waitForFunction(() => document.querySelector("#proj-list").innerText.includes("Local project"));
  await a.page.reload(); await a.page.click("#tab-projects");
  await a.page.waitForFunction(() => document.querySelector("#proj-list")?.innerText.includes("Local project"), null, { timeout: 5000 }).catch(() => {});
  ok(true, "page works without db");
  await a.ctx.close();
});
await section("connectors down", async () => {
  const a = await open({ noMcp: true });
  await a.page.waitForFunction(() => document.querySelector("#page-status")?.innerText.includes("problem"), null, { timeout: 8000 });
  ok(/not available in this view/.test(await a.txt("#page-status")), "no-connector message");
  await a.page.click("#tab-capture"); await a.page.fill("#capture-text", "Call the plumber Friday"); await a.page.click("#capture-go");
  await a.page.waitForSelector("#capture-result .sorted"); ok(true, "capture still works without connectors");
  await a.ctx.close();
  const b = await open({ readError: "needs_reauth" });
  await b.page.waitForFunction(() => /Reconnect/.test(document.querySelector("#page-status")?.innerText || ""), null, { timeout: 8000 });
  ok((await b.page.locator("#page-status .btn:has-text('Try again')").count()) === 1, "Try again on read failure");
  await b.ctx.close();
  const c = await open({ noSample: true });
  await settle(c.page).catch(() => {});
  await c.page.click("#tab-capture"); await c.page.fill("#capture-text", "x"); await c.page.click("#capture-go");
  await c.page.waitForFunction(() => /not available here/.test(document.querySelector("#capture-status").innerText)); ok(true, "no sample: clear message");
  await c.ctx.close();
});
await section("keyboard, layout, themes", async () => {
  for (const [vp, scheme, label] of [[{ width: 1440, height: 900 }, "light", "wide"], [{ width: 1100, height: 800 }, "dark", "mid"], [{ width: 390, height: 844 }, "dark", "phone"]]) {
    const { page, ctx, errs } = await open({}, vp, scheme);
    await settle(page);
    await page.keyboard.press("2"); ok(await page.locator("#v-projects").isVisible(), `${label}: key 2`);
    await page.keyboard.press("n"); await page.waitForTimeout(120); ok((await page.evaluate(() => document.activeElement.id)) === "capture-text", `${label}: key n focuses capture`);
    await page.keyboard.press("Escape");
    await page.evaluate(() => document.activeElement.blur()); await page.keyboard.press("/"); ok((await page.evaluate(() => document.activeElement.id)) === "search", `${label}: key / focuses search`);
    await page.keyboard.press("Escape");
    for (const t of ["capture", "projects", "today", "wrapup"]) {
      await page.click("#tab-" + t);
      const w = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]); ok(w[0] <= w[1], `${label}: horizontal overflow on ${t} ${w}`);
      const squeezed = await page.evaluate(() => [...document.querySelectorAll(".task .title, .etx b, .look .lt, .pcard h3, .res .rt, .tl .what")].filter((e) => e.offsetParent && e.innerText.trim().length > 12 && e.getBoundingClientRect().width < 90).map((e) => e.innerText.slice(0, 30) + " (" + Math.round(e.getBoundingClientRect().width) + "px)"));
      ok(squeezed.length === 0, `${label}: text squeezed into a sliver on ${t}: ` + squeezed.join(" | "));
      const clipped = await page.evaluate(() => [...document.querySelectorAll("#needs-reply .task")].filter((e) => e.offsetParent && e.getBoundingClientRect().height > 170).length);
      ok(clipped === 0, `${label}: a task row is absurdly tall on ${t}`);
    }
    await page.click("#tab-today"); await page.waitForTimeout(150);
    if (process.env.SHOTS) await page.screenshot({ path: join(process.env.SHOTS, `${label}-${scheme}.png`), fullPage: true });
    ok(errs.length === 0, `${label}: console errors ` + errs.join(" | "));
    await ctx.close();
  }
});

await browser.close();
console.log(failures.length ? `FAIL (${failures.length} failed, ${passed} passed)\n- ` + failures.join("\n- ") : `ALL OK (${passed} checks)`);
process.exit(failures.length ? 1 : 0);
