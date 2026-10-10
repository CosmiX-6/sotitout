import { addDays, parseYmd, ymd } from "./dates.ts";
import type { EmailMessage, Project, Task } from "./types.ts";

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS: Record<string, number> = {
  january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2, april: 3, apr: 3, may: 4,
  june: 5, jun: 5, july: 6, jul: 6, august: 7, aug: 7, september: 8, sept: 8, sep: 8,
  october: 9, oct: 9, november: 10, nov: 10, december: 11, dec: 11,
};
const MONTH_RE = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");

function validDate(y: number, m: number, d: number): boolean {
  const dt = new Date(y, m, d);
  return dt.getFullYear() === y && dt.getMonth() === m && dt.getDate() === d;
}

/** Month/day with no year: pick this year, or next year if it is long past. */
function inferYear(m: number, d: number, now: Date): string | undefined {
  let y = now.getFullYear();
  if (!validDate(y, m, d)) return undefined;
  if (new Date(y, m, d).getTime() < addDays(now, -30).getTime()) y += 1;
  return validDate(y, m, d) ? ymd(new Date(y, m, d)) : undefined;
}

/** Best-effort extraction of a due date (YYYY-MM-DD) from free text. */
export function parseDue(text: string, now: Date): string | undefined {
  const t = text.toLowerCase();
  let m: RegExpMatchArray | null;

  if ((m = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/)) && validDate(+m[1], +m[2] - 1, +m[3])) return m[0];

  if ((m = t.match(new RegExp(`\\b(${MONTH_RE})\\.? (\\d{1,2})(?:st|nd|rd|th)?\\b`)))) {
    const r = inferYear(MONTHS[m[1]], +m[2], now);
    if (r) return r;
  }

  if ((m = t.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/))) {
    const mo = +m[1] - 1;
    const d = +m[2];
    if (m[3]) {
      const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
      if (validDate(y, mo, d)) return ymd(new Date(y, mo, d));
    } else {
      const r = inferYear(mo, d, now);
      if (r) return r;
    }
  }

  if (/\b(eod|end of (the )?day|cob|today|tonight|asap)\b/.test(t)) return ymd(now);
  if (/\bbefore tomorrow\b/.test(t)) return ymd(now);
  if (/\btomorrow\b/.test(t)) return ymd(addDays(now, 1));

  if ((m = t.match(new RegExp(`\\b(next |this )?(${WEEKDAYS.join("|")})\\b`)))) {
    const idx = WEEKDAYS.indexOf(m[2]);
    let delta = (idx - now.getDay() + 7) % 7;
    if (delta === 0) delta = 7;
    if (m[1] === "next " && idx > now.getDay()) delta += 7;
    return ymd(addDays(now, delta));
  }

  if (/\b(eow|end of (the )?week)\b/.test(t)) {
    const delta = (5 - now.getDay() + 7) % 7;
    return ymd(addDays(now, delta));
  }
  return undefined;
}

/** Drop quoted replies and signatures so we only read what the sender wrote. */
export function cleanBody(body: string): string {
  const out: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*>/.test(line)) continue;
    if (/^--\s*$/.test(line)) break;
    if (/^On .+ wrote:\s*$/.test(line)) break;
    out.push(line);
  }
  return out.join("\n").trim();
}

export const isAutomated = (e: Pick<EmailMessage, "from" | "body">): boolean =>
  /no-?reply|do-?not-?reply|newsletter|notifications?@|mailer-daemon|updates@/i.test(e.from) ||
  /unsubscribe/i.test(e.body);

const REQUEST_RE =
  /\b(please|can you|could you|would you|need (you )?to|needs? to be|action required|action item|deadline|due|follow(?:ing)? up|reminder|don'?t forget|make sure|asap|urgent|confirm)\b/i;

const senderName = (from: string): string => from.replace(/<.*>/, "").replace(/"/g, "").trim() || from;

/** Pick the most task-like sentence in an email, preferring one with a date. */
export function extractTask(email: EmailMessage, now: Date): Omit<Task, "projectId"> | undefined {
  if (email.isSent || isAutomated(email)) return undefined;
  const text = cleanBody(email.body);
  const sentences = text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 8 && REQUEST_RE.test(s));
  if (sentences.length === 0) return undefined;

  const dated = sentences.find((s) => parseDue(s, now));
  const best = dated ?? sentences[0];
  const subject = email.subject.replace(/^((re|fwd?):\s*)+/i, "").replace(/^urgent:\s*/i, "").trim();
  const short = best.length > 110 ? `${best.slice(0, 107)}…` : best;
  const title = subject && !best.toLowerCase().includes(subject.toLowerCase()) ? `${subject} — ${short}` : short;
  const urgent = /\b(urgent|asap|action required)\b/i.test(`${email.subject} ${best}`);
  return {
    id: `email:${email.provider}:${email.id}`,
    title: `${title} (${senderName(email.from)})`,
    due: parseDue(best, now) ?? parseDue(email.subject, now),
    status: "open",
    source: "email",
    sourceFrom: email.from,
    sourceSubject: email.subject,
    highPriority: urgent || undefined,
    createdAt: email.receivedAt,
    carriedCount: 0,
  };
}

/** Match free text to the project with the most keyword hits (subject counts triple). */
export function matchProject(subject: string, body: string, projects: Project[]): string | undefined {
  const subj = subject.toLowerCase();
  const text = body.toLowerCase();
  let best: { id: string; score: number } | undefined;
  for (const p of projects) {
    if (p.status === "done") continue;
    let score = 0;
    for (const k of [p.name, ...p.keywords]) {
      const kw = k.trim().toLowerCase();
      if (!kw) continue;
      if (subj.includes(kw)) score += 3;
      if (text.includes(kw)) score += 1;
    }
    if (score > 0 && (!best || score > best.score)) best = { id: p.id, score };
  }
  return best?.id;
}

export { parseYmd };
