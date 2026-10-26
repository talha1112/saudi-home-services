"use client";

import { useState } from "react";
import { Badge, Card } from "@/components/ui/primitives";
import { Icon } from "@/components/ui/Icon";
import { useAdmin } from "@/lib/admin-context";
import { api, describeError, qs, useQuery, useTotals } from "@/lib/api";
import { dayLabel, humanize, sarH, whenLabel } from "@/lib/format";
import { initials } from "@/lib/workers-api";
import type { Paged } from "@/components/tables/ServerTablePage";
import type { Tone } from "@/types";

type Status = "OPEN" | "UNDER_REVIEW" | "AWAITING_INFO" | "RESOLVED" | "CLOSED";

interface DisputeItem {
  id: string;
  bookingId: string;
  bookingReference: string;
  category: string;
  status: Status;
  customerName: string | null;
  workerName: string | null;
  serviceNameEn: string | null;
  cityNameEn: string | null;
  amountHalalas: number | null;
  createdAt: string;
}

interface DisputeEvent {
  id: string;
  action: string;
  actorName: string | null;
  actorRole: "CUSTOMER" | "WORKER" | "ADMIN" | null;
  visibility: "PARTICIPANTS" | "INTERNAL";
  note: string | null;
  createdAt: string;
}

type Evidence = { kind: "BOOKING_PHOTO"; id: string; fileName: string } | { kind: "CHAT_MESSAGE"; id: string; body: string; senderRole: string };

interface DisputeDetail extends DisputeItem {
  description: string;
  openedByName: string | null;
  openedByRole: "CUSTOMER" | "WORKER";
  resolutionSummary: string | null;
  financialFollowup: "NONE" | "REQUESTED";
  booking: { id: string; paymentMethod: "CASH" | "ONLINE" | null; status: string };
  events: DisputeEvent[];
  evidence: Evidence[];
}

const TABS: { label: string; status?: string }[] = [
  { label: "All" },
  { label: "Submitted", status: "OPEN" },
  { label: "Under review", status: "UNDER_REVIEW" },
  { label: "Action required", status: "AWAITING_INFO" },
  { label: "Resolved", status: "RESOLVED,CLOSED" },
];
const STATUS: Record<Status, [string, Tone]> = {
  OPEN: ["Submitted", "neutral"],
  UNDER_REVIEW: ["Under review", "warn"],
  AWAITING_INFO: ["Action required", "bad"],
  RESOLVED: ["Resolved", "ok"],
  CLOSED: ["Closed", "ok"],
};
const BAR: Record<string, string> = { AWAITING_INFO: "#B42318" };
const OPTIONS: { label: string; refund: "full" | "half" | null; summary: string; close?: boolean }[] = [
  { label: "Full refund to customer", refund: "full", summary: "Resolved in the customer's favour. A full refund will be handled by the support team." },
  { label: "Partial refund", refund: "half", summary: "Resolved with a partial refund to the customer. The support team will handle it." },
  { label: "Re-do service at no cost", refund: null, summary: "Resolved: the professional will redo the service at no cost to the customer." },
  { label: "No refund · close dispute", refund: null, summary: "Reviewed and closed without a refund.", close: true },
];

const idLabel = (id: string) => `DSP-${id.slice(-6).toUpperCase()}`;
const person = (n: string | null) => n ?? "—";

export default function DisputesPage() {
  const { city, span, debouncedQuery: q, version, bump, showToast } = useAdmin();
  const [tab, setTab] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [option, setOption] = useState(1);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [reloads, setReloads] = useState(0);

  const shared = { cityId: city === "all" ? undefined : city, from: span.from, to: span.to, q: q || undefined };
  const list = useQuery<Paged<DisputeItem>>(`disputes?${qs({ ...shared, status: TABS[tab]!.status, limit: 50 })}`, version + reloads);
  const counts = useTotals(TABS.map((t) => `disputes?${qs({ ...shared, status: t.status, limit: 1 })}`), version + reloads);
  const items = list.data?.items ?? [];
  const current = items.find((i) => i.id === selected) ?? items[0] ?? null;
  const detail = useQuery<DisputeDetail>(current ? `disputes/${current.id}` : null, version + reloads);
  const d = detail.data && current && detail.data.id === current.id ? detail.data : null;
  const [stLabel, stTone] = current ? STATUS[current.status] : ["", "neutral" as Tone];
  const finished = current?.status === "RESOLVED" || current?.status === "CLOSED";

  const reload = () => {
    setReloads((n) => n + 1);
    bump();
  };

  async function send() {
    const text = message.trim();
    if (!current || !text || busy) return;
    setBusy(true);
    try {
      // Asking the two sides for something is only possible while the dispute is open or under review.
      if (current.status === "AWAITING_INFO") await api.post(`disputes/${current.id}/start-review`, {});
      await api.post(`disputes/${current.id}/request-info`, { note: text });
      setMessage("");
      showToast("Message sent to the customer and the professional");
      reload();
    } catch (e) {
      showToast(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function resolve() {
    if (!current || busy) return;
    const o = OPTIONS[option]!;
    setBusy(true);
    try {
      if (current.status !== "UNDER_REVIEW") await api.post(`disputes/${current.id}/start-review`, {});
      await api.post(`disputes/${current.id}/resolve`, { summary: o.summary, financialFollowup: o.refund ? "REQUESTED" : "NONE" });
      if (o.close) await api.post(`disputes/${current.id}/close`, { note: "Closed without a refund." });
      showToast(o.close ? "Dispute closed" : "Dispute resolved");
      reload();
    } catch (e) {
      showToast(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function openEvidence(bookingId: string, photoId: string) {
    try {
      const r = await api.get<{ url: string }>(`bookings/${bookingId}/photos/${photoId}/download-url`);
      window.open(r.url, "_blank", "noopener");
    } catch (e) {
      showToast(describeError(e));
    }
  }

  const thread = d
    ? [
        { key: "opened", name: d.openedByName ?? "—", role: d.openedByRole === "WORKER" ? "Professional" : "Customer", time: d.createdAt, text: d.description, internal: false, side: d.openedByRole === "WORKER" ? "worker" : "customer" },
        ...d.events
          .filter((e) => (e.action === "COMMENT" || e.action === "INFO_REQUESTED" || e.action === "INTERNAL_NOTE" || e.action === "RESOLVED") && e.note)
          .map((e) => ({
            key: e.id,
            name: e.actorName ?? (e.actorRole === "ADMIN" ? "Support" : e.actorRole === "WORKER" ? person(d.workerName) : person(d.customerName)),
            role: e.actorRole === "ADMIN" ? "Support" : e.actorRole === "WORKER" ? "Professional" : "Customer",
            time: e.createdAt,
            text: e.note!,
            internal: e.visibility === "INTERNAL",
            side: e.actorRole === "ADMIN" ? "admin" : e.actorRole === "WORKER" ? "worker" : "customer",
          })),
      ]
    : [];
  const STYLE: Record<string, { bg: string; fg: string }> = { customer: { bg: "#F1F4F6", fg: "#172B35" }, worker: { bg: "#E6F0EE", fg: "#00695C" }, admin: { bg: "#172B35", fg: "#F4B740" } };
  const amount = current?.amountHalalas ?? null;
  const optionAmount = (o: (typeof OPTIONS)[number]) => (o.refund && amount != null ? sarH(o.refund === "half" ? Math.round(amount / 2) : amount) : "—");

  return (
    <div className="grid grid-cols-[340px_minmax(0,1fr)] items-start gap-4">
      <Card className="overflow-hidden">
        <div className="flex flex-wrap gap-1 border-b border-soft p-2.5">
          {TABS.map((t, i) => (
            <button key={t.label} type="button" onClick={() => { setTab(i); setSelected(null); }} className={`h-[30px] rounded-[9px] px-2.5 text-[12.5px] font-semibold ${tab === i ? "bg-ink text-white" : "text-slate"}`}>
              {t.label} <span className="opacity-65">{counts[i] ?? ""}</span>
            </button>
          ))}
        </div>
        {list.error && <div role="alert" className="px-4 py-3 text-[13px] text-danger">{describeError(list.error)}</div>}
        {items.map((x) => {
          const [label, tone] = STATUS[x.status];
          const on = current?.id === x.id;
          return (
            <button key={x.id} type="button" onClick={() => setSelected(x.id)} className={`flex w-full flex-col gap-1.5 border-b border-l-[3px] border-b-faint px-4 py-[13px] text-start ${on ? "bg-[#f3f8f7]" : "bg-white"}`} style={{ borderLeftColor: on ? "#00695C" : (BAR[x.status] ?? "transparent") }}>
              <div className="flex w-full justify-between gap-2"><b className="text-[13.5px]">{humanize(x.category)}</b><span className="text-[11.5px] text-slate">{idLabel(x.id)}</span></div>
              <div className="text-[12.5px] text-slate">{person(x.customerName)} vs {person(x.workerName)} · {x.cityNameEn ?? "—"}</div>
              <div className="flex w-full items-center justify-between"><Badge label={label} tone={tone} className="!rounded-md !px-2 !py-0.5 !text-[11px]" /><span className="text-[12.5px] font-bold">{sarH(x.amountHalalas)}</span></div>
            </button>
          );
        })}
        {items.length === 0 && <div className="px-4 py-10 text-center text-[13.5px] text-slate">{list.loading ? "Loading…" : "No disputes match the current filters."}</div>}
      </Card>
      {current ? (
        <Card className="flex flex-col">
          <div className="flex items-start gap-3.5 border-b border-soft px-5 py-[18px]">
            <div className="flex flex-1 flex-col gap-1">
              <div className="text-xs text-slate">{idLabel(current.id)} · Booking {current.bookingReference}</div>
              <div className="text-lg font-bold">{humanize(current.category)}</div>
              <div className="text-[13px] text-slate">{humanize(current.category)} · {current.serviceNameEn ?? "—"} · {current.cityNameEn ?? "—"} · opened {dayLabel(current.createdAt)}</div>
            </div>
            <Badge label={stLabel} tone={stTone} className="!px-2.5 !py-[5px] !text-[12.5px]" />
          </div>
          <div className="grid grid-cols-4 gap-px border-b border-soft bg-soft">
            {[["Customer", person(current.customerName)], ["Professional", person(current.workerName)], ["Amount paid", sarH(current.amountHalalas)], ["Booking", d ? humanize(d.booking.status) : "…"]].map(([k, v]) => (
              <div key={k} className="flex flex-col gap-[3px] bg-white px-4 py-3"><span className="text-[11.5px] text-slate">{k}</span><span className="text-[13.5px] font-semibold">{v}</span></div>
            ))}
          </div>
          <div className="grid grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
            <div className="flex flex-col gap-3 border-r border-soft px-5 py-[18px]">
              <div className="text-sm font-bold">Conversation</div>
              {thread.length === 0 && <div className="text-[13px] text-slate">{detail.loading ? "Loading…" : "No messages yet."}</div>}
              {thread.map((m) => (
                <div key={m.key} className="flex gap-2.5">
                  <span className="grid size-[30px] shrink-0 place-items-center rounded-[9px] text-[11px] font-bold" style={{ background: STYLE[m.side]!.bg, color: STYLE[m.side]!.fg }}>{initials(m.name === "—" ? null : m.name)}</span>
                  <div className="flex flex-1 flex-col gap-[3px]">
                    <div className="flex items-baseline gap-2"><b className="text-[13px]">{m.name}</b><span className="text-[11.5px] text-slate">{m.role}{m.internal ? " · internal note" : ""} · {whenLabel(m.time)}</span></div>
                    <div className="text-[13.5px] leading-normal text-[#334155]">{m.text}</div>
                  </div>
                </div>
              ))}
              <div className="mt-1 flex gap-2">
                <input
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void send()}
                  disabled={finished}
                  maxLength={2000}
                  placeholder={finished ? "This dispute is finished" : "Message customer and worker…"}
                  className="h-10 flex-1 rounded-[11px] border-[1.5px] border-line px-3 text-[13.5px]"
                />
                <button type="button" disabled={finished || busy || !message.trim()} onClick={() => void send()} className={`h-10 rounded-[11px] bg-ink px-3.5 text-[13px] font-semibold text-white ${finished || busy || !message.trim() ? "opacity-50" : ""}`}>Send</button>
              </div>
            </div>
            <div className="flex flex-col gap-3 px-5 py-[18px]">
              <div className="text-sm font-bold">Evidence</div>
              <div className="grid grid-cols-3 gap-2">
                {(d?.evidence ?? []).map((e, i) =>
                  e.kind === "BOOKING_PHOTO" ? (
                    <button key={e.id} type="button" onClick={() => void openEvidence(current.bookingId, e.id)} title={e.fileName} className="flex aspect-square flex-col items-center justify-center gap-1 rounded-[11px] text-[10.5px] text-muted" style={{ background: "repeating-linear-gradient(135deg,#EEF2F4 0 8px,#F7F9FA 8px 16px)" }}>
                      <Icon name="image" size={20} />Photo · {i + 1}
                    </button>
                  ) : (
                    <div key={e.id} title={e.body} className="flex aspect-square flex-col items-center justify-center gap-1 overflow-hidden rounded-[11px] px-1.5 text-center text-[10.5px] text-muted" style={{ background: "repeating-linear-gradient(135deg,#EEF2F4 0 8px,#F7F9FA 8px 16px)" }}>
                      <Icon name="message" size={18} /><span className="line-clamp-3">{e.body}</span>
                    </div>
                  ),
                )}
                {d && d.evidence.length === 0 && <div className="col-span-3 text-[13px] text-slate">Nothing attached.</div>}
              </div>
              <div className="mt-1.5 text-sm font-bold">Resolution</div>
              {finished ? (
                <div className="rounded-[11px] border-[1.5px] border-line px-3 py-2.5 text-[13px] leading-normal">
                  <b>{current.status === "CLOSED" ? "Closed" : "Resolved"}</b>
                  <div className="text-slate">{d?.resolutionSummary ?? ""}</div>
                  {d?.financialFollowup === "REQUESTED" && <div className="mt-1 text-[12px] font-semibold text-[#8A5B00]">A refund follow-up is flagged for the support team.</div>}
                </div>
              ) : (
                <>
                  {OPTIONS.map((o, i) => (
                    <button key={o.label} type="button" onClick={() => setOption(i)} className={`flex items-center gap-2.5 rounded-[11px] border-[1.5px] bg-white px-3 py-2.5 text-start text-[13px] ${option === i ? "border-brand" : "border-line"}`}>
                      <span className={`grid size-[18px] shrink-0 place-items-center rounded-full border-2 ${option === i ? "border-brand" : "border-[#c9d3d9]"}`}><span className={`size-2 rounded-full ${option === i ? "bg-brand" : "bg-transparent"}`} /></span>
                      <span className="flex-1 font-semibold">{o.label}</span>
                      <span className="text-slate">{optionAmount(o)}</span>
                    </button>
                  ))}
                  <button type="button" disabled={busy} onClick={() => void resolve()} className={`mt-1 h-11 rounded-xl bg-brand font-semibold text-white ${busy ? "opacity-60" : ""}`}>{busy ? "Working…" : "Resolve dispute"}</button>
                </>
              )}
            </div>
          </div>
        </Card>
      ) : (
        <Card className="px-5 py-14 text-center text-[13.5px] text-slate">{list.loading ? "Loading…" : "Select a dispute to see it."}</Card>
      )}
    </div>
  );
}
