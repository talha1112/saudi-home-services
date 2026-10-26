import { Injectable } from '@nestjs/common';
import type { AuthenticatedUser } from '../../common/auth/authenticated-user.js';
import { forbidden } from '../../common/errors/api-error.js';
import { PrismaService } from '../../database/prisma.service.js';
import { BookingStatus, Role, WorkerVerificationStatus } from '../../generated/prisma/client.js';
import { notFound } from '../bookings/booking-support.js';
import { UUID_RE } from './realtime.constants.js';

export type BookingSide = 'CUSTOMER' | 'WORKER';

export interface BookingAccess {
  side: BookingSide;
  booking: {
    id: string;
    status: BookingStatus;
    customerId: string;
    workerUserId: string | null;
    preferredStartAt: Date;
  };
}

/**
 * Who may see a booking's live data (status events, chat, position) and in which role.
 *
 * Read from the database on every call; nothing the client says is trusted. Only two people are
 * ever participants: the booking's customer (acting as CUSTOMER) and the worker the accepted quote
 * assigned (acting as WORKER, still APPROVED). Administrators are NOT participants: they have the
 * REST booking views, but they do not join booking rooms, read chat or see positions.
 * Everyone else gets "not found", the same answer as for a booking that does not exist.
 */
@Injectable()
export class BookingAccessService {
  constructor(private readonly prisma: PrismaService) {}

  /** `db` lets a caller run the same check inside its own transaction, after taking the booking lock. */
  async resolve(user: AuthenticatedUser, bookingId: string, db: Pick<PrismaService, 'booking'> = this.prisma): Promise<BookingAccess> {
    if (typeof bookingId !== 'string' || !UUID_RE.test(bookingId)) throw notFound('Booking');
    const row = await db.booking.findUnique({
      where: { id: bookingId },
      select: {
        id: true,
        status: true,
        customerId: true,
        preferredStartAt: true,
        worker: { select: { userId: true, verificationStatus: true } },
      },
    });
    if (!row) throw notFound('Booking');

    const booking = {
      id: row.id,
      status: row.status,
      customerId: row.customerId,
      workerUserId: row.worker?.userId ?? null,
      preferredStartAt: row.preferredStartAt,
    };

    if (user.role === Role.CUSTOMER && row.customerId === user.id) return { side: 'CUSTOMER', booking };

    if (user.role === Role.WORKER && row.worker && row.worker.userId === user.id) {
      if (row.worker.verificationStatus !== WorkerVerificationStatus.APPROVED) {
        throw forbidden('WORKER_NOT_APPROVED', 'Your worker account is not approved to take part in bookings');
      }
      return { side: 'WORKER', booking };
    }

    throw notFound('Booking');
  }
}
