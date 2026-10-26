/** Shapes of the backend's `/admin/support/threads` API (the person's conversation with the administrators). */

export type SupportStatus = "OPEN" | "ANSWERED" | "RESOLVED";

export interface SupportThread {
  id: string;
  userId: string;
  status: SupportStatus;
  role: "CUSTOMER" | "WORKER";
  fullName: string | null;
  phone: string | null;
  /** For workers: why they are writing is often the application status. */
  workerVerificationStatus: string | null;
  workerId: string | null;
  lastMessage: string | null;
  lastSenderRole: "CUSTOMER" | "WORKER" | "ADMIN";
  lastMessageAt: string;
  messageCount: number;
}

export interface SupportMessage {
  id: string;
  seq: number;
  senderRole: "CUSTOMER" | "WORKER" | "ADMIN";
  clientMessageId: string;
  body: string;
  createdAt: string;
}

export interface SupportThreadDetail extends SupportThread {
  messages: SupportMessage[];
}

export const SUPPORT_STATUS_LABEL: Record<SupportStatus, string> = { OPEN: "Needs reply", ANSWERED: "Answered", RESOLVED: "Resolved" };
export const SUPPORT_FILTERS: { key: SupportStatus | "ALL"; label: string }[] = [
  { key: "OPEN", label: "Needs reply" },
  { key: "ANSWERED", label: "Answered" },
  { key: "RESOLVED", label: "Resolved" },
  { key: "ALL", label: "All" },
];

/** The text to show for a worker's application status (unknown values are shown as they came). */
export const APPLICATION_LABEL: Record<string, string> = {
  NOT_SUBMITTED: "Application not submitted",
  SUBMITTED: "Application submitted",
  UNDER_REVIEW: "Application under review",
  INFO_REQUIRED: "More information requested",
  APPROVED: "Approved",
  REJECTED: "Application rejected",
  SUSPENDED: "Suspended",
};
