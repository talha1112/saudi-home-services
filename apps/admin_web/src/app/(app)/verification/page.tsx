"use client";

import { useEffect, useState } from "react";
import { ReasonDialog } from "@/components/modals/ReasonDialog";
import { Icon } from "@/components/ui/Icon";
import { KpiGrid } from "@/components/ui/KpiGrid";
import { Avatar, Badge, Card } from "@/components/ui/primitives";
import { useAdmin } from "@/lib/admin-context";
import { api, describeError, useQuery } from "@/lib/api";
import {
  DOCUMENT_LABEL, STATUS_LABEL, ago, describeAvailability, initials,
  type AdminDocument, type Paged, type VerificationStatus, type WorkerDetail, type WorkerListItem,
} from "@/lib/workers-api";
import type { Tone } from "@/types";

const QUEUE = "workers?status=SUBMITTED,UNDER_REVIEW&sort=oldest&limit=50";
const TONE: Record<VerificationStatus, Tone> = {
  NOT_SUBMITTED: "neutral", SUBMITTED: "neutral", UNDER_REVIEW: "warn", INFO_REQUIRED: "warn", APPROVED: "ok", REJECTED: "bad", SUSPENDED: "bad",
};
const DOC_TONE: Record<AdminDocument["status"], Tone> = { PENDING_UPLOAD: "neutral", UPLOADED: "warn", ACCEPTED: "ok", REJECTED: "bad" };
const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : "—");

type Dialog = { kind: "reject" | "request-info" | "suspend" } | { kind: "doc-reject"; doc: AdminDocument } | null;

function useTotal(status: string) {
  return useQuery<Paged<WorkerListItem>>(`workers?status=${status}&limit=1`);
}

export default function VerificationPage() {
  const { showToast } = useAdmin();
  const queue = useQuery<Paged<WorkerListItem>>(QUEUE);
  const infoCount = useTotal("INFO_REQUIRED");
  const approvedCount = useTotal("APPROVED");
  const rejectedCount = useTotal("REJECTED");
  const [selected, setSelected] = useState<string | null>(null);
  const items = queue.data?.items ?? [];
  const currentId = selected ?? items[0]?.id ?? null;
  const detail = useQuery<WorkerDetail>(currentId ? `workers/${currentId}` : null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const w = detail.data && detail.data.id === currentId ? detail.data : null;

  // The applicant's profile photo (step 1 of their application), shown to the reviewer through a short-lived signed address.
  const photoDocId = w?.documents.find((d) => d.type === "PHOTO" && d.status !== "PENDING_UPLOAD" && d.status !== "REJECTED")?.id ?? null;
  const photoKey = currentId && photoDocId ? `${currentId}/${photoDocId}` : null;
  const [photo, setPhoto] = useState<{ key: string; url: string } | null>(null);
  useEffect(() => {
    if (!photoKey) return;
    let off = false;
    api
      .get<{ url: string }>(`workers/${photoKey.split("/")[0]}/documents/${photoKey.split("/")[1]}/download-url`)
      .then((r) => { if (!off) setPhoto({ key: photoKey, url: r.url }); })
      .catch(() => { /* the document list below still has a View button */ });
    return () => { off = true; };
  }, [photoKey]);
  const photoUrl = photo && photo.key === photoKey ? photo.url : null;

  function refreshAll() {
    queue.reload();
    detail.reload();
    infoCount.reload();
    approvedCount.reload();
    rejectedCount.reload();
  }

  async function decide(action: "start-review" | "approve" | "reject" | "request-info" | "suspend" | "reinstate", reason?: string) {
    if (!currentId) return;
    await api.post(`workers/${currentId}/${action}`, reason ? { reason } : {});
    const label = { "start-review": "Review started", approve: "Worker approved", reject: "Application rejected", "request-info": "More information requested", suspend: "Worker suspended", reinstate: "Worker reinstated" }[action];
    showToast(label);
    // The application stays open after a decision, so the reviewer sees its new status; it leaves the queue list on its own.
    setSelected(currentId);
    refreshAll();
  }

  async function run(action: "start-review" | "approve" | "reinstate") {
    setBusy(true);
    setError(null);
    try {
      await decide(action);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function reviewDocument(doc: AdminDocument, status: "ACCEPTED" | "REJECTED", note?: string) {
    if (!currentId) return;
    await api.patch(`workers/${currentId}/documents/${doc.id}`, { status, ...(note ? { note } : {}) });
    showToast(status === "ACCEPTED" ? "Document accepted" : "Document rejected");
    detail.reload();
  }

  async function view(doc: AdminDocument) {
    if (!currentId) return;
    setError(null);
    try {
      const { url } = await api.get<{ url: string }>(`workers/${currentId}/documents/${doc.id}/download-url`);
      window.open(url, "_blank", "noopener,noreferrer"); // a short-lived signed address; not stored or shown
    } catch (e) {
      setError(describeError(e));
    }
  }

  const total = (q: { data: Paged<WorkerListItem> | null }) => (q.data ? String(q.data.meta.total) : "…");

  return (
    <>
      <KpiGrid
        kpis={[
          { k: "Waiting for review", v: total(queue), icon: "shield", d: "Submitted or under review", dc: "#8A5B00", tone: "gold" },
          { k: "Info requested", v: total(infoCount), icon: "clock", d: "Waiting on the worker", dc: "#64748B" },
          { k: "Approved", v: total(approvedCount), icon: "check", d: "All time" },
          { k: "Rejected", v: total(rejectedCount), icon: "x", d: "All time", dc: "#64748B", tone: "red" },
        ]}
      />
      {queue.error && <div role="alert" className="rounded-xl border border-danger-line bg-danger-bg px-4 py-3 text-[13.5px] text-danger">{describeError(queue.error)} <button type="button" className="font-semibold underline" onClick={queue.reload}>Try again</button></div>}
      <div className="grid grid-cols-[320px_minmax(0,1fr)] items-start gap-4">
        <Card className="overflow-hidden">
          <div className="flex justify-between border-b border-soft px-4 py-3.5 text-[14.5px] font-bold">
            Queue<span className="text-[13px] font-medium text-slate">{queue.data ? `${queue.data.meta.total} waiting` : "Loading…"}</span>
          </div>
          {queue.data && items.length === 0 && <div className="px-4 py-8 text-center text-[13.5px] text-slate">No applications are waiting. 🎉</div>}
          {items.map((q) => (
            <button key={q.id} type="button" onClick={() => { setSelected(q.id); setError(null); }} className={`flex w-full items-center gap-3 border-b border-l-[3px] border-b-faint px-4 py-3 text-start ${currentId === q.id ? "border-l-brand bg-[#f3f8f7]" : "border-l-transparent bg-white"}`}>
              <Avatar text={initials(q.fullName)} size={36} className="!text-[12.5px]" />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5"><b className="truncate text-sm font-semibold">{q.fullName ?? q.phone ?? "Unnamed applicant"}</b><span className="truncate text-xs text-slate">{q.serviceCount} services · {q.cityCount} cities · {q.documentCount} docs</span></span>
              <span className="flex flex-col items-end gap-1"><span className="text-[11.5px] text-slate">{ago(q.submittedAt)}</span><Badge label={STATUS_LABEL[q.verificationStatus]} tone={TONE[q.verificationStatus]} className="!rounded-md !px-[7px] !py-0.5 !text-[11px]" /></span>
            </button>
          ))}
        </Card>

        <Card className="flex flex-col">
          {!currentId && <div className="px-5 py-16 text-center text-[14px] text-slate">Select an application to review.</div>}
          {currentId && !w && !detail.error && <div className="px-5 py-16 text-center text-[14px] text-slate">Loading application…</div>}
          {currentId && detail.error && !w && <div className="px-5 py-16 text-center text-[14px] text-danger">{describeError(detail.error)}</div>}
          {w && (
            <>
              <div className="flex items-center gap-3.5 border-b border-soft px-5 py-[18px]">
                {photoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={photoUrl} alt="Profile photo" className="size-14 rounded-full border border-line object-cover" />
                ) : (
                  <Avatar text={initials(w.fullName)} size={56} round className="!text-lg" />
                )}
                <div className="flex flex-1 flex-col gap-1">
                  <div className="text-lg font-bold">{w.fullName ?? "Unnamed applicant"} {w.fullNameAr && <span className="font-arabic text-[15px] font-medium text-slate">· {w.fullNameAr}</span>}</div>
                  <div className="text-[13px] text-slate">Submitted {fmtDate(w.submittedAt)}</div>
                </div>
                <Badge label={STATUS_LABEL[w.verificationStatus]} tone={TONE[w.verificationStatus]} className="!px-2.5 !py-[5px] !text-[12.5px]" />
              </div>
              <div className="grid grid-cols-4 gap-px border-b border-soft bg-soft">
                {([
                  ["Phone", w.phone ?? "—"], ["Email", w.email ?? "—"], ["Account", w.accountStatus], ["Experience", w.yearsOfExperience != null ? `${w.yearsOfExperience} years` : "—"],
                  ["Services", w.services.map((s) => s.nameEn).join(", ") || "—"], ["Cities", w.cities.map((c) => c.nameEn).join(", ") || "—"],
                  ["Availability", describeAvailability(w.availability)], ["Verified", fmtDate(w.verifiedAt)],
                ] as [string, string][]).map(([k, v]) => (
                  <div key={k} className="flex min-w-0 flex-col gap-[3px] bg-white px-4 py-3"><span className="text-[11.5px] text-slate">{k}</span><span className="break-words text-[13.5px] font-semibold">{v}</span></div>
                ))}
              </div>
              {w.bio && <div className="border-b border-soft px-5 py-3 text-[13.5px] text-slate">{w.bio}</div>}
              <div className="flex flex-col gap-3 px-5 py-[18px]">
                <div className="text-[14.5px] font-bold">Documents</div>
                {w.documents.length === 0 && <div className="text-[13.5px] text-slate">No documents were uploaded.</div>}
                <div className="grid grid-cols-2 gap-3">
                  {w.documents.map((d) => (
                    <div key={d.id} className={`flex flex-col gap-2 rounded-[14px] border-[1.5px] p-3 ${d.status === "ACCEPTED" ? "border-[#9cc5ba]" : d.status === "REJECTED" ? "border-danger-line" : "border-line"}`}>
                      <div className="flex items-start gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="text-[13.5px] font-semibold">{DOCUMENT_LABEL[d.type] ?? d.type}</div>
                          <div className="truncate text-xs text-slate">{d.fileName} · {(d.sizeBytes / 1024).toFixed(0)} KB</div>
                        </div>
                        <Badge label={d.status === "UPLOADED" ? "To review" : d.status[0] + d.status.slice(1).toLowerCase()} tone={DOC_TONE[d.status]} className="!rounded-md !px-[7px] !py-0.5 !text-[11px]" />
                      </div>
                      {d.reviewNote && <div className="text-xs text-slate">Note: {d.reviewNote}</div>}
                      <div className="grid grid-cols-3 gap-1.5">
                        <button type="button" onClick={() => view(d)} className="flex h-[30px] items-center justify-center gap-1 rounded-lg border border-line bg-white text-xs font-semibold"><Icon name="file" size={13} />View</button>
                        <button type="button" disabled={d.status === "PENDING_UPLOAD"} onClick={async () => { setError(null); try { await reviewDocument(d, "ACCEPTED"); } catch (e) { setError(describeError(e)); } }} className="flex h-[30px] items-center justify-center gap-1 rounded-lg border border-line bg-white text-xs font-semibold disabled:opacity-40"><Icon name="check" size={13} strokeWidth={2.6} />Accept</button>
                        <button type="button" disabled={d.status === "PENDING_UPLOAD"} onClick={() => setDialog({ kind: "doc-reject", doc: d })} className="flex h-[30px] items-center justify-center gap-1 rounded-lg border border-danger-line bg-white text-xs font-semibold text-danger disabled:opacity-40"><Icon name="flag" size={12} />Reject</button>
                      </div>
                    </div>
                  ))}
                </div>
                {w.verificationNote && <div className="rounded-xl bg-background px-3.5 py-3 text-[13px]"><b>Last note to the worker:</b> {w.verificationNote}</div>}
                {w.history.length > 0 && (
                  <div className="flex flex-col gap-1.5 pt-1">
                    <div className="text-[13.5px] font-semibold">History</div>
                    {w.history.slice(0, 6).map((h, i) => (
                      <div key={i} className="flex justify-between gap-3 text-[12.5px]"><span>{STATUS_LABEL[h.toStatus]}{h.reason ? ` — ${h.reason}` : ""}{h.actorName ? ` · ${h.actorName}` : ""}</span><span className="shrink-0 text-slate">{fmtDate(h.createdAt)}</span></div>
                    ))}
                  </div>
                )}
              </div>
              {error && <div role="alert" className="mx-5 mb-3 rounded-xl border border-danger-line bg-danger-bg px-3 py-2.5 text-[13px] text-danger">{error}</div>}
              <StatusFooter
                status={w.verificationStatus}
                note={w.verificationNote}
                when={{ submitted: w.submittedAt, verified: w.verifiedAt }}
                busy={busy}
                onStart={() => run("start-review")}
                onApprove={() => run("approve")}
                onRequestInfo={() => setDialog({ kind: "request-info" })}
                onReject={() => setDialog({ kind: "reject" })}
                onSuspend={() => setDialog({ kind: "suspend" })}
                onReinstate={() => run("reinstate")}
              />
            </>
          )}
        </Card>
      </div>

      {dialog?.kind === "reject" && <ReasonDialog title="Reject application" subtitle="The worker sees this reason and can fix the application and apply again." cta="Reject" required onClose={() => setDialog(null)} onConfirm={async (r) => { try { await decide("reject", r); } catch (e) { throw new Error(describeError(e)); } }} />}
      {dialog?.kind === "suspend" && <ReasonDialog title="Suspend worker" subtitle="The worker is blocked from taking jobs and sees this reason." cta="Suspend" required onClose={() => setDialog(null)} onConfirm={async (r) => { try { await decide("suspend", r); } catch (e) { throw new Error(describeError(e)); } }} />}
      {dialog?.kind === "request-info" && <ReasonDialog title="Request more information" subtitle="Tell the worker exactly what to fix or add." cta="Send request" required onClose={() => setDialog(null)} onConfirm={async (r) => { try { await decide("request-info", r); } catch (e) { throw new Error(describeError(e)); } }} />}
      {dialog?.kind === "doc-reject" && <ReasonDialog title={`Reject ${DOCUMENT_LABEL[dialog.doc.type] ?? "document"}`} subtitle="Say what is wrong with this document." cta="Reject document" required onClose={() => setDialog(null)} onConfirm={async (r) => { try { await reviewDocument(dialog.doc, "REJECTED", r); } catch (e) { throw new Error(describeError(e)); } }} />}
    </>
  );
}

/** What the reviewer can do with an application depends on where it is: the bar under the application changes with its status. */
function StatusFooter({
  status, note, when, busy, onStart, onApprove, onRequestInfo, onReject, onSuspend, onReinstate,
}: {
  status: VerificationStatus;
  note: string | null;
  when: { submitted: string | null; verified: string | null };
  busy: boolean;
  onStart: () => void;
  onApprove: () => void;
  onRequestInfo: () => void;
  onReject: () => void;
  onSuspend: () => void;
  onReinstate: () => void;
}) {
  const approve = (
    <button type="button" disabled={busy} onClick={onApprove} className="flex h-11 items-center gap-2 rounded-xl bg-brand px-5 font-semibold text-white disabled:opacity-40"><Icon name="check" size={16} strokeWidth={2.6} />Approve worker</button>
  );
  const info = <button type="button" disabled={busy} onClick={onRequestInfo} className="h-11 rounded-xl bg-cream px-[18px] font-semibold text-[#8a5b00] disabled:opacity-40">Request more info</button>;
  const reject = <button type="button" disabled={busy} onClick={onReject} className="h-11 rounded-xl border-[1.5px] border-danger-line bg-white px-[18px] font-semibold text-danger disabled:opacity-40">Reject</button>;
  const banner = (tone: "ok" | "warn" | "bad" | "neutral", text: string) => (
    <div role="status" className={`mx-5 mb-0 mt-1 rounded-xl px-3.5 py-2.5 text-[13px] ${tone === "ok" ? "bg-tint text-brand" : tone === "warn" ? "bg-cream text-[#8a5b00]" : tone === "bad" ? "bg-danger-bg text-danger" : "bg-background text-slate"}`}>{text}</div>
  );
  const date = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-GB") : "");
  const bar = (children: React.ReactNode) => <div className="flex gap-2.5 border-t border-soft px-5 py-4">{children}</div>;

  switch (status) {
    case "SUBMITTED":
      return (
        <>
          {banner("neutral", `Submitted ${date(when.submitted)}. Start the review to decide on it, or decide straight away.`)}
          {bar(<>
            <button type="button" disabled={busy} onClick={onStart} className="h-11 rounded-xl border-[1.5px] border-line bg-white px-[18px] font-semibold disabled:opacity-50">Start review</button>
            {approve}{info}<div className="flex-1" />{reject}
          </>)}
        </>
      );
    case "UNDER_REVIEW":
      return (
        <>
          {banner("warn", "Under review. Check the documents, then approve, ask for more information or reject.")}
          {bar(<>{approve}{info}<div className="flex-1" />{reject}</>)}
        </>
      );
    case "INFO_REQUIRED":
      return banner("warn", `Waiting for the worker to send more information${note ? `: “${note}”` : "."} The application comes back to the queue when they resubmit.`);
    case "APPROVED":
      return (
        <>
          {banner("ok", `Approved${when.verified ? ` on ${date(when.verified)}` : ""}. The worker can take jobs.`)}
          {bar(<><div className="flex-1" /><button type="button" disabled={busy} onClick={onSuspend} className="h-11 rounded-xl border-[1.5px] border-danger-line bg-white px-[18px] font-semibold text-danger disabled:opacity-40">Suspend worker</button></>)}
        </>
      );
    case "REJECTED":
      return banner("bad", `Rejected${note ? `: “${note}”` : "."} The worker can fix the application and apply again.`);
    case "SUSPENDED":
      return (
        <>
          {banner("bad", `Suspended${note ? `: “${note}”` : "."} The worker cannot take jobs.`)}
          {bar(<><div className="flex-1" /><button type="button" disabled={busy} onClick={onReinstate} className="h-11 rounded-xl bg-brand px-5 font-semibold text-white disabled:opacity-40">Reinstate worker</button></>)}
        </>
      );
    default:
      return banner("neutral", "The worker has not submitted this application yet.");
  }
}
