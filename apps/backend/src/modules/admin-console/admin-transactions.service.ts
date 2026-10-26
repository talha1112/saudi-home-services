import { Injectable } from '@nestjs/common';
import { type Page, PageQueryDto, toPage } from '../../common/pagination/pagination.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { resolveRange } from '../reports/reports.service.js';
import { maskPhone } from '../admin/admin-users.service.js';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsISO8601, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const contains = (q: string) => ({ contains: q, mode: 'insensitive' as const });

export class TransactionsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ description: 'Booking reference or customer name/phone' }) @IsOptional() @Transform(trim) @IsString() @MinLength(1) @MaxLength(60) q?: string;
  @ApiPropertyOptional({ enum: ['CASH', 'ONLINE'] }) @IsOptional() @IsIn(['CASH', 'ONLINE']) method?: 'CASH' | 'ONLINE';
  @ApiPropertyOptional({ enum: ['COLLECTED', 'CASH_DUE', 'PAID', 'CANCELLED'], description: 'Derived payment state of the booking' }) @IsOptional() @IsIn(['COLLECTED', 'CASH_DUE', 'PAID', 'CANCELLED']) state?: string;
  @ApiPropertyOptional() @IsOptional() @IsISO8601({ strict: true }) from?: string;
  @ApiPropertyOptional() @IsOptional() @IsISO8601({ strict: true }) to?: string;
  @ApiPropertyOptional({ description: 'Only bookings in this city' }) @IsOptional() @IsUUID() cityId?: string;
  @ApiProperty({ required: false, enum: ['transactions', 'refunds', 'failed'], default: 'transactions' }) @IsOptional() @IsIn(['transactions', 'refunds', 'failed']) view?: 'transactions' | 'refunds' | 'failed';
}

/**
 * The money screen. A "transaction" is a booking whose payment was chosen: cash (collected by the worker in person) or online (a captured
 * payment attempt). Amounts are what the customer agreed to pay (incl. VAT). Refunds are REQUESTS recorded by administrators; nothing is
 * returned to a customer until a payment provider confirms it, and none can yet. Failed means online payment attempts that did not succeed.
 */
@Injectable()
export class AdminTransactionsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(q: TransactionsQueryDto) {
    return q.view === 'refunds' ? this.refunds(q) : q.view === 'failed' ? this.failed(q) : this.transactions(q);
  }

  private async transactions(q: TransactionsQueryDto) {
    // Only cash is stored on the booking; a confirmed booking that is not cash was paid online.
    const and: Prisma.BookingWhereInput[] = [{ confirmedAt: { not: null } }];
    if (q.cityId) and.push({ cityId: q.cityId });
    if (q.method === 'CASH') and.push({ paymentMethod: 'CASH' });
    if (q.method === 'ONLINE') and.push({ OR: [{ paymentMethod: null }, { paymentMethod: { not: 'CASH' } }] });
    if (q.state === 'COLLECTED') and.push({ paymentMethod: 'CASH', cashCollectedAt: { not: null } });
    if (q.state === 'CASH_DUE') and.push({ paymentMethod: 'CASH', cashCollectedAt: null, status: { not: 'CANCELLED' } });
    if (q.state === 'CANCELLED') and.push({ status: 'CANCELLED' });
    if (q.state === 'PAID') and.push({ OR: [{ paymentMethod: null }, { paymentMethod: { not: 'CASH' } }], status: { not: 'CANCELLED' } });
    if (q.from || q.to) and.push({ confirmedAt: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lt: new Date(q.to) } : {}) } });
    if (q.q) and.push({ OR: [{ reference: { startsWith: q.q.toUpperCase() } }, { customer: { OR: [{ fullName: contains(q.q) }, { phone: { contains: q.q } }] } }] });
    const where: Prisma.BookingWhereInput = { AND: and };
    const [rows, total] = await Promise.all([
      this.prisma.booking.findMany({
        where,
        orderBy: [{ confirmedAt: 'desc' }, { id: 'desc' }],
        skip: q.skip,
        take: q.limit,
        select: {
          id: true, reference: true, status: true, paymentMethod: true, cashCollectedAt: true, confirmedAt: true, currency: true,
          totalAmountHalalas: true, vatAmountHalalas: true, commissionAmountHalalas: true, serviceAmountHalalas: true, workerPayoutHalalas: true,
          customer: { select: { id: true, fullName: true } },
          paymentAttempts: { where: { status: 'SUCCEEDED' }, orderBy: { createdAt: 'desc' }, take: 1, select: { id: true, provider: true, providerPaymentId: true, isSimulated: true, refundReservedHalalas: true, capturedAmountHalalas: true } },
          service: { select: { nameEn: true, nameAr: true } },
        },
      }),
      this.prisma.booking.count({ where }),
    ]);
    return toPage(
      rows.map((b) => {
        const attempt = b.paymentAttempts[0];
        const state = b.status === 'CANCELLED' ? 'CANCELLED' : b.paymentMethod === 'CASH' ? (b.cashCollectedAt ? 'COLLECTED' : 'CASH_DUE') : 'PAID';
        return {
          bookingId: b.id, reference: b.reference, bookingStatus: b.status, customerId: b.customer.id, customerName: b.customer.fullName,
          serviceNameEn: b.service.nameEn, serviceNameAr: b.service.nameAr,
          method: b.paymentMethod === 'CASH' ? 'CASH' : 'ONLINE', state,
          totalHalalas: b.totalAmountHalalas ?? 0, vatHalalas: b.vatAmountHalalas ?? 0, serviceAmountHalalas: b.serviceAmountHalalas ?? 0,
          commissionHalalas: b.commissionAmountHalalas ?? 0, workerPayoutHalalas: b.workerPayoutHalalas ?? 0, currency: b.currency,
          date: (b.cashCollectedAt ?? b.confirmedAt)?.toISOString() ?? null,
          confirmedAt: b.confirmedAt?.toISOString() ?? null,
          cashCollectedAt: b.cashCollectedAt?.toISOString() ?? null,
          payment: attempt ? { id: attempt.id, provider: attempt.provider, providerPaymentId: attempt.providerPaymentId, simulated: attempt.isSimulated, refundReservedHalalas: attempt.refundReservedHalalas, capturedHalalas: attempt.capturedAmountHalalas } : null,
        };
      }),
      total,
      q,
    );
  }

  private async refunds(q: TransactionsQueryDto) {
    const where: Prisma.PaymentRefundWhereInput = {
      ...(q.from || q.to ? { createdAt: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lt: new Date(q.to) } : {}) } } : {}),
      ...(q.cityId ? { booking: { cityId: q.cityId } } : {}),
      ...(q.q ? { OR: [{ booking: { reference: { startsWith: q.q.toUpperCase() } } }, { booking: { customer: { fullName: contains(q.q) } } }] } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.paymentRefund.findMany({
        where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: q.skip, take: q.limit,
        select: { id: true, paymentId: true, bookingId: true, amountHalalas: true, currency: true, reason: true, status: true, createdAt: true, booking: { select: { reference: true, customer: { select: { fullName: true } } } } },
      }),
      this.prisma.paymentRefund.count({ where }),
    ]);
    return toPage(
      rows.map((r) => ({
        refundId: r.id, paymentId: r.paymentId, bookingId: r.bookingId, reference: r.booking.reference, customerName: r.booking.customer.fullName,
        amountHalalas: r.amountHalalas, currency: r.currency, reason: r.reason, status: r.status, moneyReturned: r.status === 'SUCCEEDED', date: r.createdAt.toISOString(),
      })),
      total,
      q,
    );
  }

  private async failed(q: TransactionsQueryDto) {
    const where: Prisma.PaymentAttemptWhereInput = {
      status: { in: ['FAILED', 'CANCELLED', 'EXPIRED'] },
      ...(q.from || q.to ? { createdAt: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lt: new Date(q.to) } : {}) } } : {}),
      ...(q.cityId ? { booking: { cityId: q.cityId } } : {}),
      ...(q.q ? { OR: [{ booking: { reference: { startsWith: q.q.toUpperCase() } } }, { booking: { customer: { fullName: contains(q.q) } } }] } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.paymentAttempt.findMany({
        where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: q.skip, take: q.limit,
        select: { id: true, bookingId: true, status: true, amountHalalas: true, currency: true, provider: true, failureCode: true, failureMessage: true, createdAt: true, booking: { select: { reference: true, customer: { select: { fullName: true, phone: true } } } } },
      }),
      this.prisma.paymentAttempt.count({ where }),
    ]);
    return toPage(
      rows.map((a) => ({
        paymentId: a.id, bookingId: a.bookingId, reference: a.booking.reference, customerName: a.booking.customer.fullName, customerPhone: maskPhone(a.booking.customer.phone),
        amountHalalas: a.amountHalalas, currency: a.currency, provider: a.provider, status: a.status, failureCode: a.failureCode, failureMessage: a.failureMessage, date: a.createdAt.toISOString(),
      })),
      total,
      q,
    );
  }

  async summary(fromIso?: string, toIso?: string, cityId?: string, now: Date = new Date()) {
    const range = resolveRange(fromIso, toIso, now);
    const city = cityId ? { cityId } : {};
    const confirmed = { confirmedAt: { gte: range.from, lt: range.to }, ...city } satisfies Prisma.BookingWhereInput;
    const [cash, online, refunds, attempts, failedAttempts, byMethod] = await Promise.all([
      this.prisma.booking.aggregate({ where: { ...confirmed, paymentMethod: 'CASH', status: { not: 'CANCELLED' } }, _count: { _all: true }, _sum: { totalAmountHalalas: true, vatAmountHalalas: true } }),
      this.prisma.booking.aggregate({ where: { ...confirmed, OR: [{ paymentMethod: null }, { paymentMethod: { not: 'CASH' } }], status: { not: 'CANCELLED' } }, _count: { _all: true }, _sum: { totalAmountHalalas: true, vatAmountHalalas: true } }),
      this.prisma.paymentRefund.aggregate({ where: { createdAt: { gte: range.from, lt: range.to }, ...(cityId ? { booking: { cityId } } : {}) }, _count: { _all: true }, _sum: { amountHalalas: true } }),
      this.prisma.paymentAttempt.count({ where: { createdAt: { gte: range.from, lt: range.to }, ...(cityId ? { booking: { cityId } } : {}) } }),
      this.prisma.paymentAttempt.count({ where: { createdAt: { gte: range.from, lt: range.to }, status: { in: ['FAILED', 'CANCELLED', 'EXPIRED'] }, ...(cityId ? { booking: { cityId } } : {}) } }),
      this.prisma.booking.aggregate({ where: { ...confirmed, paymentMethod: 'CASH', status: { not: 'CANCELLED' }, cashCollectedAt: null }, _count: { _all: true }, _sum: { totalAmountHalalas: true } }),
    ]);
    const n = (v: number | null | undefined) => v ?? 0;
    return {
      range: { from: range.from.toISOString(), to: range.to.toISOString() },
      agreedHalalas: n(cash._sum.totalAmountHalalas) + n(online._sum.totalAmountHalalas),
      vatHalalas: n(cash._sum.vatAmountHalalas) + n(online._sum.vatAmountHalalas),
      cash: { bookings: cash._count._all, totalHalalas: n(cash._sum.totalAmountHalalas), stillToCollectBookings: byMethod._count._all, stillToCollectHalalas: n(byMethod._sum.totalAmountHalalas) },
      online: { bookings: online._count._all, totalHalalas: n(online._sum.totalAmountHalalas) },
      refundRequests: { count: refunds._count._all, amountHalalas: n(refunds._sum.amountHalalas) },
      paymentAttempts: attempts,
      failedAttempts,
      failedSharePct: attempts > 0 ? Math.round((failedAttempts / attempts) * 1000) / 10 : null,
      definitions: {
        agreed: 'Total (incl. VAT) of bookings whose payment was chosen in the window and are not cancelled. Cash is counted when chosen; it is collected by the worker in person.',
        refunds: 'Refund REQUESTS created in the window. No money is returned until a payment provider confirms it.',
      },
    };
  }
}

export type TransactionsPage = Page<unknown>;
