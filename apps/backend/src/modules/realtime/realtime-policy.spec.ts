import { IsInt, IsString, Max } from 'class-validator';
import { BookingStatus } from '../../generated/prisma/client.js';
import { validatePayload } from '../../common/validation/validate-payload.js';
import { FINAL_STATUSES } from '../bookings/booking-state-machine.js';
import { outboxBackoffMs } from './jobs/outbox-dispatcher.service.js';
import { notifiedBookingEventTypes } from '../notifications/notifications.service.js';
import { distanceMeters, locationSharingDecision } from './location-policy.js';
import { CHAT_SEND_STATUSES, FINAL_BOOKING_STATUSES, LOCATION_SHARING_STATUSES, bookingCustomerRoom, bookingRoom, locationRoom } from './realtime.constants.js';
import { isBookingEventPayload } from './booking-event-publisher.js';

const NOW = new Date('2026-11-01T10:00:00.000Z');
const at = (minutesFromNow: number) => new Date(NOW.getTime() + minutesFromNow * 60_000);

describe('which booking statuses enable what', () => {
  it('shares the worker position only while the job is paid for and not finished', () => {
    const allowed = Object.values(BookingStatus).filter((status) => locationSharingDecision({ status, preferredStartAt: at(-5) }, NOW, 180).allowed);
    expect(allowed.sort()).toEqual([BookingStatus.CONFIRMED, BookingStatus.IN_PROGRESS].sort());
    expect(LOCATION_SHARING_STATUSES).toEqual([BookingStatus.CONFIRMED, BookingStatus.IN_PROGRESS]);
  });

  it('never shares for open, unpaid or finished bookings, whatever the clock says', () => {
    for (const status of [BookingStatus.OPEN, BookingStatus.PAYMENT_PENDING, BookingStatus.COMPLETED, BookingStatus.CANCELLED, BookingStatus.EXPIRED]) {
      expect(locationSharingDecision({ status, preferredStartAt: at(-5) }, NOW, 0)).toEqual({ allowed: false, reason: 'STATUS_NOT_ELIGIBLE' });
    }
  });

  it('limits a CONFIRMED booking to the lead window before the preferred start; IN_PROGRESS is always allowed', () => {
    const confirmed = (startsInMinutes: number) => locationSharingDecision({ status: 'CONFIRMED', preferredStartAt: at(startsInMinutes) }, NOW, 180);
    expect(confirmed(2 * 24 * 60)).toEqual({ allowed: false, reason: 'TOO_EARLY' });
    expect(confirmed(181)).toEqual({ allowed: false, reason: 'TOO_EARLY' });
    expect(confirmed(180)).toEqual({ allowed: true });
    expect(confirmed(-600)).toEqual({ allowed: true }); // running late is still sharing
    expect(locationSharingDecision({ status: 'CONFIRMED', preferredStartAt: at(5 * 24 * 60) }, NOW, 0)).toEqual({ allowed: true }); // 0 disables the limit
    expect(locationSharingDecision({ status: 'IN_PROGRESS', preferredStartAt: at(5 * 24 * 60) }, NOW, 180)).toEqual({ allowed: true });
  });

  it('allows chat messages in the same two statuses and agrees with the booking state machine about "finished"', () => {
    expect([...CHAT_SEND_STATUSES].sort()).toEqual([BookingStatus.CONFIRMED, BookingStatus.IN_PROGRESS].sort());
    expect([...FINAL_BOOKING_STATUSES].sort()).toEqual([...FINAL_STATUSES].sort());
    for (const status of FINAL_BOOKING_STATUSES) {
      expect(LOCATION_SHARING_STATUSES).not.toContain(status);
      expect(CHAT_SEND_STATUSES).not.toContain(status);
    }
  });

  it('uses distinct, booking-scoped room names', () => {
    const id = '6f1c2f0e-6d4a-4a39-9d1e-0f6b1a9a0001';
    const names = [bookingRoom(id), bookingCustomerRoom(id), locationRoom(id)];
    expect(new Set(names).size).toBe(3);
    expect(names.every((n) => n.includes(id))).toBe(true);
  });
});

describe('distanceMeters', () => {
  it('measures great-circle distance', () => {
    expect(distanceMeters({ lat: 24.7136, lng: 46.6753 }, { lat: 24.7136, lng: 46.6753 })).toBe(0);
    // one degree of latitude is about 111.2 km
    expect(distanceMeters({ lat: 24, lng: 46 }, { lat: 25, lng: 46 })).toBeGreaterThan(111_000);
    expect(distanceMeters({ lat: 24, lng: 46 }, { lat: 25, lng: 46 })).toBeLessThan(111_400);
    // Riyadh to Jeddah is roughly 850 km
    const d = distanceMeters({ lat: 24.7136, lng: 46.6753 }, { lat: 21.4858, lng: 39.1925 });
    expect(d).toBeGreaterThan(830_000);
    expect(d).toBeLessThan(960_000);
  });
});

describe('outbox backoff', () => {
  it('doubles from one second, is capped at ten minutes, and jitters by at most 20 percent', () => {
    const mid = () => 0.5; // jitter factor 1.0
    expect([1, 2, 3, 4, 5].map((n) => outboxBackoffMs(n, mid))).toEqual([1000, 2000, 4000, 8000, 16000]);
    expect(outboxBackoffMs(30, mid)).toBe(600_000);
    expect(outboxBackoffMs(3, () => 0)).toBe(3200);
    expect(outboxBackoffMs(3, () => 1)).toBe(4800);
  });
});

describe('which booking events notify anyone', () => {
  it('notifies only for events whose meaning is established, and never for internal or self-service ones', () => {
    expect([...notifiedBookingEventTypes].sort()).toEqual(
      ['BOOKING_CANCELLED', 'BOOKING_CREATED', 'BOOKING_EXPIRED', 'PAYMENT_CONFIRMED', 'QUOTE_ACCEPTED', 'QUOTE_REJECTED', 'QUOTE_REVISED', 'QUOTE_SUBMITTED', 'WORK_COMPLETED', 'WORK_STARTED'].sort(),
    );
    // BOOKING_CREATED tells the eligible workers about a new request (never the customer who made it)
    for (const quiet of ['QUOTE_WITHDRAWN', 'QUOTE_EXPIRED']) expect(notifiedBookingEventTypes).not.toContain(quiet);
  });
});

describe('booking event payload contract (version 1)', () => {
  const valid = { v: 1, eventId: 'e', bookingId: 'b', type: 'WORK_STARTED', fromStatus: 'CONFIRMED', toStatus: 'IN_PROGRESS', occurredAt: '2026-11-01T10:00:00.000Z' };
  it('accepts the documented shape and rejects other versions or missing identifiers', () => {
    expect(isBookingEventPayload(valid)).toBe(true);
    expect(isBookingEventPayload({ ...valid, v: 2 })).toBe(false);
    expect(isBookingEventPayload({ ...valid, eventId: undefined })).toBe(false);
    expect(isBookingEventPayload(null)).toBe(false);
    expect(isBookingEventPayload('x')).toBe(false);
  });
});

describe('validatePayload (socket messages)', () => {
  class Dto {
    @IsString() name!: string;
    @IsInt() @Max(10) count!: number;
  }

  it('returns a typed instance for a valid payload', () => {
    expect(validatePayload(Dto, { name: 'a', count: 3 })).toMatchObject({ name: 'a', count: 3 });
  });

  it('rejects non-objects, missing, wrongly typed and unknown fields, naming only the fields', () => {
    for (const bad of [null, undefined, 'x', 5, [], [{ name: 'a', count: 1 }]]) {
      expect(() => validatePayload(Dto, bad)).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
    }
    for (const bad of [{ name: 'a' }, { name: 1, count: 1 }, { name: 'a', count: 11 }, { name: 'a', count: 1.5 }, { name: 'a', count: 1, userId: 'x' }]) {
      expect(() => validatePayload(Dto, bad)).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
    }
    try {
      validatePayload(Dto, { name: 'secret text', count: 99 });
    } catch (e) {
      expect(JSON.stringify((e as { getResponse: () => unknown }).getResponse())).not.toContain('secret text');
    }
  });
});
