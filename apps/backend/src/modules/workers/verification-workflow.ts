import { DocumentStatus, DocumentType, VerificationAction, WorkerVerificationStatus } from '../../generated/prisma/client.js';

type Status = WorkerVerificationStatus;
const S = WorkerVerificationStatus;

/** Admin decisions on a worker's verification. */
export type ReviewAction = 'start_review' | 'approve' | 'reject' | 'request_info' | 'suspend' | 'reinstate';

export interface Transition {
  from: Status[];
  to: Status;
  event: VerificationAction;
  /** A written reason is mandatory (it is shown to the worker and kept in the history). */
  reasonRequired: boolean;
}

/**
 * The only allowed verification state changes made by administrators.
 *
 *   NOT_SUBMITTED --worker submits--> SUBMITTED --start_review--> UNDER_REVIEW
 *   SUBMITTED | UNDER_REVIEW --approve--> APPROVED
 *   SUBMITTED | UNDER_REVIEW --reject--> REJECTED          (worker may fix and resubmit)
 *   SUBMITTED | UNDER_REVIEW --request_info--> INFO_REQUIRED (worker may fix and resubmit)
 *   APPROVED --suspend--> SUSPENDED --reinstate--> APPROVED
 */
export const TRANSITIONS: Record<ReviewAction, Transition> = {
  start_review: { from: [S.SUBMITTED], to: S.UNDER_REVIEW, event: VerificationAction.REVIEW_STARTED, reasonRequired: false },
  approve: { from: [S.SUBMITTED, S.UNDER_REVIEW], to: S.APPROVED, event: VerificationAction.APPROVED, reasonRequired: false },
  reject: { from: [S.SUBMITTED, S.UNDER_REVIEW], to: S.REJECTED, event: VerificationAction.REJECTED, reasonRequired: true },
  request_info: {
    from: [S.SUBMITTED, S.UNDER_REVIEW],
    to: S.INFO_REQUIRED,
    event: VerificationAction.INFO_REQUESTED,
    reasonRequired: true,
  },
  suspend: { from: [S.APPROVED], to: S.SUSPENDED, event: VerificationAction.SUSPENDED, reasonRequired: true },
  reinstate: { from: [S.SUSPENDED], to: S.APPROVED, event: VerificationAction.REINSTATED, reasonRequired: false },
};

/** States from which a worker may (re)submit for review. */
export const SUBMITTABLE: Status[] = [S.NOT_SUBMITTED, S.INFO_REQUIRED, S.REJECTED];

/** States in which a worker may delete uploaded documents (not while a review is running or after approval). */
export const DOCUMENTS_DELETABLE: Status[] = [S.NOT_SUBMITTED, S.INFO_REQUIRED, S.REJECTED];

export const IDENTITY_DOCUMENT_TYPES: DocumentType[] = [DocumentType.NATIONAL_ID, DocumentType.IQAMA];

export type MissingItem = 'FULL_NAME' | 'YEARS_OF_EXPERIENCE' | 'SERVICES' | 'SERVICE_AREAS' | 'AVAILABILITY' | 'IDENTITY_DOCUMENT';

export interface OnboardingSnapshot {
  fullName: string | null;
  yearsOfExperience: number | null;
  serviceCount: number;
  areaCount: number;
  availabilityCount: number;
  documents: { type: DocumentType; status: DocumentStatus }[];
}

/** What is still missing before the worker can submit for review. Empty means "ready". */
export function missingForSubmission(snapshot: OnboardingSnapshot, requireIdentityDocument: boolean): MissingItem[] {
  const missing: MissingItem[] = [];
  if (!snapshot.fullName?.trim()) missing.push('FULL_NAME');
  if (snapshot.yearsOfExperience === null) missing.push('YEARS_OF_EXPERIENCE');
  if (snapshot.serviceCount === 0) missing.push('SERVICES');
  if (snapshot.areaCount === 0) missing.push('SERVICE_AREAS');
  if (snapshot.availabilityCount === 0) missing.push('AVAILABILITY');
  if (requireIdentityDocument && !hasUsableIdentityDocument(snapshot.documents, [DocumentStatus.UPLOADED, DocumentStatus.ACCEPTED])) {
    missing.push('IDENTITY_DOCUMENT');
  }
  return missing;
}

export function hasUsableIdentityDocument(
  documents: { type: DocumentType; status: DocumentStatus }[],
  statuses: DocumentStatus[],
): boolean {
  return documents.some((d) => IDENTITY_DOCUMENT_TYPES.includes(d.type) && statuses.includes(d.status));
}
