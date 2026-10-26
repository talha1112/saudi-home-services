"use client";

import { useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { Card, Toggle } from "@/components/ui/primitives";
import { useAdmin } from "@/lib/admin-context";
import { describeError, useQuery } from "@/lib/api";
import type { PricingSetting } from "@/lib/catalog-api";
import { agoLabel, dayLabel, humanize, sarH } from "@/lib/format";

/** [label, description, kind (v = a value, t = on/off), value, opens the commission rules dialog] */
type Row = [label: string, description: string, kind: "v" | "t", value: string | boolean, editable?: boolean];

interface Admin {
  id: string;
  fullName: string | null;
  email: string | null;
  status: string;
  lastLoginAt: string | null;
  mustChangePassword: boolean;
}

interface System {
  environment: string;
  cities: { id: string; nameEn: string; nameAr: string; isActive: boolean }[];
  catalog: { categories: number; activeServices: number };
  bookings: {
    requestTtlHours: number;
    minLeadMinutes: number;
    maxOpenPerCustomer: number;
    maxQuotesPerBooking: number;
    quoteDefaultValidityHours: number;
    quoteMaxValidityHours: number;
    paymentWindowMinutes: number;
    openRequestsNow: number;
  };
  payments: { onlineProvider: string; cashOnDelivery: boolean; checkoutTtlMinutes: number };
  notifications: { pushProvider: string; fcmEnabled: boolean; fcmDryRun: boolean; maxDevicesPerUser: number };
  signIn: { phoneSmsProvider: string; firebasePhoneAuth: boolean; defaultPhoneRegion: string };
  workers: { requireIdentityDocument: boolean };
  realtime: { enabled: boolean };
}

interface OptIn {
  pushOptIn: { customers: { pct: number | null; withPhone: number; accounts: number }; workers: { pct: number | null; withPhone: number; accounts: number } };
}

const TABS: [string, string][] = [
  ["Admin users & roles", "users"], ["Service configuration", "sliders"], ["Payment configuration", "card"], ["Commission", "percent"],
  ["Subscriptions", "refresh"], ["Notifications", "bell"], ["Localization", "globe"], ["General marketplace", "settings"],
];

const hours = (h: number) => (h === 1 ? "1 hour" : `${h} hours`);
const mins = (m: number) => (m % 60 === 0 && m >= 60 ? hours(m / 60) : `${m} min`);

function rowsFor(tab: number, admins: Admin[], sys: System | null, price: PricingSetting | null, opt: OptIn | null): Row[] {
  const loading: Row[] = [["Loading…", "", "v", "…"]];
  switch (tab) {
    case 0:
      return admins.length
        ? [
            ...admins.map((a): Row => [a.fullName ?? a.email ?? "Administrator", `${a.email ?? "no e-mail"} · ${a.lastLoginAt ? `last active ${agoLabel(a.lastLoginAt)}` : "never signed in"}${a.mustChangePassword ? " · must change password" : ""}`, "v", a.status === "ACTIVE" ? "Administrator" : humanize(a.status)]),
            ["Adding or removing administrators", "Administrator accounts are created with the command-line tool, never from this screen", "v", "Command line"],
          ]
        : loading;
    case 1:
      return sys && price
        ? [
            ["Minimum service charge", "Lowest price a professional may quote, before VAT", "v", sarH(price.minServiceChargeHalalas), true],
            ["Quote validity", "How long a quote stays open: default · longest a worker may choose", "v", `${hours(sys.bookings.quoteDefaultValidityHours)} · ${hours(sys.bookings.quoteMaxValidityHours)}`],
            ["Max quotes per request", "Customers see up to this many", "v", String(sys.bookings.maxQuotesPerBooking)],
            ["Earliest visit", "A request must start at least this long from now", "v", mins(sys.bookings.minLeadMinutes)],
            ["Identity document required to join", "Workers must upload an ID before review", "t", sys.workers.requireIdentityDocument],
          ]
        : loading;
    case 2:
      return sys
        ? [
            ["Cash on delivery", "The customer pays the professional in person", "t", sys.payments.cashOnDelivery],
            ["Online payment", `Provider: ${humanize(sys.payments.onlineProvider)}`, "t", sys.payments.onlineProvider !== "disabled"],
            ["Card, Apple Pay, STC Pay", "Shown as “Coming soon” in the customer app", "t", false],
            ["Payment window", "Time a customer has to pay after accepting a quote", "v", mins(sys.bookings.paymentWindowMinutes)],
            ["Online checkout link lifetime", "", "v", mins(sys.payments.checkoutTtlMinutes)],
          ]
        : loading;
    case 3:
      return price
        ? [
            ["Platform commission", "Share of the service price (before VAT) the platform keeps", "v", `${price.commissionRateBps / 100}%`, true],
            ["VAT", "Added on top of the service price", "v", `${price.vatRateBps / 100}%`, true],
            ["In force since", price.isProvisional ? "Placeholder rates that the business has not confirmed" : "Applies to new quotes; accepted quotes keep their rate", "v", dayLabel(price.effectiveFrom)],
            ["Payouts to workers", "The platform does not record payouts yet", "v", "Not recorded"],
          ]
        : loading;
    case 4:
      return [["Worker subscriptions", "Every approved worker pays the one commission rate", "t", false], ["Plans and prices", "Not part of the platform yet", "v", "None"]];
    case 5:
      return sys
        ? [
            ["Push delivery", "Who sends notifications to phones", "v", sys.notifications.pushProvider === "fcm" ? "Firebase (FCM)" : humanize(sys.notifications.pushProvider)],
            ["Firebase push enabled", sys.notifications.fcmDryRun ? "Dry run: messages are built but not delivered" : "Messages are delivered to phones", "t", sys.notifications.fcmEnabled && !sys.notifications.fcmDryRun],
            ["Phones per account", "Most devices that can receive push for one person", "v", String(sys.notifications.maxDevicesPerUser)],
            ["Push opt-in · customers", opt ? `${opt.pushOptIn.customers.withPhone} of ${opt.pushOptIn.customers.accounts} accounts have a phone registered` : "", "v", opt?.pushOptIn.customers.pct != null ? `${opt.pushOptIn.customers.pct}%` : "—"],
            ["Push opt-in · workers", opt ? `${opt.pushOptIn.workers.withPhone} of ${opt.pushOptIn.workers.accounts} accounts have a phone registered` : "", "v", opt?.pushOptIn.workers.pct != null ? `${opt.pushOptIn.workers.pct}%` : "—"],
          ]
        : loading;
    case 6:
      return price
        ? [["Default language", "First launch", "v", "Arabic"], ["Currency", "", "v", "SAR (ر.س)"], ["VAT rate", "", "v", `${price.vatRateBps / 100}%`, true], ["Time zone", "Dates and reports", "v", "Asia/Riyadh (UTC+3)"], ["Phone numbers", "Default region for sign-in", "v", sys?.signIn.defaultPhoneRegion ?? "SA"]]
        : loading;
    default:
      return sys
        ? [
            ["Cities", sys.cities.map((c) => `${c.nameEn}${c.isActive ? "" : " (off)"}`).join(", ") || "None", "v", String(sys.cities.length)],
            ["Service catalogue", `${sys.catalog.categories} categories`, "v", `${sys.catalog.activeServices} active services`],
            ["Request lifetime", "A request stops taking quotes after this long", "v", hours(sys.bookings.requestTtlHours)],
            ["Open requests per customer", "", "v", String(sys.bookings.maxOpenPerCustomer)],
            ["Live location and chat", "Real-time connection for tracking and messages", "t", sys.realtime.enabled],
            ["Environment", "", "v", humanize(sys.environment)],
          ]
        : loading;
  }
}

export default function SettingsPage() {
  const { version, openModal } = useAdmin();
  const [tab, setTab] = useState(0);
  const admins = useQuery<Admin[]>("admins", version);
  const system = useQuery<System>("system", version);
  const pricing = useQuery<PricingSetting>("pricing-settings/current", version);
  const optIn = useQuery<OptIn>("notifications/summary", version);
  const error = [admins, system, pricing, optIn].find((q) => q.error)?.error;
  const rows = rowsFor(tab, admins.data ?? [], system.data, pricing.data, optIn.data);
  return (
    <div className="grid grid-cols-[220px_minmax(0,1fr)] items-start gap-4">
      <Card className="flex flex-col gap-0.5 p-2">
        {TABS.map(([label, icon], i) => (
          <button key={label} type="button" onClick={() => setTab(i)} className={`flex h-10 items-center gap-2.5 rounded-[10px] px-3 text-start text-[13.5px] font-semibold ${tab === i ? "bg-ink text-white" : "text-slate"}`}>
            <Icon name={icon} size={16} />{label}
          </button>
        ))}
      </Card>
      <Card className="px-5 pb-3 pt-1.5">
        {error && <div role="alert" className="my-3 rounded-xl border border-danger-line bg-danger-bg px-4 py-3 text-[13.5px] text-danger">{describeError(error)}</div>}
        {rows.map(([label, description, kind, value, editable], i) => (
          <div key={`${tab}-${i}`} className="flex items-center gap-4 border-b border-faint py-3.5">
            <div className="flex flex-1 flex-col gap-[3px]">
              <b className="text-sm font-semibold">{label}</b>
              {description && <span className="text-[12.5px] leading-[1.45] text-slate">{description}</span>}
            </div>
            {kind === "t" ? (
              <Toggle on={value as boolean} />
            ) : (
              <button type="button" disabled={!editable} onClick={() => openModal("rules")} className={`flex h-[38px] min-w-[140px] items-center justify-between gap-2 rounded-[10px] border-[1.5px] border-line px-3 text-[13.5px] font-semibold ${editable ? "" : "cursor-default"}`}>
                {String(value)}
                <Icon name={editable ? "chevron-down" : "chevron-down"} size={14} />
              </button>
            )}
          </div>
        ))}
      </Card>
    </div>
  );
}
