import type { CalendarEvent, EmailMessage, Task } from "../core/types.ts";

/** A task owned by another system (Jira issue, Microsoft To Do item). */
export interface ExternalTask {
  id: string; // globally unique, e.g. "jira:ABC-12"
  title: string;
  due?: string; // YYYY-MM-DD
  highPriority?: boolean;
  source: Task["source"];
  /** Extra text used to match a project (e.g. Jira project key + name). */
  projectHint?: string;
}

/**
 * A source of messages, calendar events and/or tasks. Everything is optional:
 * chat apps only give messages, Jira only gives tasks.
 */
export interface Provider {
  id: string;
  label: string;
  fetchEmails?(since: Date): Promise<EmailMessage[]>;
  fetchEvents?(from: Date, to: Date): Promise<CalendarEvent[]>;
  /** Must return the COMPLETE set of currently-open tasks; absent ones are treated as finished. */
  fetchTasks?(): Promise<ExternalTask[]>;
  /** Which Task.source this provider owns (required when fetchTasks is implemented). */
  taskSource?: Task["source"];
}
