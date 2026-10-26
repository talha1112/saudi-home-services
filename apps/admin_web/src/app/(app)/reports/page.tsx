"use client";

import { useState } from "react";
import { GroupedBars, Legend } from "@/components/charts/charts";
import { num, text, type Column } from "@/components/tables/cells";
import { DataTable } from "@/components/tables/DataTable";
import { Icon } from "@/components/ui/Icon";
import { Card, Chip } from "@/components/ui/primitives";
import { useAdmin } from "@/lib/admin-context";
import { describeError, useQuery } from "@/lib/api";
import { fmt, rangeLabel, shortH } from "@/lib/format";

const REPORTS: [label: string, metric: string][] = [
  ["Revenue", "revenue"], ["Bookings", "bookings"], ["Commissions", "commissions"], ["Worker earnings", "earnings"], ["Cancellations", "cancellations"], ["Refunds", "refunds"],
  ["Disputes", "disputes"], ["Offers", "offers"], ["Subscriptions", "subscriptions"], ["Customer activity", "customers"], ["Worker performance", "workers"], ["City performance", "cities"],
];
const COLORS = ["#00695C", "#5FA39A", "#F4B740", "#172B35", "#9CC5BE", "#B42318"];

interface Series {
  unit: "halalas" | "count";
  months: string[];
  cities: { id: string; nameEn: string }[];
  values: number[][];
  available: boolean;
}
interface Summary {
  note: string | null;
  rows: { label: string; value: number | string | null; kind: "money" | "count" | "pct" | "text" }[];
}
interface CityRow {
  id: string;
  nameEn: string;
  bookings: number;
  revenueHalalas: number;
  commissionHalalas: number;
  workerEarningsHalalas: number;
  cancellationPct: number | null;
  refundsHalalas: number;
  disputes: number;
  averageRating: number | null;
}
interface Cities {
  items: CityRow[];
  total: Omit<CityRow, "id" | "nameEn"> & { cancellations: number };
}

const COLUMNS: Column[] = [
  { label: "City", w: 1.4 }, { label: "Bookings", w: 1, align: "end" }, { label: "Revenue", w: 1.2, align: "end" }, { label: "Commission", w: 1.1, align: "end" },
  { label: "Worker earnings", w: 1.2, align: "end" }, { label: "Cancellations", w: 1, align: "end" }, { label: "Refunds", w: 1, align: "end" }, { label: "Disputes", w: 0.9, align: "end" }, { label: "Rating", w: 0.8, align: "end" },
];

const show = (v: number | string | null, kind: Summary["rows"][number]["kind"]) => (v === null ? "—" : kind === "money" ? shortH(Number(v)) : kind === "pct" ? `${v}%` : typeof v === "number" ? fmt(v) : v);
const csv = (cells: (string | number)[]) => cells.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",");

export default function ReportsPage() {
  const { range, span, version, showToast } = useAdmin();
  const [tab, setTab] = useState(0);
  const [label, metric] = REPORTS[tab]!;
  const win = `from=${encodeURIComponent(span.from)}&to=${encodeURIComponent(span.to)}`;
  const series = useQuery<Series>(`report-series?metric=${metric}&months=6`, version);
  const summary = useQuery<Summary>(`report-series/summary?metric=${metric}&${win}`, version);
  const cities = useQuery<Cities>(`report-series/cities?${win}`, version);
  const sr = series.data;
  const max = sr ? Math.max(1, ...sr.values.flat()) : 1;
  const error = [series, summary, cities].find((q) => q.error)?.error;

  const rows = [
    ...(cities.data?.items ?? []).map((c) => ({
      key: c.id,
      cells: [text(c.nameEn, undefined, { fw: 700 }), num(fmt(c.bookings)), num(shortH(c.revenueHalalas)), num(shortH(c.commissionHalalas), { fg: "#8A5B00" }), num(shortH(c.workerEarningsHalalas), { fg: "#00695C" }), num(c.cancellationPct != null ? `${c.cancellationPct}%` : "—"), num(shortH(c.refundsHalalas)), num(c.disputes), num(c.averageRating != null ? `★ ${c.averageRating}` : "—")],
    })),
    ...(cities.data
      ? [{ key: "total", cells: [text("Total", undefined, { fw: 700 }), num(fmt(cities.data.total.bookings)), num(shortH(cities.data.total.revenueHalalas)), num(shortH(cities.data.total.commissionHalalas), { fg: "#8A5B00" }), num(shortH(cities.data.total.workerEarningsHalalas), { fg: "#00695C" }), num(cities.data.total.cancellationPct != null ? `${cities.data.total.cancellationPct}%` : "—"), num(shortH(cities.data.total.refundsHalalas)), num(cities.data.total.disputes), num(cities.data.total.averageRating != null ? `★ ${cities.data.total.averageRating}` : "—")] }]
      : []),
  ];

  function exportCsv() {
    if (!cities.data) return;
    const lines = [
      csv(["Report", label, "Dates", rangeLabel(range.from, range.to)]),
      csv(COLUMNS.map((c) => c.label)),
      ...cities.data.items.map((c) => csv([c.nameEn, c.bookings, c.revenueHalalas / 100, c.commissionHalalas / 100, c.workerEarningsHalalas / 100, c.cancellationPct ?? "", c.refundsHalalas / 100, c.disputes, c.averageRating ?? ""])),
      "",
      csv([`${label} by month`, ...(sr?.cities.map((c) => c.nameEn) ?? [])]),
      ...(sr?.months.map((m, i) => csv([m, ...(sr.values[i] ?? []).map((v) => (sr.unit === "halalas" ? v / 100 : v))])) ?? []),
    ];
    const url = URL.createObjectURL(new Blob([`﻿${lines.join("\r\n")}`], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `report-${metric}-${span.from.slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    showToast("Report exported");
  }

  return (
    <>
      {error && <div role="alert" className="rounded-xl border border-danger-line bg-danger-bg px-4 py-3 text-[13.5px] text-danger">{describeError(error)}</div>}
      <div className="flex flex-wrap gap-1.5">
        {REPORTS.map(([l], i) => <Chip key={l} label={l} selected={tab === i} onClick={() => setTab(i)} className="!h-[34px] !px-3" />)}
      </div>
      <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)] gap-4">
        <Card className="flex flex-col gap-3.5 p-[18px]">
          <div className="flex items-center justify-between">
            <div className="text-[15.5px] font-bold">{label} by city · last 6 months</div>
            <div className="flex gap-2">
              <button type="button" onClick={exportCsv} className="flex h-8 items-center gap-[5px] rounded-[9px] border border-line bg-white px-3 text-[12.5px] font-semibold"><Icon name="download" size={14} />CSV</button>
              <button type="button" onClick={() => window_print()} className="flex h-8 items-center gap-[5px] rounded-[9px] border border-line bg-white px-3 text-[12.5px] font-semibold"><Icon name="download" size={14} />PDF</button>
            </div>
          </div>
          {sr && sr.available ? (
            <GroupedBars height={220} gap={18} colors={COLORS} groups={sr.months.map((m, i) => ({ label: m, values: (sr.values[i] ?? []).map((v) => Math.round((v / max) * 100)) }))} />
          ) : (
            <div className="grid h-[220px] place-items-center text-[13.5px] text-slate">{series.loading ? "Loading…" : "Nothing to chart for this report yet."}</div>
          )}
          <Legend items={(sr?.cities ?? []).map((c, i) => ({ color: COLORS[i % COLORS.length]!, label: c.nameEn }))} />
        </Card>
        <Card className="flex flex-col gap-3 p-[18px]">
          <div className="text-[15.5px] font-bold">Summary</div>
          {(summary.data?.rows ?? []).map((r) => (
            <div key={r.label} className="flex items-baseline justify-between border-b border-faint py-2.5">
              <span className="text-[13.5px] text-slate">{r.label}</span>
              <b className="text-[17px]">{show(r.value, r.kind)}</b>
            </div>
          ))}
          {!summary.data && <div className="text-[13px] text-slate">{summary.loading ? "Loading…" : ""}</div>}
          {summary.data?.note && <div className="text-xs leading-normal text-slate">{summary.data.note}</div>}
        </Card>
      </div>
      <DataTable columns={COLUMNS} rows={rows} footer={`City performance · ${rangeLabel(range.from, range.to)}`} />
    </>
  );
}

/** Opens the browser's print dialog, where "Save as PDF" is one of the destinations. */
function window_print() {
  if (typeof globalThis.window !== "undefined") globalThis.window.print();
}
