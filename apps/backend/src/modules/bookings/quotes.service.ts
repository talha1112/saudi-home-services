import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { badRequest, badRequestWith } from '../../common/errors/api-error.js';
import { APP_CONFIG, type AppConfig, type BookingsConfig } from '../../config/app.config.js';
import { PrismaService } from '../../database/prisma.service.js';
import { BookingEventType, BookingStatus, QuoteStatus, Role } from '../../generated/prisma/client.js';
import { PricingService } from '../pricing/pricing.service.js';
import { computeQuoteAmounts } from '../pricing/money.js';
import { conflict, isUniqueViolation, isLive, lockBooking, notFound, recordEvent } from './booking-support.js';
import type { CreateQuoteDto, UpdateQuoteDto } from './dto/bookings.dto.js';

const MAX_PROPOSAL_HORIZON_DAYS = 90;

export interface WorkerContext {
  id: string;
  serviceIds: Map<string, number | null>;
  cityIds: Set<string>;
}

/** Quote submission, editing and withdrawal by workers. Prices are always computed here. */
@Injectable()
export class QuotesService {
  private readonly cfg: BookingsConfig;

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly pricing: PricingService,
  ) {
    this.cfg = config.getOrThrow<AppConfig>(APP_CONFIG).bookings;
  }

  /** The worker's profile id and what they offer. Callers already passed the approved-worker guard. */
  async workerContext(userId: string): Promise<WorkerContext> {
    const profile = await this.prisma.workerProfile.findUnique({
      where: { userId },
      select: { id: true, services: { select: { serviceId: true, yearsOfExperience: true } }, serviceAreas: { select: { cityId: true } } },
    });
    if (!profile) throw notFound('Worker profile');
    return {
      id: profile.id,
      serviceIds: new Map(profile.services.map((s) => [s.serviceId, s.yearsOfExperience])),
      cityIds: new Set(profile.serviceAreas.map((a) => a.cityId)),
    };
  }

  isEligible(worker: WorkerContext, booking: { serviceId: string; cityId: string }): boolean {
    return worker.serviceIds.has(booking.serviceId) && worker.cityIds.has(booking.cityId);
  }

  // ------------------------------------------------------------------ submit

  async submit(workerUserId: string, bookingId: string, dto: CreateQuoteDto): Promise<{ id: string }> {
    const worker = await this.workerContext(workerUserId);
    const now = new Date();

    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: { id: true, status: true, serviceId: true, cityId: true, expiresAt: true },
    });
    // A request the worker is not eligible for looks exactly like one that does not exist.
    if (!booking || !this.isEligible(worker, booking)) throw notFound('Request');
    if (booking.status !== BookingStatus.OPEN || booking.expiresAt.getTime() <= now.getTime()) {
      throw conflict('BOOKING_NOT_OPEN', 'This request is no longer accepting quotes');
    }

    const pricing = await this.pricing.current(now);
    const offer = this.validateOffer(
      { price: dto.priceHalalas, start: dto.proposedStartAt, end: dto.proposedEndAt, validForHours: dto.validForHours },
      pricing.minServiceChargeHalalas,
      booking.expiresAt,
      now,
    );
    const amounts = computeQuoteAmounts(dto.priceHalalas, pricing);
    const fields = {
      priceHalalas: amounts.priceHalalas,
      vatAmountHalalas: amounts.vatAmountHalalas,
      totalAmountHalalas: amounts.totalAmountHalalas,
      commissionAmountHalalas: amounts.commissionAmountHalalas,
      workerPayoutHalalas: amounts.workerPayoutHalalas,
      vatRateBps: pricing.vatRateBps,
      commissionRateBps: pricing.commissionRateBps,
      pricingSettingId: pricing.id,
      proposedStartAt: offer.start,
      proposedEndAt: offer.end,
      estimatedDurationMinutes: dto.estimatedDurationMinutes ?? null,
      message: dto.message ?? null,
      validUntil: offer.validUntil,
    };

    try {
      return await this.prisma.$transaction(async (tx) => {
        // Serialise with accept/cancel/expire and re-check: a quote must never be added to a booking
        // that was accepted or cancelled while this request was being validated.
        await lockBooking(tx, bookingId);
        const fresh = await tx.booking.findUnique({ where: { id: bookingId }, select: { status: true, expiresAt: true } });
        if (!fresh || fresh.status !== BookingStatus.OPEN || fresh.expiresAt.getTime() <= now.getTime()) {
          throw conflict('BOOKING_NOT_OPEN', 'This request is no longer accepting quotes');
        }
        const existing = await tx.quote.findUnique({ where: { bookingId_workerProfileId: { bookingId, workerProfileId: worker.id } } });
        const live = await tx.quote.count({ where: { bookingId, status: QuoteStatus.SUBMITTED, validUntil: { gt: now } } });
        if (live >= this.cfg.maxQuotesPerBooking && !(existing && isLive(existing, now))) {
          throw conflict('QUOTE_LIMIT_REACHED', 'This request already has the maximum number of quotes');
        }

        let id: string;
        let type: BookingEventType = BookingEventType.QUOTE_SUBMITTED;
        if (!existing) {
          id = (await tx.quote.create({ data: { bookingId, workerProfileId: worker.id, ...fields }, select: { id: true } })).id;
        } else if (isLive(existing, now)) {
          throw conflict('QUOTE_EXISTS', 'You already quoted on this request. Edit your quote instead');
        } else if (existing.status === QuoteStatus.WITHDRAWN || existing.status === QuoteStatus.EXPIRED || existing.status === QuoteStatus.SUBMITTED) {
          // Withdrawn or expired quotes can be offered again; the same row is reused (one quote per worker per request).
          const revived = await tx.quote.updateMany({
            where: { id: existing.id, status: existing.status, version: existing.version },
            data: { ...fields, status: QuoteStatus.SUBMITTED, withdrawnAt: null, version: { increment: 1 } },
          });
          if (revived.count !== 1) throw conflict('QUOTE_CHANGED', 'Your quote changed, please reload');
          id = existing.id;
          type = BookingEventType.QUOTE_REVISED;
        } else {
          throw conflict('QUOTE_NOT_REACTIVATABLE', `A ${existing.status.toLowerCase()} quote cannot be resubmitted`);
        }
        await recordEvent(tx, {
          bookingId,
          type,
          quoteId: id,
          actorUserId: workerUserId,
          actorRole: Role.WORKER,
          amountHalalas: amounts.priceHalalas,
        });
        return { id };
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('QUOTE_EXISTS', 'You already quoted on this request. Edit your quote instead');
      throw err;
    }
  }

  // ------------------------------------------------------------------ revise

  async revise(workerUserId: string, quoteId: string, dto: UpdateQuoteDto): Promise<void> {
    if (Object.values(dto).every((v) => v === undefined)) throw badRequest('NOTHING_TO_UPDATE', 'Send at least one field to change');
    const worker = await this.workerContext(workerUserId);
    const now = new Date();

    const quote = await this.prisma.quote.findFirst({
      where: { id: quoteId, workerProfileId: worker.id },
      include: { booking: { select: { id: true, status: true, expiresAt: true } } },
    });
    if (!quote) throw notFound('Quote');
    if (!isLive(quote, now)) throw conflict('QUOTE_NOT_EDITABLE', `A ${quote.status.toLowerCase()} or expired quote cannot be edited`, { status: quote.status });
    if (quote.booking.status !== BookingStatus.OPEN || quote.booking.expiresAt.getTime() <= now.getTime()) {
      throw conflict('BOOKING_NOT_OPEN', 'This request is no longer accepting changes');
    }

    const pricing = await this.pricing.current(now);
    const price = dto.priceHalalas ?? quote.priceHalalas;
    const offer = this.validateOffer(
      {
        price,
        start: dto.proposedStartAt ?? quote.proposedStartAt.toISOString(),
        end: dto.proposedEndAt ?? quote.proposedEndAt.toISOString(),
        validForHours: dto.validForHours,
      },
      pricing.minServiceChargeHalalas,
      quote.booking.expiresAt,
      now,
      dto.validForHours === undefined ? quote.validUntil : undefined,
    );
    const amounts = computeQuoteAmounts(price, pricing);

    await this.prisma.$transaction(async (tx) => {
      const moved = await tx.quote.updateMany({
        // The version check means an edit that races with an acceptance (or another edit) cannot slip through.
        where: { id: quote.id, workerProfileId: worker.id, status: QuoteStatus.SUBMITTED, version: quote.version },
        data: {
          priceHalalas: amounts.priceHalalas,
          vatAmountHalalas: amounts.vatAmountHalalas,
          totalAmountHalalas: amounts.totalAmountHalalas,
          commissionAmountHalalas: amounts.commissionAmountHalalas,
          workerPayoutHalalas: amounts.workerPayoutHalalas,
          vatRateBps: pricing.vatRateBps,
          commissionRateBps: pricing.commissionRateBps,
          pricingSettingId: pricing.id,
          proposedStartAt: offer.start,
          proposedEndAt: offer.end,
          estimatedDurationMinutes: dto.estimatedDurationMinutes ?? quote.estimatedDurationMinutes,
          message: dto.message ?? quote.message,
          validUntil: offer.validUntil,
          version: { increment: 1 },
        },
      });
      if (moved.count !== 1) throw conflict('QUOTE_CHANGED', 'The quote changed or was accepted meanwhile, please reload');
      await recordEvent(tx, {
        bookingId: quote.bookingId,
        type: BookingEventType.QUOTE_REVISED,
        quoteId: quote.id,
        actorUserId: workerUserId,
        actorRole: Role.WORKER,
        amountHalalas: amounts.priceHalalas,
      });
    });
  }

  // ---------------------------------------------------------------- withdraw

  async withdraw(workerUserId: string, quoteId: string): Promise<void> {
    const worker = await this.workerContext(workerUserId);
    await this.prisma.$transaction(async (tx) => {
      const quote = await tx.quote.findFirst({ where: { id: quoteId, workerProfileId: worker.id } });
      if (!quote) throw notFound('Quote');
      if (quote.status === QuoteStatus.ACCEPTED) {
        throw conflict('QUOTE_ACCEPTED', 'An accepted quote cannot be withdrawn. Contact support to cancel the job');
      }
      if (quote.status !== QuoteStatus.SUBMITTED) {
        throw conflict('QUOTE_NOT_WITHDRAWABLE', `A ${quote.status.toLowerCase()} quote cannot be withdrawn`, { status: quote.status });
      }
      const moved = await tx.quote.updateMany({
        where: { id: quote.id, workerProfileId: worker.id, status: QuoteStatus.SUBMITTED },
        data: { status: QuoteStatus.WITHDRAWN, withdrawnAt: new Date() },
      });
      if (moved.count !== 1) throw conflict('QUOTE_NOT_WITHDRAWABLE', 'The quote was accepted or changed meanwhile');
      await recordEvent(tx, {
        bookingId: quote.bookingId,
        type: BookingEventType.QUOTE_WITHDRAWN,
        quoteId: quote.id,
        actorUserId: workerUserId,
        actorRole: Role.WORKER,
        amountHalalas: quote.priceHalalas,
      });
    });
  }

  // -------------------------------------------------------------- validation

  /** Server-side checks of everything the worker typed. Throws 400 with a stable code. */
  private validateOffer(
    input: { price: number; start: string; end: string; validForHours?: number },
    minServiceChargeHalalas: number,
    bookingExpiresAt: Date,
    now: Date,
    keepValidUntil?: Date,
  ): { start: Date; end: Date; validUntil: Date } {
    if (!Number.isSafeInteger(input.price) || input.price <= 0) throw badRequest('INVALID_PRICE', 'The price must be a whole number of halalas');
    if (input.price < minServiceChargeHalalas) {
      throw badRequestWith('PRICE_BELOW_MINIMUM', 'The price is below the minimum service charge', { minServiceChargeHalalas });
    }
    if (input.price > this.cfg.quoteMaxPriceHalalas) {
      throw badRequestWith('PRICE_TOO_HIGH', 'The price is above the allowed maximum', { maxHalalas: this.cfg.quoteMaxPriceHalalas });
    }

    const start = new Date(input.start);
    const end = new Date(input.end);
    if (start.getTime() < now.getTime() - 60_000) throw badRequest('INVALID_PROPOSED_WINDOW', 'The proposed start is in the past');
    if (end.getTime() <= start.getTime()) throw badRequest('INVALID_PROPOSED_WINDOW', 'The proposed end must be after the start');
    if (start.getTime() > now.getTime() + MAX_PROPOSAL_HORIZON_DAYS * 86_400_000) {
      throw badRequest('INVALID_PROPOSED_WINDOW', `The proposed start must be within ${MAX_PROPOSAL_HORIZON_DAYS} days`);
    }

    let validUntil: Date;
    if (keepValidUntil) {
      validUntil = keepValidUntil;
    } else {
      const hours = input.validForHours ?? this.cfg.quoteDefaultValidityHours;
      if (hours > this.cfg.quoteMaxValidityHours) {
        throw badRequest('INVALID_VALIDITY', `A quote can stay valid for at most ${this.cfg.quoteMaxValidityHours} hours`);
      }
      // Never longer than the request itself.
      validUntil = new Date(Math.min(now.getTime() + hours * 3_600_000, bookingExpiresAt.getTime()));
    }
    if (validUntil.getTime() <= now.getTime() + 60_000) throw conflict('BOOKING_NOT_OPEN', 'This request is about to close');
    return { start, end, validUntil };
  }
}
