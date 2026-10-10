import assert from "node:assert/strict";
import { test } from "node:test";
import { narrate } from "../src/core/llm.ts";
import { parseAppleMail } from "../src/providers/apple-mail.ts";
import { GmailProvider, parseGmailMessage, parseGoogleEvent } from "../src/providers/gmail.ts";
import { parseOutlookEvents, parseOutlookMail } from "../src/providers/outlook.ts";
import { refreshTokens } from "../src/providers/oauth.ts";

const b64 = (s: string) => Buffer.from(s).toString("base64url");

test("parseGmailMessage reads headers, labels and nested text/plain", () => {
  const m = parseGmailMessage({
    id: "m1", threadId: "t1", labelIds: ["INBOX", "UNREAD"], internalDate: "1760000000000",
    payload: {
      mimeType: "multipart/alternative",
      headers: [{ name: "From", value: "A <a@x.com>" }, { name: "To", value: "b@x.com, c@x.com" }, { name: "Subject", value: "Hi" }],
      parts: [{ mimeType: "text/html", body: { data: b64("<b>html</b>") } }, { mimeType: "text/plain", body: { data: b64("plain body") } }],
    },
  });
  assert.equal(m.body, "plain body");
  assert.deepEqual(m.to, ["b@x.com", "c@x.com"]);
  assert.equal(m.isUnread, true);
  assert.equal(m.isSent, false);
});

test("parseGmailMessage falls back to stripped html", () => {
  const m = parseGmailMessage({
    id: "m2", threadId: "t", labelIds: ["SENT"],
    payload: { mimeType: "text/html", headers: [], body: { data: b64("<style>x{}</style><p>Hello <b>you</b></p>") } },
  });
  assert.equal(m.body.trim(), "Hello you");
  assert.equal(m.isSent, true);
});

test("parseGoogleEvent distinguishes all-day and cancelled events", () => {
  assert.equal(parseGoogleEvent({ id: "1", status: "cancelled", start: {}, end: {} }), undefined);
  assert.equal(parseGoogleEvent({ id: "2", summary: "Off", start: { date: "2026-10-12" }, end: { date: "2026-10-13" } })!.allDay, true);
  assert.equal(parseGoogleEvent({ id: "3", start: { dateTime: "2026-10-12T09:00:00Z" }, end: { dateTime: "2026-10-12T10:00:00Z" } })!.title, "(no title)");
});

test("GmailProvider sends bearer token and fetches each listed message", async () => {
  const seen: string[] = [];
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    seen.push(`${url}|${(init?.headers as Record<string, string>).authorization}`);
    const body = String(url).includes("?maxResults") ? { messages: [{ id: "a" }] } : { id: "a", threadId: "t", payload: { headers: [] } };
    return new Response(JSON.stringify(body));
  }) as unknown as typeof fetch;
  const out = await new GmailProvider(async () => "TOK", fakeFetch).fetchEmails(new Date(Date.now() - 86_400_000));
  assert.equal(out.length, 1);
  assert.ok(seen.every((s) => s.endsWith("|Bearer TOK")));
  assert.equal(seen.length, 2);
});

test("Apple Mail and Outlook output parsers filter by date", () => {
  const since = new Date("2026-10-10T00:00:00Z");
  const apple = parseAppleMail(JSON.stringify([
    { id: "1", subject: "Re: Plan", from: "a", receivedAt: "2026-10-11T00:00:00Z", isUnread: true, body: "x" },
    { id: "2", subject: "Old", from: "a", receivedAt: "2026-09-01T00:00:00Z", isUnread: false, body: "x" },
  ]), since);
  assert.equal(apple.length, 1);
  assert.equal(apple[0].threadId, "plan");
  const ol = parseOutlookMail(JSON.stringify([{ id: "1", subject: "s", from: "f", receivedAt: "2026-10-11T00:00:00Z", isUnread: true, threadId: "T", body: "b" }]), since);
  assert.equal(ol[0].threadId, "T");
  assert.equal(parseOutlookEvents("").length, 0); // PowerShell prints nothing when there are no items
  assert.equal(parseOutlookEvents(JSON.stringify([{ id: "e", title: "t", location: "", allDay: false, start: "s", end: "e" }]))[0].location, undefined);
});

test("refreshTokens reuses a valid token and refreshes an expired one", async () => {
  const fresh = { access_token: "A", expires_at: Date.now() + 3_600_000 };
  assert.equal(await refreshTokens("cid", fresh), fresh);
  const fakeFetch = (async () => new Response(JSON.stringify({ access_token: "B", expires_in: 3600 }))) as unknown as typeof fetch;
  const r = await refreshTokens("cid", { access_token: "A", refresh_token: "R", expires_at: 0 }, fakeFetch);
  assert.equal(r.access_token, "B");
  assert.equal(r.refresh_token, "R");
  await assert.rejects(refreshTokens("cid", { access_token: "A", expires_at: 0 }, fakeFetch), /sign in again/);
});

test("narrate posts the briefing and returns text; surfaces API errors", async () => {
  let sent: { headers: Record<string, string>; body: string } | undefined;
  const ok = (async (_u: string, init: RequestInit) => {
    sent = { headers: init.headers as Record<string, string>, body: String(init.body) };
    return new Response(JSON.stringify({ content: [{ type: "text", text: " Busy day. " }] }));
  }) as unknown as typeof fetch;
  assert.equal(await narrate("brief", { apiKey: "k", fetchImpl: ok }), "Busy day.");
  assert.equal(sent!.headers["x-api-key"], "k");
  assert.equal(JSON.parse(sent!.body).messages[0].content, "brief");
  const bad = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
  await assert.rejects(narrate("b", { apiKey: "k", fetchImpl: bad }), /401/);
});
