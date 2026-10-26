"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { KpiGrid } from "@/components/ui/KpiGrid";
import { Avatar, Badge, Card } from "@/components/ui/primitives";
import { useAdmin } from "@/lib/admin-context";
import { api, describeError, useQuery } from "@/lib/api";
import {
  APPLICATION_LABEL, SUPPORT_FILTERS, SUPPORT_STATUS_LABEL,
  type SupportStatus, type SupportThread, type SupportThreadDetail,
} from "@/lib/support-api";
import { ago, initials, type Paged } from "@/lib/workers-api";
import type { Tone } from "@/types";

const TONE: Record<SupportStatus, Tone> = { OPEN: "warn", ANSWERED: "ok", RESOLVED: "neutral" };
const fmtTime = (iso: string) => new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
/** How often the list and the open conversation look for new messages. */
const POLL_MS = 10_000;

export default function SupportPage() {
  const { showToast } = useAdmin();
  const [filter, setFilter] = useState<SupportStatus | "ALL">("OPEN");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const query = `support/threads?limit=50${filter === "ALL" ? "" : `&status=${filter}`}${search.trim() ? `&search=${encodeURIComponent(search.trim())}` : ""}`;
  const list = useQuery<Paged<SupportThread>>(query);
  const openCount = useQuery<Paged<SupportThread>>("support/threads?status=OPEN&limit=1");
  const answeredCount = useQuery<Paged<SupportThread>>("support/threads?status=ANSWERED&limit=1");
  const resolvedCount = useQuery<Paged<SupportThread>>("support/threads?status=RESOLVED&limit=1");
  const items = list.data?.items ?? [];
  const currentId = selected ?? items[0]?.id ?? null;
  const detail = useQuery<SupportThreadDetail>(currentId ? `support/threads/${currentId}` : null);
  const t = detail.data && detail.data.id === currentId ? detail.data : null;
  const bottom = useRef<HTMLDivElement>(null);

  // new messages arrive while the page is open
  const reloadList = list.reload;
  const reloadDetail = detail.reload;
  useEffect(() => {
    const id = setInterval(() => {
      reloadList();
      reloadDetail();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [reloadList, reloadDetail]);

  const count = t?.messages.length ?? 0;
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [count, currentId]);

  const total = (q: { data: Paged<SupportThread> | null }) => (q.data ? String(q.data.meta.total) : "…");
  function refreshAll() {
    list.reload();
    detail.reload();
    openCount.reload();
    answeredCount.reload();
    resolvedCount.reload();
  }

  async function send() {
    if (!currentId || !draft.trim()) return;
    setBusy(true);
    setError(null);
    try {
      // one id per click: if the answer is lost and the button is pressed again, the reply is still stored once
      await api.post(`support/threads/${currentId}/reply`, { body: draft.trim(), clientMessageId: `admin-${crypto.randomUUID()}` });
      setDraft("");
      showToast("Reply sent");
      refreshAll();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(action: "resolve" | "reopen") {
    if (!currentId) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`support/threads/${currentId}/${action}`, {});
      showToast(action === "resolve" ? "Marked resolved" : "Reopened");
      refreshAll();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <KpiGrid
        kpis={[
          { k: "Needs a reply", v: total(openCount), icon: "message", d: "Waiting for an administrator", dc: "#8A5B00", tone: "gold" },
          { k: "Answered", v: total(answeredCount), icon: "check", d: "Waiting for the person" },
          { k: "Resolved", v: total(resolvedCount), icon: "shield", d: "Closed", dc: "#64748B" },
        ]}
      />
      {list.error && (
        <div role="alert" className="rounded-xl border border-danger-line bg-danger-bg px-4 py-3 text-[13.5px] text-danger">
          {describeError(list.error)} <button type="button" className="font-semibold underline" onClick={list.reload}>Try again</button>
        </div>
      )}
      <div className="grid grid-cols-[340px_minmax(0,1fr)] items-start gap-4">
        <Card className="overflow-hidden">
          <div className="flex flex-col gap-2.5 border-b border-soft px-4 py-3.5">
            <div className="flex justify-between text-[14.5px] font-bold">
              Conversations<span className="text-[13px] font-medium text-slate">{list.data ? `${list.data.meta.total}` : "Loading…"}</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {SUPPORT_FILTERS.map((f) => (
                <button key={f.key} type="button" onClick={() => { setFilter(f.key); setSelected(null); }} className={`h-[30px] rounded-full border px-3 text-xs font-semibold ${filter === f.key ? "border-brand bg-brand text-white" : "border-line bg-white"}`}>{f.label}</button>
              ))}
            </div>
            <input value={search} onChange={(e) => { setSearch(e.target.value); setSelected(null); }} placeholder="Search name or phone" aria-label="Search conversations" className="h-9 rounded-lg border border-line px-3 text-[13px]" />
          </div>
          {list.data && items.length === 0 && <div className="px-4 py-8 text-center text-[13.5px] text-slate">No conversations here.</div>}
          {items.map((q) => (
            <button key={q.id} type="button" onClick={() => { setSelected(q.id); setError(null); }} className={`flex w-full items-center gap-3 border-b border-l-[3px] border-b-faint px-4 py-3 text-start ${currentId === q.id ? "border-l-brand bg-[#f3f8f7]" : "border-l-transparent bg-white"}`}>
              <Avatar text={initials(q.fullName)} size={36} className="!text-[12.5px]" />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <b className="truncate text-sm font-semibold">{q.fullName ?? q.phone ?? "Unnamed"}</b>
                <span className="truncate text-xs text-slate">{q.lastSenderRole === "ADMIN" ? "You: " : ""}{q.lastMessage ?? ""}</span>
              </span>
              <span className="flex flex-col items-end gap-1">
                <span className="text-[11.5px] text-slate">{ago(q.lastMessageAt)}</span>
                <Badge label={SUPPORT_STATUS_LABEL[q.status]} tone={TONE[q.status]} className="!rounded-md !px-[7px] !py-0.5 !text-[11px]" />
              </span>
            </button>
          ))}
        </Card>

        <Card className="flex min-h-[520px] flex-col">
          {!currentId && <div className="px-5 py-16 text-center text-[14px] text-slate">Select a conversation.</div>}
          {currentId && !t && !detail.error && <div className="px-5 py-16 text-center text-[14px] text-slate">Loading…</div>}
          {currentId && detail.error && !t && <div className="px-5 py-16 text-center text-[14px] text-danger">{describeError(detail.error)}</div>}
          {t && (
            <>
              <div className="flex items-center gap-3.5 border-b border-soft px-5 py-4">
                <Avatar text={initials(t.fullName)} size={46} round className="!text-base" />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <div className="truncate text-[16px] font-bold">{t.fullName ?? "Unnamed"} <span className="text-[13px] font-medium text-slate">· {t.role === "WORKER" ? "Worker" : "Customer"}</span></div>
                  <div className="text-[13px] text-slate" dir="ltr">{t.phone ?? "No phone"}</div>
                </div>
                {t.role === "WORKER" && t.workerVerificationStatus && (
                  <Link href="/verification" className="flex items-center gap-1.5 rounded-lg border border-line bg-white px-3 py-1.5 text-xs font-semibold">
                    <Icon name="shield" size={13} />{APPLICATION_LABEL[t.workerVerificationStatus] ?? t.workerVerificationStatus}
                  </Link>
                )}
                <Badge label={SUPPORT_STATUS_LABEL[t.status]} tone={TONE[t.status]} className="!px-2.5 !py-[5px] !text-[12.5px]" />
              </div>
              <div className="flex max-h-[460px] min-h-[260px] flex-1 flex-col gap-2.5 overflow-y-auto bg-background px-5 py-4" aria-live="polite">
                {t.messages.map((m) => {
                  const mine = m.senderRole === "ADMIN";
                  return (
                    <div key={m.id} className={`flex flex-col gap-1 ${mine ? "items-end" : "items-start"}`}>
                      <div className={`max-w-[75%] whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2.5 text-[13.5px] leading-relaxed ${mine ? "bg-brand text-white" : "border border-line bg-white"}`}>{m.body}</div>
                      <span className="px-1 text-[11px] text-slate">{mine ? "Support" : t.role === "WORKER" ? "Worker" : "Customer"} · {fmtTime(m.createdAt)}</span>
                    </div>
                  );
                })}
                <div ref={bottom} />
              </div>
              {error && <div role="alert" className="mx-5 mt-3 rounded-xl border border-danger-line bg-danger-bg px-3 py-2.5 text-[13px] text-danger">{error}</div>}
              <div className="flex items-end gap-2.5 border-t border-soft px-5 py-4">
                <textarea value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={2000} rows={2} placeholder="Write a reply…" aria-label="Reply" className="min-h-[46px] flex-1 resize-none rounded-xl border-[1.5px] border-line px-3.5 py-2.5 text-[14px]" />
                <button type="button" disabled={busy || !draft.trim()} onClick={send} className="flex h-11 items-center gap-2 rounded-xl bg-brand px-5 font-semibold text-white disabled:opacity-40"><Icon name="check" size={16} strokeWidth={2.6} />Send reply</button>
                {t.status === "RESOLVED" ? (
                  <button type="button" disabled={busy} onClick={() => setStatus("reopen")} className="h-11 rounded-xl border-[1.5px] border-line bg-white px-[18px] font-semibold disabled:opacity-50">Reopen</button>
                ) : (
                  <button type="button" disabled={busy} onClick={() => setStatus("resolve")} className="h-11 rounded-xl border-[1.5px] border-line bg-white px-[18px] font-semibold disabled:opacity-50">Mark resolved</button>
                )}
              </div>
            </>
          )}
        </Card>
      </div>
    </>
  );
}
