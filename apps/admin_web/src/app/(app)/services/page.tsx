"use client";

import { useState } from "react";
import { Field, StaticBox, TextArea, TextInput } from "@/components/forms/fields";
import { badge, num, text, type Column } from "@/components/tables/cells";
import { ServerTablePage, type ServerFilter } from "@/components/tables/ServerTablePage";
import { Icon } from "@/components/ui/Icon";
import { Button, Card } from "@/components/ui/primitives";
import { useAdmin } from "@/lib/admin-context";
import { api, describeError } from "@/lib/api";
import { categoryIcon, useCatalog, type CategoryItem, type ServiceItem } from "@/lib/catalog-api";
import { fmt, sarH } from "@/lib/format";

const COLUMNS: Column[] = [
  { label: "Service", w: 2.4 }, { label: "Category", w: 1.1 }, { label: "Min. charge", w: 1, align: "end" }, { label: "Commission", w: 0.9, align: "end" },
  { label: "Avg. quote", w: 1, align: "end" }, { label: "Bookings", w: 0.9, align: "end" }, { label: "Status", w: 0.9 },
];

/** The edit form for one service. It is remounted (keyed) whenever another service is chosen or the saved one changes, so its fields start from the saved values. */
function Editor({ service, categories, minCharge, onSaved, onError }: { service: ServiceItem; categories: CategoryItem[]; minCharge: string; onSaved: () => void; onError: (m: string) => void }) {
  const [f, setF] = useState({ nameEn: service.nameEn, nameAr: service.nameAr, descEn: service.descriptionEn ?? "", descAr: service.descriptionAr ?? "", categoryId: service.categoryId, isActive: service.isActive });
  const [busy, setBusy] = useState(false);
  const [resets, setResets] = useState(0);
  const dirty = f.nameEn !== service.nameEn || f.nameAr !== service.nameAr || f.descEn !== (service.descriptionEn ?? "") || f.descAr !== (service.descriptionAr ?? "") || f.categoryId !== service.categoryId || f.isActive !== service.isActive;

  async function save() {
    setBusy(true);
    try {
      await api.patch(`services/${service.id}`, { nameEn: f.nameEn, nameAr: f.nameAr, descriptionEn: f.descEn, descriptionAr: f.descAr, categoryId: f.categoryId, isActive: f.isActive });
      onSaved();
    } catch (e) {
      onError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card key={resets} className="flex flex-col gap-4 p-5">
      <div className="flex items-center justify-between">
        <div className="flex flex-col gap-0.5"><div className="text-xs text-slate">Editing service</div><div className="text-[16.5px] font-bold">{service.nameEn}</div></div>
        <div className="flex gap-2">
          <Button variant="outline" className="!h-[38px] !rounded-[11px] !px-3.5 !text-[13px]" disabled={!dirty || busy} onClick={() => { setF({ nameEn: service.nameEn, nameAr: service.nameAr, descEn: service.descriptionEn ?? "", descAr: service.descriptionAr ?? "", categoryId: service.categoryId, isActive: service.isActive }); setResets((n) => n + 1); }}>Discard</Button>
          <Button className="!h-[38px] !rounded-[11px] !text-[13px]" disabled={!dirty || busy || f.nameEn.trim().length < 2 || f.nameAr.trim().length < 2} onClick={() => void save()}>{busy ? "Saving…" : "Save changes"}</Button>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div className="flex flex-col gap-2.5">
          <div className="text-[11.5px] font-bold tracking-[.06em] text-slate">ENGLISH CONTENT</div>
          <Field label="Name"><TextInput value={f.nameEn} onChange={(nameEn) => setF({ ...f, nameEn })} /></Field>
          <Field label="Description"><TextArea height={66} value={f.descEn} onChange={(descEn) => setF({ ...f, descEn })} /></Field>
        </div>
        <div dir="rtl" className="font-arabic flex flex-col gap-2.5">
          <div className="text-[11.5px] font-bold text-slate">المحتوى العربي</div>
          <Field label="الاسم" rtl><TextInput rtl value={f.nameAr} onChange={(nameAr) => setF({ ...f, nameAr })} /></Field>
          <Field label="الوصف" rtl><TextArea rtl height={66} value={f.descAr} onChange={(descAr) => setF({ ...f, descAr })} /></Field>
        </div>
      </div>
      <div className="grid grid-cols-5 gap-3">
        <div className="flex flex-col gap-1.5"><span className="text-[12.5px] font-semibold">Minimum charge</span><StaticBox className="font-semibold">{minCharge}</StaticBox><span className="text-[11.5px] text-slate">Platform default for every service</span></div>
        <div className="flex flex-col gap-1.5"><span className="text-[12.5px] font-semibold">Commission override</span><StaticBox className="font-semibold">None</StaticBox><span className="text-[11.5px] text-slate">Blank = platform rate</span></div>
        <div className="flex flex-col gap-1.5"><span className="text-[12.5px] font-semibold">Est. duration</span><StaticBox className="font-semibold">—</StaticBox><span className="text-[11.5px] text-slate">Workers set it in their quote</span></div>
        <div className="flex flex-col gap-1.5">
          <span className="text-[12.5px] font-semibold">Category</span>
          <select value={f.categoryId} onChange={(e) => setF({ ...f, categoryId: e.target.value })} className="min-h-[42px] rounded-[11px] border-[1.5px] border-line bg-white px-3 text-sm font-semibold">
            {categories.map((c) => <option key={c.id} value={c.id}>{c.nameEn}</option>)}
          </select>
          <span className="text-[11.5px] text-slate" />
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-[12.5px] font-semibold">Status</span>
          <button type="button" onClick={() => setF({ ...f, isActive: !f.isActive })} className="flex min-h-[42px] items-center justify-between rounded-[11px] border-[1.5px] border-line bg-white px-3 text-start text-sm font-semibold">
            {f.isActive ? "Active" : "Inactive"}<Icon name="refresh" size={14} />
          </button>
          <span className="text-[11.5px] text-slate">Visible in app when Active</span>
        </div>
      </div>
    </Card>
  );
}

export default function ServicesPage() {
  const { openModal, version, bump, showToast } = useAdmin();
  const { categories, services, stats, pricing } = useCatalog(version);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const cats = categories.data?.items ?? [];
  const list = services.data?.items ?? [];
  const catName = new Map(cats.map((c) => [c.id, c.nameEn]));
  const serviceStats = new Map((stats.data?.services ?? []).map((s) => [s.serviceId, s]));
  const catStats = new Map((stats.data?.categories ?? []).map((c) => [c.categoryId, c]));
  const current = list.find((s) => s.id === selected) ?? list[0] ?? null;
  const min = pricing.data ? sarH(pricing.data.minServiceChargeHalalas) : "…";
  const rate = pricing.data ? `${pricing.data.commissionRateBps / 100}%` : "…";
  const categoryId = new Map(cats.map((c) => [c.nameEn, c.id]));
  const filters: ServerFilter[] = [
    { key: "Category", label: "Category", options: ["All", ...categoryId.keys()], param: (v) => ({ categoryId: categoryId.get(v) }) },
    { key: "Status", label: "Status", options: ["All", "Active", "Inactive"], param: (v) => ({ isActive: v === "Active" ? "true" : "false" }) },
  ];

  async function toggleCategory(c: CategoryItem) {
    try {
      await api.patch(`service-categories/${c.id}`, { isActive: !c.isActive });
      showToast(c.isActive ? `${c.nameEn} hidden from the app` : `${c.nameEn} shown in the app`);
      bump();
    } catch (e) {
      showToast(describeError(e));
    }
  }

  const block = (
    <>
      <div className="grid grid-cols-3 gap-3.5">
        {cats.map((c) => {
          const inCat = list.filter((s) => s.categoryId === c.id);
          const active = current?.categoryId === c.id;
          return (
            <button key={c.id} type="button" onClick={() => setSelected(inCat[0]?.id ?? null)} className={`flex flex-col gap-3.5 rounded-[18px] border-[1.5px] bg-white p-[18px] text-start ${active ? "border-[#9cc5ba]" : "border-hair"}`}>
              <div className="flex w-full items-center gap-3">
                <span className="grid size-11 place-items-center rounded-[13px] bg-tint text-brand"><Icon name={categoryIcon(c.iconKey)} size={21} /></span>
                <span className="flex flex-1 flex-col gap-0.5"><b className="text-base">{c.nameEn}</b><span className="font-arabic text-sm text-slate">{c.nameAr}</span></span>
                <span role="switch" aria-checked={c.isActive} aria-label={`${c.nameEn} visible in the app`} onClick={(e) => { e.stopPropagation(); void toggleCategory(c); }} className={`flex h-6 w-10 rounded-full p-0.5 ${c.isActive ? "justify-end bg-brand" : "justify-start bg-[#d5dde2]"}`}><span className="size-5 rounded-full bg-white" /></span>
              </div>
              <div className="grid w-full grid-cols-3 gap-2 text-xs text-slate">
                {[[String(inCat.length), "Services"], [fmt(catStats.get(c.id)?.bookings ?? 0), "Bookings"], [fmt(catStats.get(c.id)?.workers ?? 0), "Workers"]].map(([v, k]) => (
                  <span key={k} className="flex flex-col gap-0.5"><b className="text-base text-ink">{v}</b>{k}</span>
                ))}
              </div>
            </button>
          );
        })}
      </div>
      {error && <div role="alert" className="rounded-xl border border-danger-line bg-danger-bg px-4 py-3 text-[13.5px] text-danger">{error}</div>}
      {current ? (
        <Editor
          key={`${current.id}-${current.nameEn}-${current.nameAr}-${current.descriptionEn}-${current.descriptionAr}-${current.categoryId}-${current.isActive}`}
          service={current}
          categories={cats}
          minCharge={min}
          onError={setError}
          onSaved={() => { setError(null); showToast("Service saved"); bump(); }}
        />
      ) : (
        <Card className="px-5 py-10 text-center text-[13.5px] text-slate">{services.loading ? "Loading…" : "No services yet. Use “Add service”."}</Card>
      )}
    </>
  );

  return (
    <ServerTablePage<ServiceItem>
      before={block}
      filters={filters}
      action={{ label: "Add service", icon: "plus", onClick: () => openModal("service") }}
      path="services"
      columns={COLUMNS}
      idOf={(s) => s.id}
      onSelect={(s) => { setSelected(s.id); setError(null); }}
      toRow={(x) => {
        const st = serviceStats.get(x.id);
        return { key: x.id, cells: [text(x.nameEn, x.nameAr, { fw: 600 }), text(catName.get(x.categoryId) ?? "—"), num(min), num(rate), num(st?.averageQuoteHalalas ? sarH(st.averageQuoteHalalas) : "—"), num(fmt(st?.bookings ?? 0)), badge(x.isActive ? "Active" : "Inactive", x.isActive ? "ok" : "neutral")] };
      }}
      footerBase={(shown, total) => `${total} services · ${cats.length} categories${shown < total ? ` · showing ${shown}` : ""}`}
    />
  );
}
