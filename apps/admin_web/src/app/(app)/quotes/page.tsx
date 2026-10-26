"use client";

import { useMemo } from "react";
import { badge, mono, num, text, type Column } from "@/components/tables/cells";
import { ServerTablePage, type Paged, type ServerFilter } from "@/components/tables/ServerTablePage";
import { useAdmin } from "@/lib/admin-context";
import { useQuery } from "@/lib/api";
import { humanize, sarH, whenLabel } from "@/lib/format";
import type { Kpi, Tone } from "@/types";

interface QuoteRow {
  id: string;
  bookingReference: string;
  serviceNameEn: string;
  workerName: string | null;
  status: string;
  priceHalalas: number;
  workerPayoutHalalas: number;
  sentAt: string;
  validUntil: string;
}

interface Summary {
  sent: number;
  acceptanceRatePct: number | null;
  averageQuotesPerRequest: number | null;
  averageFirstResponseMinutes: number | null;
  accepted: number;
  requestsQuoted: number;
}

const COLUMNS: Column[] = [
  { label: "Quote", w: 1 }, { label: "Booking · service", w: 1.8 }, { label: "Professional", w: 1.6 }, { label: "Quote (ex. VAT)", w: 1.1, align: "end" },
  { label: "Worker nets", w: 1, align: "end" }, { label: "Sent", w: 1 }, { label: "Expires", w: 1 }, { label: "Status", w: 1 },
];
const TABS = [
  { label: "All" },
  { label: "Pending", params: { status: "PENDING" } },
  { label: "Accepted", params: { status: "ACCEPTED" } },
  { label: "Rejected", params: { status: "REJECTED" } },
  { label: "Expired", params: { status: "EXPIRED" } },
];
const TONE: Record<string, Tone> = { PENDING: "warn", ACCEPTED: "ok", REJECTED: "bad", EXPIRED: "neutral", WITHDRAWN: "neutral" };

/** "in 1 h 58 m" for a time ahead, nothing once it has passed. */
function untilLabel(iso: string, now: number = Date.now()): string {
  const m = Math.floor((new Date(iso).getTime() - now) / 60_000);
  if (m <= 0) return "—";
  return m < 60 ? `in ${m} m` : m < 1440 ? `in ${Math.floor(m / 60)} h ${m % 60} m` : `in ${Math.floor(m / 1440)} d`;
}

export default function QuotesPage() {
  const { city, span, version } = useAdmin();
  const workers = useQuery<Paged<{ id: string; fullName: string | null }>>("workers?status=APPROVED&limit=100&sort=newest");
  const summary = useQuery<Summary>(`quotes/summary?from=${encodeURIComponent(span.from)}&to=${encodeURIComponent(span.to)}${city === "all" ? "" : `&cityId=${city}`}`, version);
  const workerId = useMemo(() => new Map((workers.data?.items ?? []).filter((w) => w.fullName).map((w) => [w.fullName!, w.id])), [workers.data]);
  const filters: ServerFilter[] = [{ key: "Professional", label: "Professional", options: ["All", ...workerId.keys()], param: (v) => ({ workerId: workerId.get(v) }) }];
  const s = summary.data;
  const kpis: Kpi[] = [
    { k: "Quotes sent", v: s ? s.sent.toLocaleString("en-GB") : "…", icon: "file", d: "In the chosen dates" },
    { k: "Acceptance rate", v: s?.acceptanceRatePct != null ? `${s.acceptanceRatePct}%` : "—", icon: "check", d: s ? `${s.accepted} accepted` : "", dc: "#64748B" },
    { k: "Avg. quotes per request", v: s?.averageQuotesPerRequest != null ? String(s.averageQuotesPerRequest) : "—", icon: "users", d: s ? `${s.requestsQuoted} requests quoted` : "", dc: "#64748B" },
    { k: "Avg. response time", v: s?.averageFirstResponseMinutes != null ? `${s.averageFirstResponseMinutes} min` : "—", icon: "clock", d: "To the first quote", tone: "gold" },
  ];
  return (
    <ServerTablePage<QuoteRow>
      kpis={kpis}
      tabs={TABS}
      filters={filters}
      path="quotes"
      params={{ from: span.from, to: span.to, cityId: city === "all" ? undefined : city }}
      columns={COLUMNS}
      idOf={(q) => q.id}
      toRow={(q) => ({
        key: q.id,
        cells: [mono(`Q-${q.id.slice(-6).toUpperCase()}`), text(q.serviceNameEn, q.bookingReference, { fw: 600 }), text(q.workerName ?? "—"), num(sarH(q.priceHalalas)), num(sarH(q.workerPayoutHalalas), { fg: "#00695C" }), text(whenLabel(q.sentAt)), text(q.status === "PENDING" ? untilLabel(q.validUntil) : "—", undefined, { fg: "#64748B" }), badge(humanize(q.status), TONE[q.status])],
      })}
      footerBase={(shown, total) => `Showing ${shown} of ${total.toLocaleString("en-GB")} quotes`}
    />
  );
}
