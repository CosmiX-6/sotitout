export const pad = (n: number): string => String(n).padStart(2, "0");

/** Local calendar date as YYYY-MM-DD. */
export const ymd = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export function parseYmd(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

/** Whole days from b to a (a - b), both YYYY-MM-DD. */
export const diffDays = (a: string, b: string): number =>
  Math.round((parseYmd(a).getTime() - parseYmd(b).getTime()) / 86_400_000);

/** "9:30 AM" */
export function clock(d: Date): string {
  const h = d.getHours();
  return `${h % 12 || 12}:${pad(d.getMinutes())} ${h < 12 ? "AM" : "PM"}`;
}

/** Combine a day with an "HH:MM" wall-clock string. */
export function atTime(day: Date, hhmm: string): Date {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, 0, 0);
}

export const minutesBetween = (a: Date, b: Date): number => Math.round((b.getTime() - a.getTime()) / 60_000);

export const dayLabel = (d: Date): string =>
  d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
