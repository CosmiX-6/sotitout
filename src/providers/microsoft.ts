import type { CalendarEvent, EmailMessage } from "../core/types.ts";
import type { ExternalTask, Provider } from "./types.ts";

/**
 * Microsoft 365 / Outlook.com / new Outlook via Microsoft Graph (read-only).
 * Register a public client in Entra ID (Azure) → "Mobile and desktop" platform with redirect
 * http://localhost, and grant delegated permissions below.
 */
export const MICROSOFT_SCOPES = ["offline_access", "User.Read", "Mail.Read", "Calendars.Read", "Tasks.Read"];

const GRAPH = "https://graph.microsoft.com/v1.0";

interface GMail {
  id: string;
  conversationId?: string;
  subject?: string;
  from?: { emailAddress?: { name?: string; address?: string } };
  toRecipients?: { emailAddress?: { address?: string } }[];
  receivedDateTime: string;
  isRead?: boolean;
  body?: { content?: string };
}

export function parseGraphMail(m: GMail, sent: boolean): EmailMessage {
  const f = m.from?.emailAddress;
  return {
    id: m.id,
    provider: "microsoft",
    threadId: m.conversationId ?? m.id,
    from: f?.name ? `${f.name} <${f.address ?? ""}>` : (f?.address ?? ""),
    to: (m.toRecipients ?? []).map((r) => r.emailAddress?.address ?? "").filter(Boolean),
    subject: m.subject ?? "",
    body: (m.body?.content ?? "").slice(0, 4000),
    receivedAt: new Date(m.receivedDateTime).toISOString(),
    isUnread: sent ? false : m.isRead === false,
    isSent: sent,
  };
}

interface GEvent {
  id: string;
  subject?: string;
  isAllDay?: boolean;
  isCancelled?: boolean;
  location?: { displayName?: string };
  start: { dateTime: string };
  end: { dateTime: string };
}

/** With `Prefer: outlook.timezone="UTC"` Graph returns UTC wall time without a "Z". */
export function parseGraphEvent(e: GEvent): CalendarEvent | undefined {
  if (e.isCancelled) return undefined;
  const utc = (s: string) => new Date(`${s.split(".")[0]}Z`).toISOString();
  return {
    id: e.id,
    title: e.subject || "(no title)",
    allDay: !!e.isAllDay,
    start: e.isAllDay ? e.start.dateTime.slice(0, 10) : utc(e.start.dateTime),
    end: e.isAllDay ? e.end.dateTime.slice(0, 10) : utc(e.end.dateTime),
    location: e.location?.displayName || undefined,
  };
}

interface GTodo {
  id: string;
  title: string;
  importance?: string;
  dueDateTime?: { dateTime: string };
}

export function parseTodo(t: GTodo): ExternalTask {
  return {
    id: `todo:${t.id}`,
    title: t.title,
    due: t.dueDateTime?.dateTime.slice(0, 10),
    highPriority: t.importance === "high",
    source: "todo",
  };
}

export class MicrosoftProvider implements Provider {
  id = "microsoft";
  label = "Microsoft 365 / Outlook";
  taskSource = "todo" as const;
  private getToken: () => Promise<string>;
  private fetchImpl: typeof fetch;
  constructor(getToken: () => Promise<string>, fetchImpl: typeof fetch = fetch) {
    this.getToken = getToken;
    this.fetchImpl = fetchImpl;
  }

  private async api<T>(path: string, prefer?: string): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${await this.getToken()}` };
    if (prefer) headers.prefer = prefer;
    const res = await this.fetchImpl(path.startsWith("http") ? path : `${GRAPH}${path}`, { headers });
    if (!res.ok) throw new Error(`Microsoft Graph ${res.status} for ${path.split("?")[0]}`);
    return (await res.json()) as T;
  }

  async fetchEmails(since: Date): Promise<EmailMessage[]> {
    const q = (folder: string) =>
      `/me/mailFolders/${folder}/messages?$top=50&$orderby=receivedDateTime desc` +
      `&$filter=${encodeURIComponent(`receivedDateTime ge ${since.toISOString()}`)}` +
      `&$select=id,conversationId,subject,from,toRecipients,receivedDateTime,isRead,body`;
    const text = 'outlook.body-content-type="text"';
    const [inbox, sent] = await Promise.all([
      this.api<{ value: GMail[] }>(q("inbox"), text),
      this.api<{ value: GMail[] }>(q("sentitems"), text),
    ]);
    return [...inbox.value.map((m) => parseGraphMail(m, false)), ...sent.value.map((m) => parseGraphMail(m, true))];
  }

  async fetchEvents(from: Date, to: Date): Promise<CalendarEvent[]> {
    const q = new URLSearchParams({
      startDateTime: from.toISOString(), endDateTime: to.toISOString(), $top: "50", $orderby: "start/dateTime",
      $select: "id,subject,start,end,isAllDay,isCancelled,location",
    });
    const data = await this.api<{ value: GEvent[] }>(`/me/calendarView?${q}`, 'outlook.timezone="UTC"');
    return data.value.map(parseGraphEvent).filter((e): e is CalendarEvent => !!e);
  }

  async fetchTasks(): Promise<ExternalTask[]> {
    const lists = await this.api<{ value: { id: string }[] }>("/me/todo/lists");
    const out: ExternalTask[] = [];
    for (const l of lists.value) {
      const f = encodeURIComponent("status ne 'completed'");
      const t = await this.api<{ value: GTodo[] }>(`/me/todo/lists/${l.id}/tasks?$top=100&$filter=${f}`);
      out.push(...t.value.map(parseTodo));
    }
    return out;
  }
}
