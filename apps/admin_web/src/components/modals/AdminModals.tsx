"use client";

import { useState } from "react";
import { Field, TextArea, TextInput, UnitInput } from "@/components/forms/fields";
import { Icon } from "@/components/ui/Icon";
import { Chip, Segmented } from "@/components/ui/primitives";
import { useAdmin } from "@/lib/admin-context";
import { api, describeError } from "@/lib/api";
import { categoryIcon, slugify, useCatalog } from "@/lib/catalog-api";
import { addDays, TODAY } from "@/lib/format";
import { Modal } from "./Modal";

const digits = (v: string, max: number) => v.replace(/\D/g, "").slice(0, max);

/** Renders whichever dialog is currently open in the admin context. */
export function AdminModals() {
  const { modal } = useAdmin();
  if (modal === "service") return <AddServiceModal />;
  if (modal === "rules") return <EditRulesModal />;
  return null;
}

function AddServiceModal() {
  const { openModal, showToast, bump } = useAdmin();
  const { categories, pricing } = useCatalog();
  const cats = categories.data?.items ?? [];
  const [f, setF] = useState({ cat: "", en: "", ar: "", dEn: "", dAr: "", status: "Active" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cat = f.cat || cats[0]?.id || "";
  const ok = !busy && !!cat && f.en.trim().length >= 2 && f.ar.trim().length >= 2;
  const minCharge = pricing.data ? String(pricing.data.minServiceChargeHalalas / 100) : "";
  const rate = pricing.data ? String(pricing.data.commissionRateBps / 100) : "";

  async function submit() {
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await api.post("services", { categoryId: cat, slug: slugify(f.en), nameEn: f.en.trim(), nameAr: f.ar.trim(), descriptionEn: f.dEn.trim(), descriptionAr: f.dAr.trim(), isActive: f.status === "Active" });
      openModal(null);
      showToast(`${f.en.trim()} ${f.status === "Active" ? "published to the app" : "saved as inactive"}`);
      bump();
    } catch (e) {
      setError(describeError(e));
      setBusy(false);
    }
  }

  return (
    <Modal title="Add service" subtitle="Appears in the customer app under its category once Active. English and Arabic names are both required." icon="sliders" width={820} hint={error ?? (ok ? "Ready" : "Fill in both names")} cta={busy ? "Saving…" : f.status === "Active" ? "Publish service" : "Save inactive"} canSubmit={ok} onClose={() => openModal(null)} onSubmit={() => void submit()}>
      <div className="flex flex-col gap-2">
        <span className="text-[12.5px] font-semibold">Category *</span>
        <div className="flex gap-2">
          {cats.map((c) => (
            <Chip key={c.id} icon={categoryIcon(c.iconKey)} label={c.nameEn} selected={cat === c.id} className="!h-[38px] !px-3.5" onClick={() => setF({ ...f, cat: c.id })} />
          ))}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3.5">
        <Field label="Service name (English) *">
          <TextInput value={f.en} onChange={(en) => setF({ ...f, en })} placeholder="e.g. Ceiling Fan Installation" />
        </Field>
        <Field label="اسم الخدمة (عربي) *" rtl>
          <TextInput rtl value={f.ar} onChange={(ar) => setF({ ...f, ar })} placeholder="مثال: تركيب مروحة سقف" />
        </Field>
        <Field label="Description (English)">
          <TextArea height={76} value={f.dEn} onChange={(dEn) => setF({ ...f, dEn })} placeholder="What the professional does, shown on the service page" />
        </Field>
        <Field label="الوصف (عربي)" rtl>
          <TextArea rtl height={76} value={f.dAr} onChange={(dAr) => setF({ ...f, dAr })} placeholder="ما يقوم به الفني، يظهر في صفحة الخدمة" />
        </Field>
      </div>
      <div className="grid grid-cols-4 gap-3.5">
        <Field label="Minimum charge">
          <UnitInput prefix="SAR" value={minCharge} onChange={() => undefined} />
        </Field>
        <Field label="Commission override">
          <UnitInput suffix="%" placeholder="Platform rate" value={rate} onChange={() => undefined} />
        </Field>
        <Field label="Est. duration">
          <TextInput value="Set by the worker" />
        </Field>
        <div className="flex flex-col gap-1.5">
          <span className="text-[12.5px] font-semibold">Status</span>
          <Segmented options={[{ value: "Active", label: "Active" }, { value: "Draft", label: "Inactive" }]} value={f.status} onChange={(status) => setF({ ...f, status })} />
        </div>
      </div>
    </Modal>
  );
}

function EditRulesModal() {
  const { openModal, showToast, bump } = useAdmin();
  const { pricing } = useCatalog();
  const current = pricing.data;
  const [f, setF] = useState<{ commission: string; vat: string; min: string } | null>(null);
  const [eff, setEff] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const v = f ?? (current ? { commission: String(current.commissionRateBps / 100), vat: String(current.vatRateBps / 100), min: String(current.minServiceChargeHalalas / 100) } : { commission: "", vat: "", min: "" });
  const pct = (s: string) => s !== "" && Number.isFinite(Number(s)) && Number(s) >= 0 && Number(s) <= 50;
  const ok = !busy && !!current && pct(v.commission) && pct(v.vat) && v.min !== "" && Number(v.min) >= 0;
  const fee = Math.round((300 * (Number(v.commission) || 0)) / 100);
  const tomorrow = addDays(TODAY, 1);

  const rows = [
    { k: "commission" as const, label: "Platform commission", desc: "Share of the service price (before VAT) the platform keeps", old: current ? current.commissionRateBps / 100 : 0, suffix: "%" },
    { k: "vat" as const, label: "VAT", desc: "Added to the service price", old: current ? current.vatRateBps / 100 : 0, suffix: "%" },
    { k: "min" as const, label: "Minimum service charge", desc: "Lowest price a professional may quote, before VAT", old: current ? current.minServiceChargeHalalas / 100 : 0, suffix: "SAR" },
  ];

  async function submit() {
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      await api.post("pricing-settings", {
        commissionRateBps: Math.round(Number(v.commission) * 100),
        vatRateBps: Math.round(Number(v.vat) * 100),
        minServiceChargeHalalas: Math.round(Number(v.min) * 100),
        ...(eff === 1 ? { effectiveFrom: new Date(`${tomorrow}T00:00:00+03:00`).toISOString() } : {}),
        note: "Changed in the admin console",
      });
      openModal(null);
      showToast(eff === 0 ? "Commission rules updated · live now" : "Commission rules scheduled for tomorrow");
      bump();
    } catch (e) {
      setError(describeError(e));
      setBusy(false);
    }
  }

  return (
    <Modal title="Edit commission rules" subtitle="Rates apply to the booking amount before VAT. Existing accepted quotes keep the rate they were accepted at." icon="percent" width={640} hint={error ?? (ok ? "Changes are logged in the admin audit trail" : "Rates must be between 0 and 50%")} cta={busy ? "Saving…" : "Save rules"} canSubmit={ok} onClose={() => openModal(null)} onSubmit={() => void submit()}>
      <div className="flex flex-col">
        {rows.map((r) => {
          const changed = Number(v[r.k]) !== r.old;
          const bad = r.k === "min" ? v.min === "" : !pct(v[r.k]);
          return (
            <div key={r.k} className="flex items-center gap-3.5 border-b border-faint py-3">
              <div className="flex flex-1 flex-col gap-0.5">
                <b className="text-sm font-semibold">{r.label}</b>
                <span className="text-xs text-slate">{r.desc}</span>
              </div>
              <span className={`whitespace-nowrap text-xs font-semibold ${changed ? "text-[#8a5b00]" : "text-slate"}`}>{changed ? `${r.old}${r.suffix === "%" ? "%" : ""} → ${v[r.k] || 0}${r.suffix === "%" ? "%" : ""}` : ""}</span>
              <div className={`flex h-10 w-[110px] items-center overflow-hidden rounded-[11px] border-[1.5px] ${bad ? "border-danger" : "border-line"}`}>
                <input value={v[r.k]} onChange={(e) => setF({ ...v, [r.k]: r.k === "min" ? digits(e.target.value, 6) : e.target.value.replace(/[^\d.]/g, "").slice(0, 5) })} className="min-w-0 flex-1 border-none px-2.5 text-end text-[15px] font-bold" />
                <span className="px-2.5 text-[13px] font-semibold text-slate">{r.suffix}</span>
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-[12.5px] font-semibold">Takes effect</span>
        <Segmented className="w-[360px]" options={[{ value: 0, label: "Immediately" }, { value: 1, label: `Tomorrow (${tomorrow})` }]} value={eff} onChange={setEff} />
      </div>
      <div className="flex flex-col gap-1.5 rounded-[14px] bg-ink p-3.5 text-white">
        <span className="flex items-center gap-1.5 text-xs opacity-70">
          <Icon name="info" size={12} /> Example · SAR 300 booking
        </span>
        <div className="flex gap-[22px] text-sm">
          <span>Platform <b className="text-gold">SAR {fee}</b></span>
          <span>Worker earns <b>SAR {300 - fee}</b></span>
        </div>
      </div>
    </Modal>
  );
}
