import { jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import type { AuthenticatedUser } from '../../../common/auth/authenticated-user.js';
import type { PrismaService } from '../../../database/prisma.service.js';
import { MemoryKeyValueStore } from '../../../testing/memory-key-value.store.js';
import { testConfigService } from '../../../testing/test-support.js';
import type { BookingAccess, BookingAccessService, BookingSide } from '../booking-access.service.js';
import { KEYS } from '../realtime.constants.js';
import { RealtimeEmitter } from '../realtime-emitter.js';
import { LocationService } from './location.service.js';
import type { LocationPublishDto } from './location.dto.js';

const BOOKING = '6f1c2f0e-6d4a-4a39-9d1e-0f6b1a9a0001';
const T0 = new Date('2026-11-01T10:00:00.000Z');
const later = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

class CapturingEmitter extends RealtimeEmitter {
  sent: Array<{ room: string; event: string; payload: unknown }> = [];
  emptied: string[] = [];
  toRoom(room: string, event: string, payload: unknown) {
    this.sent.push({ room, event, payload });
  }
  emptyRoom(room: string) {
    this.emptied.push(room);
  }
}

const user = (role: 'CUSTOMER' | 'WORKER'): AuthenticatedUser => ({ id: `u-${role}`, sessionId: 's', role, roles: [role], status: 'ACTIVE', mustChangePassword: false });

function setup(opts: { side?: BookingSide; status?: string; startsInMinutes?: number; lead?: number; minIntervalMs?: number; rateLimit?: number } = {}) {
  const store = new MemoryKeyValueStore();
  const emitter = new CapturingEmitter();
  const access: Partial<BookingAccessService> = {
    resolve: async (): Promise<BookingAccess> => ({
      side: opts.side ?? 'WORKER',
      booking: {
        id: BOOKING,
        status: (opts.status ?? 'CONFIRMED') as never,
        customerId: 'u-CUSTOMER',
        workerUserId: 'u-WORKER',
        preferredStartAt: later((opts.startsInMinutes ?? 30) * 60),
      },
    }),
  };
  const base = testConfigService().getOrThrow('x') as { realtime: { location: object } };
  const config = {
    getOrThrow: () => ({
      ...base,
      realtime: { ...base.realtime, location: { ...base.realtime.location, minIntervalMs: opts.minIntervalMs ?? 2000, rateLimitPerMinute: opts.rateLimit ?? 30, sharingLeadMinutes: opts.lead ?? 180 } },
    }),
  };
  const service = new LocationService(config as never, access as BookingAccessService, store, emitter, {} as PrismaService);
  return { service, store, emitter };
}

const dto = (n: number, over: Partial<LocationPublishDto> = {}, at = later(n * 10)): LocationPublishDto => ({
  bookingId: BOOKING,
  latitude: 24.7136 + n * 0.0001,
  longitude: 46.6753,
  recordedAt: at.toISOString(),
  ...over,
});

describe('LocationService rules', () => {
  it('stores the latest position with an expiry and announces it to the location room only', async () => {
    const { service, store, emitter } = setup();
    await service.publish(user('WORKER'), dto(0), later(0));
    expect(await store.ttl(KEYS.location(BOOKING))).toBeGreaterThan(0);
    expect(emitter.sent).toHaveLength(1);
    expect(emitter.sent[0]).toMatchObject({ room: `booking:${BOOKING}:location`, event: 'location.update.v1' });
    expect(emitter.sent[0]!.payload).toMatchObject({ v: 1, bookingId: BOOKING, latitude: 24.7136, longitude: 46.6753 });
  });

  it('rounds coordinates to 6 decimals before storing', async () => {
    const { service, store } = setup();
    await service.publish(user('WORKER'), dto(0, { latitude: 24.123456789, longitude: 46.987654321 }), later(0));
    const stored = JSON.parse((await store.get(KEYS.location(BOOKING)))!);
    expect(stored).toMatchObject({ lat: 24.123457, lng: 46.987654 });
  });

  it.each([
    ['too frequent', 1, 'LOCATION_TOO_FREQUENT'],
    ['at the minimum interval', 2, undefined],
  ])('spaces updates (%s)', async (_label, seconds, code) => {
    const { service } = setup({ minIntervalMs: 2000 });
    await service.publish(user('WORKER'), dto(0), later(0));
    const next = service.publish(user('WORKER'), dto(1, {}, later(seconds)), later(seconds));
    if (code) await expect(next).rejects.toMatchObject({ code });
    else await expect(next).resolves.toBeDefined();
  });

  it('rejects out-of-order and replayed readings', async () => {
    const { service } = setup({ minIntervalMs: 0 });
    await service.publish(user('WORKER'), dto(0, {}, later(10)), later(10));
    await expect(service.publish(user('WORKER'), dto(0, {}, later(10)), later(12))).rejects.toMatchObject({ code: 'LOCATION_OUT_OF_ORDER' });
    await expect(service.publish(user('WORKER'), dto(0, {}, later(5)), later(12))).rejects.toMatchObject({ code: 'LOCATION_OUT_OF_ORDER' });
  });

  it('rejects implausible jumps but allows normal driving and an accuracy-sized wobble', async () => {
    const { service } = setup({ minIntervalMs: 0 });
    await service.publish(user('WORKER'), dto(0, { latitude: 24.7, longitude: 46.7 }, later(0)), later(0));
    // 60 m/s (216 km/h) over 10 s = 600 m north (0.0054 degrees): allowed (limit 70 m/s)
    await service.publish(user('WORKER'), dto(1, { latitude: 24.7054, longitude: 46.7 }, later(10)), later(10));
    // 800 m in 10 s = 80 m/s: rejected
    await expect(service.publish(user('WORKER'), dto(2, { latitude: 24.7126, longitude: 46.7 }, later(20)), later(20))).rejects.toMatchObject({ code: 'LOCATION_IMPLAUSIBLE' });
    // a stationary phone with poor accuracy jumping 300 m in one second is within its own error radius
    await service.publish(user('WORKER'), dto(3, { latitude: 24.7054, longitude: 46.7, accuracyMeters: 200 }, later(21)), later(21));
    await service.publish(user('WORKER'), dto(4, { latitude: 24.7081, longitude: 46.7, accuracyMeters: 200 }, later(22)), later(22));
  });

  it('rejects stale, future, imprecise and null-island readings', async () => {
    const { service } = setup({ minIntervalMs: 0 });
    await expect(service.publish(user('WORKER'), dto(0, {}, later(-31)), later(0))).rejects.toMatchObject({ code: 'LOCATION_STALE' });
    await expect(service.publish(user('WORKER'), dto(0, {}, later(11)), later(0))).rejects.toMatchObject({ code: 'LOCATION_FROM_FUTURE' });
    await expect(service.publish(user('WORKER'), dto(0, { accuracyMeters: 501 }), later(0))).rejects.toMatchObject({ code: 'LOCATION_ACCURACY_TOO_LOW' });
    await expect(service.publish(user('WORKER'), dto(0, { latitude: 0, longitude: 0 }), later(0))).rejects.toMatchObject({ code: 'LOCATION_INVALID' });
    await expect(service.publish(user('WORKER'), { ...dto(0), recordedAt: 'nope' }, later(0))).rejects.toMatchObject({ code: 'LOCATION_INVALID' });
  });

  it('rejects flooding per booking per minute', async () => {
    const { service } = setup({ minIntervalMs: 0, rateLimit: 3 });
    for (let i = 0; i < 3; i++) await service.publish(user('WORKER'), dto(i, {}, later(i * 10)), later(i * 10));
    await expect(service.publish(user('WORKER'), dto(3, {}, later(30)), later(30))).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('refuses the customer, and refuses publishing outside the sharing statuses and window', async () => {
    await expect(setup({ side: 'CUSTOMER' }).service.publish(user('CUSTOMER'), dto(0), later(0))).rejects.toMatchObject({ code: 'LOCATION_PUBLISH_FORBIDDEN' });
    for (const status of ['OPEN', 'PAYMENT_PENDING', 'COMPLETED', 'CANCELLED', 'EXPIRED']) {
      await expect(setup({ status }).service.publish(user('WORKER'), dto(0), later(0))).rejects.toMatchObject({ code: 'LOCATION_SHARING_NOT_ACTIVE' });
    }
    await expect(setup({ startsInMinutes: 24 * 60 }).service.publish(user('WORKER'), dto(0), later(0))).rejects.toMatchObject({
      code: 'LOCATION_SHARING_NOT_ACTIVE',
      response: expect.objectContaining({ details: { reason: 'TOO_EARLY' } }),
    });
  });

  it('lets only the customer read, and never returns a position when sharing is not active', async () => {
    const worker = setup({ side: 'WORKER' });
    await expect(worker.service.read(user('WORKER'), BOOKING, later(0))).rejects.toMatchObject({ code: 'LOCATION_READ_FORBIDDEN' });

    const ended = setup({ side: 'CUSTOMER', status: 'COMPLETED' });
    await ended.store.set(KEYS.location(BOOKING), JSON.stringify({ lat: 24.7, lng: 46.7, rec: T0.getTime(), got: T0.getTime() }), 60);
    expect(await ended.service.read(user('CUSTOMER'), BOOKING, later(1))).toEqual({ available: false, reason: 'SHARING_NOT_ACTIVE' });
    await expect(ended.service.authorizeSubscription(user('CUSTOMER'), BOOKING, later(1))).rejects.toMatchObject({ code: 'LOCATION_SHARING_NOT_ACTIVE' });
  });

  it('reports "no recent position" for a missing or damaged value instead of fabricating coordinates', async () => {
    const { service, store } = setup({ side: 'CUSTOMER' });
    expect(await service.read(user('CUSTOMER'), BOOKING, later(0))).toEqual({ available: false, reason: 'NO_RECENT_POSITION' });
    for (const bad of ['', 'null', '{', '{"lat":"x","lng":1,"rec":1,"got":1}', '[]']) {
      await store.set(KEYS.location(BOOKING), bad, 60);
      expect(await service.read(user('CUSTOMER'), BOOKING, later(0))).toEqual({ available: false, reason: 'NO_RECENT_POSITION' });
    }
  });

  it('endSharing forgets the position, tells subscribers and empties the room', async () => {
    const { service, store, emitter } = setup();
    await service.publish(user('WORKER'), dto(0), later(0));
    await service.endSharing(BOOKING);
    expect(await store.get(KEYS.location(BOOKING))).toBeNull();
    expect(emitter.sent.at(-1)).toMatchObject({ event: 'location.ended.v1', payload: { v: 1, bookingId: BOOKING } });
    expect(emitter.emptied).toEqual([`booking:${BOOKING}:location`]);
  });

  it('a store failure surfaces as an error and nothing is announced', async () => {
    const { service, store, emitter } = setup();
    jest.spyOn(store, 'set').mockRejectedValueOnce(new Error('503'));
    await expect(service.publish(user('WORKER'), dto(0), later(0))).rejects.toThrow('503');
    expect(emitter.sent).toHaveLength(0);
  });

  it('never writes coordinates to any log', async () => {
    const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map((level) => jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined));
    try {
      const { service, store } = setup({ minIntervalMs: 0 });
      jest.spyOn(store, 'del').mockRejectedValueOnce(new Error('redis down'));
      await service.publish(user('WORKER'), dto(0, { latitude: 24.123456, longitude: 46.654321 }), later(0));
      await expect(service.publish(user('WORKER'), dto(1, { latitude: 24.123457, longitude: 46.654322 }, later(0)), later(10))).rejects.toBeDefined();
      await service.endSharing(BOOKING);
      const logged = spies.flatMap((s) => s.mock.calls.map((c) => JSON.stringify(c))).join('\n');
      expect(logged).not.toMatch(/24\.12|46\.65/);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });
});
