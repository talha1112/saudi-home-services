import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service.js';
import { Role } from '../../generated/prisma/client.js';
import { maskPhone } from '../admin/admin-users.service.js';

const contains = (q: string) => ({ contains: q, mode: 'insensitive' as const });
const PER_KIND = 5;

export interface SearchHit {
  type: 'customer' | 'worker' | 'booking' | 'service' | 'dispute';
  id: string;
  title: string;
  subtitle: string;
}

/**
 * The header search: a few matches of each kind. Phone numbers are masked like in every list. The administrator's browser decides where a
 * hit leads (the page for its type); nothing here is a link.
 */
@Injectable()
export class AdminSearchService {
  constructor(private readonly prisma: PrismaService) {}

  async search(q: string): Promise<{ query: string; hits: SearchHit[] }> {
    const person = (role: Role) => ({
      roles: { some: { role } },
      OR: [{ fullName: contains(q) }, { fullNameAr: contains(q) }, { phone: { contains: q } }, { email: contains(q) }],
    });
    const [customers, workers, bookings, services, disputes] = await Promise.all([
      this.prisma.user.findMany({ where: person(Role.CUSTOMER), orderBy: { createdAt: 'desc' }, take: PER_KIND, select: { id: true, fullName: true, phone: true, status: true } }),
      this.prisma.workerProfile.findMany({
        where: { user: person(Role.WORKER) },
        orderBy: { createdAt: 'desc' },
        take: PER_KIND,
        select: { id: true, verificationStatus: true, user: { select: { fullName: true, phone: true } } },
      }),
      this.prisma.booking.findMany({
        where: { OR: [{ reference: { startsWith: q.toUpperCase() } }, { customer: { OR: [{ fullName: contains(q) }, { phone: { contains: q } }] } }, { worker: { user: { fullName: contains(q) } } }] },
        orderBy: { createdAt: 'desc' },
        take: PER_KIND,
        select: { id: true, reference: true, status: true, service: { select: { nameEn: true } }, customer: { select: { fullName: true } } },
      }),
      this.prisma.service.findMany({ where: { OR: [{ nameEn: contains(q) }, { nameAr: contains(q) }] }, take: PER_KIND, select: { id: true, nameEn: true, nameAr: true, category: { select: { nameEn: true } } } }),
      this.prisma.dispute.findMany({
        where: { OR: [{ booking: { reference: { startsWith: q.toUpperCase() } } }, { opener: { fullName: contains(q) } }] },
        orderBy: { createdAt: 'desc' },
        take: PER_KIND,
        select: { id: true, category: true, status: true, booking: { select: { reference: true } } },
      }),
    ]);
    const hits: SearchHit[] = [
      ...customers.map((c): SearchHit => ({ type: 'customer', id: c.id, title: c.fullName ?? 'Unnamed customer', subtitle: [maskPhone(c.phone), c.status.toLowerCase()].filter(Boolean).join(' · ') })),
      ...workers.map((w): SearchHit => ({ type: 'worker', id: w.id, title: w.user.fullName ?? 'Unnamed worker', subtitle: [maskPhone(w.user.phone), w.verificationStatus.toLowerCase().replace('_', ' ')].filter(Boolean).join(' · ') })),
      ...bookings.map((b): SearchHit => ({ type: 'booking', id: b.id, title: `${b.reference} · ${b.service.nameEn}`, subtitle: [b.customer.fullName, b.status.toLowerCase().replace('_', ' ')].filter(Boolean).join(' · ') })),
      ...services.map((s): SearchHit => ({ type: 'service', id: s.id, title: s.nameEn, subtitle: `${s.nameAr} · ${s.category.nameEn}` })),
      ...disputes.map((d): SearchHit => ({ type: 'dispute', id: d.id, title: `Dispute · ${d.booking.reference}`, subtitle: `${d.category.toLowerCase().replace('_', ' ')} · ${d.status.toLowerCase().replace('_', ' ')}` })),
    ];
    return { query: q, hits };
  }
}
