import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanBody, extractTask, matchProject, parseDue } from "../src/core/extract.ts";
import type { EmailMessage, Project } from "../src/core/types.ts";

// Saturday 2026-10-10, local time
const now = new Date(2026, 9, 10, 12, 0);

test("parseDue handles common phrasings", () => {
  assert.equal(parseDue("send it by Friday", now), "2026-10-16");
  assert.equal(parseDue("due 10/15", now), "2026-10-15");
  assert.equal(parseDue("due October 20th", now), "2026-10-20");
  assert.equal(parseDue("deadline 2026-11-01", now), "2026-11-01");
  assert.equal(parseDue("need it EOD", now), "2026-10-10");
  assert.equal(parseDue("by tomorrow", now), "2026-10-11");
  assert.equal(parseDue("review it before tomorrow", now), "2026-10-10");
  assert.equal(parseDue("next monday", now), "2026-10-12");
  assert.equal(parseDue("nothing here", now), undefined);
});

test("parseDue rolls past month/day into next year and rejects invalid dates", () => {
  assert.equal(parseDue("due Jan 5", now), "2027-01-05");
  assert.equal(parseDue("due 2/30", now), undefined);
  assert.equal(parseDue("market 5 units", now), undefined);
});

test("cleanBody strips quotes and signatures", () => {
  assert.equal(cleanBody("Do it.\n> old text\n-- \nBob"), "Do it.");
});

const mail = (o: Partial<EmailMessage>): EmailMessage => ({
  id: "1", provider: "t", threadId: "1", from: "Ann <ann@x.com>", to: [], subject: "Budget",
  body: "", receivedAt: now.toISOString(), isUnread: true, isSent: false, ...o,
});

test("extractTask prefers the dated sentence and flags urgency", () => {
  const t = extractTask(
    mail({ subject: "URGENT: Report", body: "Hello there. Please review the draft. Please submit the report by Friday." }),
    now,
  )!;
  assert.equal(t.due, "2026-10-16");
  assert.match(t.title, /submit the report/);
  assert.equal(t.highPriority, true);
  assert.equal(t.id, "email:t:1");
});

test("extractTask ignores sent, automated and request-free mail", () => {
  assert.equal(extractTask(mail({ isSent: true, body: "Please do X by Friday." }), now), undefined);
  assert.equal(extractTask(mail({ from: "noreply@x.com", body: "Please do X by Friday." }), now), undefined);
  assert.equal(extractTask(mail({ body: "Please do X. Unsubscribe" }), now), undefined);
  assert.equal(extractTask(mail({ body: "Thanks, see you at lunch." }), now), undefined);
});

test("matchProject weights subject over body and skips finished projects", () => {
  const ps: Project[] = [
    { id: "a", name: "Atlas", keywords: [], status: "active" },
    { id: "b", name: "Budget", keywords: ["q4"], status: "active" },
    { id: "c", name: "Old", keywords: ["legacy"], status: "done" },
  ];
  assert.equal(matchProject("Q4 budget", "mentions atlas once", ps), "b");
  assert.equal(matchProject("legacy stuff", "", ps), undefined);
});
