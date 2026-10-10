export interface EmailMessage {
  id: string;
  provider: string;
  threadId: string;
  from: string; // "Name <addr>" or bare address
  to: string[];
  subject: string;
  body: string; // plain text, may be truncated
  receivedAt: string; // ISO
  isUnread: boolean;
  isSent: boolean;
}

export interface CalendarEvent {
  id: string;
  title: string;
  start: string; // ISO (or YYYY-MM-DD when allDay)
  end: string;
  allDay: boolean;
  location?: string;
}

export type ProjectStatus = "active" | "blocked" | "done";

export interface Project {
  id: string;
  name: string;
  keywords: string[]; // used to match emails/tasks to this project
  deadline?: string; // YYYY-MM-DD
  status: ProjectStatus;
  notes?: string;
}

export type TaskStatus = "open" | "done" | "dismissed";

export interface Task {
  id: string;
  title: string;
  projectId?: string;
  due?: string; // YYYY-MM-DD
  status: TaskStatus;
  source: "email" | "manual" | "jira" | "todo";
  sourceFrom?: string;
  sourceSubject?: string;
  highPriority?: boolean;
  estimateMin?: number;
  createdAt: string; // ISO
  completedAt?: string; // ISO
  carriedCount: number;
  lastCarriedOn?: string; // YYYY-MM-DD, makes rollover idempotent per day
}

export interface Settings {
  workStart: string; // "HH:MM"
  workEnd: string;
  defaultTaskMinutes: number;
  minBlockMinutes: number;
  vipSenders: string[]; // substrings matched against From
}

export interface State {
  version: 1;
  settings: Settings;
  projects: Project[];
  tasks: Task[];
}

export const DEFAULT_SETTINGS: Settings = {
  workStart: "09:00",
  workEnd: "17:30",
  defaultTaskMinutes: 45,
  minBlockMinutes: 25,
  vipSenders: [],
};
