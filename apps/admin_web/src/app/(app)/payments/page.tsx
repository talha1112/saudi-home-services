"use client";

import { useState } from "react";
import { ReasonDialog } from "@/components/modals/ReasonDialog";
import { RefundDialog, findRefundTarget, type RefundTarget } from "@/components/modals/RefundDialog";
import { badge, mono, num, text, type Column } from "@/components/tables/cells";
import { ServerTablePage, type ServerFilter } from "@/components/tables/ServerTablePage";
import { useAdmin } from "@/lib/admin-context";
import { api, describeError, useQuery } from "@/lib/api";
import { humanize, sarH, shortH, whenLabel } from "@/lib/format";
import type { Kpi, Tone } from "@/types";

interface TransactionRow {
  bookingId: string;
  reference: string;
  customerName: string | null;
  serviceNameEn: string;
  method: "CASH" | "ONLINE";
  state: string;
  totalHalalas: number;
  vatHalalas: number;
  serviceAmountHalalas: number;
  commissionHalalas: number;
  workerPayoutHalalas: number;
  date: string | null;
  payment: { id: string; provider: string; providerPaymentId: string | null; simulated: boolean } | null;
}
interface RefundRow {
  refundId: string;
  paymentId: string;
  bookingId: string;
  reference: string;
  customerName: string | null;
  amountHalalas: number;
  reason: string;
  status: string;
  moneyReturned: boolean;
  date: string;
}
interface FailedRow {
  paymentId: string;
  bookingId: string;
  reference: string;
  customerName: string | null;
  amountHalalas: number;
  provider: string;
  status: string;
  failureCode: string | null;
  failureMessage: string | null;
  date: string;
}
type Row = TransactionRow | RefundRow | FailedRow;

interface Summary {
  agreedHalalas: number;
  vatHalalas: number;
  cash: { bookings: number; totalHalalas: number; stillToCollectBookings: number; stillToCollectHalalas: number };
  online: { bookings: number; totalHalalas: number };
  refundRequests: { count: number; amountHalalas: number };
  paymentAttempts: number;
  failedAttempts: number;
  failedSharePct: number | null;
}

const COLUMNS: Column[] = [
  { label: "Transaction", w: 1.4 }, { label: "Booking", w: 1 }, { label: "Customer", w: 1.2 }, { label: "Method", w: 1 },
  { label: "Amount", w: 0.9, align: "end" }, { label: "VAT", w: 0.7, align: "end" }, { label: "Status", w: 1.1 }, { label: "Date", w: 1.2 },
];
const FILTERS: ServerFilter[] = [{ key: "Method", label: "Method", options: ["All", "Cash", "Online"], param: (v) => ({ method: v === "Cash" ? "CASH" : "ONLINE" }) }];
const TABS = [{ label: "Transactions", params: { view: "transactions" } }, { label: "Refunds", params: { view: "refunds" } }, { label: "Failed", params: { view: "failed" } }];
const STATE_LABEL: Record<string, [string, Tone]> = { COLLECTED: ["Cash collected", "ok"], CASH_DUE: ["Cash on delivery", "warn"], PAID: ["Paid", "ok"], CANCELLED: ["Cancelled", "neutral"] };
const REFUND_TONE: Record<string, Tone> = { REQUESTED: "warn", PROCESSING: "warn", SUCCEEDED: "ok", FAILED: "bad", CANCELLED: "neutral" };

const isRefund = (r: Row): r is RefundRow => "refundId" in r;
const isFailed = (r: Row): r is FailedRow => "failureCode" in r;
const keyOf = (r: Row) => (isRefund(r) ? `refund-${r.refundId}` : isFailed(r) ? `failed-${r.paymentId}` : `tx-${r.bookingId}`);

export default function PaymentsPage() {
  const { city, span, version, bump, showToast } = useAdmin();
  const [refund, setRefund] = useState<RefundTarget | null>(null);
  const [cancelRefund, setCancelRefund] = useState<string | null>(null);
  const summary = useQuery<Summary>(`transactions/summary?from=${encodeURIComponent(span.from)}&to=${encodeURIComponent(span.to)}${city === "all" ? "" : `&cityId=${city}`}`, version);
  const s = summary.data;
  const kpis: Kpi[] = [
    { k: "Payments (incl. VAT)", v: s ? shortH(s.agreedHalalas) : "…", icon: "card", d: s ? `${s.cash.bookings + s.online.bookings} bookings paid or agreed` : "" },
    { k: "VAT", v: s ? shortH(s.vatHalalas) : "…", icon: "receipt", d: "Included in the payments", dc: "#64748B" },
    { k: "Refund requests", v: s ? shortH(s.refundRequests.amountHalalas) : "…", icon: "refresh", d: s ? `${s.refundRequests.count} requests` : "", dc: "#64748B", tone: "gold" },
    { k: "Failed payments", v: s?.failedSharePct != null ? `${s.failedSharePct}%` : "—", icon: "alert", d: s ? `${s.failedAttempts} of ${s.paymentAttempts} online attempts` : "", dc: "#B42318", tone: "red" },
  ];

  async function startRefund(reference: string) {
    try {
      setRefund(await findRefundTarget(reference));
    } catch (e) {
      showToast(e instanceof Error ? e.message : describeError(e));
    }
  }

  return (
    <>
      <ServerTablePage<Row>
        kpis={kpis}
        tabs={TABS}
        filters={FILTERS}
        path="transactions"
        params={{ from: span.from, to: span.to, cityId: city === "all" ? undefined : city }}
        exportName="payments"
        columns={COLUMNS}
        idOf={keyOf}
        toRow={(r) => {
          if (isRefund(r)) return { key: keyOf(r), cells: [mono(`RF-${r.refundId.slice(-8).toUpperCase()}`), mono(r.reference), text(r.customerName ?? "—"), text("Refund"), num(sarH(r.amountHalalas)), num("—", { fg: "#64748B" }), badge(humanize(r.status), REFUND_TONE[r.status]), text(whenLabel(r.date), undefined, { fg: "#64748B" })] };
          if (isFailed(r)) return { key: keyOf(r), cells: [mono(`PAY-${r.paymentId.slice(-8).toUpperCase()}`), mono(r.reference), text(r.customerName ?? "—"), text(humanize(r.provider)), num(sarH(r.amountHalalas)), num("—", { fg: "#64748B" }), badge(humanize(r.status), "bad"), text(whenLabel(r.date), undefined, { fg: "#64748B" })] };
          const [label, tone] = STATE_LABEL[r.state] ?? [humanize(r.state), "neutral" as Tone];
          return { key: keyOf(r), cells: [mono(r.payment ? `PAY-${r.payment.id.slice(-8).toUpperCase()}` : `CASH-${r.reference}`), mono(r.reference), text(r.customerName ?? "—"), text(r.method === "CASH" ? "Cash" : "Online"), num(sarH(r.totalHalalas)), num(sarH(r.vatHalalas), { fg: "#64748B" }), badge(label, tone), text(whenLabel(r.date), undefined, { fg: "#64748B" })] };
        }}
        footerBase={(shown, total) => `Showing ${shown} of ${total.toLocaleString("en-GB")} ${total === 1 ? "record" : "records"}`}
        panelFor={(r) => {
          if (isRefund(r)) {
            return {
              ini: "RF", title: `RF-${r.refundId.slice(-8).toUpperCase()}`, sub: `${r.reference} · ${r.customerName ?? "—"}`,
              badges: [{ l: humanize(r.status), tone: REFUND_TONE[r.status] }],
              stats: [{ v: sarH(r.amountHalalas), k: "Amount" }, { v: r.moneyReturned ? "Yes" : "No", k: "Money returned" }, { v: whenLabel(r.date).split(" · ")[0]!, k: "Requested" }],
              sections: [{ t: "Request", rows: [["Reason", r.reason], ["Status", humanize(r.status)], ["Note", r.moneyReturned ? "The provider confirmed the refund" : "Nothing has been returned: it is only a request"]] }],
              actions: r.status === "REQUESTED" ? [{ l: "Cancel refund request", icon: "x", danger: true, onClick: () => setCancelRefund(r.refundId) }] : [],
            };
          }
          if (isFailed(r)) {
            return {
              ini: "TX", title: `PAY-${r.paymentId.slice(-8).toUpperCase()}`, sub: `${r.reference} · ${r.customerName ?? "—"}`,
              badges: [{ l: humanize(r.status), tone: "bad" }],
              stats: [{ v: sarH(r.amountHalalas), k: "Amount" }, { v: humanize(r.provider), k: "Provider" }, { v: whenLabel(r.date).split(" · ")[0]!, k: "Date" }],
              sections: [{ t: "Why it failed", rows: [["Code", r.failureCode ?? "—"], ["Message", r.failureMessage ?? "—"]] }],
              actions: [],
            };
          }
          const [label, tone] = STATE_LABEL[r.state] ?? [humanize(r.state), "neutral" as Tone];
          return {
            ini: "TX", title: r.payment ? `PAY-${r.payment.id.slice(-8).toUpperCase()}` : `CASH-${r.reference}`, sub: `${r.reference} · ${r.customerName ?? "—"}`,
            badges: [{ l: label, tone }, { l: r.method === "CASH" ? "Cash" : "Online", tone: "neutral" }],
            stats: [{ v: sarH(r.totalHalalas), k: "Amount" }, { v: sarH(r.vatHalalas), k: "VAT" }, { v: r.method === "CASH" ? "Cash" : "Online", k: "Method" }],
            sections: [
              { t: "Breakdown", rows: [["Service amount", sarH(r.serviceAmountHalalas)], ["VAT", sarH(r.vatHalalas)], ["Total", sarH(r.totalHalalas)], ["Platform commission", sarH(r.commissionHalalas), "#8A5B00"], ["Worker earns", sarH(r.workerPayoutHalalas), "#00695C"]] },
              { t: r.method === "CASH" ? "Cash" : "Gateway", rows: r.payment ? [["Provider", humanize(r.payment.provider)], ["Provider payment", r.payment.providerPaymentId ?? "—"], ["Simulated", r.payment.simulated ? "Yes" : "No"]] : [["Collected by the worker", r.state === "COLLECTED" ? "Yes" : "Not yet"]] },
            ],
            actions: [
              { l: "View invoice", icon: "file", onClick: () => showToast("Invoices are not generated yet") },
              { l: "Issue refund", icon: "refresh", onClick: () => (r.method === "CASH" ? showToast("This booking is paid in cash: the worker returns cash in person") : void startRefund(r.reference)) },
            ],
          };
        }}
      />
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
      {cancelRefund && (
        <ReasonDialog
          title="Cancel refund request"
          subtitle="The request is withdrawn and the amount can be requested again."
          cta="Cancel request"
          required
          hint="A reason is required and is kept in the audit trail."
          onClose={() => setCancelRefund(null)}
          onConfirm={async (reason) => {
            try {
              await api.post(`refunds/${cancelRefund}/cancel`, { reason });
              showToast("Refund request cancelled");
              bump();
            } catch (e) {
              throw new Error(describeError(e));
            }
          }}
        />
      )}
    </>
  );
}
