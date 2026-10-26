"use client";

import { useState } from "react";
import type { Column, FilterShape } from "@/components/tables/cells";
import { DataTable } from "@/components/tables/DataTable";
import { KpiGrid } from "@/components/ui/KpiGrid";
import { useAdmin } from "@/lib/admin-context";
import { useQuery } from "@/lib/api";
import type { Paged } from "@/components/tables/ServerTablePage";

const COLUMNS: Column[] = [
  { label: "Worker", w: 2 }, { label: "Plan", w: 0.9 }, { label: "Price", w: 0.9, align: "end" }, { label: "Status", w: 1 }, { label: "Started", w: 1.1 }, { label: "Renews / ends", w: 1.1 },
];
const FILTERS: FilterShape[] = [{ key: "Plan", label: "Plan", options: ["All", "Pro", "Elite"] }];

/**
 * Worker subscriptions do not exist in the platform yet: every approved worker is on the one commission rate and nobody pays a monthly
 * fee. The screen says exactly that, from the database, instead of showing plans and revenue nobody has.
 */
export default function SubscriptionsPage() {
  const { version } = useAdmin();
  const [tab, setTab] = useState(0);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const approved = useQuery<Paged<unknown>>("workers?status=APPROVED&limit=1", version);
  const pricing = useQuery<{ commissionRateBps: number }>("pricing-settings/current", version);
  const workers = approved.data ? approved.data.meta.total.toLocaleString("en-GB") : "…";
  const rate = pricing.data ? `${pricing.data.commissionRateBps / 100}% commission` : "…";

  const plans = [
    { name: "Basic", price: "Free", subs: workers, mrr: "—", churn: "—", perks: `${rate} · every approved worker`, bg: "bg-white text-ink" },
    { name: "Pro", price: "Not offered yet", subs: "0", mrr: "—", churn: "—", perks: "Lower commission, higher ranking: planned", bg: "bg-brand text-white" },
    { name: "Elite", price: "Not offered yet", subs: "0", mrr: "—", churn: "—", perks: "Featured badge, priority support: planned", bg: "bg-ink text-white" },
  ];

  return (
    <>
      <KpiGrid
        kpis={[
          { k: "Active subscriptions", v: "0", icon: "refresh", d: "No paid plans yet" },
          { k: "Monthly recurring revenue", v: "SAR 0", icon: "card", d: "—" },
          { k: "Expired (30d)", v: "0", icon: "clock", d: "—", dc: "#64748B", tone: "gold" },
          { k: "Churn", v: "—", icon: "down", d: "—" },
        ]}
      />
      <div className="grid grid-cols-3 gap-3.5">
        {plans.map((c) => (
          <div key={c.name} className={`flex flex-col gap-3 rounded-[18px] border border-hair p-[18px] ${c.bg}`}>
            <div className="flex items-center justify-between">
              <b className="text-base">{c.name}</b>
              <span className="text-[13px] opacity-75">{c.price}</span>
            </div>
            <div className="grid grid-cols-3 gap-2 text-xs">
              {[[c.subs, "Active"], [c.mrr, "MRR"], [c.churn, "Churn"]].map(([v, k]) => (
                <span key={k} className="flex flex-col gap-0.5 opacity-90">
                  <b className="text-[19px]">{v}</b>
                  {k}
                </span>
              ))}
            </div>
            <div className="text-[12.5px] opacity-80">{c.perks}</div>
          </div>
        ))}
      </div>
      <DataTable
        tabs={["Active", "Expiring", "Expired"].map((label) => ({ label, n: "0" }))}
        tab={tab}
        onTab={setTab}
        filters={FILTERS}
        filterValues={filters}
        onFilter={(k, v) => setFilters((p) => ({ ...p, [k]: v }))}
        onClearFilters={() => setFilters({})}
        columns={COLUMNS}
        rows={[]}
        footer="No paid subscriptions: every worker is on the standard commission"
      />
    </>
  );
}
