import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Store } from "../src/core/store.ts";
import { handleRpc } from "../src/mcp/server.ts";
import { Session, toEvent, toMessage } from "../src/mcp/tools.ts";

const NOW = new Date(2026, 9, 12, 8, 0); // Monday 08:00 local
const at = (h: number, m = 0, d = 0) => new Date(2026, 9, 12 + d, h, m).toISOString();

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "sot-mcp-"));
  const session = new Session(new Store(join(dir, "state.json")), () => NOW);
  let n = 0;
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await handleRpc({ jsonrpc: "2.0", id: ++n, method: "tools/call", params: { name, arguments: args } }, session))!;
    const res = r.result as { content: { text: string }[]; isError?: boolean };
    return { text: res.content[0].text, isError: !!res.isError };
  };
  return { dir, session, call, cleanup: () => rmSync(dir, { recursive: true }) };
}

test("protocol: initialize negotiates version, lists tools, ignores notifications, rejects unknown methods", async () => {
  const { session, cleanup } = setup();
  try {
    const init = (await handleRpc({ id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } }, session))!;
    assert.equal((init.result as { protocolVersion: string }).protocolVersion, "2024-11-05");
    const newer = (await handleRpc({ id: 2, method: "initialize", params: { protocolVersion: "2099-01-01" } }, session))!;
    assert.equal((newer.result as { protocolVersion: string }).protocolVersion, "2025-06-18");
    assert.equal(await handleRpc({ method: "notifications/initialized" }, session), undefined);
    const list = (await handleRpc({ id: 3, method: "tools/list" }, session))!.result as { tools: { name: string; inputSchema: { type: string } }[] };
    assert.ok(list.tools.length >= 12);
    assert.ok(list.tools.every((t) => t.inputSchema.type === "object"));
    assert.equal(new Set(list.tools.map((t) => t.name)).size, list.tools.length);
    assert.equal((await handleRpc({ id: 4, method: "nope" }, session))!.error!.code, -32601);
    assert.equal((await handleRpc({ id: 5, method: "tools/call", params: { name: "nope" } }, session))!.error!.code, -32602);
  } finally { cleanup(); }
});

test("flow: project + messages + events + jira → day brief, then end of day carries over", async () => {
  const { call, cleanup, dir } = setup();
  try {
    await call("add_project", { name: "Atlas", keywords: ["atlas"], deadline: "2026-10-14" });
    const r1 = await call("ingest_messages", { messages: [
      { id: "g1", source: "gmail", from: "Priya <p@x.com>", subject: "Atlas pricing copy", body: "Can you send the copy by Friday?", received_at: at(7), unread: true },
      { id: "s1", source: "slack", from: "Dana", subject: "#ops", body: "thanks!", received_at: at(7, 30), unread: true },
      "garbage",
    ] });
    assert.match(r1.text, /Ingested 2 message\(s\); 1 new task/);
    assert.match((await call("ingest_events", { events: [
      { id: "e1", title: "Standup", start: at(9), end: at(9, 30) },
      { id: "e2", title: "Offsite", start: "2026-10-12", end: "2026-10-13", all_day: true },
      { id: "e3", title: "Sprint planning", start: at(10, 0, 1), end: at(11, 0, 1) },
      { id: "bad", title: "x", start: "nonsense", end: "nonsense" },
    ] })).text, /Loaded 3 event\(s\); skipped 1/);
    assert.match((await call("sync_tasks", { source: "jira", tasks: [
      { id: "ATL-41", title: "Fix checkout timeout", due: "tomorrow", high_priority: true, project: "Atlas" },
    ] })).text, /1 new, 0 marked done/);

    const day = (await call("day_brief")).text;
    assert.match(day, /Monday, October 12/);
    assert.match(day, /Standup/);
    assert.match(day, /all day {2}Offsite/);
    assert.doesNotMatch(day, /Sprint planning/); // tomorrow's event not in today's view
    assert.match(day, /ATL-41 Fix checkout timeout/);
    assert.match(day, /\[gmail\] Priya/);

    assert.match((await call("project_status")).text, /Atlas — AT-RISK/);

    // finish one task, then close the day
    const ids = (await call("list_tasks")).text.split("\n").map((l) => l.split(" ")[0]);
    await call("update_task", { id: "jira:ATL-41", status: "done" });
    const eod = (await call("end_of_day", { close_day: true })).text;
    assert.match(eod, /Done today \(1\)/);
    assert.match(eod, /Sprint planning/);
    assert.match(eod, /Day closed: 1 task\(s\) marked as carried over/);
    assert.equal(ids.length, 2);
    // closing twice on the same day carries nothing more
    assert.match((await call("end_of_day", { close_day: true })).text, /0 task\(s\) marked/);

    // state survives a restart
    const again = new Store(join(dir, "state.json"));
    assert.equal(again.state.projects.length, 1);
    assert.equal(again.state.tasks.find((t) => t.id === "jira:ATL-41")!.status, "done");
  } finally { cleanup(); }
});

test("sync_tasks marks vanished issues done; add_tasks is idempotent and understands 'Friday'", async () => {
  const { call, session, cleanup } = setup();
  try {
    await call("sync_tasks", { source: "jira", tasks: [{ id: "A-1", title: "One" }, { id: "A-2", title: "Two" }] });
    assert.match((await call("sync_tasks", { source: "jira", tasks: [{ id: "A-2", title: "Two" }] })).text, /0 new, 1 marked done/);
    assert.match((await call("add_tasks", { tasks: [{ id: "gmail:9", title: "Send deck", due: "Friday" }] })).text, /Added 1/);
    assert.match((await call("add_tasks", { tasks: [{ id: "gmail:9", title: "Send deck" }] })).text, /Added 0/);
    assert.equal(session.store.state.tasks.find((t) => t.id === "x:gmail:9")!.due, "2026-10-16");
  } finally { cleanup(); }
});

test("errors are reported in-band and bad input never crashes", async () => {
  const { call, cleanup } = setup();
  try {
    assert.equal((await call("update_task", { id: "nope" })).isError, true);
    assert.equal((await call("sync_tasks", { source: "asana", tasks: [] })).isError, true);
    assert.equal((await call("settings", { work_start: "25:00" })).isError, true);
    assert.equal((await call("add_project", {})).isError, true);
    await call("add_project", { name: "Dup" });
    assert.match((await call("add_project", { name: "dup" })).text, /already exists/);
    assert.equal((await call("ingest_messages", { messages: "not an array" })).isError, false);
    assert.match((await call("settings", { vip_senders: ["boss@x.com"], default_task_minutes: 30 })).text, /boss@x.com/);
  } finally { cleanup(); }
});

test("import_whatsapp reads local exports but refuses relative paths and non-.txt files", async () => {
  const { call, cleanup, dir } = setup();
  try {
    const f = join(dir, "WhatsApp Chat with Ravi.txt");
    writeFileSync(f, "10/12/26, 7:30 AM - Ravi: Can you share the vendor invoice by EOD?\n10/12/26, 7:31 AM - Me: ok");
    const r = await call("import_whatsapp", { paths: [f, "relative.txt", join(dir, "x.pdf")], me: "Me" });
    assert.match(r.text, /Imported 2 WhatsApp message\(s\); 1 new task/);
    assert.match(r.text, /relative\.txt: skipped/);
    assert.match(r.text, /x\.pdf: skipped/);
    assert.match((await call("day_brief")).text, /vendor invoice/);
  } finally { cleanup(); }
});

test("coercion helpers tolerate junk", () => {
  assert.equal(toMessage(null, 0, NOW), undefined);
  assert.equal(toMessage({ id: 5, received_at: "garbage" }, 0, NOW)!.receivedAt, NOW.toISOString());
  assert.equal(toEvent({ title: "x", start: "2026-10-12", end: "2026-10-13", all_day: true }, 0)!.allDay, true);
  assert.equal(toEvent({ title: "x", start: "2026-10-12T09:00", end: "bad" }, 0), undefined);
});

test("real stdio process: handshake + tool call over newline-delimited JSON-RPC", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sot-proc-"));
  const child = spawn(process.execPath, ["src/mcp/server.ts"], { env: { ...process.env, SOTITOUT_DATA: dir }, stdio: ["pipe", "pipe", "pipe"] });
  try {
    const lines: string[] = [];
    let buf = "";
    child.stdout.on("data", (d: Buffer) => { buf += d; const p = buf.split("\n"); buf = p.pop()!; lines.push(...p); });
    const send = (o: object) => child.stdin.write(`${JSON.stringify(o)}\n`);
    const wait = async (n: number) => { for (let i = 0; i < 100 && lines.length < n; i++) await new Promise((r) => setTimeout(r, 50)); };
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "add_project", arguments: { name: "Proc" } } });
    child.stdin.write("{not json\n");
    await wait(3);
    assert.equal(lines.length, 3);
    assert.equal(JSON.parse(lines[0]).result.serverInfo.name, "sotitout");
    assert.match(JSON.parse(lines[1]).result.content[0].text, /Created project "Proc"/);
    assert.equal(JSON.parse(lines[2]).error.code, -32700);
  } finally { child.kill(); rmSync(dir, { recursive: true }); }
});
