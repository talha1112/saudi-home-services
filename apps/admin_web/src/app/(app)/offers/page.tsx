"use client";

import { useState } from "react";
import { Field, StaticBox, TextArea, TextInput } from "@/components/forms/fields";
import { badge, mono, num, text, type Column } from "@/components/tables/cells";
import { ServerTablePage, type ServerFilter } from "@/components/tables/ServerTablePage";
import { Icon } from "@/components/ui/Icon";
import { Button, Card, Chip, Segmented } from "@/components/ui/primitives";
import { useAdmin } from "@/lib/admin-context";
import { api, describeError } from "@/lib/api";
import { categoryIcon, useCatalog } from "@/lib/catalog-api";
import { TODAY, addDays, dayLabel, rangeLabel } from "@/lib/format";
import type { Tone } from "@/types";

type RibbonStyle = "corner" | "horiz" | "badge" | "limited";
const STYLES: { id: RibbonStyle; label: string }[] = [
  { id: "corner", label: "Corner ribbon" }, { id: "horiz", label: "Horizontal" }, { id: "badge", label: "Discount badge" }, { id: "limited", label: "Limited-time" },
];

interface OfferRow {
  id: string;
  status: string;
  phase: string;
  audience: "CUSTOMERS" | "WORKERS" | "ALL";
  titleEn: string | null;
  titleAr: string | null;
  termsEn: string | null;
  endsAt: string;
  cityId: string | null;
  serviceId: string | null;
}

const COLUMNS: Column[] = [
  { label: "Offer", w: 2.2 }, { label: "Code", w: 0.9 }, { label: "Discount", w: 0.9 }, { label: "Cities", w: 1.3 }, { label: "Redemptions", w: 1, align: "end" }, { label: "Ends", w: 1 }, { label: "Status", w: 1 },
];
const FILTERS: ServerFilter[] = [{ key: "Status", label: "Status", options: ["All", "Active", "Scheduled", "Expired"], param: (v) => ({ phase: v.toUpperCase() }) }];
const PHASE: Record<string, [string, Tone]> = { LIVE: ["Active", "ok"], SCHEDULED: ["Scheduled", "warn"], EXPIRED: ["Expired", "neutral"], DRAFT: ["Draft", "neutral"], PAUSED: ["Paused", "warn"], ARCHIVED: ["Archived", "neutral"] };
const MAX_OFFERS_AT_ONCE = 12;

function Preview({ rtl, title, ribbon, cat, exp, style, endLabel }: { rtl: boolean; title: string; ribbon: string; cat: string; exp: string; style: RibbonStyle; endLabel: string }) {
  return (
    <div dir={rtl ? "rtl" : "ltr"} className={`flex flex-col gap-1.5 ${rtl ? "font-arabic" : ""}`}>
      <span className="text-[11px] font-bold tracking-[.06em] text-muted">{rtl ? "العربية · RTL" : "ENGLISH · LTR"}</span>
      <div className="relative flex min-h-[146px] flex-col gap-2 overflow-hidden rounded-[22px] bg-ink p-[20px_18px] text-white">
        {style === "corner" && (
          <div className="absolute top-5 w-[150px] bg-gold py-[5px] text-center text-[11px] font-extrabold tracking-[.05em] text-ink" style={{ insetInlineEnd: -38, transform: `rotate(${rtl ? -45 : 45}deg)` }}>
            {ribbon}
          </div>
        )}
        {style === "horiz" && (
          <div className="absolute top-0 rounded-b-[9px] bg-gold px-2.5 py-[5px] text-[10.5px] font-extrabold tracking-[.05em] text-ink" style={{ insetInlineStart: 18 }}>
            {ribbon}
          </div>
        )}
        {style === "limited" && (
          <div className="-mx-[18px] -mt-5 mb-1.5 flex items-center gap-1.5 bg-gold px-4 py-2 text-[11px] font-extrabold tracking-[.05em] text-ink">
            <Icon name="clock" size={13} />
            {rtl ? `لفترة محدودة • ينتهي ${endLabel}` : `LIMITED TIME • Ends ${endLabel}`}
          </div>
        )}
        <div className="text-xs font-semibold text-gold" style={{ marginTop: style === "horiz" ? 14 : 0 }}>{cat}</div>
        <div className="max-w-[250px] text-[19px] font-bold leading-[1.25]">{title}</div>
        <div className="mt-auto flex items-center gap-2">
          {style === "badge" && <span className="rounded-lg bg-gold px-2 py-1 text-[11.5px] font-extrabold text-ink">{ribbon}</span>}
          <span className="text-xs opacity-75">{exp}</span>
        </div>
      </div>
    </div>
  );
}


function CreateOffer({ onSaved }: { onSaved: () => void }) {
  const { cities, showToast } = useAdmin();
  const { categories, services } = useCatalog();
  const cats = categories.data?.items ?? [];
  const [f, setF] = useState({ tEn: "", tAr: "", dEn: "", dAr: "", type: "pct", val: "20", style: "corner" as RibbonStyle, cats: [] as string[], cities: [] as string[], audience: "CUSTOMERS" as "CUSTOMERS" | "WORKERS" | "ALL", from: TODAY, to: addDays(TODAY, 14) });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = <T,>(arr: T[], v: T) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
  const ribEn = f.type === "pct" ? `${f.val || 0}% OFF` : `SAVE SAR ${f.val || 0}`;
  const ribAr = f.type === "pct" ? `خصم ${f.val || 0}%` : `وفّر ${f.val || 0} ر.س`;
  const cat = cats.find((c) => f.cats.includes(c.id)) ?? cats[0];
  const cityNames = cities.filter((c) => f.cities.includes(c.id));
  const all = f.cities.length === 0 || f.cities.length === cities.length;
  const cityEn = all ? "All cities" : cityNames.map((c) => c.nameEn).join(", ");
  const cityAr = all ? "كل المدن" : cityNames.map((c) => c.nameAr).join("، ");
  const endLabel = rangeLabel(f.to, f.to);
  const valid = Boolean(f.tEn.trim() || f.tAr.trim()) && f.from <= f.to && f.to >= TODAY;

  async function save(publish: boolean) {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const wholeCatalogue = f.cats.length === 0 || f.cats.length === cats.length;
      const serviceIds: (string | null)[] = wholeCatalogue ? [null] : (services.data?.items ?? []).filter((s) => f.cats.includes(s.categoryId)).map((s) => s.id);
      const cityIds: (string | null)[] = all ? [null] : f.cities;
      if (serviceIds.length * cityIds.length > MAX_OFFERS_AT_ONCE) {
        setError(`That would make ${serviceIds.length * cityIds.length} offers at once. Pick fewer cities or categories (at most ${MAX_OFFERS_AT_ONCE}).`);
        return;
      }
      let made = 0;
      for (const cityId of cityIds) {
        for (const serviceId of serviceIds) {
          const body = {
            audience: f.audience,
            titleEn: f.tEn.trim() || undefined,
            titleAr: f.tAr.trim() || undefined,
            descriptionEn: f.dEn.trim() || undefined,
            descriptionAr: f.dAr.trim() || undefined,
            termsEn: Number(f.val) > 0 ? ribEn : undefined,
            termsAr: Number(f.val) > 0 ? ribAr : undefined,
            startsAt: new Date(`${f.from}T00:00:00+03:00`).toISOString(),
            endsAt: new Date(`${f.to}T23:59:59+03:00`).toISOString(),
            ...(cityId ? { cityId } : {}),
            ...(serviceId ? { serviceId } : {}),
          };
          const offer = await api.post<{ id: string }>("offers", body);
          if (publish) await api.post(`offers/${offer.id}/publish`, {});
          made += 1;
        }
      }
      showToast(`${made} offer${made === 1 ? "" : "s"} ${publish ? "published" : "saved as draft"}`);
      onSaved();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_420px] items-start gap-4">
      <Card className="flex flex-col gap-4 p-5">
        <div className="flex items-center justify-between">
          <div className="text-[16.5px] font-bold">Create offer</div>
          <span className="rounded-lg bg-soft px-[9px] py-1 text-xs font-bold text-slate">Draft</span>
        </div>
        <div className="grid grid-cols-2 gap-3.5">
          <Field label="Offer title (English)"><TextInput value={f.tEn} onChange={(tEn) => setF({ ...f, tEn })} placeholder="e.g. 20% off AC deep cleaning" /></Field>
          <Field label="عنوان العرض (عربي)" rtl><TextInput rtl value={f.tAr} onChange={(tAr) => setF({ ...f, tAr })} placeholder="مثال: خصم 20% على التنظيف العميق" /></Field>
          <Field label="Description (English)"><TextArea height={64} value={f.dEn} onChange={(dEn) => setF({ ...f, dEn })} /></Field>
          <Field label="الوصف (عربي)" rtl><TextArea rtl height={64} value={f.dAr} onChange={(dAr) => setF({ ...f, dAr })} /></Field>
        </div>
        <div className="grid grid-cols-[1.2fr_1fr_1fr_1fr] items-end gap-3.5">
          <div className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-semibold">Discount type</span>
            <Segmented options={[{ value: "pct", label: "Percentage" }, { value: "fixed", label: "Fixed amount" }]} value={f.type} onChange={(type) => setF({ ...f, type, val: type === "pct" ? "20" : "50" })} />
          </div>
          <Field label={f.type === "pct" ? "Discount (%)" : "Amount (SAR)"}><TextInput bold value={f.val} onChange={(v) => setF({ ...f, val: v.replace(/\D/g, "").slice(0, 3) })} /></Field>
          <Field label="Starts"><input type="date" value={f.from} min={TODAY} onChange={(e) => setF({ ...f, from: e.target.value })} className="h-[42px] rounded-[11px] border-[1.5px] border-line bg-white px-3 text-[13.5px]" /></Field>
          <Field label="Ends"><input type="date" value={f.to} min={f.from} onChange={(e) => setF({ ...f, to: e.target.value })} className="h-[42px] rounded-[11px] border-[1.5px] border-line bg-white px-3 text-[13.5px]" /></Field>
        </div>
        <div className="grid grid-cols-2 gap-3.5">
          <div className="flex flex-col gap-2">
            <span className="text-[12.5px] font-semibold">Service category</span>
            <div className="flex flex-wrap gap-1.5">
              {cats.map((c) => <Chip key={c.id} icon={categoryIcon(c.iconKey)} label={c.nameEn} selected={f.cats.includes(c.id)} onClick={() => setF({ ...f, cats: toggle(f.cats, c.id) })} />)}
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-[12.5px] font-semibold">Cities</span>
            <div className="flex flex-wrap gap-1.5">
              {cities.map((c) => <Chip key={c.id} label={c.nameEn} selected={f.cities.includes(c.id)} onClick={() => setF({ ...f, cities: toggle(f.cities, c.id) })} />)}
            </div>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-3.5">
          <Field label="Eligibility">
            <select value={f.audience} onChange={(e) => setF({ ...f, audience: e.target.value as typeof f.audience })} className="min-h-[42px] rounded-[11px] border-[1.5px] border-line bg-white px-3 text-[13.5px]">
              <option value="CUSTOMERS">All customers</option>
              <option value="WORKERS">All workers</option>
              <option value="ALL">Everyone signed in</option>
            </select>
          </Field>
          <Field label="Total usage limit"><StaticBox className="text-[13.5px] font-semibold">Not tracked</StaticBox></Field>
          <Field label="Per customer"><StaticBox className="text-[13.5px] font-semibold">Not tracked</StaticBox></Field>
        </div>
        <div className="flex flex-col gap-2">
          <span className="text-[12.5px] font-semibold">Ribbon style</span>
          <div className="grid grid-cols-4 gap-2">
            {STYLES.map((s) => (
              <button key={s.id} type="button" onClick={() => setF({ ...f, style: s.id })} className={`h-10 rounded-[11px] border-[1.5px] text-[13px] font-semibold ${f.style === s.id ? "border-[#9cc5ba] bg-tint text-brand" : "border-line bg-white text-ink"}`}>
                {s.label}
              </button>
            ))}
          </div>
        </div>
        {error && <div role="alert" className="rounded-xl border border-danger-line bg-danger-bg px-3 py-2.5 text-[13px] text-danger">{error}</div>}
        <div className="flex justify-end gap-2.5 border-t border-soft pt-1.5">
          <Button variant="outline" className="h-[42px]" disabled={!valid || busy} onClick={() => void save(false)}>Save draft</Button>
          <Button className="h-[42px] !px-[18px]" disabled={!valid || busy} onClick={() => void save(true)}>{busy ? "Saving…" : "Publish offer"}</Button>
        </div>
      </Card>
      <Card className="sticky top-0 flex flex-col gap-3.5 p-5">
        <div className="flex items-center justify-between"><div className="text-[15.5px] font-bold">Live preview</div><span className="text-xs text-slate">Customer app</span></div>
        <Preview rtl={false} style={f.style} title={f.tEn || "Offer title"} ribbon={ribEn} cat={cat?.nameEn ?? ""} exp={`Ends ${endLabel} · ${cityEn}`} endLabel={endLabel} />
        <Preview rtl style={f.style} title={f.tAr || "عنوان العرض"} ribbon={ribAr} cat={cat?.nameAr ?? ""} exp={`ينتهي ${endLabel} · ${cityAr}`} endLabel={endLabel} />
        <div className="text-xs leading-normal text-slate">Ribbon position mirrors automatically in Arabic. Gold ribbons carry charcoal text for contrast.</div>
      </Card>
    </div>
  );
}

export default function OffersPage() {
  const { cities, bump } = useAdmin();
  const cityName = new Map(cities.map((c) => [c.id, c.nameEn]));
  return (
    <ServerTablePage<OfferRow>
      before={<CreateOffer onSaved={bump} />}
      filters={FILTERS}
      path="offers"
      columns={COLUMNS}
      idOf={(o) => o.id}
      toRow={(o) => {
        const [label, tone] = PHASE[o.phase] ?? [o.phase, "neutral" as Tone];
        const discount = o.termsEn && /^(\d+% OFF|SAVE SAR \d+)$/.test(o.termsEn) ? o.termsEn.replace("OFF", "off").replace("SAVE", "Save") : "—";
        return {
          key: o.id,
          cells: [text(o.titleEn ?? o.titleAr ?? "Untitled", o.titleEn ? (o.titleAr ?? undefined) : undefined, { fw: 600 }), mono("—"), text(discount), text(o.cityId ? (cityName.get(o.cityId) ?? "—") : "All cities"), num("—"), text(dayLabel(o.endsAt)), badge(label, tone)],
        };
      }}
      footerBase={(shown, total) => `${total} ${total === 1 ? "offer" : "offers"}${shown < total ? ` · showing ${shown}` : ""}`}
    />
  );
}
