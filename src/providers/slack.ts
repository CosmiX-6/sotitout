import type { EmailMessage } from "../core/types.ts";
import type { Provider } from "./types.ts";

/**
 * Slack via a user token (xoxp-…) from your own Slack app.
 * Scopes: search:read, im:read, im:history, mpim:read, mpim:history, users:read.
 * Pulls direct messages, group DMs and @mentions; maps them onto the same message shape as email.
 */
interface SlackMsg {
  ts: string;
  user?: string;
  text?: string;
}

export const cleanSlackText = (t: string, names: Map<string, string>): string =>
  t
    .replace(/<@([A-Z0-9]+)(?:\|[^>]+)?>/g, (_m, id: string) => `@${names.get(id) ?? "user"}`)
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1")
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2 ($1)")
    .replace(/<(https?:[^>]+)>/g, "$1")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

export class SlackProvider implements Provider {
  id = "slack";
  label = "Slack";
  private token: string;
  private fetchImpl: typeof fetch;
  constructor(token: string, fetchImpl: typeof fetch = fetch) {
    this.token = token;
    this.fetchImpl = fetchImpl;
  }

  private async api<T extends { ok: boolean; error?: string }>(method: string, params: Record<string, string> = {}): Promise<T> {
    const res = await this.fetchImpl(`https://slack.com/api/${method}?${new URLSearchParams(params)}`, {
      headers: { authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) throw new Error(`Slack ${res.status}`);
    const j = (await res.json()) as T;
    if (!j.ok) throw new Error(`Slack ${method}: ${j.error ?? "error"}`);
    return j;
  }

  async fetchEmails(since: Date): Promise<EmailMessage[]> {
    const me = (await this.api<{ ok: boolean; user_id: string }>("auth.test")).user_id;
    const names = new Map<string, string>();
    const nameOf = async (id: string) => {
      if (!names.has(id)) {
        try {
          const u = await this.api<{ ok: boolean; user: { real_name?: string; name?: string } }>("users.info", { user: id });
          names.set(id, u.user.real_name || u.user.name || id);
        } catch {
          names.set(id, id);
        }
      }
      return names.get(id)!;
    };
    const iso = (ts: string) => new Date(Number(ts) * 1000).toISOString();
    const out: EmailMessage[] = [];

    // 1) DMs and group DMs
    const convs = await this.api<{ ok: boolean; channels: { id: string; is_im?: boolean; user?: string; name?: string }[] }>(
      "users.conversations", { types: "im,mpim", limit: "30", exclude_archived: "true" },
    );
    for (const c of convs.channels) {
      const h = await this.api<{ ok: boolean; messages: SlackMsg[] }>("conversations.history", {
        channel: c.id, oldest: String(since.getTime() / 1000), limit: "30",
      });
      const label = c.is_im && c.user ? `DM with ${await nameOf(c.user)}` : `Group DM ${c.name ?? ""}`.trim();
      const newestFirst = h.messages;
      for (const [i, m] of newestFirst.entries()) {
        if (!m.user || !m.text) continue;
        const mine = m.user === me;
        await nameOf(m.user);
        out.push({
          id: `${c.id}:${m.ts}`, provider: "slack", threadId: c.id,
          from: names.get(m.user)!, to: [], subject: label,
          body: cleanSlackText(m.text, names), receivedAt: iso(m.ts),
          // only the latest message in a conversation can be "waiting on me"
          isUnread: i === 0 && !mine, isSent: mine,
        });
      }
    }

    // 2) @mentions in channels (search needs a user token with search:read)
    const day = since.toISOString().slice(0, 10);
    const found = await this.api<{
      ok: boolean;
      messages: { matches: { ts: string; user?: string; username?: string; text: string; channel: { id: string; name?: string } }[] };
    }>("search.messages", { query: `<@${me}> after:${day}`, count: "30", sort: "timestamp" });
    for (const m of found.messages.matches) {
      if (m.user === me || out.some((o) => o.id === `${m.channel.id}:${m.ts}`)) continue;
      out.push({
        id: `${m.channel.id}:${m.ts}`, provider: "slack", threadId: m.channel.id,
        from: m.user ? await nameOf(m.user) : (m.username ?? "someone"), to: [],
        subject: `#${m.channel.name ?? "channel"} (mention)`,
        body: cleanSlackText(m.text, names), receivedAt: iso(m.ts), isUnread: true, isSent: false,
      });
    }
    return out;
  }
}
