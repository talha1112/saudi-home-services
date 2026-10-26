export const fmt = (n: number) => n.toLocaleString("en-US");
export const sar = (n: number) => `SAR ${fmt(n)}`;
export const short = (n: number) =>
  n >= 1e6 ? `SAR ${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `SAR ${Math.round(n / 1e3)}K` : sar(n);

/** Today in Saudi Arabia (UTC+3), as YYYY-MM-DD: the admin works in the Riyadh calendar. */
const RIYADH_OFFSET_MS = 3 * 3_600_000;
export const todayInRiyadh = (now: number = Date.now()) => new Date(now + RIYADH_OFFSET_MS).toISOString().slice(0, 10);
export const TODAY = todayInRiyadh();
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export const toDate = (s: string) => new Date(`${s}T00:00:00Z`);
export const toIso = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (s: string, n: number) => {
  const d = toDate(s);
  d.setUTCDate(d.getUTCDate() + n);
  return toIso(d);
};
export const daysBetween = (a: string, b: string) => Math.round((+toDate(b) - +toDate(a)) / 864e5) + 1;

/** "1 Sep – 6 Oct 2026" style range label. */
export function rangeLabel(a: string, b: string) {
  const A = toDate(a);
  const B = toDate(b);
  const da = `${A.getUTCDate()} ${MON[A.getUTCMonth()]}`;
  const db = `${B.getUTCDate()} ${MON[B.getUTCMonth()]} ${B.getUTCFullYear()}`;
  if (a === b) return db;
  return A.getUTCFullYear() !== B.getUTCFullYear() ? `${da} ${A.getUTCFullYear()} – ${db}` : `${da} – ${db}`;
}

export function initials(name: string) {
  return name
    .split(/\s+/)
    .map((x) => x[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

/** Halalas (integer, 100 = SAR 1) as "SAR 1,234" or "SAR 1,234.50"; null/undefined as an em dash. */
export function sarH(halalas: number | null | undefined): string {
  if (halalas == null) return "—";
  const v = halalas / 100;
  return `SAR ${v.toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 })}`;
}

/** Halalas as a short figure: "SAR 3.84M", "SAR 562K" or the full amount. */
export function shortH(halalas: number | null | undefined): string {
  if (halalas == null) return "—";
  const v = halalas / 100;
  return v >= 1e6 ? `SAR ${(v / 1e6).toFixed(2)}M` : v >= 1e4 ? `SAR ${Math.round(v / 1e3)}K` : sarH(halalas);
}

/** The start (inclusive) and end (exclusive) instants of a Riyadh-calendar day range, as the ISO times the backend takes. */
export function rangeToIso(range: { from: string; to: string }): { from: string; to: string } {
  return { from: new Date(`${range.from}T00:00:00+03:00`).toISOString(), to: new Date(`${addDays(range.to, 1)}T00:00:00+03:00`).toISOString() };
}

/** "5 Oct", "5 Oct 2025" (other year) or "—" for an ISO instant, in the Riyadh calendar. */
export function dayLabel(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "—";
  const d = new Date(new Date(iso).getTime() + RIYADH_OFFSET_MS);
  const label = `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
  return d.getUTCFullYear() === new Date(now + RIYADH_OFFSET_MS).getUTCFullYear() ? label : `${label} ${d.getUTCFullYear()}`;
}

/** "Today · 6:00 PM", "Yesterday · 7:00 PM" or "5 Oct · 4:00 PM" for an ISO instant, in the Riyadh calendar. */
export function whenLabel(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  const d = new Date(t + RIYADH_OFFSET_MS);
  const h = d.getUTCHours();
  const time = `${h % 12 === 0 ? 12 : h % 12}:${String(d.getUTCMinutes()).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
  const day = toIso(d);
  const today = todayInRiyadh(now);
  const lead = day === today ? "Today" : day === addDays(today, -1) ? "Yesterday" : day === addDays(today, 1) ? "Tomorrow" : dayLabel(iso, now);
  return `${lead} · ${time}`;
}

/** "just now", "5 min ago", "3 h ago", "2 d ago" for an ISO instant. */
export function agoLabel(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "—";
  const m = Math.floor((now - new Date(iso).getTime()) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  if (m < 1440) return `${Math.floor(m / 60)} h ago`;
  return `${Math.floor(m / 1440)} d ago`;
}

/** Title-cases an ENUM_LIKE value: "UNDER_REVIEW" becomes "Under review". */
export function humanize(value: string | null | undefined): string {
  if (!value) return "—";
  const s = value.toLowerCase().replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}
