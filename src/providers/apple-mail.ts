import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { EmailMessage } from "../core/types.ts";
import type { Provider } from "./types.ts";

const run = promisify(execFile);

/**
 * macOS Mail.app via JXA. The first run triggers the system "Automation" permission
 * prompt (System Settings → Privacy & Security → Automation).
 */
const SCRIPT = (limit: number) => `
const Mail = Application('Mail');
const out = [];
const msgs = Mail.inbox.messages();
for (let i = 0; i < Math.min(msgs.length, ${limit}); i++) {
  const m = msgs[i];
  out.push({
    id: String(m.id()), subject: m.subject(), from: m.sender(),
    receivedAt: m.dateReceived().toISOString(), isUnread: !m.readStatus(),
    body: (m.content() || '').slice(0, 4000),
  });
}
JSON.stringify(out);`;

interface Row {
  id: string;
  subject: string;
  from: string;
  receivedAt: string;
  isUnread: boolean;
  body: string;
}

export function parseAppleMail(json: string, since: Date): EmailMessage[] {
  return (JSON.parse(json) as Row[])
    .filter((r) => new Date(r.receivedAt) >= since)
    .map((r) => ({
      id: r.id,
      provider: "apple-mail",
      threadId: `${r.subject.replace(/^(re|fwd?):\s*/gi, "").toLowerCase()}`,
      from: r.from,
      to: [],
      subject: r.subject,
      body: r.body,
      receivedAt: r.receivedAt,
      isUnread: r.isUnread,
      isSent: false,
    }));
}

export class AppleMailProvider implements Provider {
  id = "apple-mail";
  label = "Apple Mail";
  async fetchEmails(since: Date): Promise<EmailMessage[]> {
    const { stdout } = await run("osascript", ["-l", "JavaScript", "-e", SCRIPT(80)], { maxBuffer: 20 * 1024 * 1024 });
    return parseAppleMail(stdout.trim(), since);
  }
}
