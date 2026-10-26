import { DocumentStatus, DocumentType, VerificationAction, WorkerVerificationStatus } from '../../generated/prisma/client.js';
import {
  IDENTITY_DOCUMENT_TYPES,
  SUBMITTABLE,
  TRANSITIONS,
  hasUsableIdentityDocument,
  missingForSubmission,
  type OnboardingSnapshot,
  type ReviewAction,
} from './verification-workflow.js';

const S = WorkerVerificationStatus;
const ALL = Object.values(S);

describe('verification transitions', () => {
  const allowed = (action: ReviewAction) => ALL.filter((s) => TRANSITIONS[action].from.includes(s));

  it('only moves forward along the documented paths', () => {
    expect(allowed('start_review')).toEqual([S.SUBMITTED]);
    expect(allowed('approve').sort()).toEqual([S.SUBMITTED, S.UNDER_REVIEW].sort());
    expect(allowed('reject').sort()).toEqual([S.SUBMITTED, S.UNDER_REVIEW].sort());
    expect(allowed('request_info').sort()).toEqual([S.SUBMITTED, S.UNDER_REVIEW].sort());
    expect(allowed('suspend')).toEqual([S.APPROVED]);
    expect(allowed('reinstate')).toEqual([S.SUSPENDED]);
  });

  it.each([S.NOT_SUBMITTED, S.REJECTED, S.INFO_REQUIRED, S.SUSPENDED, S.APPROVED])(
    'an administrator cannot approve a worker whose status is %s',
    (status) => {
      expect(TRANSITIONS.approve.from).not.toContain(status);
    },
  );

  it('never lets an administrator suspend someone who was never approved', () => {
    for (const status of ALL.filter((s) => s !== S.APPROVED)) expect(TRANSITIONS.suspend.from).not.toContain(status);
  });

  it('has no transition that targets NOT_SUBMITTED, so history cannot be reset', () => {
    for (const t of Object.values(TRANSITIONS)) expect(t.to).not.toBe(S.NOT_SUBMITTED);
  });

  it('requires a reason for every decision that is adverse to the worker', () => {
    expect(TRANSITIONS.reject.reasonRequired).toBe(true);
    expect(TRANSITIONS.request_info.reasonRequired).toBe(true);
    expect(TRANSITIONS.suspend.reasonRequired).toBe(true);
    expect(TRANSITIONS.approve.reasonRequired).toBe(false);
  });

  it('records a distinct history action for each decision', () => {
    const events = Object.values(TRANSITIONS).map((t) => t.event);
    expect(new Set(events).size).toBe(events.length);
    expect(events).not.toContain(VerificationAction.SUBMITTED); // submissions come from the worker, not an admin
  });

  it('lets workers resubmit only after a rejection or a request for information', () => {
    expect(SUBMITTABLE.sort()).toEqual([S.INFO_REQUIRED, S.NOT_SUBMITTED, S.REJECTED].sort());
    expect(SUBMITTABLE).not.toContain(S.SUSPENDED);
    expect(SUBMITTABLE).not.toContain(S.APPROVED);
  });
});

describe('missingForSubmission', () => {
  const complete: OnboardingSnapshot = {
    fullName: 'Ahmed',
    yearsOfExperience: 5,
    serviceCount: 1,
    areaCount: 1,
    availabilityCount: 1,
    documents: [{ type: DocumentType.IQAMA, status: DocumentStatus.UPLOADED }],
  };

  it('is empty for a complete application', () => {
    expect(missingForSubmission(complete, true)).toEqual([]);
  });

  it('lists every missing item for an empty one', () => {
    const empty: OnboardingSnapshot = { fullName: null, yearsOfExperience: null, serviceCount: 0, areaCount: 0, availabilityCount: 0, documents: [] };
    expect(missingForSubmission(empty, true)).toEqual([
      'FULL_NAME',
      'YEARS_OF_EXPERIENCE',
      'SERVICES',
      'SERVICE_AREAS',
      'AVAILABILITY',
      'IDENTITY_DOCUMENT',
    ]);
  });

  it('treats 0 years of experience as provided, but a blank name as missing', () => {
    expect(missingForSubmission({ ...complete, yearsOfExperience: 0 }, true)).toEqual([]);
    expect(missingForSubmission({ ...complete, fullName: '   ' }, true)).toEqual(['FULL_NAME']);
  });

  it('only counts identity documents that are uploaded or accepted', () => {
    const doc = (type: DocumentType, status: DocumentStatus) => ({ ...complete, documents: [{ type, status }] });
    expect(missingForSubmission(doc(DocumentType.NATIONAL_ID, DocumentStatus.PENDING_UPLOAD), true)).toEqual(['IDENTITY_DOCUMENT']);
    expect(missingForSubmission(doc(DocumentType.NATIONAL_ID, DocumentStatus.REJECTED), true)).toEqual(['IDENTITY_DOCUMENT']);
    expect(missingForSubmission(doc(DocumentType.CERTIFICATE, DocumentStatus.UPLOADED), true)).toEqual(['IDENTITY_DOCUMENT']);
    expect(missingForSubmission(doc(DocumentType.NATIONAL_ID, DocumentStatus.ACCEPTED), true)).toEqual([]);
  });

  it('does not require a document when the setting is off', () => {
    expect(missingForSubmission({ ...complete, documents: [] }, false)).toEqual([]);
  });
});

describe('hasUsableIdentityDocument', () => {
  it('recognises national ID and iqama only', () => {
    expect(IDENTITY_DOCUMENT_TYPES.sort()).toEqual([DocumentType.IQAMA, DocumentType.NATIONAL_ID].sort());
    expect(hasUsableIdentityDocument([{ type: DocumentType.PHOTO, status: DocumentStatus.ACCEPTED }], [DocumentStatus.ACCEPTED])).toBe(false);
    expect(hasUsableIdentityDocument([{ type: DocumentType.IQAMA, status: DocumentStatus.UPLOADED }], [DocumentStatus.ACCEPTED])).toBe(false);
    expect(hasUsableIdentityDocument([{ type: DocumentType.IQAMA, status: DocumentStatus.ACCEPTED }], [DocumentStatus.ACCEPTED])).toBe(true);
  });
});
