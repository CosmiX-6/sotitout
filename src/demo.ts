import { addDays } from "./core/dates.ts";
import type { CalendarEvent, EmailMessage } from "./core/types.ts";
import { Store } from "./core/store.ts";

const at = (now: Date, h: number, m = 0, dayOffset = 0) => {
  const d = addDays(now, dayOffset);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
};

/** Fixture data so the product can be tried without connecting any account. */
export function demoData(now: Date) {
  const mail = (o: Partial<EmailMessage> & Pick<EmailMessage, "id" | "from" | "subject" | "body">): EmailMessage => ({
    provider: "demo", threadId: o.id, to: ["me@example.com"], receivedAt: at(now, 7, 30), isUnread: true, isSent: false, ...o,
  });
  const emails: EmailMessage[] = [
    mail({ id: "1", from: "Priya Shah <priya@acme.com>", subject: "Atlas launch: pricing page copy",
      body: "Hi, can you send the final pricing page copy by Friday? Legal needs a day to review.\n\n-- \nPriya" }),
    mail({ id: "2", from: "Marcus <marcus@acme.com>", subject: "URGENT: Atlas staging is down",
      body: "Staging is failing health checks. Please look at it before the 2pm demo. Thanks!" }),
    mail({ id: "3", from: "Finance <finance@acme.com>", subject: "Q4 budget",
      body: "Reminder: Q4 budget submissions are due 10/15. Please confirm your numbers." }),
    mail({ id: "4", from: "Newsletter <news@vendor.com>", subject: "Ten tips", body: "Great tips inside. Unsubscribe here." }),
    mail({ id: "5", from: "me@example.com", subject: "Vendor contract questions", isUnread: false, isSent: true,
      threadId: "t-vendor", to: ["sam@vendor.com"], receivedAt: at(now, 10, 0, -3), body: "Can you confirm the renewal terms?" }),
    mail({ id: "wa1", provider: "whatsapp", threadId: "wa:Ops Team", from: "Ravi", subject: "Ops Team",
      body: "Can you share the vendor invoice by EOD? Finance is chasing.", receivedAt: at(now, 8, 5) }),
    mail({ id: "sl1", provider: "slack", threadId: "C5", from: "Dana", subject: "#atlas (mention)",
      body: "@me please review the launch checklist before tomorrow", receivedAt: at(now, 8, 20) }),
  ];
  const events: CalendarEvent[] = [
    { id: "e1", title: "Standup", start: at(now, 9, 30), end: at(now, 9, 45), allDay: false },
    { id: "e2", title: "Atlas demo prep", start: at(now, 13, 0), end: at(now, 14, 0), allDay: false, location: "Zoom" },
    { id: "e3", title: "1:1 with Priya", start: at(now, 15, 30), end: at(now, 16, 0), allDay: false },
    { id: "e4", title: "Team offsite (Thu)", start: at(now, 0), end: at(now, 0, 0, 1), allDay: true },
  ];
  const tomorrow: CalendarEvent[] = [
    { id: "e5", title: "Sprint planning", start: at(now, 10, 0, 1), end: at(now, 11, 0, 1), allDay: false },
  ];
  return { emails, events, tomorrow };
}

export function seedDemoStore(store: Store, now: Date, emails: EmailMessage[]) {
  store.addProject({ name: "Atlas launch", keywords: ["atlas", "pricing page"], deadline: addDaysYmd(now, 3), notes: "Public launch" });
  store.addProject({ name: "Q4 planning", keywords: ["budget", "q4"], deadline: addDaysYmd(now, 12) });
  store.ingestEmails(emails, now);
  store.syncExternal("jira", [
    { id: "jira:ATL-41", title: "ATL-41 Fix checkout timeout", due: addDaysYmd(now, 1), highPriority: true, source: "jira", projectHint: "ATL Atlas" },
    { id: "jira:OPS-7", title: "OPS-7 Rotate API keys", source: "jira", projectHint: "OPS" },
  ], now);
  store.addTask({ title: "Write launch announcement draft", projectId: store.state.projects[0].id, due: addDaysYmd(now, 2), estimateMin: 60 }, now);
}

function addDaysYmd(now: Date, n: number): string {
  const d = addDays(now, n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
