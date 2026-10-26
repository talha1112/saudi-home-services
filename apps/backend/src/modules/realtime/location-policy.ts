import type { BookingStatus } from '../../generated/prisma/client.js';
import { LOCATION_SHARING_STATUSES } from './realtime.constants.js';

export type SharingDecision = { allowed: true } | { allowed: false; reason: 'STATUS_NOT_ELIGIBLE' | 'TOO_EARLY' };

/**
 * Pure decision: may the assigned worker's position be shared for this booking right now?
 * IN_PROGRESS: always. CONFIRMED: only from `leadMinutes` before the customer's preferred start
 * (0 disables the limit). Any other status: never.
 */
export function locationSharingDecision(
  booking: { status: BookingStatus; preferredStartAt: Date },
  now: Date,
  leadMinutes: number,
): SharingDecision {
  if (!LOCATION_SHARING_STATUSES.includes(booking.status)) return { allowed: false, reason: 'STATUS_NOT_ELIGIBLE' };
  if (booking.status === 'CONFIRMED' && leadMinutes > 0) {
    const opensAt = booking.preferredStartAt.getTime() - leadMinutes * 60_000;
    if (now.getTime() < opensAt) return { allowed: false, reason: 'TOO_EARLY' };
  }
  return { allowed: true };
}

const EARTH_RADIUS_M = 6_371_000;

/** Great-circle distance in metres. */
export function distanceMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}
