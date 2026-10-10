export const pad = (n) => String(n).padStart(2, "0");
/** Local calendar date as YYYY-MM-DD. */
export const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export function parseYmd(s) {
    const [y, m, d] = s.split("-").map(Number);
    return new Date(y, m - 1, d);
}
export function addDays(d, n) {
    const r = new Date(d);
    r.setDate(r.getDate() + n);
    return r;
}
/** Whole days from b to a (a - b), both YYYY-MM-DD. */
export const diffDays = (a, b) => Math.round((parseYmd(a).getTime() - parseYmd(b).getTime()) / 86_400_000);
/** "9:30 AM" */
export function clock(d) {
    const h = d.getHours();
    return `${h % 12 || 12}:${pad(d.getMinutes())} ${h < 12 ? "AM" : "PM"}`;
}
/** Combine a day with an "HH:MM" wall-clock string. */
export function atTime(day, hhmm) {
    const [h, m] = hhmm.split(":").map(Number);
    return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, 0, 0);
}
export const minutesBetween = (a, b) => Math.round((b.getTime() - a.getTime()) / 60_000);
export const dayLabel = (d) => d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
