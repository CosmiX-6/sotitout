import type { ExternalTask, Provider } from "./types.ts";

/**
 * Jira Cloud: every unresolved issue assigned to you becomes a task (due date, priority and
 * project come from Jira). Auth is your Atlassian email + an API token
 * (https://id.atlassian.com/manage-profile/security/api-tokens).
 */
export interface JiraConfig {
  site: string; // e.g. https://acme.atlassian.net
  email: string;
  token: string;
}

interface Issue {
  key: string;
  fields: {
    summary?: string;
    duedate?: string | null;
    priority?: { name?: string } | null;
    project?: { key?: string; name?: string };
  };
}

const HIGH = new Set(["highest", "high", "blocker", "critical", "major"]);

export function parseIssue(i: Issue): ExternalTask {
  return {
    id: `jira:${i.key}`,
    title: `${i.key} ${i.fields.summary ?? ""}`.trim(),
    due: i.fields.duedate ?? undefined,
    highPriority: HIGH.has((i.fields.priority?.name ?? "").toLowerCase()),
    source: "jira",
    projectHint: `${i.fields.project?.key ?? ""} ${i.fields.project?.name ?? ""}`.trim(),
  };
}

export const normalizeSite = (s: string): string => {
  const u = new URL(/^https?:\/\//.test(s) ? s : `https://${s}`);
  if (u.protocol !== "https:") throw new Error("Jira site must use https");
  return u.origin;
};

export class JiraProvider implements Provider {
  id = "jira";
  label = "Jira";
  taskSource = "jira" as const;
  private cfg: JiraConfig;
  private fetchImpl: typeof fetch;
  constructor(cfg: JiraConfig, fetchImpl: typeof fetch = fetch) {
    this.cfg = { ...cfg, site: normalizeSite(cfg.site) };
    this.fetchImpl = fetchImpl;
  }

  async fetchTasks(): Promise<ExternalTask[]> {
    const auth = Buffer.from(`${this.cfg.email}:${this.cfg.token}`).toString("base64");
    const out: ExternalTask[] = [];
    let nextPageToken: string | undefined;
    for (let page = 0; page < 5; page++) {
      const res = await this.fetchImpl(`${this.cfg.site}/rest/api/3/search/jql`, {
        method: "POST",
        headers: { authorization: `Basic ${auth}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          jql: "assignee = currentUser() AND statusCategory != Done ORDER BY duedate ASC, priority DESC",
          fields: ["summary", "duedate", "priority", "project"],
          maxResults: 100,
          nextPageToken,
        }),
      });
      if (res.status === 401 || res.status === 403) throw new Error(`Jira rejected the credentials (${res.status})`);
      if (!res.ok) throw new Error(`Jira ${res.status}`);
      const data = (await res.json()) as { issues: Issue[]; nextPageToken?: string; isLast?: boolean };
      out.push(...data.issues.map(parseIssue));
      if (data.isLast !== false || !data.nextPageToken) return out;
      nextPageToken = data.nextPageToken;
    }
    // More than 500 open issues: a partial list would wrongly mark the rest done, so refuse.
    throw new Error("Jira returned more than 500 open issues; narrow the query");
  }
}
