"use client";

import { badge, num, person, type Column } from "@/components/tables/cells";
import { ServerTablePage, type ServerFilter } from "@/components/tables/ServerTablePage";
import { Button, Card } from "@/components/ui/primitives";
import { useAdmin } from "@/lib/admin-context";
import { useQuery } from "@/lib/api";
import { dayLabel, rangeLabel, sarH, shortH } from "@/lib/format";
import { initials } from "@/lib/workers-api";
import type { Kpi } from "@/types";

interface Report {
  rule: { commissionRateBps: number; vatRateBps: number; minServiceChargeHalalas: number; effectiveFrom: string; isProvisional: boolean };
  totals: {
    completedBookings: number;
    serviceAmountHalalas: number;
    commissionHalalas: number;
    workerEarningsHalalas: number;
    effectiveRatePct: number | null;
    awaitingCompletionBookings: number;
    awaitingCompletionWorkerEarningsHalalas: number;
  };
}

interface WorkerRow {
  workerId: string;
  fullName: string | null;
  completedJobs: number;
  serviceAmountHalalas: number;
  commissionHalalas: number;
  workerEarningsHalalas: number;
}

const COLUMNS: Column[] = [
  { label: "Worker", w: 2 }, { label: "Plan", w: 0.9 }, { label: "Rate", w: 0.7, align: "end" }, { label: "Bookings", w: 0.9, align: "end" },
  { label: "Gross", w: 1.1, align: "end" }, { label: "Commission", w: 1.1, align: "end" }, { label: "Worker net", w: 1.1, align: "end" },
];
// Everyone is on the one platform rate, so "Standard" is the only plan there is.
const FILTERS: ServerFilter[] = [{ key: "Plan", label: "Plan", options: ["All", "Standard"], param: () => ({}) }];

export default function CommissionsPage() {
  const { city, range, span, version, openModal } = useAdmin();
  const params = { from: span.from, to: span.to, cityId: city === "all" ? undefined : city };
  const report = useQuery<Report>(`commissions?from=${encodeURIComponent(span.from)}&to=${encodeURIComponent(span.to)}${city === "all" ? "" : `&cityId=${city}`}`, version);
  const r = report.data;
  const t = r?.totals;
  const rule = r?.rule;
  const rate = rule ? rule.commissionRateBps / 100 : null;
  const kpis: Kpi[] = [
    { k: "Platform commission", v: t ? shortH(t.commissionHalalas) : "…", icon: "percent", d: t ? `${t.completedBookings} completed bookings` : "" },
    { k: "Effective rate", v: t?.effectiveRatePct != null ? `${t.effectiveRatePct}%` : "—", icon: "chart", d: "Of the service price", dc: "#64748B" },
    { k: "Worker earnings", v: t ? shortH(t.workerEarningsHalalas) : "…", icon: "users", d: "On completed jobs", dc: "#64748B" },
    { k: "Awaiting completion", v: t ? shortH(t.awaitingCompletionWorkerEarningsHalalas) : "…", icon: "clock", d: t ? `${t.awaitingCompletionBookings} confirmed bookings` : "", dc: "#8A5B00", tone: "gold" },
  ];
  const ruleRows: [string, string, string][] = [
    ["Platform commission", "Share of the service price (before VAT)", rate != null ? `${rate}%` : "…"],
    ["VAT", "Added on top of the service price", rule ? `${rule.vatRateBps / 100}%` : "…"],
    ["Minimum service charge", "Lowest price a professional may quote", rule ? sarH(rule.minServiceChargeHalalas) : "…"],
    ["In force since", rule?.isProvisional ? "Placeholder rates, not yet confirmed" : "Applies to new quotes", rule ? dayLabel(rule.effectiveFrom) : "…"],
  ];
  const service = t?.serviceAmountHalalas ?? 0;
  const workerPct = service > 0 && t ? Math.max(0, Math.min(100, (t.workerEarningsHalalas / service) * 100)) : 100;

  const block = (
    <div className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] gap-4">
      <Card className="flex flex-col gap-3.5 p-[18px]">
        <div className="text-[15.5px] font-bold">Revenue sharing · {rangeLabel(range.from, range.to)}</div>
        <div className="flex h-11 overflow-hidden rounded-xl text-[12.5px] font-bold">
          <div className="flex items-center bg-brand px-3.5 text-white" style={{ width: `${workerPct}%` }}>Worker earnings · {t ? shortH(t.workerEarningsHalalas) : "…"}</div>
          <div className="flex flex-1 items-center justify-center bg-gold text-ink">{t ? shortH(t.commissionHalalas) : "…"}</div>
        </div>
        <div className="grid grid-cols-3 gap-2.5">
          {[["Booking amount (ex. VAT)", t ? shortH(t.serviceAmountHalalas) : "…", "bg-background", "text-slate"], ["Platform commission", t ? shortH(t.commissionHalalas) : "…", "bg-cream", "text-[#6b4700]"], ["Worker earnings", t ? shortH(t.workerEarningsHalalas) : "…", "bg-tint", "text-[#0b4f46]"]].map(([k, v, bg, fg]) => (
            <div key={k} className={`flex flex-col gap-[3px] rounded-xl p-3 ${bg}`}>
              <span className={`text-xs ${fg}`}>{k}</span>
              <b className="text-lg">{v}</b>
            </div>
          ))}
        </div>
        <div className="text-[12.5px] text-slate">Example: Service SAR 300 → platform fee SAR {rate != null ? Math.round(300 * rate) / 100 : "…"} ({rate ?? "…"}%) → worker earnings SAR {rate != null ? 300 - Math.round(300 * rate) / 100 : "…"}.</div>
      </Card>
      <Card className="flex flex-col gap-2.5 p-[18px]">
        <div className="flex items-center justify-between">
          <div className="text-[15.5px] font-bold">Commission rules</div>
          <Button variant="soft" className="!h-8 !rounded-[9px] !px-3 !text-[12.5px]" onClick={() => openModal("rules")}>Edit rules</Button>
        </div>
        {ruleRows.map(([l, d, v]) => (
          <div key={l} className="flex items-center gap-2.5 border-b border-faint py-[9px] text-[13.5px]">
            <span className="flex flex-1 flex-col gap-px">
              <b className="font-semibold">{l}</b>
              <span className="text-xs text-slate">{d}</span>
            </span>
            <span className="text-[17px] font-bold text-brand">{v}</span>
          </div>
        ))}
      </Card>
    </div>
  );

  return (
    <ServerTablePage<WorkerRow>
      kpis={kpis}
      before={block}
      filters={FILTERS}
      path="commissions/workers"
      params={params}
      columns={COLUMNS}
      idOf={(w) => w.workerId}
      toRow={(w) => ({
        key: w.workerId,
        cells: [
          person(w.fullName ?? "Unnamed", initials(w.fullName)),
          badge("Standard"),
          num(w.serviceAmountHalalas > 0 ? `${Math.round((w.commissionHalalas / w.serviceAmountHalalas) * 1000) / 10}%` : "—"),
          num(w.completedJobs),
          num(sarH(w.serviceAmountHalalas)),
          num(sarH(w.commissionHalalas), { fg: "#8A5B00" }),
          num(sarH(w.workerEarningsHalalas), { fg: "#00695C" }),
        ],
      })}
      footerBase={(shown, total) => `Commission report · ${rangeLabel(range.from, range.to)} · ${shown} of ${total} workers`}
    />
  );
}
