"use client";

import { useMemo, useState } from "react";
import { ReasonDialog } from "@/components/modals/ReasonDialog";
import { RefundDialog, findRefundTarget, type RefundTarget } from "@/components/modals/RefundDialog";
import { badge, mono, num, text, type Column } from "@/components/tables/cells";
import { ServerTablePage, type Paged, type ServerFilter } from "@/components/tables/ServerTablePage";
import { useAdmin } from "@/lib/admin-context";
import { api, describeError, useQuery } from "@/lib/api";
import { dayLabel, humanize, sarH, whenLabel } from "@/lib/format";
import type { Kpi, Tone } from "@/types";

interface BookingRow {
  id: string;
  reference: string;
  status: string;
  service: { nameEn: string; nameAr: string };
  customerName: string | null;
  workerName: string | null;
  cityNameEn: string | null;
  preferredStartAt: string;
  money: { totalHalalas: number } | null;
  paymentMethod: "CASH" | "ONLINE" | null;
  cashCollected: boolean;
  quoteCount: number;
}

interface BookingDetail {
  id: string;
  reference: string;
  status: string;
  problemDescription: string;
  customerPhone: string | null;
  location: { cityNameEn: string; district: string | null; addressLine?: string; building?: string | null };
  worker: { fullName: string | null; phone?: string | null } | null;
  paymentMethod: "CASH" | "ONLINE" | null;
  cashCollectedAt?: string | null;
  money: { serviceHalalas: number; vatHalalas: number; totalHalalas: number; vatRateBps: number } | null;
  fullMoney: { commissionHalalas: number; payoutHalalas: number; commissionRateBps: number } | null;
  quotes: { id: string; status: string }[];
  timeline: { type: string; createdAt: string; amountHalalas: number | null; note: string | null }[];
  cancelledAt: string | null;
}

const COLUMNS: Column[] = [
  { label: "Booking", w: 1.1 }, { label: "Service · customer", w: 2 }, { label: "Professional", w: 1.5 }, { label: "City", w: 0.9 },
  { label: "Scheduled", w: 1.4 }, { label: "Amount", w: 0.9, align: "end" }, { label: "Payment", w: 1.1 }, { label: "Status", w: 1.2 },
];

const STATUS_LABEL: Record<string, string> = {
  OPEN: "Quotes pending", PAYMENT_PENDING: "Payment pending", CONFIRMED: "Confirmed", IN_PROGRESS: "In progress", COMPLETED: "Completed", CANCELLED: "Cancelled", EXPIRED: "Expired",
};
const STATUS_TONE: Record<string, Tone> = { OPEN: "warn", PAYMENT_PENDING: "warn", CONFIRMED: "neutral", IN_PROGRESS: "ok", COMPLETED: "ok", CANCELLED: "neutral", EXPIRED: "neutral" };
const TABS = [
  { label: "All" },
  { label: "Active", params: { status: "OPEN,PAYMENT_PENDING,CONFIRMED,IN_PROGRESS" } },
  { label: "Completed", params: { status: "COMPLETED" } },
  { label: "Cancelled", params: { status: "CANCELLED,EXPIRED" } },
];
const EVENT_LABEL: Record<string, string> = {
  BOOKING_CREATED: "Requested", QUOTE_SUBMITTED: "Quote received", QUOTE_REVISED: "Quote updated", QUOTE_WITHDRAWN: "Quote withdrawn", QUOTE_ACCEPTED: "Quote accepted",
  QUOTE_REJECTED: "Quote not chosen", QUOTE_CHANGE_REQUESTED: "Change requested", QUOTE_EXPIRED: "Quote expired", PAYMENT_CONFIRMED: "Payment confirmed", WORK_STARTED: "Work started", WORK_COMPLETED: "Work completed",
  BOOKING_CANCELLED: "Cancelled", BOOKING_EXPIRED: "Request expired",
};

function paymentCell(b: BookingRow): { label: string; tone: Tone } {
  if (b.paymentMethod === "CASH") return b.cashCollected ? { label: "Cash collected", tone: "ok" } : { label: "Cash on delivery", tone: "warn" };
  if (b.paymentMethod === "ONLINE") return { label: "Paid", tone: "ok" };
  if (b.status === "PAYMENT_PENDING") return { label: "Awaiting payment", tone: "warn" };
  return { label: "—", tone: "neutral" };
}

export default function BookingsPage() {
  const { city, span, version, bump, showToast } = useAdmin();
  const [cancelId, setCancelId] = useState<string | null>(null);
  const [refund, setRefund] = useState<RefundTarget | null>(null);

  const services = useQuery<{ items: { id: string; nameEn: string }[] }>("services?limit=100");
  const workers = useQuery<Paged<{ id: string; fullName: string | null }>>("workers?status=APPROVED&limit=100&sort=newest");
  const overview = useQuery<{ kpis: { bookingsCreated: number; inProgress: number; completionRatePct: number | null; cancelledBookings: number; completedBookings: number } }>(
    `dashboard?from=${encodeURIComponent(span.from)}&to=${encodeURIComponent(span.to)}${city === "all" ? "" : `&cityId=${city}`}`,
    version,
  );

  const serviceId = useMemo(() => new Map((services.data?.items ?? []).map((s) => [s.nameEn, s.id])), [services.data]);
  const workerId = useMemo(() => new Map((workers.data?.items ?? []).filter((w) => w.fullName).map((w) => [w.fullName!, w.id])), [workers.data]);
  const filters: ServerFilter[] = [
    { key: "Service", label: "Service", options: ["All", ...serviceId.keys()], param: (v) => ({ serviceId: serviceId.get(v) }) },
    { key: "Professional", label: "Professional", options: ["All", ...workerId.keys()], param: (v) => ({ workerId: workerId.get(v) }) },
    { key: "Payment", label: "Payment", options: ["All", "Cash", "Online", "Awaiting payment"], param: (v) => (v === "Cash" ? { paymentMethod: "CASH" } : v === "Online" ? { paymentMethod: "ONLINE" } : { status: "PAYMENT_PENDING" }) },
  ];

  const k = overview.data?.kpis;
  const kpis: Kpi[] = [
    { k: "Bookings in range", v: k ? k.bookingsCreated.toLocaleString("en-GB") : "…", icon: "calendar", d: "Created in the chosen dates" },
    { k: "In progress", v: k ? String(k.inProgress) : "…", icon: "wrench", d: "Right now", dc: "#64748B" },
    { k: "Completion rate", v: k?.completionRatePct != null ? `${k.completionRatePct}%` : "—", icon: "check", d: k ? `${k.completedBookings} completed in range` : "", dc: "#64748B" },
    { k: "Cancelled", v: k ? String(k.cancelledBookings) : "…", icon: "x", d: "In the chosen dates", tone: "gold" },
  ];

  async function startRefund(reference: string) {
    try {
      setRefund(await findRefundTarget(reference));
    } catch (e) {
      showToast(describeError(e));
    }
  }

  return (
    <>
      <ServerTablePage<BookingRow, BookingDetail>
        kpis={kpis}
        tabs={TABS}
        filters={filters}
        path="bookings"
        params={{ cityId: city === "all" ? undefined : city, createdFrom: span.from, createdTo: span.to }}
        exportName="bookings"
        columns={COLUMNS}
        idOf={(b) => b.id}
        toRow={(b) => {
          const pay = paymentCell(b);
          return {
            key: b.id,
            cells: [mono(b.reference), text(b.service.nameEn, b.customerName ?? undefined, { fw: 600 }), text(b.workerName ?? "—", undefined, { fg: b.workerName ? "#172B35" : "#64748B" }), text(b.cityNameEn ?? "—"), text(whenLabel(b.preferredStartAt)), num(b.money ? sarH(b.money.totalHalalas) : "—"), badge(pay.label, pay.tone), badge(STATUS_LABEL[b.status] ?? humanize(b.status), STATUS_TONE[b.status])],
          };
        }}
        footerBase={(shown, total) => `Showing ${shown} of ${total.toLocaleString("en-GB")} bookings`}
        detailPath={(b) => `bookings/${b.id}`}
        panelFor={(b, { detail }) => {
          const d = detail && detail.id === b.id ? detail : null;
          const pay = paymentCell(b);
          const open = !["COMPLETED", "CANCELLED", "EXPIRED"].includes(b.status);
          return {
            ini: "HS", title: b.reference, sub: `${b.service.nameEn} · ${b.cityNameEn ?? "—"}`,
            badges: [{ l: STATUS_LABEL[b.status] ?? humanize(b.status), tone: STATUS_TONE[b.status] }, { l: pay.label, tone: pay.tone }],
            sections: [
              { t: "Parties", rows: [["Customer", b.customerName ?? "—"], ["Customer phone", d?.customerPhone ?? "—"], ["Professional", b.workerName ?? "—"], ["Scheduled", whenLabel(b.preferredStartAt)], ["Address", d ? ([d.location.addressLine, d.location.building, d.location.district].filter(Boolean).join(", ") || "—") : "…"]] },
              { t: "Problem described", rows: [[d?.problemDescription ?? "…", ""]] },
              {
                t: "Quote & price agreement",
                rows: d
                  ? [["Quotes received", String(d.quotes.length)], ["Service price", d.money ? sarH(d.money.serviceHalalas) : "—"], [`VAT ${d.money ? d.money.vatRateBps / 100 : 15}%`, d.money ? sarH(d.money.vatHalalas) : "—"], ["Total", d.money ? sarH(d.money.totalHalalas) : "—"], ["Platform commission", d.fullMoney ? `${sarH(d.fullMoney.commissionHalalas)} (${d.fullMoney.commissionRateBps / 100}%)` : "—", "#8A5B00"], ["Worker earns", d.fullMoney ? sarH(d.fullMoney.payoutHalalas) : "—", "#00695C"]]
                  : [["Loading…", ""]],
              },
              { t: "Payment", rows: [["Method", b.paymentMethod === "CASH" ? "Cash on delivery" : b.paymentMethod === "ONLINE" ? "Online" : "Not chosen yet"], ["Status", pay.label]] },
              { t: "Timeline", rows: d ? d.timeline.map((e) => [EVENT_LABEL[e.type] ?? humanize(e.type), `${dayLabel(e.createdAt)} ${whenLabel(e.createdAt).split(" · ")[1] ?? ""}`.trim()] as [string, string]) : [["Loading…", ""]] },
            ],
            actions: [
              { l: "Reassign professional", icon: "refresh", onClick: () => showToast("Reassigning a professional is not available yet: cancel the booking and the customer can request again") },
              { l: "Issue refund", icon: "card", onClick: () => (b.paymentMethod === "CASH" ? showToast("This booking is paid in cash: the worker returns cash in person") : void startRefund(b.reference)) },
              ...(open ? [{ l: "Cancel booking", icon: "x", danger: true, onClick: () => setCancelId(b.id) }] : []),
            ],
          };
        }}
      />
      {cancelId && (
        <ReasonDialog
          title="Cancel booking"
          subtitle="The customer and the professional are told. A booking that is cancelled cannot be restored."
          cta="Cancel booking"
          required
          hint="A reason is required and is kept in the booking history."
          onClose={() => setCancelId(null)}
          onConfirm={async (note) => {
            try {
              await api.post(`bookings/${cancelId}/cancel`, { note });
              showToast("Booking cancelled");
              bump();
            } catch (e) {
              throw new Error(describeError(e));
            }
          }}
        />
      )}
      {refund && (
        <RefundDialog
          target={refund}
          onClose={() => setRefund(null)}
          onDone={() => {
            showToast("Refund requested");
            bump();
          }}
        />
      )}
    </>
  );
}
