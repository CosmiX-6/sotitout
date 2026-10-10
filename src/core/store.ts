import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { extractTask, matchProject } from "./extract.ts";
import type { ExternalTask } from "../providers/types.ts";
import { DEFAULT_SETTINGS, type EmailMessage, type Project, type State, type Task } from "./types.ts";

export const emptyState = (): State => ({ version: 1, settings: { ...DEFAULT_SETTINGS }, projects: [], tasks: [] });

export class Store {
  state: State;
  readonly path: string;
  constructor(path: string) {
    this.path = path;
    this.state = emptyState();
    this.reload();
  }

  /** Re-read the file so several processes (e.g. two Claude sessions) don't clobber each other. */
  reload(): void {
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as Partial<State>;
      this.state = {
        ...emptyState(),
        ...raw,
        settings: { ...DEFAULT_SETTINGS, ...raw.settings },
      } as State;
    } catch {
      /* first run or unreadable file: start empty */
    }
  }

  save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, this.path); // atomic replace so a crash never leaves a half-written file
  }

  /** Turn new emails into tasks. Existing ids (done or dismissed too) are never re-added. */
  ingestEmails(emails: EmailMessage[], now: Date): number {
    const known = new Set(this.state.tasks.map((t) => t.id));
    let added = 0;
    for (const e of emails) {
      const t = extractTask(e, now);
      if (!t || known.has(t.id)) continue;
      const projectId = matchProject(e.subject, e.body, this.state.projects);
      this.state.tasks.push({ ...t, projectId });
      known.add(t.id);
      added++;
    }
    return added;
  }

  /**
   * Reconcile tasks owned by an external system. `items` is the complete open set for `source`:
   * new ones are added, known ones refreshed, and previously-open ones that vanished are marked done.
   * Tasks the user dismissed stay dismissed.
   */
  syncExternal(source: Task["source"], items: ExternalTask[], now: Date): { added: number; completed: number } {
    let added = 0;
    let completed = 0;
    const seen = new Set<string>();
    for (const it of items) {
      seen.add(it.id);
      const existing = this.state.tasks.find((t) => t.id === it.id);
      if (!existing) {
        this.state.tasks.push({
          id: it.id, title: it.title, due: it.due, highPriority: it.highPriority || undefined,
          status: "open", source: it.source, createdAt: now.toISOString(), carriedCount: 0,
          projectId: matchProject(it.title, it.projectHint ?? "", this.state.projects),
        });
        added++;
        continue;
      }
      existing.title = it.title;
      existing.due = it.due;
      existing.highPriority = it.highPriority || undefined;
      if (existing.status === "done") {
        existing.status = "open"; // reopened upstream
        existing.completedAt = undefined;
      }
    }
    for (const t of this.state.tasks) {
      if (t.source === source && t.status === "open" && !seen.has(t.id)) {
        t.status = "done";
        t.completedAt = now.toISOString();
        completed++;
      }
    }
    return { added, completed };
  }

  addProject(p: Omit<Project, "id" | "status"> & { status?: Project["status"] }): Project {
    const project: Project = { id: `p_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, status: "active", ...p };
    this.state.projects.push(project);
    return project;
  }

  addTask(t: Pick<Task, "title"> & Partial<Task>, now: Date): Task {
    const task: Task = {
      id: `m_${now.getTime().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
      status: "open",
      source: "manual",
      createdAt: now.toISOString(),
      carriedCount: 0,
      ...t,
    };
    this.state.tasks.push(task);
    return task;
  }

  setTaskStatus(id: string, status: Task["status"], now: Date): void {
    const t = this.state.tasks.find((x) => x.id === id);
    if (!t) return;
    t.status = status;
    t.completedAt = status === "done" ? now.toISOString() : undefined;
  }
}
