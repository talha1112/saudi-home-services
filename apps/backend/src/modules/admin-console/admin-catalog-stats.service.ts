import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { UserStatus, WorkerVerificationStatus } from '../../generated/prisma/client.js';

/**
 * Figures shown next to the service catalogue: how many bookings each service and category has had, how many approved workers offer it and
 * what quotes for it usually cost (before VAT). All time, from the database.
 */
@Injectable()
export class AdminCatalogStatsService {
  constructor(private readonly prisma: PrismaService) {}

  async stats() {
    const [services, bookings, completed, quotes, workers, categories, categoryWorkers] = await Promise.all([
      this.prisma.service.findMany({ select: { id: true, categoryId: true } }),
      this.prisma.booking.groupBy({ by: ['serviceId'], _count: { _all: true } }),
      this.prisma.booking.groupBy({ by: ['serviceId'], where: { status: 'COMPLETED' }, _count: { _all: true } }),
      this.prisma.$queryRaw<Array<{ service_id: string; avg_price: number | null }>>`
        SELECT b.service_id, avg(q.price_halalas)::float AS avg_price FROM quotes q JOIN bookings b ON b.id = q.booking_id GROUP BY b.service_id`,
      this.prisma.workerService.groupBy({
        by: ['serviceId'],
        where: { worker: { verificationStatus: WorkerVerificationStatus.APPROVED, user: { status: UserStatus.ACTIVE } } },
        _count: { _all: true },
      }),
      this.prisma.serviceCategory.findMany({ select: { id: true } }),
      this.prisma.$queryRaw<Array<{ category_id: string; n: number }>>`
        SELECT s.category_id, count(DISTINCT ws.worker_profile_id)::int AS n
        FROM worker_services ws JOIN services s ON s.id = ws.service_id JOIN worker_profiles wp ON wp.id = ws.worker_profile_id JOIN users u ON u.id = wp.user_id
        WHERE wp.verification_status = 'APPROVED' AND u.status = 'ACTIVE' GROUP BY s.category_id`,
    ]);
    const count = (rows: Array<{ serviceId: string; _count: { _all: number } }>, id: string) => rows.find((r) => r.serviceId === id)?._count._all ?? 0;
    return {
      services: services.map((s) => ({
        serviceId: s.id,
        bookings: count(bookings, s.id),
        completedBookings: count(completed, s.id),
        workers: count(workers, s.id),
        averageQuoteHalalas: Math.round(quotes.find((q) => q.service_id === s.id)?.avg_price ?? 0) || null,
      })),
      categories: categories.map((c) => ({
        categoryId: c.id,
        bookings: services.filter((s) => s.categoryId === c.id).reduce((a, s) => a + count(bookings, s.id), 0),
        workers: categoryWorkers.find((w) => w.category_id === c.id)?.n ?? 0,
      })),
    };
  }
}
