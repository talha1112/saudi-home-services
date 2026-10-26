/** Shapes of the backend's `/admin/workers` API (see the backend's admin-workers DTOs). Only the fields the screens use. */

export type VerificationStatus = "NOT_SUBMITTED" | "SUBMITTED" | "UNDER_REVIEW" | "INFO_REQUIRED" | "APPROVED" | "REJECTED" | "SUSPENDED";
export type DocumentStatus = "PENDING_UPLOAD" | "UPLOADED" | "ACCEPTED" | "REJECTED";

export interface PageMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface Paged<T> {
  items: T[];
  meta: PageMeta;
}

export interface WorkerListItem {
  id: string;
  userId: string;
  fullName: string | null;
  fullNameAr: string | null;
  phone: string | null;
  verificationStatus: VerificationStatus;
  submittedAt: string | null;
  serviceCount: number;
  cityCount: number;
  documentCount: number;
}

export interface AdminDocument {
  id: string;
  type: string;
  status: DocumentStatus;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  expiresOn: string | null;
  reviewNote: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

export interface WorkerDetail {
  id: string;
  userId: string;
  fullName: string | null;
  fullNameAr: string | null;
  phone: string | null;
  email: string | null;
  accountStatus: string;
  bio: string | null;
  yearsOfExperience: number | null;
  verificationStatus: VerificationStatus;
  verificationNote: string | null;
  submittedAt: string | null;
  verifiedAt: string | null;
  services: { id: string; nameEn: string; nameAr: string; workerYearsOfExperience: number | null }[];
  cities: { id: string; nameEn: string; nameAr: string }[];
  availability: { dayOfWeek: number; startTime: string; endTime: string }[];
  documents: AdminDocument[];
  history: { action: string; fromStatus: VerificationStatus; toStatus: VerificationStatus; reason: string | null; actorName: string | null; createdAt: string }[];
}

export const STATUS_LABEL: Record<VerificationStatus, string> = {
  NOT_SUBMITTED: "Not submitted",
  SUBMITTED: "Submitted",
  UNDER_REVIEW: "Under review",
  INFO_REQUIRED: "Info requested",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  SUSPENDED: "Suspended",
};

export const DOCUMENT_LABEL: Record<string, string> = {
  NATIONAL_ID: "National ID",
  IQAMA: "Iqama",
  PROFESSIONAL_LICENSE: "Professional license",
  CERTIFICATE: "Certificate",
  PHOTO: "Profile photo",
  OTHER: "Other document",
};

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Sun, Mon 08:00-17:00" style summary of a weekly schedule (windows that share hours are grouped). */
export function describeAvailability(windows: WorkerDetail["availability"]): string {
  if (windows.length === 0) return "Not set";
  const byHours = new Map<string, number[]>();
  for (const w of windows) byHours.set(`${w.startTime}-${w.endTime}`, [...(byHours.get(`${w.startTime}-${w.endTime}`) ?? []), w.dayOfWeek]);
  return [...byHours].map(([hours, days]) => `${days.sort().map((d) => DAYS[d] ?? "?").join(", ")} ${hours}`).join(" · ");
}

export function initials(name: string | null, fallback = "?"): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return fallback;
  return (parts[0]![0]! + (parts.length > 1 ? parts[parts.length - 1]![0]! : "")).toUpperCase();
}

export function ago(iso: string | null, now: number = Date.now()): string {
  if (!iso) return "—";
  const ms = now - new Date(iso).getTime();
  const h = Math.floor(ms / 3_600_000);
  if (h < 1) return "just now";
  if (h < 24) return `${h} h`;
  return `${Math.floor(h / 24)} d`;
}
