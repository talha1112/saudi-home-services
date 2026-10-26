"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ReasonDialog } from "@/components/modals/ReasonDialog";
import { badge, num, person, text, type Column } from "@/components/tables/cells";
import { ServerTablePage, type ServerFilter } from "@/components/tables/ServerTablePage";
import { useAdmin } from "@/lib/admin-context";
import { api, describeError, useQuery } from "@/lib/api";
import { dayLabel, humanize, sarH } from "@/lib/format";
import type { Kpi, Tone } from "@/types";

interface CustomerRow {
  id: string;
  fullName: string | null;
  initials: string;
  phone: string | null;
  status: string;
  city: { id: string; nameEn: string; nameAr: string } | null;
  bookings: number;
  completedBookings: number;
  spentHalalas: number;
  lastBookingAt: string | null;
  disputes: number;
  createdAt: string;
}

interface CustomerDetail {
  id: string;
  fullName: string | null;
  phone: string | null;
  phoneVerified: boolean;
  email: string | null;
  locale: string;
  status: string;
  statusReason: string | null;
  createdAt: string;
  lastLoginAt: string | null;
  bookings: number;
  spentHalalas: number;
  reviewsGiven: number;
  averageRatingGiven: number | null;
  recentBookings: { id: string; reference: string; status: string; totalHalalas: number | null; serviceNameEn: string }[];
  disputes: { id: string; category: string; status: string; bookingReference: string }[];
  paymentMethods: { method: string; bookings: number; totalHalalas: number }[];
}

interface Summary {
  total: number;
  byStatus: { status: string; count: number }[];
  customersWhoBooked: number;
  repeatCustomers: number;
  repeatSharePct: number | null;
  averageCompletedBookingHalalas: number | null;
  withDisputes: number;
}

const COLUMNS: Column[] = [
  { label: "Customer", w: 2.2 }, { label: "City", w: 1 }, { label: "Bookings", w: 0.9, align: "end" }, { label: "Total spent", w: 1.1, align: "end" },
  { label: "Last booking", w: 1 }, { label: "Disputes", w: 0.8, align: "end" }, { label: "Status", w: 1 },
];

const FILTERS: ServerFilter[] = [
  {
    key: "Spend", label: "Spend", options: ["Any", "SAR 1,000+", "SAR 500 – 999", "Under SAR 500"],
    param: (v) => (v === "SAR 1,000+" ? { minSpentHalalas: "100000" } : v === "Under SAR 500" ? { maxSpentHalalas: "50000" } : { minSpentHalalas: "50000", maxSpentHalalas: "100000" }),
  },
  { key: "Disputes", label: "Disputes", options: ["Any", "Has disputes", "No disputes"], param: (v) => ({ hasDisputes: v === "Has disputes" ? "true" : "false" }) },
];

const TABS = [{ label: "All" }, { label: "Active", params: { status: "ACTIVE" } }, { label: "Flagged", params: { status: "SUSPENDED" } }];
const TONE: Record<string, Tone> = { ACTIVE: "ok", SUSPENDED: "bad", PENDING_VERIFICATION: "warn", DEACTIVATED: "neutral" };
const statusLabel = (s: string) => (s === "SUSPENDED" ? "Flagged" : s === "PENDING_VERIFICATION" ? "Pending" : humanize(s));

export default function CustomersPage() {
  const { city, version, bump, showToast, setQuery } = useAdmin();
  const router = useRouter();
  const [dialog, setDialog] = useState<{ id: string; suspended: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const summary = useQuery<Summary>("customers/summary", version);
  const s = summary.data;
  const count = (status: string) => s?.byStatus.find((b) => b.status === status)?.count ?? 0;
  const kpis: Kpi[] = [
    { k: "Customers", v: s ? s.total.toLocaleString("en-GB") : "…", icon: "users", d: s ? `${s.customersWhoBooked.toLocaleString("en-GB")} have booked` : "" },
    { k: "Repeat customers", v: s?.repeatSharePct != null ? `${s.repeatSharePct}%` : "—", icon: "refresh", d: s ? `${s.repeatCustomers.toLocaleString("en-GB")} booked 2+ times` : "" },
    { k: "Avg. spend", v: s?.averageCompletedBookingHalalas != null ? sarH(s.averageCompletedBookingHalalas) : "—", icon: "card", d: "Per completed booking", dc: "#64748B" },
    { k: "Flagged accounts", v: s ? String(count("SUSPENDED")) : "…", icon: "flag", d: s ? `${s.withDisputes} with disputes` : "", dc: "#B42318", tone: "red" },
  ];

  async function decide(id: string, suspended: boolean, reason: string) {
    await api.post(`users/${id}/${suspended ? "reactivate" : "suspend"}`, { reason });
    showToast(suspended ? "Account reactivated" : "Account suspended");
    bump();
  }

  return (
    <>
      <ServerTablePage<CustomerRow, CustomerDetail>
        kpis={kpis}
        tabs={TABS}
        filters={FILTERS}
        path="customers"
        params={{ cityId: city === "all" ? undefined : city }}
        columns={COLUMNS}
        idOf={(c) => c.id}
        toRow={(c) => ({
          key: c.id,
          cells: [person(c.fullName ?? "Unnamed", c.initials, c.phone ?? undefined), text(c.city?.nameEn ?? "—"), num(c.bookings), num(sarH(c.spentHalalas)), text(dayLabel(c.lastBookingAt)), num(c.disputes), badge(statusLabel(c.status), TONE[c.status])],
        })}
        footerBase={(shown, total) => `Showing ${shown} of ${total.toLocaleString("en-GB")} customers`}
        detailPath={(c) => `customers/${c.id}`}
        notice={error ? <div role="alert" className="rounded-xl border border-danger-line bg-danger-bg px-4 py-3 text-[13.5px] text-danger">{error}</div> : undefined}
        panelFor={(c, { detail }) => {
          const d = detail && detail.id === c.id ? detail : null;
          return {
            ini: c.initials, title: c.fullName ?? "Unnamed customer", sub: [c.phone, c.city?.nameEn].filter(Boolean).join(" · ") || "—",
            badges: [{ l: statusLabel(c.status), tone: TONE[c.status] }, ...(d?.phoneVerified ? [{ l: "Phone verified", tone: "neutral" as Tone }] : [])],
            stats: [{ v: String(c.bookings), k: "Bookings" }, { v: sarH(c.spentHalalas), k: "Total spent" }, { v: d?.averageRatingGiven != null ? String(d.averageRatingGiven) : "—", k: "Avg. rating given" }],
            sections: [
              { t: "Account", rows: [["Phone", d?.phone ?? c.phone ?? "—"], ["Email", d?.email ?? "—"], ["Joined", dayLabel(c.createdAt)], ["Language", d ? (d.locale === "AR" ? "Arabic" : "English") : "—"], ["Last sign-in", d?.lastLoginAt ? dayLabel(d.lastLoginAt) : "—"], ...(d?.statusReason ? [["Status reason", d.statusReason] as [string, string]] : [])] },
              { t: "Booking history", rows: d ? (d.recentBookings.length ? d.recentBookings.map((b) => [`${b.reference} · ${b.serviceNameEn}`, b.totalHalalas != null ? sarH(b.totalHalalas) : humanize(b.status)] as [string, string]) : [["No bookings", "—"]]) : [["Loading…", ""]] },
              { t: "Payment history", rows: d ? (d.paymentMethods.length ? d.paymentMethods.map((p) => [p.method === "CASH" ? "Cash on delivery" : "Online", sarH(p.totalHalalas)] as [string, string]) : [["No payments", "—"]]) : [["Loading…", ""]] },
              { t: "Disputes", rows: d ? (d.disputes.length ? d.disputes.map((x) => [`${x.bookingReference} · ${humanize(x.status)}`, humanize(x.category), x.status === "OPEN" || x.status === "UNDER_REVIEW" ? "#8A5B00" : undefined] as [string, string, string?]) : [["No disputes", "—"]]) : [["Loading…", ""]] },
            ],
            actions: [
              { l: "Message customer", icon: "message", onClick: () => { setQuery(c.fullName ?? ""); router.push("/support"); } },
              { l: c.status === "SUSPENDED" ? "Reactivate account" : "Suspend account", icon: "alert", danger: c.status !== "SUSPENDED", onClick: () => { setError(null); setDialog({ id: c.id, suspended: c.status === "SUSPENDED" }); } },
            ],
          };
        }}
      />
      {dialog && (
        <ReasonDialog
          title={dialog.suspended ? "Reactivate account" : "Suspend account"}
          subtitle={dialog.suspended ? "The customer can sign in and book again." : "The customer is signed out at once and cannot book. Existing bookings are left as they are."}
          cta={dialog.suspended ? "Reactivate" : "Suspend"}
          required
          hint="A reason is required and is kept in the audit trail."
          onClose={() => setDialog(null)}
          onConfirm={async (r) => {
            try {
              await decide(dialog.id, dialog.suspended, r);
            } catch (e) {
              throw new Error(describeError(e));
            }
          }}
        />
      )}
    </>
  );
}
