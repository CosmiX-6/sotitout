import type { CalendarEvent, EmailMessage } from "../core/types.ts";

/** A source of mail and (optionally) calendar data. */
export interface Provider {
  id: string;
  label: string;
  fetchEmails(since: Date): Promise<EmailMessage[]>;
  fetchEvents?(from: Date, to: Date): Promise<CalendarEvent[]>;
}
