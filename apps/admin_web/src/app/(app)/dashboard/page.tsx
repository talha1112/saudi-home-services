"use client";

import { useRouter } from "next/navigation";
import { GroupedBars, Legend, LineChart, ProgressBar } from "@/components/charts/charts";
import { Avatar, Badge, Card, CardTitle, LinkButton } from "@/components/ui/primitives";
import { Icon } from "@/components/ui/Icon";
import { KpiGrid } from "@/components/ui/KpiGrid";
import { useAdmin } from "@/lib/admin-context";
import { describeError, useQuery } from "@/lib/api";
import { categoryIcon } from "@/lib/catalog-api";
import { addDays, daysBetween, fmt, humanize, shortH } from "@/lib/format";
import { ago, initials } from "@/lib/workers-api";
import type { Kpi, Tone } from "@/types";

interface Dashboard {
  kpis: {
    bookingsCreated: number;
    activeBookings: number;
    inProgress: number;
    completedBookings: number;
    completionRatePct: number | null;
    completedValueHalalas: number;
    commissionHalalas: number;
    effectiveCommissionPct: number | null;
    workerEarningsHalalas: number;
    awaitingCompletionWorkerEarningsHalalas: number;
    activeWorkers: number;
    onlineWorkers: number;
    pendingVerification: number;
    openDisputes: number;
    disputesNeedingAction: number;
    customers: number;
    newCustomers: number;
  };
  trend: { date: string; created: number; completed: number }[];
  categories: { id: string; nameEn: string; iconKey: string | null; bookings: number; sharePct: number }[];
  cities: { id: string; nameEn: string; bookings: number; sharePct: number | null; completedValueHalalas: number; workers: number; averageRating: number | null }[];
  weekly: { weekStart: string; grossHalalas: number; commissionHalalas: number; workerEarningsHalalas: number }[];
  topWorkers: { workerId: string; fullName: string | null; completedJobs: number; earningsHalalas: number; averageRating: number | null }[];
  pendingVerification: { workerId: string; fullName: string | null; services: { nameEn: string }[]; cities: { nameEn: string }[]; submittedAt: string | null }[];
  openDisputesList: { id: string; category: string; status: string; bookingReference: string; cityNameEn: string }[];
}

const DISPUTE_STATUS: Record<string, [string, Tone]> = { OPEN: ["Submitted", "neutral"], UNDER_REVIEW: ["Under review", "warn"], AWAITING_INFO: ["Action required", "bad"] };
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayShort = (iso: string) => `${Number(iso.slice(8, 10))} ${MON[Number(iso.slice(5, 7)) - 1]}`;

/** Splits the chosen day range into `n` equal chunks and totals the daily figures inside each. */
function bucketize(trend: Dashboard["trend"], from: string, to: string, n = 12) {
  const days = Math.max(1, daysBetween(from, to));
  const created = Array.from({ length: n }, () => 0);
  const completed = Array.from({ length: n }, () => 0);
  const byDate = new Map(trend.map((t) => [t.date, t]));
  for (let i = 0; i < days; i++) {
    const d = byDate.get(addDays(from, i));
    const slot = Math.min(n - 1, Math.floor((i * n) / days));
    created[slot]! += d?.created ?? 0;
    completed[slot]! += d?.completed ?? 0;
  }
  const labels = Array.from({ length: 6 }, (_, k) => dayShort(addDays(from, Math.floor((k * 2 * days) / n))));
  return { created, completed, labels };
}

export default function DashboardPage() {
  const router = useRouter();
  const { city, range, span, version } = useAdmin();
  const q = useQuery<Dashboard>(`dashboard?from=${encodeURIComponent(span.from)}&to=${encodeURIComponent(span.to)}${city === "all" ? "" : `&cityId=${city}`}`, version);
  const d = q.data;
  const k = d?.kpis;
  const loading = !d;
  const kpi = (kk: string, v: string, icon: string, dd: string, dc?: string, tone?: Kpi["tone"]): Kpi => ({ k: kk, v: loading ? "…" : v, icon, d: loading ? "" : dd, dc, tone });
  const kpis: Kpi[] = [
    kpi("Total bookings", fmt(k?.bookingsCreated ?? 0), "calendar", "Created in the chosen dates"),
    kpi("Active bookings", fmt(k?.activeBookings ?? 0), "clock", `${k?.inProgress ?? 0} in progress now`, "#64748B"),
    kpi("Completed bookings", fmt(k?.completedBookings ?? 0), "check", k?.completionRatePct != null ? `${k.completionRatePct}% completion` : "None finished yet"),
    kpi("Revenue (gross)", shortH(k?.completedValueHalalas ?? 0), "card", "Completed bookings, incl. VAT"),
    kpi("Platform commission", shortH(k?.commissionHalalas ?? 0), "percent", k?.effectiveCommissionPct != null ? `${k.effectiveCommissionPct}% effective rate` : "—", "#64748B", "gold"),
    kpi("Worker earnings", shortH(k?.workerEarningsHalalas ?? 0), "users", `${shortH(k?.awaitingCompletionWorkerEarningsHalalas ?? 0)} on jobs in progress`, "#64748B"),
    kpi("Active workers", fmt(k?.activeWorkers ?? 0), "wrench", `${k?.onlineWorkers ?? 0} online now`, "#64748B"),
    kpi("Pending verification", fmt(k?.pendingVerification ?? 0), "shield", "Waiting for review", "#8A5B00", "gold"),
    kpi("Open disputes", fmt(k?.openDisputes ?? 0), "alert", `${k?.disputesNeedingAction ?? 0} need action`, "#B42318", "red"),
    kpi("Customers", fmt(k?.customers ?? 0), "user", `${fmt(k?.newCustomers ?? 0)} joined in the chosen dates`),
  ];

  const lines = d ? bucketize(d.trend, range.from, range.to) : null;
  const catTotal = d?.categories.reduce((a, c) => a + c.bookings, 0) ?? 0;
  const topCat = d ? [...d.categories].sort((a, b) => b.bookings - a.bookings)[0] : null;
  const weeklyMax = Math.max(1, ...(d?.weekly.map((w) => w.grossHalalas) ?? [1]));

  return (
    <>
      {q.error && (
        <div role="alert" className="rounded-xl border border-danger-line bg-danger-bg px-4 py-3 text-[13.5px] text-danger">
          {describeError(q.error)} <button type="button" className="font-semibold underline" onClick={q.reload}>Try again</button>
        </div>
      )}
      <KpiGrid kpis={kpis} />
      <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)] gap-4">
        <Card className="flex flex-col gap-3.5 p-[18px]">
          <CardTitle aside={<Legend items={[{ color: "#00695C", label: "Booked", round: true }, { color: "#F4B740", label: "Completed", round: true }]} />}>Bookings over time</CardTitle>
          {lines ? <LineChart series={[lines.created, lines.completed]} xLabels={lines.labels} /> : <div className="grid h-[230px] place-items-center text-[13.5px] text-slate">Loading…</div>}
        </Card>
        <Card className="flex flex-col gap-3.5 p-[18px]">
          <div className="text-[15.5px] font-bold">Service categories</div>
          {(d?.categories ?? []).map((c) => (
            <div key={c.id} className="flex flex-col gap-[7px]">
              <div className="flex items-center gap-2.5">
                <span className="grid size-[30px] place-items-center rounded-[9px] bg-tint text-brand">
                  <Icon name={categoryIcon(c.iconKey)} size={15} />
                </span>
                <span className="flex-1 text-sm font-semibold">{c.nameEn}</span>
                <span className="text-[13px] text-slate">{fmt(c.bookings)} bookings</span>
                <span className="w-[42px] text-end text-[13.5px] font-bold">{c.sharePct}%</span>
              </div>
              <ProgressBar pct={c.sharePct} />
            </div>
          ))}
          <div className="mt-auto rounded-xl bg-cream p-3 text-[12.5px] leading-[1.45] text-[#6b4700]">
            {!d ? "Loading…" : topCat && catTotal > 0 ? `${topCat.nameEn} is the most booked category: ${topCat.sharePct}% of the ${fmt(catTotal)} bookings in these dates.` : "No bookings in these dates."}
          </div>
        </Card>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <Card className="flex flex-col gap-3.5 p-[18px]">
          <CardTitle aside={<span className="text-xs text-slate">Weekly · completed bookings</span>}>Revenue, commission &amp; payouts</CardTitle>
          {d && d.weekly.length > 0 ? (
            <GroupedBars colors={["#00695C", "#F4B740", "#9CC5BE"]} groups={d.weekly.map((w) => ({ label: dayShort(w.weekStart), values: [w.grossHalalas, w.commissionHalalas, w.workerEarningsHalalas].map((v) => Math.round((v / weeklyMax) * 100)) }))} />
          ) : (
            <div className="grid h-[170px] place-items-center text-[13.5px] text-slate">{loading ? "Loading…" : "No completed bookings in these dates."}</div>
          )}
          <Legend items={[{ color: "#00695C", label: "Gross bookings" }, { color: "#F4B740", label: "Commission" }, { color: "#9CC5BE", label: "Worker earnings" }]} />
        </Card>
        <Card className="flex flex-col gap-1.5 p-[18px]">
          <div className="mb-1.5 text-[15.5px] font-bold">City performance</div>
          <div className="grid grid-cols-[1.2fr_1fr_1fr_1fr_1fr] gap-2.5 border-b border-soft py-2 text-[11.5px] font-bold uppercase tracking-[.04em] text-slate">
            <span>City</span><span>Bookings</span><span>Revenue</span><span>Workers</span><span>Rating</span>
          </div>
          {(d?.cities ?? []).map((c) => (
            <div key={c.id} className="grid grid-cols-[1.2fr_1fr_1fr_1fr_1fr] items-center gap-2.5 border-b border-faint py-[11px] text-[13.5px]">
              <span className="flex flex-col gap-[5px]">
                <b className="font-semibold">{c.nameEn}</b>
                <ProgressBar pct={c.sharePct ?? 0} height={5} className="w-[90%]" />
              </span>
              <span>{fmt(c.bookings)}</span>
              <span className="font-semibold">{shortH(c.completedValueHalalas)}</span>
              <span>{fmt(c.workers)}</span>
              <span className="flex items-center gap-1">
                {c.averageRating != null ? (<><span className="flex text-gold"><Icon name="star" size={12} filled strokeWidth={0} /></span>{c.averageRating}</>) : "—"}
              </span>
            </div>
          ))}
        </Card>
      </div>
      <div className="grid grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)] gap-4">
        <Card className="flex flex-col gap-1 p-[18px]">
          <div className="mb-2 text-[15.5px] font-bold">Top workers in these dates</div>
          {(d?.topWorkers ?? []).map((w, i) => (
            <div key={w.workerId} className="flex items-center gap-2.5 border-b border-faint py-2 text-[13.5px]">
              <span className="w-5 font-semibold text-slate">{i + 1}</span>
              <Avatar text={initials(w.fullName)} size={30} />
              <span className="flex-1 font-semibold">{w.fullName ?? "Unnamed"}</span>
              <span className="text-[12.5px] text-slate">{w.completedJobs} jobs</span>
              <span className="flex w-11 items-center gap-[3px]">
                {w.averageRating != null ? (<><span className="flex text-gold"><Icon name="star" size={12} filled strokeWidth={0} /></span>{w.averageRating}</>) : "—"}
              </span>
              <span className="w-[86px] text-end font-bold">{shortH(w.earningsHalalas)}</span>
            </div>
          ))}
          {d && d.topWorkers.length === 0 && <div className="py-4 text-[13px] text-slate">No completed jobs in these dates.</div>}
        </Card>
        <Card className="flex flex-col gap-2.5 p-[18px]">
          <CardTitle aside={<LinkButton onClick={() => router.push("/verification")}>Open queue</LinkButton>}>Pending verification</CardTitle>
          {(d?.pendingVerification ?? []).map((w) => (
            <div key={w.workerId} className="flex items-center gap-2.5 text-[13.5px]">
              <span className="grid size-[30px] place-items-center rounded-[9px] bg-cream text-[11.5px] font-bold text-[#8a5b00]">{initials(w.fullName)}</span>
              <span className="flex flex-1 flex-col gap-px">
                <b className="font-semibold">{w.fullName ?? "Unnamed"}</b>
                <span className="text-xs text-slate">{w.services.map((s) => s.nameEn).join(" · ") || "No services"} · {w.cities[0]?.nameEn ?? "—"}</span>
              </span>
              <span className="text-xs text-slate">{ago(w.submittedAt)}</span>
            </div>
          ))}
          {d && d.pendingVerification.length === 0 && <div className="text-[13px] text-slate">Nobody is waiting.</div>}
        </Card>
        <Card className="flex flex-col gap-2.5 p-[18px]">
          <CardTitle aside={<LinkButton onClick={() => router.push("/disputes")}>View all</LinkButton>}>Open disputes</CardTitle>
          {(d?.openDisputesList ?? []).map((x) => {
            const [label, tone] = DISPUTE_STATUS[x.status] ?? [humanize(x.status), "neutral" as Tone];
            return (
              <div key={x.id} className="flex items-center gap-2.5 text-[13.5px]">
                <span className="flex flex-1 flex-col gap-px">
                  <b className="font-semibold">{humanize(x.category)}</b>
                  <span className="text-xs text-slate">{x.bookingReference} · {x.cityNameEn}</span>
                </span>
                <Badge label={label} tone={tone} className="!rounded-[7px] !px-2 !py-[3px] !text-[11.5px]" />
              </div>
            );
          })}
          {d && d.openDisputesList.length === 0 && <div className="text-[13px] text-slate">No open disputes.</div>}
        </Card>
      </div>
    </>
  );
}
