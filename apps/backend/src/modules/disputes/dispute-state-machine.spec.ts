import { DisputeStatus } from '../../generated/prisma/client.js';
import { ACTIVE_DISPUTE_STATUSES, DISPUTE_RULES, type DisputeAction, isFinal, nextStatus } from './dispute-state-machine.js';

const S = DisputeStatus;
const ALL = Object.values(S);
const allowed = (action: DisputeAction) => ALL.filter((s) => DISPUTE_RULES[action].from.includes(s));

describe('dispute state machine', () => {
  it('allows each action only from the documented states', () => {
    expect(allowed('start_review')).toEqual([S.OPEN, S.AWAITING_INFO]);
    expect(allowed('request_info')).toEqual([S.OPEN, S.UNDER_REVIEW]);
    expect(allowed('resolve')).toEqual([S.UNDER_REVIEW]); // a case must be under review before it can be resolved
    expect(allowed('close')).toEqual([S.RESOLVED]);
    expect(allowed('reopen')).toEqual([S.RESOLVED]);
    expect(allowed('withdraw')).toEqual([S.OPEN]);
    expect(allowed('comment')).toEqual([...ACTIVE_DISPUTE_STATUSES]);
    expect(allowed('add_evidence')).toEqual([...ACTIVE_DISPUTE_STATUSES]);
  });

  it('never leaves CLOSED, and gives participants no way to touch a resolved dispute', () => {
    expect(isFinal(S.CLOSED)).toBe(true);
    for (const [action, rule] of Object.entries(DISPUTE_RULES)) {
      expect({ action, fromClosed: rule.from.includes(S.CLOSED) }).toEqual({ action, fromClosed: false });
      if (rule.actor !== 'ADMIN') expect({ action, fromResolved: rule.from.includes(S.RESOLVED) }).toEqual({ action, fromResolved: false });
    }
  });

  it('computes the next status', () => {
    expect(nextStatus(DISPUTE_RULES.start_review, S.OPEN)).toBe(S.UNDER_REVIEW);
    expect(nextStatus(DISPUTE_RULES.request_info, S.UNDER_REVIEW)).toBe(S.AWAITING_INFO);
    expect(nextStatus(DISPUTE_RULES.resolve, S.UNDER_REVIEW)).toBe(S.RESOLVED);
    expect(nextStatus(DISPUTE_RULES.close, S.RESOLVED)).toBe(S.CLOSED);
    expect(nextStatus(DISPUTE_RULES.reopen, S.RESOLVED)).toBe(S.UNDER_REVIEW);
    expect(nextStatus(DISPUTE_RULES.withdraw, S.OPEN)).toBe(S.CLOSED);
    // an answer to a request for information puts the case back under review; other comments change nothing
    expect(nextStatus(DISPUTE_RULES.comment, S.AWAITING_INFO)).toBe(S.UNDER_REVIEW);
    expect(nextStatus(DISPUTE_RULES.comment, S.OPEN)).toBe(S.OPEN);
    expect(nextStatus(DISPUTE_RULES.comment, S.UNDER_REVIEW)).toBe(S.UNDER_REVIEW);
    expect(nextStatus(DISPUTE_RULES.internal_note, S.RESOLVED)).toBe(S.RESOLVED);
  });

  it('reserves decisions for administrators and requires a note where a decision is made', () => {
    for (const a of ['assign', 'start_review', 'request_info', 'internal_note', 'resolve', 'close', 'reopen'] as DisputeAction[]) expect(DISPUTE_RULES[a].actor).toBe('ADMIN');
    for (const a of ['request_info', 'internal_note', 'resolve', 'close', 'reopen', 'comment'] as DisputeAction[]) expect(DISPUTE_RULES[a].noteRequired).toBe(true);
    expect(DISPUTE_RULES.withdraw.actor).toBe('OPENER');
    expect(DISPUTE_RULES.comment.actor).toBe('PARTICIPANT');
  });

  it('reaches every non-final state and every state is reachable only through the table', () => {
    const reachable = new Set<DisputeStatus>([S.OPEN]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const rule of Object.values(DISPUTE_RULES)) {
        for (const from of rule.from) {
          if (!reachable.has(from)) continue;
          const to = nextStatus(rule, from);
          if (!reachable.has(to)) {
            reachable.add(to);
            grew = true;
          }
        }
      }
    }
    expect([...reachable].sort()).toEqual([...ALL].sort());
  });
});
