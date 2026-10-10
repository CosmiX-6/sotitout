import type { CalendarEvent, EmailMessage } from "../core/types.ts";
import type { Provider } from "./types.ts";

/**
 * Gmail + Google Calendar over the REST APIs (read-only scopes).
 * This is also how "Gmail in Chrome" is covered: the browser session is not scraped;
 * the same Google account is read through its official API.
 */
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
];

interface GPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GPart[];
}
interface GMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  internalDate?: string;
  payload?: GPart & { headers?: { name: string; value: string }[] };
}

const b64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

function findMime(part: GPart | undefined, mime: string): string {
  if (!part) return "";
  if (part.mimeType === mime && part.body?.data) return b64url(part.body.data);
  for (const p of part.parts ?? []) {
    const t = findMime(p, mime);
    if (t) return t;
  }
  return "";
}

/** Prefer text/plain anywhere in the tree; only fall back to stripped HTML if there is none. */
function findText(part: GPart | undefined): string {
  const plain = findMime(part, "text/plain");
  if (plain) return plain;
  return findMime(part, "text/html").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

export function parseGmailMessage(m: GMessage): EmailMessage {
  const h = (n: string) => m.payload?.headers?.find((x) => x.name.toLowerCase() === n)?.value ?? "";
  const labels = m.labelIds ?? [];
  return {
    id: m.id,
    provider: "gmail",
    threadId: m.threadId,
    from: h("from"),
    to: h("to").split(",").map((s) => s.trim()).filter(Boolean),
    subject: h("subject"),
    body: findText(m.payload).slice(0, 4000),
    receivedAt: new Date(Number(m.internalDate ?? Date.now())).toISOString(),
    isUnread: labels.includes("UNREAD"),
    isSent: labels.includes("SENT"),
  };
}

interface GEvent {
  id: string;
  summary?: string;
  location?: string;
  status?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
}

export function parseGoogleEvent(e: GEvent): CalendarEvent | undefined {
  if (e.status === "cancelled" || !e.start || !e.end) return undefined;
  const allDay = !e.start.dateTime;
  return {
    id: e.id,
    title: e.summary ?? "(no title)",
    start: (e.start.dateTime ?? e.start.date)!,
    end: (e.end.dateTime ?? e.end.date)!,
    allDay,
    location: e.location,
  };
}

export class GmailProvider implements Provider {
  id = "gmail";
  label = "Gmail / Google Calendar";
  private getToken: () => Promise<string>;
  private fetchImpl: typeof fetch;
  constructor(getToken: () => Promise<string>, fetchImpl: typeof fetch = fetch) {
    this.getToken = getToken;
    this.fetchImpl = fetchImpl;
  }

  private async api<T>(url: string): Promise<T> {
    const res = await this.fetchImpl(url, { headers: { authorization: `Bearer ${await this.getToken()}` } });
    if (!res.ok) throw new Error(`Google API ${res.status} for ${new URL(url).pathname}`);
    return (await res.json()) as T;
  }

  async fetchEmails(since: Date): Promise<EmailMessage[]> {
    const days = Math.max(1, Math.ceil((Date.now() - since.getTime()) / 86_400_000));
    const base = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
    const list = await this.api<{ messages?: { id: string }[] }>(
      `${base}?maxResults=60&q=${encodeURIComponent(`newer_than:${days}d -in:spam -in:trash -category:promotions`)}`,
    );
    const full = await Promise.all((list.messages ?? []).map((m) => this.api<GMessage>(`${base}/${m.id}?format=full`)));
    return full.map(parseGmailMessage);
  }

  async fetchEvents(from: Date, to: Date): Promise<CalendarEvent[]> {
    const q = new URLSearchParams({
      timeMin: from.toISOString(),
      timeMax: to.toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "50",
    });
    const data = await this.api<{ items?: GEvent[] }>(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?${q}`,
    );
    return (data.items ?? []).map(parseGoogleEvent).filter((e): e is CalendarEvent => !!e);
  }
}
