import assert from "node:assert/strict";
import { test } from "node:test";
import {
  awaitingReply, buildDayBrief, buildEndOfDay, freeBlocks, planDay, projectStatuses, rankTasks, rollover,
} from "../src/core/briefing.ts";
import { emptyState, Store } from "../src/core/store.ts";
import type { CalendarEvent, EmailMessage, State, Task } from "../src/core/types.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const now = new Date(2026, 9, 12, 8, 0); // Monday 08:00
const at = (h: number, m = 0, d = 0) => new Date(2026, 9, 12 + d, h, m).toISOString();
const ev = (title: string, s: string, e: string): CalendarEvent => ({ id: title, title, start: s, end: e, allDay: false });
const task = (o: Partial<Task> & { id: string }): Task => ({
  title: o.id, status: "open", source: "manual", createdAt: at(7), carriedCount: 0, ...o,
});
const stateWith = (tasks: Task[], extra: Partial<State> = {}): State => ({ ...emptyState(), tasks, ...extra });

test("freeBlocks subtracts meetings, clips to now and drops tiny gaps", () => {
  const s = emptyState();
  const events = [ev("a", at(9, 30), at(10, 0)), ev("b", at(10, 10), at(11, 0))]; // 10-min gap is too small
  const blocks = freeBlocks(events, now, s, new Date(2026, 9, 12, 9, 15));
  assert.deepEqual(
    blocks.map((b) => [b.start.getHours() * 60 + b.start.getMinutes(), b.end.getHours() * 60 + b.end.getMinutes()]),
    [[9 * 60 + 15, 9 * 60 + 30], [11 * 60, 17 * 60 + 30]].filter(([a, b]) => b - a >= 25),
  );
});

test("overdue outranks due-today outranks undated; blocked projects are demoted", () => {
  const s = stateWith(
    [
      task({ id: "none" }),
      task({ id: "today", due: "2026-10-12" }),
      task({ id: "late", due: "2026-10-09" }),
      task({ id: "blk", due: "2026-10-12", projectId: "p" }),
    ],
    { projects: [{ id: "p", name: "P", keywords: [], status: "blocked" }] },
  );
  assert.deepEqual(rankTasks(s, now).map((r) => r.task.id), ["late", "today", "blk", "none"]);
});

test("planDay fills blocks in rank order and reports overflow", () => {
  const s = stateWith([task({ id: "a", due: "2026-10-12" }), task({ id: "b", estimateMin: 120 }), task({ id: "c" })]);
  const blocks = [{ start: new Date(2026, 9, 12, 9), end: new Date(2026, 9, 12, 10) }];
  const { plan, overflow } = planDay(rankTasks(s, now), blocks, 45);
  assert.deepEqual(plan.map((p) => p.task.id), ["a"]);
  assert.deepEqual(overflow.map((o) => o.task.id).sort(), ["b", "c"]);
});

test("project health: at-risk on overdue, blocked, done, on-track", () => {
  const s = stateWith(
    [
      task({ id: "t1", projectId: "a", due: "2026-10-01" }),
      task({ id: "t2", projectId: "c", status: "done", completedAt: at(7) }),
      task({ id: "t3", projectId: "d", due: "2026-12-01" }),
    ],
    {
      projects: [
        { id: "a", name: "A", keywords: [], status: "active" },
        { id: "b", name: "B", keywords: [], status: "blocked" },
        { id: "c", name: "C", keywords: [], status: "active" },
        { id: "d", name: "D", keywords: [], status: "active", deadline: "2026-12-01" },
      ],
    },
  );
  const h = Object.fromEntries(projectStatuses(s, [], now).map((p) => [p.project.id, p.health]));
  assert.deepEqual(h, { a: "at-risk", b: "blocked", c: "done", d: "on-track" });
});

test("project with a deadline in 2 days and open work is at-risk", () => {
  const s = stateWith([task({ id: "x", projectId: "p" })], {
    projects: [{ id: "p", name: "P", keywords: [], status: "active", deadline: "2026-10-14" }],
  });
  assert.equal(projectStatuses(s, [], now)[0].health, "at-risk");
});

test("awaitingReply finds old sent mail with no later inbound reply", () => {
  const m = (o: Partial<EmailMessage>): EmailMessage => ({
    id: "x", provider: "t", threadId: "t1", from: "", to: ["z"], subject: "s", body: "",
    receivedAt: at(8, 0, -2), isUnread: false, isSent: true, ...o,
  });
  assert.equal(awaitingReply([m({})], now).length, 1);
  assert.equal(awaitingReply([m({}), m({ id: "r", isSent: false, receivedAt: at(8, 0, -1) })], now).length, 0);
  assert.equal(awaitingReply([m({ receivedAt: at(7) })], now).length, 0); // under 24h old
});

test("rollover is idempotent per day and end-of-day reports done vs carried", () => {
  const s = stateWith([
    task({ id: "done", status: "done", completedAt: at(7) }),
    task({ id: "open" }),
  ]);
  assert.equal(rollover(s, now), 1);
  assert.equal(rollover(s, now), 0);
  assert.equal(s.tasks[1].carriedCount, 1);
  const eod = buildEndOfDay(s, [], [], now);
  assert.deepEqual(eod.doneToday.map((t) => t.id), ["done"]);
  assert.deepEqual(eod.carryOver.map((c) => c.task.id), ["open"]);
});

test("day brief warns about overdue work and heavy meeting days", () => {
  const s = stateWith([task({ id: "late", due: "2026-10-01" })]);
  const events = [ev("long", at(9), at(15))];
  const b = buildDayBrief(s, events, [], now);
  assert.ok(b.warnings.some((w) => w.includes("overdue")));
  assert.ok(b.warnings.some((w) => w.includes("Meeting-heavy")));
  assert.equal(b.meetingMinutes, 360);
});

test("store persists, never re-adds dismissed email tasks", () => {
  const dir = mkdtempSync(join(tmpdir(), "sot-"));
  try {
    const path = join(dir, "s.json");
    const store = new Store(path);
    const mail: EmailMessage = {
      id: "9", provider: "t", threadId: "9", from: "A <a@x.com>", to: [], subject: "Plan",
      body: "Please send the plan by Friday.", receivedAt: at(7), isUnread: true, isSent: false,
    };
    assert.equal(store.ingestEmails([mail], now), 1);
    store.setTaskStatus(store.state.tasks[0].id, "dismissed", now);
    store.save();
    const again = new Store(path);
    assert.equal(again.ingestEmails([mail], now), 0);
    assert.equal(again.state.tasks.length, 1);
  } finally {
    rmSync(dir, { recursive: true });
  }
});
