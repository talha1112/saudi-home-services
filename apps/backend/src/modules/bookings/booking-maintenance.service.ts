import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { describeError } from '../../common/logging/safe-error.js';
import { APP_CONFIG, type AppConfig } from '../../config/app.config.js';
import { NodeEnv } from '../../config/env.validation.js';
import { PrismaService } from '../../database/prisma.service.js';
import { BookingEventType, QuoteStatus } from '../../generated/prisma/client.js';
import { BookingLifecycleService } from './booking-lifecycle.service.js';
import { recordEvent } from './booking-support.js';

const INTERVAL_MS = 5 * 60_000;
const BATCH = 200;

/**
 * Housekeeping that makes time-based rules visible in the data: quotes whose validity ran out
 * become EXPIRED and OPEN requests nobody was chosen for become EXPIRED. Correctness never
 * depends on it (accepting re-checks the times itself); it only keeps statuses honest.
 * Idempotent, safe on several instances, disabled in tests.
 */
@Injectable()
export class BookingMaintenanceService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(BookingMaintenanceService.name);
  private timer?: NodeJS.Timeout;
  private readonly enabled: boolean;

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly lifecycle: BookingLifecycleService,
  ) {
    this.enabled = config.getOrThrow<AppConfig>(APP_CONFIG).env !== NodeEnv.Test;
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) return;
    this.timer = setInterval(() => void this.runSafely(), INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  private async runSafely(): Promise<void> {
    try {
      const done = await this.run();
      if (done.quotes + done.bookings > 0) this.logger.log(`Expired ${done.quotes} quotes and ${done.bookings} booking requests`);
    } catch (err) {
      this.logger.warn(`Booking housekeeping failed: ${describeError(err)}`);
    }
  }

  async run(now: Date = new Date()): Promise<{ quotes: number; bookings: number }> {
    let quotes = 0;
    const dueQuotes = await this.prisma.quote.findMany({
      where: { status: QuoteStatus.SUBMITTED, validUntil: { lte: now } },
      select: { id: true, bookingId: true, priceHalalas: true },
      take: BATCH,
    });
    for (const q of dueQuotes) {
      const changed = await this.prisma.$transaction(async (tx) => {
        const moved = await tx.quote.updateMany({
          where: { id: q.id, status: QuoteStatus.SUBMITTED, validUntil: { lte: now } },
          data: { status: QuoteStatus.EXPIRED },
        });
        if (moved.count !== 1) return false;
        await recordEvent(tx, { bookingId: q.bookingId, type: BookingEventType.QUOTE_EXPIRED, quoteId: q.id, amountHalalas: q.priceHalalas });
        return true;
      });
      if (changed) quotes++;
    }

    let bookings = 0;
    const dueBookings = await this.prisma.booking.findMany({ where: { status: 'OPEN', expiresAt: { lte: now } }, select: { id: true }, take: BATCH });
    for (const b of dueBookings) if (await this.lifecycle.expireBooking(b.id)) bookings++;
    return { quotes, bookings };
  }
}
