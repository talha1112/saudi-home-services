import { DisputeStatus } from '../../generated/prisma/client.js';

/**
 * The dispute lifecycle as data. Nothing outside this table decides what is allowed.
 *
 *   OPEN --start_review--> UNDER_REVIEW --resolve--> RESOLVED --close--> CLOSED
 *     |                        ^   |                     |
 *     |--request_info--> AWAITING_INFO --(participant comment | start_review)--^        RESOLVED --reopen--> UNDER_REVIEW
 *     |--withdraw (opener only)--> CLOSED
 *
 * Participants (the booking's customer and assigned worker) can: open, comment, add evidence, and the opener can withdraw
 * while OPEN. Administrators run everything else. RESOLVED is read-only except for an auditable `reopen`; CLOSED is final.
 * A dispute never changes a booking, a payment, the ledger, a rating or an account: money follow-ups are only flagged for a
 * separate approved workflow.
 */
export type DisputeAction =
  | 'comment'
  | 'add_evidence'
  | 'withdraw'
  | 'assign'
  | 'start_review'
  | 'request_info'
  | 'internal_note'
  | 'resolve'
  | 'close'
  | 'reopen';

export type DisputeActor = 'PARTICIPANT' | 'OPENER' | 'ADMIN';

const S = DisputeStatus;
export const ACTIVE_DISPUTE_STATUSES: readonly DisputeStatus[] = [S.OPEN, S.UNDER_REVIEW, S.AWAITING_INFO];

export interface DisputeRule {
  from: readonly DisputeStatus[];
  /** The new status, or a function of the old one when it depends on it. Undefined = status unchanged. */
  to?: DisputeStatus | ((from: DisputeStatus) => DisputeStatus);
  actor: DisputeActor;
  /** Event label written to the history. */
  event: string;
  /** Whether a note/text is mandatory. */
  noteRequired: boolean;
}

export const DISPUTE_RULES: Record<DisputeAction, DisputeRule> = {
  comment: { from: ACTIVE_DISPUTE_STATUSES, to: (from) => (from === S.AWAITING_INFO ? S.UNDER_REVIEW : from), actor: 'PARTICIPANT', event: 'COMMENT', noteRequired: true },
  add_evidence: { from: ACTIVE_DISPUTE_STATUSES, actor: 'PARTICIPANT', event: 'EVIDENCE_ADDED', noteRequired: false },
  withdraw: { from: [S.OPEN], to: S.CLOSED, actor: 'OPENER', event: 'WITHDRAWN', noteRequired: false },
  assign: { from: ACTIVE_DISPUTE_STATUSES, actor: 'ADMIN', event: 'ASSIGNED', noteRequired: false },
  start_review: { from: [S.OPEN, S.AWAITING_INFO], to: S.UNDER_REVIEW, actor: 'ADMIN', event: 'REVIEW_STARTED', noteRequired: false },
  request_info: { from: [S.OPEN, S.UNDER_REVIEW], to: S.AWAITING_INFO, actor: 'ADMIN', event: 'INFO_REQUESTED', noteRequired: true },
  internal_note: { from: [S.OPEN, S.UNDER_REVIEW, S.AWAITING_INFO, S.RESOLVED], actor: 'ADMIN', event: 'INTERNAL_NOTE', noteRequired: true },
  resolve: { from: [S.UNDER_REVIEW], to: S.RESOLVED, actor: 'ADMIN', event: 'RESOLVED', noteRequired: true },
  close: { from: [S.RESOLVED], to: S.CLOSED, actor: 'ADMIN', event: 'CLOSED', noteRequired: true },
  reopen: { from: [S.RESOLVED], to: S.UNDER_REVIEW, actor: 'ADMIN', event: 'REOPENED', noteRequired: true },
};

export function nextStatus(rule: DisputeRule, from: DisputeStatus): DisputeStatus {
  if (!rule.to) return from;
  return typeof rule.to === 'function' ? rule.to(from) : rule.to;
}

export const isFinal = (status: DisputeStatus) => status === S.CLOSED;
