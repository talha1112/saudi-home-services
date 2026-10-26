import { BookingStatus } from '../../generated/prisma/client.js';

/**
 * Server-to-client event names. The version is part of the name: a breaking change to a payload
 * ships as a NEW name (`...v2`) next to the old one, so old app builds keep working.
 */
export const SERVER_EVENTS = {
  bookingEvent: 'booking.event.v1',
  chatMessage: 'chat.message.v1',
  chatReceipt: 'chat.receipt.v1',
  locationUpdate: 'location.update.v1',
  locationEnded: 'location.ended.v1',
  /** Sent to one socket just before the server closes it. */
  sessionEnding: 'session.ending.v1',
  /** The caller no longer participates in this booking; the socket was removed from its rooms. */
  accessRevoked: 'booking.access-revoked.v1',
} as const;

/** Client-to-server events (each is answered through the acknowledgement callback). */
export const CLIENT_EVENTS = {
  authRefresh: 'auth.refresh',
  bookingJoin: 'booking.join',
  bookingLeave: 'booking.leave',
  chatSend: 'chat.send',
  chatSync: 'chat.sync',
  chatReceipt: 'chat.receipt',
  locationPublish: 'location.publish',
  locationSubscribe: 'location.subscribe',
  locationUnsubscribe: 'location.unsubscribe',
} as const;

export const REALTIME_NAMESPACE = '/realtime';

export const bookingRoom = (bookingId: string) => `booking:${bookingId}`;
/** Customer-only room of a booking: quote activity must not reach the assigned worker. */
export const bookingCustomerRoom = (bookingId: string) => `booking:${bookingId}:customer`;
/** Separate from the booking room so it can be emptied the moment sharing stops, without losing chat and status events. */
export const locationRoom = (bookingId: string) => `booking:${bookingId}:location`;

/**
 * THE rules for which booking statuses enable what. Everything else (REST, sockets, jobs) reads
 * them from here. Source of truth for the statuses is booking-state-machine.ts; no status was added.
 *
 * Location sharing: the worker is on the way to, or at, the customer's address. The address is only
 * released to the worker from CONFIRMED on, so sharing starts there too. PAYMENT_PENDING is excluded
 * (nothing is agreed yet) and COMPLETED / CANCELLED / EXPIRED end sharing at once.
 * The state machine has no "on the way" status, so a CONFIRMED booking is additionally limited by
 * LOCATION_SHARING_LEAD_MINUTES before the preferred start time (see location-policy.ts).
 */
export const LOCATION_SHARING_STATUSES: readonly BookingStatus[] = [BookingStatus.CONFIRMED, BookingStatus.IN_PROGRESS];

/** Chat can be SENT while the job is paid for and not finished. History stays readable afterwards. */
export const CHAT_SEND_STATUSES: readonly BookingStatus[] = [BookingStatus.CONFIRMED, BookingStatus.IN_PROGRESS];

export const FINAL_BOOKING_STATUSES: readonly BookingStatus[] = [BookingStatus.COMPLETED, BookingStatus.CANCELLED, BookingStatus.EXPIRED];

/** Redis key conventions (the `v1` lets a future format coexist with old keys during a rollout). */
export const KEYS = {
  location: (bookingId: string) => `loc:v1:${bookingId}`,
  locationPrefix: 'loc:v1:',
  locationRate: (bookingId: string) => `rl:loc:v1:${bookingId}`,
  chatRate: (userId: string) => `rl:chat:v1:${userId}`,
  wsConnectRate: (ip: string) => `rl:ws-connect:v1:${ip}`,
} as const;

/** Booking event types that only the customer should hear about (competing-quote activity). */
export const CUSTOMER_ONLY_EVENT_TYPES: readonly string[] = ['BOOKING_CREATED', 'QUOTE_SUBMITTED', 'QUOTE_REVISED', 'QUOTE_WITHDRAWN', 'QUOTE_REJECTED', 'QUOTE_EXPIRED'];

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
