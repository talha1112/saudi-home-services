"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ReasonDialog } from "@/components/modals/ReasonDialog";
import { badge, person, text, type Column } from "@/components/tables/cells";
import { DataTable } from "@/components/tables/DataTable";
import { DetailPanel } from "@/components/tables/DetailPanel";
import { KpiGrid } from "@/components/ui/KpiGrid";
import { useAdmin } from "@/lib/admin-context";
import { api, describeError, useQuery } from "@/lib/api";
import {
  DOCUMENT_LABEL, STATUS_LABEL, describeAvailability, initials,
  type Paged, type VerificationStatus, type WorkerDetail, type WorkerListItem,
} from "@/lib/workers-api";
import type { PanelData, Tone } from "@/types";

const COLUMNS: Column[] = [
  { label: "Worker", w: 2.4 }, { label: "Phone", w: 1.4 }, { label: "Services", w: 0.8, align: "end" }, { label: "Cities", w: 0.8, align: "end" },
  { label: "Documents", w: 0.9, align: "end" }, { label: "Status", w: 1.2 },
];
const TABS: { label: string; status: string }[] = [
  { label: "Approved", status: "APPROVED" },
  { label: "Suspended", status: "SUSPENDED" },
  { label: "Needs attention", status: "SUBMITTED,UNDER_REVIEW,INFO_REQUIRED,REJECTED" },
  { label: "Not submitted", status: "NOT_SUBMITTED" },
  { label: "All", status: "ALL" },
];
const TONE: Record<VerificationStatus, Tone> = {
  NOT_SUBMITTED: "neutral", SUBMITTED: "neutral", UNDER_REVIEW: "warn", INFO_REQUIRED: "warn", APPROVED: "ok", REJECTED: "bad", SUSPENDED: "bad",
};

function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export default function WorkersPage() {
  const { query, showToast } = useAdmin();
  const router = useRouter();
  const [tab, setTab] = useState(0);
  const [sel, setSel] = useState<string | null>(null);
  const [suspending, setSuspending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const q = useDebounced(query.trim());

  const list = useQuery<Paged<WorkerListItem>>(`workers?status=${TABS[tab]!.status}&sort=newest&limit=100${q ? `&q=${encodeURIComponent(q)}` : ""}`);
  const approved = useQuery<Paged<WorkerListItem>>("workers?status=APPROVED&limit=1");
  const suspended = useQuery<Paged<WorkerListItem>>("workers?status=SUSPENDED&limit=1");
  const waiting = useQuery<Paged<WorkerListItem>>("workers?status=SUBMITTED,UNDER_REVIEW&limit=1");
  const everyone = useQuery<Paged<WorkerListItem>>("workers?status=ALL&limit=1");
  const detail = useQuery<WorkerDetail>(sel ? `workers/${sel}` : null);

  const items = list.data?.items ?? [];
  const rows = items.map((w) => ({
    key: w.id,
    cells: [
      person(w.fullName ?? "Unnamed", initials(w.fullName), w.fullNameAr ?? undefined),
      text(w.phone ?? "—"),
      text(String(w.serviceCount), undefined, { align: "end", fw: 600 }),
      text(String(w.cityCount), undefined, { align: "end", fw: 600 }),
      text(String(w.documentCount), undefined, { align: "end", fw: 600 }),
      badge(STATUS_LABEL[w.verificationStatus], TONE[w.verificationStatus]),
    ],
  }));
  const count = (r: { data: Paged<WorkerListItem> | null }) => (r.data ? r.data.meta.total.toLocaleString("en-GB") : "…");

  const d = detail.data && detail.data.id === sel ? detail.data : null;
  async function decide(action: "suspend" | "reinstate", reason?: string) {
    await api.post(`workers/${sel}/${action}`, reason ? { reason } : {});
    showToast(action === "suspend" ? "Worker suspended" : "Worker reinstated");
    list.reload(); detail.reload(); approved.reload(); suspended.reload();
  }

  let panel: PanelData | null = null;
  if (sel && d) {
    panel = {
      ini: initials(d.fullName), title: d.fullName ?? "Unnamed worker", sub: [d.phone, d.email].filter(Boolean).join(" · ") || "—",
      badges: [{ l: STATUS_LABEL[d.verificationStatus], tone: TONE[d.verificationStatus] }, { l: `Account ${d.accountStatus.toLowerCase()}`, tone: d.accountStatus === "ACTIVE" ? "ok" : "bad" }],
      stats: [{ v: String(d.services.length), k: "Services" }, { v: String(d.cities.length), k: "Cities" }, { v: d.yearsOfExperience != null ? `${d.yearsOfExperience} y` : "—", k: "Experience" }],
      sections: [
        { t: "Profile", rows: [["Services", d.services.map((s) => s.nameEn).join(", ") || "—"], ["Cities", d.cities.map((c) => c.nameEn).join(", ") || "—"], ["Availability", describeAvailability(d.availability)]] },
        { t: "Verification", rows: [["Submitted", d.submittedAt ? new Date(d.submittedAt).toLocaleDateString("en-GB") : "—"], ["Verified", d.verifiedAt ? new Date(d.verifiedAt).toLocaleDateString("en-GB") : "—"], ["Latest note", d.verificationNote ?? "—"]] },
        { t: "Documents", rows: d.documents.length ? d.documents.map((x) => [DOCUMENT_LABEL[x.type] ?? x.type, x.status.toLowerCase()] as [string, string]) : [["None", ""] as [string, string]] },
      ],
      actions: [
        ...(d.verificationStatus === "SUSPENDED" ? [{ l: "Reinstate worker", icon: "refresh", onClick: () => { setActionError(null); decide("reinstate").catch((e) => setActionError(describeError(e))); } }] : []),
        ...(d.verificationStatus === "APPROVED" ? [{ l: "Suspend worker", icon: "alert", danger: true, onClick: () => { setActionError(null); setSuspending(true); } }] : []),
        ...(["SUBMITTED", "UNDER_REVIEW"].includes(d.verificationStatus) ? [{ l: "Open in verification queue", icon: "shield", onClick: () => router.push("/verification") }] : []),
      ],
    };
  }

  return (
    <>
      <KpiGrid
        kpis={[
          { k: "Total workers", v: count(everyone), icon: "wrench", d: "All applicants and workers" },
          { k: "Approved", v: count(approved), icon: "check", d: "Can take jobs", dc: "#64748B" },
          { k: "Waiting for review", v: count(waiting), icon: "shield", d: "Submitted or under review", dc: "#8A5B00", tone: "gold" },
          { k: "Suspended", v: count(suspended), icon: "alert", d: "Blocked by an admin", dc: "#B42318", tone: "red" },
        ]}
      />
      {list.error && <div role="alert" className="rounded-xl border border-danger-line bg-danger-bg px-4 py-3 text-[13.5px] text-danger">{describeError(list.error)} <button type="button" className="font-semibold underline" onClick={list.reload}>Try again</button></div>}
      {actionError && <div role="alert" className="rounded-xl border border-danger-line bg-danger-bg px-4 py-3 text-[13.5px] text-danger">{actionError}</div>}
      <DataTable
        tabs={TABS.map((t) => ({ label: t.label, n: i0(t.label, { approved, suspended, waiting, everyone }, count) }))}
        tab={tab}
        onTab={(i) => { setTab(i); setSel(null); }}
        columns={COLUMNS}
        rows={rows}
        selectedKey={sel}
        onRowClick={(k) => setSel((s) => (s === k ? null : String(k)))}
        footer={list.loading && !list.data ? "Loading…" : `Showing ${rows.length} of ${list.data?.meta.total ?? 0}${q ? ` matching “${q}”` : ""}${(list.data?.meta.total ?? 0) > rows.length ? " — refine the search to see the rest" : ""}`}
      />
      <DetailPanel data={panel} onClose={() => setSel(null)} />
      {suspending && sel && (
        <ReasonDialog title="Suspend worker" subtitle="The worker is blocked from taking jobs and sees this reason." cta="Suspend" required onClose={() => setSuspending(false)} onConfirm={async (r) => { try { await decide("suspend", r); } catch (e) { throw new Error(describeError(e)); } }} />
      )}
    </>
  );
}

/** Tab badge: the totals we already load; tabs without a cheap total show nothing. */
function i0(
  label: string,
  q: { approved: { data: Paged<WorkerListItem> | null }; suspended: { data: Paged<WorkerListItem> | null }; waiting: { data: Paged<WorkerListItem> | null }; everyone: { data: Paged<WorkerListItem> | null } },
  count: (r: { data: Paged<WorkerListItem> | null }) => string,
): string {
  if (label === "Approved") return count(q.approved);
  if (label === "Suspended") return count(q.suspended);
  if (label === "All") return count(q.everyone);
  return "";
}
