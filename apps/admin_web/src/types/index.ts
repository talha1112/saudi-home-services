export type Tone = "ok" | "warn" | "bad" | "neutral" | "dark";

/** "all" or a city id from the database. */
export type CityFilter = string;

/** [name, initials, phone, services, city, rating, jobs, gross, commission, plan, status] */
export type WorkerRow = [string, string, string, string, string, number, number, number, number, string, string];

/** [name, initials, phone, city, bookings, spent, last booking, disputes, status] */
export type CustomerRow = [string, string, string, string, number, number, string, number, string];

/** [id, service, customer, professional, city, when, amount, payment, status] */
export type BookingRow = [string, string, string, string, string, string, number, string, string];

export interface Dispute {
  id: string;
  t: string;
  cat: string;
  cust: string;
  ci: string;
  wk: string;
  wi: string;
  bk: string;
  amt: number;
  status: "submitted" | "review" | "action" | "resolved";
  opened: string;
  city: string;
  svc: string;
}

export interface VerificationApplicant {
  n: string;
  ar: string;
  ini: string;
  svc: string;
  city: string;
  age: string;
  st: string;
  exp: string;
  dist: string;
  phone: string;
}

/** [en, ar, category, min charge, commission %, avg quote, bookings, status, descEn, descAr, duration] */
export type ServiceRow = [string, string, string, number, number, number, number, string, string, string, string];

export interface Category {
  id: string;
  en: string;
  ar: string;
  icon: string;
}

export interface Kpi {
  k: string;
  v: string;
  icon: string;
  d: string;
  dc?: string;
  tone?: "gold" | "red";
}

export interface PanelData {
  ini: string;
  title: string;
  sub: string;
  badges: { l: string; tone?: Tone }[];
  stats?: { v: string; k: string }[];
  sections: { t: string; rows: [string, string, string?][] }[];
  actions: { l: string; icon: string; danger?: boolean; onClick?: () => void }[];
}
