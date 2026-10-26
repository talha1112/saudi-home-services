import { BookingStatus } from '../../generated/prisma/client.js';
import { type Actor, type BookingAction, FINAL_STATUSES, RULES, allowedFrom, check } from './booking-state-machine.js';

const S = BookingStatus;
const ACTIONS = Object.keys(RULES) as BookingAction[];
const ACTORS: Actor[] = ['CUSTOMER', 'WORKER', 'ADMIN', 'SYSTEM'];
const STATUSES = Object.values(S);

describe('booking state machine', () => {
  it('describes the intended happy path', () => {
    expect(RULES.accept_quote).toMatchObject({ to: S.PAYMENT_PENDING });
    expect(allowedFrom('accept_quote', 'CUSTOMER')).toEqual([S.OPEN]);
    expect(RULES.confirm_payment.to).toBe(S.CONFIRMED);
    expect(allowedFrom('confirm_payment', 'SYSTEM')).toEqual([S.PAYMENT_PENDING]);
    expect(allowedFrom('start_work', 'WORKER')).toEqual([S.CONFIRMED]);
    expect(allowedFrom('complete_work', 'WORKER')).toEqual([S.IN_PROGRESS]);
  });

  it('gives every action exactly the actors it should have', () => {
    const actors = (a: BookingAction) => ACTORS.filter((x) => allowedFrom(a, x).length > 0).sort();
    expect(actors('accept_quote')).toEqual(['CUSTOMER']);
    expect(actors('confirm_payment')).toEqual(['SYSTEM']); // nobody can mark a booking paid over HTTP
    expect(actors('start_work')).toEqual(['WORKER']);
    expect(actors('complete_work')).toEqual(['WORKER']);
    expect(actors('cancel')).toEqual(['ADMIN', 'CUSTOMER']);
    expect(actors('expire')).toEqual(['SYSTEM']);
  });

  it('never leaves a final status', () => {
    for (const final of FINAL_STATUSES) {
      for (const action of ACTIONS) for (const actor of ACTORS) expect({ final, action, actor, verdict: check(action, actor, final) }).toMatchObject({ verdict: expect.stringMatching(/wrong/) });
    }
    expect(FINAL_STATUSES.sort()).toEqual([S.CANCELLED, S.COMPLETED, S.EXPIRED].sort());
  });

  it('lets customers cancel until the work starts, and only administrators after that', () => {
    expect(allowedFrom('cancel', 'CUSTOMER').sort()).toEqual([S.CONFIRMED, S.OPEN, S.PAYMENT_PENDING].sort());
    expect(check('cancel', 'CUSTOMER', S.IN_PROGRESS)).toBe('wrong_state');
    expect(check('cancel', 'ADMIN', S.IN_PROGRESS)).toBe('ok');
    expect(check('cancel', 'WORKER', S.OPEN)).toBe('wrong_actor');
  });

  it('is deterministic over the full (action x actor x status) matrix', () => {
    let ok = 0;
    for (const action of ACTIONS) {
      for (const actor of ACTORS) {
        for (const status of STATUSES) {
          const verdict = check(action, actor, status);
          expect(['ok', 'wrong_actor', 'wrong_state']).toContain(verdict);
          if (verdict === 'ok') {
            ok++;
            expect(allowedFrom(action, actor)).toContain(status);
            expect(RULES[action].to).not.toBe(status); // every allowed move changes the status
          }
        }
      }
    }
    // 1 + 1 + 1 + 1 + (3 customer + 4 admin) + 1
    expect(ok).toBe(12);
  });

  it('only ever targets statuses that exist and never targets OPEN again', () => {
    for (const rule of Object.values(RULES)) {
      expect(STATUSES).toContain(rule.to);
      expect(rule.to).not.toBe(S.OPEN);
    }
  });

  it('separates the wrong actor from the wrong state so the API can answer 403 vs 409', () => {
    expect(check('start_work', 'CUSTOMER', S.CONFIRMED)).toBe('wrong_actor');
    expect(check('start_work', 'WORKER', S.OPEN)).toBe('wrong_state');
  });
});
