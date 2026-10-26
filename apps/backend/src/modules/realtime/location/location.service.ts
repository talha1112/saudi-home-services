import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AuthenticatedUser } from '../../../common/auth/authenticated-user.js';
import { ApiError, badRequest, forbidden, tooManyRequests } from '../../../common/errors/api-error.js';
import { APP_CONFIG, type AppConfig, type RealtimeConfig } from '../../../config/app.config.js';
import { KeyValueStore } from '../../../database/key-value.store.js';
import { PrismaService } from '../../../database/prisma.service.js';
import { BookingAccessService } from '../booking-access.service.js';
import { distanceMeters, locationSharingDecision } from '../location-policy.js';
import { KEYS, SERVER_EVENTS, locationRoom } from '../realtime.constants.js';
import { RealtimeEmitter } from '../realtime-emitter.js';
import type { LocationPublishDto } from './location.dto.js';

/** What is stored in Redis (short keys: this is written every few seconds). */
interface StoredPosition {
  lat: number;
  lng: number;
  acc?: number;
  hdg?: number;
  spd?: number;
  /** recordedAt, epoch ms (phone clock). */
  rec: number;
  /** receivedAt, epoch ms (server clock). */
  got: number;
}

export interface LocationView {
  latitude: number;
  longitude: number;
  accuracyMeters?: number;
  headingDegrees?: number;
  speedMps?: number;
  recordedAt: string;
  receivedAt: string;
}

export type LocationReadResult =
  | { available: true; location: LocationView; ageSeconds: number }
  | { available: false; reason: 'SHARING_NOT_ACTIVE' | 'NO_RECENT_POSITION' };

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/**
 * Live worker position. Redis only, never PostgreSQL: one key per booking holding the LATEST
 * position, which expires LOCATION_TTL_SECONDS after the last accepted update. Nothing here is a
 * history; a Redis flush or restart simply means "no recent position" until the next update.
 *
 * Every call re-reads the booking from PostgreSQL (status, assignment, worker approval), so
 * eligibility is never taken from the client, the socket or a cached room membership. Coordinates
 * are never written to logs.
 */
@Injectable()
export class LocationService {
  private readonly logger = new Logger(LocationService.name);
  private readonly cfg: RealtimeConfig;

  constructor(
    config: ConfigService,
    private readonly access: BookingAccessService,
    private readonly store: KeyValueStore,
    private readonly emitter: RealtimeEmitter,
    private readonly prisma: PrismaService,
  ) {
    this.cfg = config.getOrThrow<AppConfig>(APP_CONFIG).realtime;
  }

  /** Worker publishes a position. Returns the stored view (not the booking). */
  async publish(user: AuthenticatedUser, dto: LocationPublishDto, now: Date = new Date()): Promise<{ recordedAt: string; receivedAt: string }> {
    const { side, booking } = await this.access.resolve(user, dto.bookingId);
    if (side !== 'WORKER') throw forbidden('LOCATION_PUBLISH_FORBIDDEN', 'Only the assigned worker can share a position');

    const decision = locationSharingDecision(booking, now, this.cfg.location.sharingLeadMinutes);
    if (!decision.allowed) {
      throw new ApiError(409, 'LOCATION_SHARING_NOT_ACTIVE', 'Location sharing is not active for this booking', {
        details: { reason: decision.reason },
      });
    }

    await this.enforceRateLimit(booking.id);

    const l = this.cfg.location;
    const recorded = new Date(dto.recordedAt).getTime();
    if (!Number.isFinite(recorded)) throw badRequest('LOCATION_INVALID', 'recordedAt is not a valid time');
    if (dto.latitude === 0 && dto.longitude === 0) throw badRequest('LOCATION_INVALID', 'The position is not valid');
    if (dto.accuracyMeters !== undefined && dto.accuracyMeters > l.maxAccuracyMeters) {
      throw badRequest('LOCATION_ACCURACY_TOO_LOW', 'The position is too imprecise to share');
    }
    if (recorded > now.getTime() + l.maxClockSkewSeconds * 1000) throw badRequest('LOCATION_FROM_FUTURE', 'recordedAt is in the future');
    if (recorded < now.getTime() - l.maxAgeSeconds * 1000) throw badRequest('LOCATION_STALE', 'The position is too old');

    const next: StoredPosition = {
      lat: round6(dto.latitude),
      lng: round6(dto.longitude),
      acc: dto.accuracyMeters,
      hdg: dto.headingDegrees,
      spd: dto.speedMps,
      rec: recorded,
      got: now.getTime(),
    };

    const prev = await this.readStored(booking.id);
    if (prev) {
      if (next.got - prev.got < l.minIntervalMs) {
        throw tooManyRequests('LOCATION_TOO_FREQUENT', 'Position updates are too frequent', Math.ceil(l.minIntervalMs / 1000));
      }
      if (next.rec <= prev.rec) throw badRequest('LOCATION_OUT_OF_ORDER', 'This position is older than the one already shared');
      const seconds = Math.max((next.rec - prev.rec) / 1000, 1);
      const metres = distanceMeters({ lat: prev.lat, lng: prev.lng }, { lat: next.lat, lng: next.lng });
      // A phone's own accuracy radius can make a stationary device "jump"; allow that much slack.
      const slack = (prev.acc ?? 0) + (next.acc ?? 0);
      if (metres - slack > l.maxSpeedMps * seconds) throw badRequest('LOCATION_IMPLAUSIBLE', 'The position moved further than is possible');
    }

    // Written once, with the expiry, so a crash cannot leave an immortal key. A failure is a 503 from the store.
    await this.store.set(KEYS.location(booking.id), JSON.stringify(next), l.ttlSeconds);

    const view = this.toView(next);
    this.emitter.toRoom(locationRoom(booking.id), SERVER_EVENTS.locationUpdate, { v: 1, bookingId: booking.id, ...view });
    return { recordedAt: view.recordedAt, receivedAt: view.receivedAt };
  }

  /** The owning customer reads the latest position. */
  async read(user: AuthenticatedUser, bookingId: string, now: Date = new Date()): Promise<LocationReadResult> {
    const { side, booking } = await this.access.resolve(user, bookingId);
    if (side !== 'CUSTOMER') throw forbidden('LOCATION_READ_FORBIDDEN', 'Only the booking customer can see the worker position');
    if (!locationSharingDecision(booking, now, this.cfg.location.sharingLeadMinutes).allowed) {
      return { available: false, reason: 'SHARING_NOT_ACTIVE' };
    }
    const stored = await this.readStored(booking.id);
    if (!stored) return { available: false, reason: 'NO_RECENT_POSITION' };
    return { available: true, location: this.toView(stored), ageSeconds: Math.max(0, Math.round((now.getTime() - stored.got) / 1000)) };
  }

  /** Authorization for the customer's live subscription: same rule as `read`, but refuses instead of answering "unavailable". */
  async authorizeSubscription(user: AuthenticatedUser, bookingId: string, now: Date = new Date()): Promise<LocationReadResult> {
    const result = await this.read(user, bookingId, now);
    if (!result.available && result.reason === 'SHARING_NOT_ACTIVE') {
      throw new ApiError(409, 'LOCATION_SHARING_NOT_ACTIVE', 'Location sharing is not active for this booking');
    }
    return result;
  }

  /** Sharing has ended (booking finished): forget the position and tell and remove subscribers. */
  async endSharing(bookingId: string): Promise<void> {
    try {
      await this.store.del(KEYS.location(bookingId), KEYS.locationRate(bookingId));
    } catch (err) {
      // The read path re-checks the booking, so an undeleted key is unreachable; the cleanup job removes it.
      this.logger.warn(`Could not delete the live position of booking ${bookingId}: ${(err as Error).message}`);
    }
    this.emitter.toRoom(locationRoom(bookingId), SERVER_EVENTS.locationEnded, { v: 1, bookingId });
    this.emitter.emptyRoom(locationRoom(bookingId));
  }

  /**
   * Removes stored positions whose booking no longer authorizes sharing. TTL already bounds how long
   * a key lives; this covers a key written just before a booking ended, and an endSharing that failed.
   */
  async cleanupIneligible(maxKeys = 1000, now: Date = new Date()): Promise<{ scanned: number; removed: number }> {
    const keys = await this.store.scan(KEYS.locationPrefix, maxKeys);
    const ids = keys.map((k) => k.slice(KEYS.locationPrefix.length));
    if (ids.length === 0) return { scanned: 0, removed: 0 };
    const bookings = await this.prisma.booking.findMany({
      where: { id: { in: ids.filter((id) => /^[0-9a-f-]{36}$/i.test(id)) } },
      select: { id: true, status: true, preferredStartAt: true },
    });
    const eligible = new Set(
      bookings.filter((b) => locationSharingDecision(b, now, this.cfg.location.sharingLeadMinutes).allowed).map((b) => b.id),
    );
    const stale = ids.filter((id) => !eligible.has(id));
    if (stale.length > 0) await this.store.del(...stale.map((id) => KEYS.location(id)));
    return { scanned: ids.length, removed: stale.length };
  }

  private async enforceRateLimit(bookingId: string): Promise<void> {
    const key = KEYS.locationRate(bookingId);
    const count = await this.store.increment(key, 60);
    if (count > this.cfg.location.rateLimitPerMinute) {
      throw tooManyRequests('RATE_LIMITED', 'Too many position updates, slow down', Math.max(1, await this.store.ttl(key)));
    }
  }

  private async readStored(bookingId: string): Promise<StoredPosition | null> {
    const raw = await this.store.get(KEYS.location(bookingId));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as StoredPosition;
      return Number.isFinite(parsed.lat) && Number.isFinite(parsed.lng) && Number.isFinite(parsed.rec) && Number.isFinite(parsed.got) ? parsed : null;
    } catch {
      return null; // a corrupt value is treated as "nothing", never repaired into coordinates
    }
  }

  private toView(p: StoredPosition): LocationView {
    return {
      latitude: p.lat,
      longitude: p.lng,
      ...(p.acc !== undefined ? { accuracyMeters: p.acc } : {}),
      ...(p.hdg !== undefined ? { headingDegrees: p.hdg } : {}),
      ...(p.spd !== undefined ? { speedMps: p.spd } : {}),
      recordedAt: new Date(p.rec).toISOString(),
      receivedAt: new Date(p.got).toISOString(),
    };
  }
}
