"use client";

import { badge, text, type Column } from "@/components/tables/cells";
import { ServerTablePage, type ServerFilter } from "@/components/tables/ServerTablePage";
import { useAdmin } from "@/lib/admin-context";
import { useQuery } from "@/lib/api";
import { agoLabel } from "@/lib/format";
import type { Kpi, Tone } from "@/types";

interface ReviewRow {
  id: string;
  customerName: string | null;
  workerName: string | null;
  rating: number;
  comment: string | null;
  status: string;
  createdAt: string;
}

interface ReviewsReport {
  byCurrentStatus: { status: string; count: number }[];
  published: { count: number; average: number | null; distribution: Record<string, number> };
}

const TABS = [{ label: "All" }, { label: "Published", params: { status: "PUBLISHED" } }, { label: "Flagged", params: { status: "HIDDEN" } }];
const COLUMNS: Column[] = [
  { label: "Customer", w: 1 }, { label: "Professional", w: 1.3 }, { label: "Rating", w: 1 }, { label: "Comment", w: 3 }, { label: "Date", w: 1 }, { label: "Status", w: 1 },
];
const FILTERS: ServerFilter[] = [
  {
    key: "Rating", label: "Rating", options: ["All", "5 stars", "4 stars", "1–3 stars"],
    param: (v) => (v === "5 stars" ? { rating: "5" } : v === "4 stars" ? { rating: "4" } : { maxRating: "3" }),
  },
];
const TONE: Record<string, Tone> = { PUBLISHED: "ok", HIDDEN: "bad", WITHDRAWN: "neutral" };
const LABEL: Record<string, string> = { PUBLISHED: "Published", HIDDEN: "Flagged", WITHDRAWN: "Withdrawn" };

export default function ReviewsPage() {
  const { city, span, version } = useAdmin();
  const cityQ = city === "all" ? "" : `&cityId=${city}`;
  const range = `from=${encodeURIComponent(span.from)}&to=${encodeURIComponent(span.to)}`;
  const report = useQuery<ReviewsReport>(`reports/reviews?${range}`, version);
  const done = useQuery<{ kpis: { completedBookings: number } }>(`dashboard?${range}${cityQ}`, version);
  const r = report.data;
  const pub = r?.published;
  const flagged = r?.byCurrentStatus.find((s) => s.status === "HIDDEN")?.count ?? 0;
  const completed = done.data?.kpis.completedBookings ?? 0;
  const reviewed = (r?.byCurrentStatus ?? []).reduce((a, s) => a + s.count, 0);
  const kpis: Kpi[] = [
    { k: "Average rating", v: pub?.average != null ? String(pub.average) : "—", icon: "star", d: pub ? `${pub.count.toLocaleString("en-GB")} published reviews` : "", dc: "#64748B", tone: "gold" },
    { k: "5-star share", v: pub && pub.count > 0 ? `${Math.round(((pub.distribution["5"] ?? 0) / pub.count) * 100)}%` : "—", icon: "up", d: "Of published reviews" },
    { k: "Reviewed bookings", v: r && completed > 0 ? `${Math.min(100, Math.round((reviewed / completed) * 100))}%` : "—", icon: "check", d: "Of completed in range", dc: "#64748B" },
    { k: "Flagged", v: r ? String(flagged) : "…", icon: "flag", d: "Hidden from ratings", dc: "#B42318", tone: "red" },
  ];
  return (
    <ServerTablePage<ReviewRow>
      kpis={kpis}
      tabs={TABS}
      filters={FILTERS}
      path="reviews"
      params={{ cityId: city === "all" ? undefined : city, from: span.from, to: span.to }}
      columns={COLUMNS}
      idOf={(x) => x.id}
      toRow={(x) => ({
        key: x.id,
        cells: [text(x.customerName ?? "—"), text(x.workerName ?? "—", undefined, { fw: 600 }), text("★".repeat(x.rating) + "☆".repeat(5 - x.rating), undefined, { fg: "#D9A43A", fw: 700 }), text(x.comment ?? "—", undefined, { fg: "#334155" }), text(agoLabel(x.createdAt), undefined, { fg: "#64748B" }), badge(LABEL[x.status] ?? x.status, TONE[x.status])],
      })}
      footerBase={(shown, total) => `Showing ${shown} of ${total.toLocaleString("en-GB")} reviews`}
    />
  );
}
