import { Injectable } from '@nestjs/common';
import { ApiError } from '../../common/errors/api-error.js';
import { HttpStatus } from '@nestjs/common';
import { type Page } from '../../common/pagination/pagination.js';
import { PrismaService } from '../../database/prisma.service.js';
import { Prisma, Role } from '../../generated/prisma/client.js';
import { maskPhone } from '../admin/admin-users.service.js';
import type { CustomersQueryDto } from './admin-console.dto.js';

interface Row {
  id: string;
  full_name: string | null;
  phone: string | null;
  status: string;
  created_at: Date;
  bookings: number;
  completed: number;
  spent: bigint;
  last_booking_at: Date | null;
  disputes: number;
  city_id: string | null;
  city_name_en: string | null;
  city_name_ar: string | null;
  total: number;
}

const initialsOf = (name: string | null) => (name ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('') || '?';

/**
 * Customers as the administrators see them: one row per customer with how much they booked and spent, their last booking and disputes.
 * "Spent" is the total of their COMPLETED bookings. The list masks the phone number (the same rule as the account list); the detail shows
 * it, because an administrator handling the account needs it. Administrators and workers-only accounts never appear.
 */
@Injectable()
export class AdminCustomersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(q: CustomersQueryDto) {
    const rows = await this.run(q, q.page, q.limit);
    const total = rows[0]?.total ?? (q.page > 1 ? ((await this.run(q, 1, 1))[0]?.total ?? 0) : 0);
    const items = rows.map((r) => ({
      id: r.id,
      fullName: r.full_name,
      initials: initialsOf(r.full_name),
      phone: maskPhone(r.phone),
      status: r.status,
      city: r.city_id ? { id: r.city_id, nameEn: r.city_name_en, nameAr: r.city_name_ar } : null,
      bookings: r.bookings,
      completedBookings: r.completed,
      spentHalalas: Number(r.spent),
      lastBookingAt: r.last_booking_at?.toISOString() ?? null,
      disputes: r.disputes,
      createdAt: r.created_at.toISOString(),
    }));
    return { items, meta: { page: q.page, limit: q.limit, total, totalPages: Math.max(1, Math.ceil(total / q.limit)) } } satisfies Page<(typeof items)[number]>;
  }

  private async run(q: CustomersQueryDto, page: number, limit: number): Promise<Row[]> {
    const like = q.q ? `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
    const where = Prisma.sql`ur.role = 'CUSTOMER'
      ${q.status ? Prisma.sql`AND u.status = ${q.status}::"UserStatus"` : Prisma.empty}
      ${like ? Prisma.sql`AND (u.full_name ILIKE ${like} OR u.full_name_ar ILIKE ${like} OR u.phone ILIKE ${like} OR u.email ILIKE ${like})` : Prisma.empty}`;
    const conditions = [
        ...(q.minSpentHalalas !== undefined ? [Prisma.sql`a.spent >= ${q.minSpentHalalas}`] : []),
        ...(q.maxSpentHalalas !== undefined ? [Prisma.sql`a.spent < ${q.maxSpentHalalas}`] : []),
        ...(q.hasDisputes === true ? [Prisma.sql`a.disputes > 0`] : q.hasDisputes === false ? [Prisma.sql`a.disputes = 0`] : []),
        ...(q.cityId ? [Prisma.sql`a.city_id = ${q.cityId}::uuid`] : []),
    ];

    return this.prisma.$queryRaw<Row[]>`
      WITH a AS (
        SELECT u.id, u.full_name, u.phone, u.status::text AS status, u.created_at,
          count(b.id)::int AS bookings,
          count(b.id) FILTER (WHERE b.status = 'COMPLETED')::int AS completed,
          coalesce(sum(b.total_amount_halalas) FILTER (WHERE b.status = 'COMPLETED'), 0)::bigint AS spent,
          max(b.created_at) AS last_booking_at,
          (SELECT count(*)::int FROM disputes d JOIN bookings bd ON bd.id = d.booking_id WHERE bd.customer_id = u.id) AS disputes,
          (SELECT bl.city_id FROM bookings bl WHERE bl.customer_id = u.id ORDER BY bl.created_at DESC LIMIT 1) AS city_id
        FROM users u
        JOIN user_roles ur ON ur.user_id = u.id
        LEFT JOIN bookings b ON b.customer_id = u.id
        WHERE ${where}
        GROUP BY u.id
      )
      SELECT a.*, c.name_en AS city_name_en, c.name_ar AS city_name_ar, count(*) OVER ()::int AS total
      FROM a LEFT JOIN cities c ON c.id = a.city_id
      ${conditions.length > 0 ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}` : Prisma.empty}
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT ${limit} OFFSET ${(page - 1) * limit}`;

  }

  async summary() {
    const [total, byStatus, repeat, spend, withDisputes] = await Promise.all([
      this.prisma.user.count({ where: { roles: { some: { role: Role.CUSTOMER } } } }),
      this.prisma.user.groupBy({ by: ['status'], where: { roles: { some: { role: Role.CUSTOMER } } }, _count: { _all: true } }),
      this.prisma.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM (SELECT customer_id FROM bookings GROUP BY customer_id HAVING count(*) >= 2) r`,
      this.prisma.booking.aggregate({ where: { status: 'COMPLETED' }, _avg: { totalAmountHalalas: true }, _count: { _all: true } }),
      this.prisma.$queryRaw<Array<{ n: number }>>`SELECT count(DISTINCT b.customer_id)::int AS n FROM disputes d JOIN bookings b ON b.id = d.booking_id`,
    ]);
    const bookers = await this.prisma.booking.groupBy({ by: ['customerId'], _count: { _all: true } });
    return {
      total,
      byStatus: byStatus.map((r) => ({ status: r.status, count: r._count._all })),
      customersWhoBooked: bookers.length,
      repeatCustomers: repeat[0]?.n ?? 0,
      repeatSharePct: bookers.length > 0 ? Math.round(((repeat[0]?.n ?? 0) / bookers.length) * 100) : null,
      averageCompletedBookingHalalas: spend._avg.totalAmountHalalas !== null ? Math.round(spend._avg.totalAmountHalalas) : null,
      withDisputes: withDisputes[0]?.n ?? 0,
    };
  }

  async detail(userId: string) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, roles: { some: { role: Role.CUSTOMER } } },
      select: { id: true, fullName: true, fullNameAr: true, phone: true, email: true, locale: true, status: true, statusReason: true, createdAt: true, lastLoginAt: true, phoneVerifiedAt: true },
    });
    if (!user) throw new ApiError(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Customer not found');
    const [counts, recent, disputes, payments, spent, reviews] = await Promise.all([
      this.prisma.booking.groupBy({ by: ['status'], where: { customerId: userId }, _count: { _all: true } }),
      this.prisma.booking.findMany({
        where: { customerId: userId },
        orderBy: { createdAt: 'desc' },
        take: 8,
        select: { id: true, reference: true, status: true, totalAmountHalalas: true, createdAt: true, service: { select: { nameEn: true, nameAr: true } } },
      }),
      this.prisma.dispute.findMany({
        where: { booking: { customerId: userId } },
        orderBy: { createdAt: 'desc' },
        take: 5,
        select: { id: true, category: true, status: true, booking: { select: { reference: true } } },
      }),
      this.prisma.booking.groupBy({ by: ['paymentMethod'], where: { customerId: userId, confirmedAt: { not: null } }, _count: { _all: true }, _sum: { totalAmountHalalas: true } }),
      this.prisma.booking.aggregate({ where: { customerId: userId, status: 'COMPLETED' }, _sum: { totalAmountHalalas: true } }),
      this.prisma.review.aggregate({ where: { customerId: userId, status: 'PUBLISHED' }, _avg: { rating: true }, _count: { _all: true } }),
    ]);
    return {
      id: user.id,
      fullName: user.fullName,
      fullNameAr: user.fullNameAr,
      initials: initialsOf(user.fullName),
      phone: user.phone,
      phoneVerified: user.phoneVerifiedAt !== null,
      email: user.email,
      locale: user.locale,
      status: user.status,
      statusReason: user.statusReason,
      createdAt: user.createdAt.toISOString(),
      lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
      bookingsByStatus: counts.map((r) => ({ status: r.status, count: r._count._all })),
      bookings: counts.reduce((a, r) => a + r._count._all, 0),
      spentHalalas: spent._sum.totalAmountHalalas ?? 0,
      reviewsGiven: reviews._count._all,
      averageRatingGiven: reviews._avg.rating !== null ? Math.round(reviews._avg.rating * 10) / 10 : null,
      recentBookings: recent.map((b) => ({ id: b.id, reference: b.reference, status: b.status, totalHalalas: b.totalAmountHalalas, serviceNameEn: b.service.nameEn, serviceNameAr: b.service.nameAr, createdAt: b.createdAt.toISOString() })),
      disputes: disputes.map((d) => ({ id: d.id, category: d.category, status: d.status, bookingReference: d.booking.reference })),
      // Only cash is stored on the booking; a confirmed booking that is not cash was paid online.
      paymentMethods: payments.map((p) => ({ method: p.paymentMethod === 'CASH' ? 'CASH' : 'ONLINE', bookings: p._count._all, totalHalalas: p._sum.totalAmountHalalas ?? 0 })),
    };
  }
}
