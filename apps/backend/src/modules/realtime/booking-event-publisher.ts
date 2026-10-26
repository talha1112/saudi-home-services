import { Injectable } from '@nestjs/common';
import { LocationService } from './location/location.service.js';
import { CUSTOMER_ONLY_EVENT_TYPES, FINAL_BOOKING_STATUSES, SERVER_EVENTS, bookingCustomerRoom, bookingRoom } from './realtime.constants.js';
import { RealtimeGateway } from './realtime.gateway.js';
import { SocketEmitter } from './socket-emitter.js';

/** The outbox payload (written by recordEvent). Version 1; additions are optional fields, breaking changes get a new version. */
export interface BookingEventPayload {
  v: 1;
  eventId: string;
  bookingId: string;
  type: string;
  fromStatus: string | null;
  toStatus: string | null;
  occurredAt: string;
}

export function isBookingEventPayload(value: unknown): value is BookingEventPayload {
  const p = value as Partial<BookingEventPayload> | null;
  return !!p && p.v === 1 && typeof p.eventId === 'string' && typeof p.bookingId === 'string' && typeof p.type === 'string' && typeof p.occurredAt === 'string';
}

/**
 * Delivers one committed booking event to sockets. Called only by the outbox dispatcher, i.e. after
 * the transaction that produced the event committed.
 *
 * Quote activity goes to the customer-only room so the assigned worker never learns about competing
 * quotes; lifecycle events go to the booking room (customer + assigned worker). When a booking
 * reaches a final status, live position sharing is ended and its subscribers are removed.
 */
@Injectable()
export class BookingEventPublisher {
  constructor(
    private readonly emitter: SocketEmitter,
    private readonly location: LocationService,
    private readonly gateway: RealtimeGateway,
  ) {}

  /** Throws when the realtime server is not running, so the outbox keeps the event and retries. */
  async publish(payload: BookingEventPayload): Promise<void> {
    const room = CUSTOMER_ONLY_EVENT_TYPES.includes(payload.type) ? bookingCustomerRoom(payload.bookingId) : bookingRoom(payload.bookingId);
    this.emitter.toRoomOrThrow(room, SERVER_EVENTS.bookingEvent, payload);

    if (payload.toStatus && (FINAL_BOOKING_STATUSES as readonly string[]).includes(payload.toStatus)) {
      await this.location.endSharing(payload.bookingId);
    }
    // Who may stay in the rooms can have changed with this event.
    void this.gateway.recheckRoom(payload.bookingId);
  }
}
