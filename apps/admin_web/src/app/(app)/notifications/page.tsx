"use client";

import { useState } from "react";
import { Field, TextArea, TextInput } from "@/components/forms/fields";
import { badge, num, text, type Column } from "@/components/tables/cells";
import { ServerTablePage, type ServerFilter } from "@/components/tables/ServerTablePage";
import { Icon } from "@/components/ui/Icon";
import { Button, Card, Chip, Segmented } from "@/components/ui/primitives";
import { useAdmin } from "@/lib/admin-context";
import { api, describeError, qs, useQuery } from "@/lib/api";
import { categoryIcon, useCatalog } from "@/lib/catalog-api";
import { fmt, whenLabel } from "@/lib/format";
import type { Kpi } from "@/types";

type Audience = "CUSTOMERS" | "WORKERS";
type Group = "ALL" | "NEW" | "INACTIVE" | "REPEAT" | "APPROVED" | "PENDING_VERIFICATION" | "SUSPENDED";

const TYPES: [string, string][] = [["bell", "Push notification"], ["message", "In-app announcement"], ["gift", "Promotional offer"], ["calendar", "Booking / payment update"]];
const GROUPS: Record<Audience, [Group, string][]> = {
  CUSTOMERS: [["ALL", "All customers"], ["NEW", "New (no bookings yet)"], ["INACTIVE", "Inactive 60+ days"], ["REPEAT", "Repeat customers"]],
  WORKERS: [["ALL", "All workers"], ["APPROVED", "Approved"], ["PENDING_VERIFICATION", "Pending verification"], ["SUSPENDED", "Suspended"]],
};

interface CampaignRow {
  campaignId: string;
  kind: string;
  titleEn: string;
  titleAr: string;
  audienceLabel: string;
  sentAt: string;
  reach: number;
  opened: number;
}

interface Summary {
  campaignsThisMonth: number;
  announcementReach: number;
  announcementOpenRatePct: number | null;
  openRateThisMonthPct: number | null;
  pushOptIn: { customers: { pct: number | null; withPhone: number; accounts: number }; workers: { pct: number | null; withPhone: number; accounts: number } };
}

const COLUMNS: Column[] = [
  { label: "Notification", w: 2.4 }, { label: "Type", w: 1.2 }, { label: "Audience", w: 1.6 }, { label: "Sent", w: 1.1 },
  { label: "Reach", w: 0.8, align: "end" }, { label: "Opened", w: 0.8, align: "end" }, { label: "Status", w: 0.9 },
];
const FILTERS: ServerFilter[] = [{ key: "Status", label: "Status", options: ["All", "Sent", "Scheduled"], param: (v) => ({ status: v.toUpperCase() }) }];

function Compose({ onSent }: { onSent: () => void }) {
  const { cities, showToast } = useAdmin();
  const { categories } = useCatalog();
  const cats = categories.data?.items ?? [];
  const [f, setF] = useState({ type: 2, aud: "CUSTOMERS" as Audience, group: "ALL" as Group, cities: [] as string[], cats: [] as string[], tEn: "", tAr: "", bEn: "", bAr: "", sent: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = (arr: string[], v: string) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
  const set = (o: Partial<typeof f>) => setF((p) => ({ ...p, ...o, sent: false }));

  const reachQuery = qs({ audience: f.aud, group: f.group, cityIds: f.cities.join(",") || undefined, categoryIds: f.cats.join(",") || undefined });
  const reach = useQuery<{ recipients: number; maxPerAnnouncement: number }>(`notifications/reach?${reachQuery}`);
  const recipients = reach.data?.recipients ?? null;
  const hasText = Boolean(f.tEn.trim() || f.tAr.trim()) && Boolean(f.bEn.trim() || f.bAr.trim());
  const tooMany = recipients !== null && reach.data !== null && recipients > reach.data.maxPerAnnouncement;
  const canSend = hasText && !busy && !f.sent && recipients !== null && recipients > 0 && !tooMany;

  async function send() {
    if (!canSend) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ recipients: number; pushDeliveries: number }>("notifications/broadcast", {
        audience: f.aud, group: f.group, kind: TYPES[f.type]![1],
        cityIds: f.cities.length ? f.cities : undefined, categoryIds: f.cats.length ? f.cats : undefined,
        titleEn: f.tEn, titleAr: f.tAr, bodyEn: f.bEn, bodyAr: f.bAr,
      });
      setF((p) => ({ ...p, sent: true }));
      showToast(`Sent to ${r.recipients.toLocaleString("en-GB")} ${f.aud === "CUSTOMERS" ? "customers" : "workers"} · ${r.pushDeliveries} push${r.pushDeliveries === 1 ? "" : "es"} queued`);
      onSent();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_360px] items-start gap-4">
      <Card className="flex flex-col gap-4 p-5">
        <div className="text-[16.5px] font-bold">New notification</div>
        <div className="flex flex-col gap-2">
          <span className="text-[12.5px] font-semibold">Type</span>
          <div className="grid grid-cols-4 gap-2">
            {TYPES.map(([icon, l], i) => (
              <button key={l} type="button" onClick={() => set({ type: i })} className={`flex flex-col items-start gap-2 rounded-[13px] border-[1.5px] p-3 text-start text-[13px] font-semibold ${f.type === i ? "border-[#9cc5ba] bg-tint text-brand" : "border-line bg-white text-ink"}`}>
                <Icon name={icon} size={17} />{l}
              </button>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-3.5">
          <div className="flex flex-col gap-2">
            <span className="text-[12.5px] font-semibold">Audience</span>
            <Segmented options={[{ value: "CUSTOMERS" as Audience, label: "Customers" }, { value: "WORKERS" as Audience, label: "Workers" }]} value={f.aud} onChange={(aud) => set({ aud, group: "ALL" })} />
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-[12.5px] font-semibold">Target group</span>
            <div className="flex flex-wrap gap-1.5">{GROUPS[f.aud].map(([g, l]) => <Chip key={g} label={l} selected={f.group === g} onClick={() => set({ group: g })} />)}</div>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3.5">
          <div className="flex flex-col gap-2">
            <span className="text-[12.5px] font-semibold">Cities</span>
            <div className="flex flex-wrap gap-1.5">{cities.map((c) => <Chip key={c.id} label={c.nameEn} selected={f.cities.includes(c.id)} onClick={() => set({ cities: toggle(f.cities, c.id) })} />)}</div>
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-[12.5px] font-semibold">Service / worker category</span>
            <div className="flex flex-wrap gap-1.5">{cats.map((c) => <Chip key={c.id} icon={categoryIcon(c.iconKey)} label={c.nameEn} selected={f.cats.includes(c.id)} onClick={() => set({ cats: toggle(f.cats, c.id) })} />)}</div>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3.5">
          <Field label="Title (English)"><TextInput value={f.tEn} onChange={(tEn) => set({ tEn })} placeholder="e.g. 20% off AC deep cleaning" /></Field>
          <Field label="العنوان (عربي)" rtl><TextInput rtl value={f.tAr} onChange={(tAr) => set({ tAr })} placeholder="مثال: خصم 20% على تنظيف المكيفات" /></Field>
          <Field label="Message (English)"><TextArea value={f.bEn} onChange={(bEn) => set({ bEn })} /></Field>
          <Field label="الرسالة (عربي)" rtl><TextArea rtl value={f.bAr} onChange={(bAr) => set({ bAr })} /></Field>
        </div>
        {(error || tooMany) && <div role="alert" className="rounded-xl border border-danger-line bg-danger-bg px-3 py-2.5 text-[13px] text-danger">{error ?? `This audience is too large (${fmt(recipients ?? 0)}). Narrow it to at most ${fmt(reach.data?.maxPerAnnouncement ?? 0)} people.`}</div>}
        <div className="flex items-center gap-3 border-t border-soft pt-3">
          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-slate">Estimated reach</span>
            <b className="text-lg">{recipients === null ? "…" : fmt(recipients)} {f.aud === "CUSTOMERS" ? "customers" : "workers"}</b>
          </div>
          <div className="flex-1" />
          <Button variant="outline" icon="clock" className="h-[42px]" onClick={() => showToast("Scheduling is not available yet: announcements are sent now")}>Schedule</Button>
          <button type="button" disabled={!canSend} onClick={() => void send()} className={`flex h-[42px] items-center gap-1.5 rounded-xl px-[18px] font-semibold text-white ${f.sent ? "bg-slate" : "bg-brand"} ${!canSend && !f.sent ? "opacity-50" : ""}`}>
            <Icon name="send" size={15} />{busy ? "Sending…" : f.sent ? "Sent" : "Send now"}
          </button>
        </div>
      </Card>
      <div className="sticky top-0 flex flex-col gap-3.5 rounded-[18px] bg-ink p-5">
        <div className="flex justify-between text-white"><b className="text-[15px]">Preview</b><span className="text-xs opacity-60">Lock screen</span></div>
        {[{ rtl: false, t: f.tEn || f.tAr, b: f.bEn || f.bAr, app: "HOME SERVICES", now: "now" }, { rtl: true, t: f.tAr || f.tEn, b: f.bAr || f.bEn, app: "خدمات المنزل", now: "الآن" }].map((p) => (
          <div key={p.app} dir={p.rtl ? "rtl" : "ltr"} className={`flex gap-2.5 rounded-[18px] bg-white/90 px-3.5 py-3 ${p.rtl ? "font-arabic" : ""}`}>
            <div className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-brand text-white"><Icon name="wrench" size={17} /></div>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="flex justify-between text-[11.5px] text-slate"><span className="font-semibold tracking-[.02em]">{p.app}</span><span>{p.now}</span></div>
              <b className="text-sm text-ink">{p.t || (p.rtl ? "العنوان" : "Title")}</b>
              <span className="text-[13px] leading-[1.4] text-[#334155]">{p.b || (p.rtl ? "نص الرسالة" : "Your message")}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function NotificationsPage() {
  const { version, bump } = useAdmin();
  const summary = useQuery<Summary>("notifications/summary", version);
  const s = summary.data;
  const kpis: Kpi[] = [
    { k: "Sent this month", v: s ? String(s.campaignsThisMonth) : "…", icon: "send", d: s ? `${fmt(s.announcementReach)} people reached in all` : "", dc: "#64748B" },
    { k: "Avg. open rate", v: s?.announcementOpenRatePct != null ? `${s.announcementOpenRatePct}%` : "—", icon: "eye", d: "Announcements read in the app" },
    { k: "Push opt-in", v: s?.pushOptIn.customers.pct != null ? `${s.pushOptIn.customers.pct}%` : "—", icon: "bell", d: s ? `Customers · workers ${s.pushOptIn.workers.pct ?? "—"}${s.pushOptIn.workers.pct != null ? "%" : ""}` : "Customers", dc: "#64748B" },
    { k: "All notifications read", v: s?.openRateThisMonthPct != null ? `${s.openRateThisMonthPct}%` : "—", icon: "tag", d: "This month, every kind", tone: "gold" },
  ];
  return (
    <ServerTablePage<CampaignRow>
      kpis={kpis}
      before={<Compose onSent={bump} />}
      filters={FILTERS}
      path="notifications"
      columns={COLUMNS}
      idOf={(c) => c.campaignId}
      toRow={(c) => ({
        key: c.campaignId,
        cells: [text(c.titleEn || c.titleAr, undefined, { fw: 600 }), text(c.kind), text(c.audienceLabel, undefined, { fg: "#64748B" }), text(whenLabel(c.sentAt)), num(fmt(c.reach)), num(c.reach > 0 ? `${Math.round((c.opened / c.reach) * 100)}%` : "—"), badge("Sent", "ok")],
      })}
      footerBase={(shown, total) => `Showing ${shown} of ${total} ${total === 1 ? "notification" : "notifications"}`}
    />
  );
}
