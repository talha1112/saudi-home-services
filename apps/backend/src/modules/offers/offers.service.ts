import { HttpStatus, Injectable } from '@nestjs/common';
import type { AuthenticatedUser } from '../../common/auth/authenticated-user.js';
import { ApiError, badRequest } from '../../common/errors/api-error.js';
import { type LocalizedPair, parseLocale, pickLocalized } from '../../common/i18n/localize.js';
import { type Page, toPage } from '../../common/pagination/pagination.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { Locale, Offer, OfferStatus, Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../auth/audit.service.js';
import type { AdminListOffersQueryDto, CreateOfferDto, ListOffersQueryDto, UpdateOfferDto } from './offers.dto.js';

export type OfferPhase = 'DRAFT' | 'SCHEDULED' | 'LIVE' | 'EXPIRED' | 'PAUSED' | 'ARCHIVED';

/** What the status means at `now`. EXPIRED is derived from the end time: nothing has to run for an offer to stop. */
export function offerPhase(o: { status: OfferStatus; startsAt: Date; endsAt: Date }, now: Date): OfferPhase {
  if (o.status !== 'PUBLISHED') return o.status;
  if (o.endsAt.getTime() <= now.getTime()) return 'EXPIRED';
  if (o.startsAt.getTime() > now.getTime()) return 'SCHEDULED';
  return 'LIVE';
}

type Action = 'publish' | 'pause' | 'archive';
const TRANSITIONS: Record<Action, { from: OfferStatus[]; to: OfferStatus }> = {
  publish: { from: ['DRAFT', 'PAUSED'], to: 'PUBLISHED' },
  pause: { from: ['PUBLISHED'], to: 'PAUSED' },
  archive: { from: ['DRAFT', 'PUBLISHED', 'PAUSED'], to: 'ARCHIVED' },
};

const conflict = (code: string, message: string, details?: Record<string, unknown>) => new ApiError(HttpStatus.CONFLICT, code, message, details ? { details } : {});
const notFound = () => new ApiError(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Offer not found');

const blank = (v: string | null | undefined) => (v === undefined ? undefined : v === null || v.trim() === '' ? null : v.trim());

/**
 * Admin-managed offers and read-only eligibility listing.
 *
 * An offer here is an ANNOUNCEMENT: text, audience, a time window and optional city/service eligibility. It carries no
 * discount, price or redemption data and nothing in this module touches bookings, payments or the ledger. Financial
 * redemption is deliberately not implemented: the discount model, who funds it, VAT treatment and the interaction with
 * the platform commission have not been approved (see docs/STORAGE_NOTIFICATIONS_OFFERS.md).
 */
@Injectable()
export class OffersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Offer changes are administrative actions: they go to the shared audit log as well as the offer's own history. */
  private auditAction(admin: AuthenticatedUser, action: string, offerId: string, metadata: Record<string, string | number | boolean | null> = {}) {
    return this.audit.record({ action: `offer.${action}`, actorUserId: admin.id, entityType: 'offer', entityId: offerId, metadata });
  }

  // ---------------------------------------------------------------------------------- admin

  async create(admin: AuthenticatedUser, dto: CreateOfferDto) {
    const data = await this.validated({ ...dto, startsAt: new Date(dto.startsAt), endsAt: new Date(dto.endsAt) });
    const offer = await this.prisma.$transaction(async (tx) => {
      const created = await tx.offer.create({ data: { ...data, createdById: admin.id, updatedById: admin.id } as Prisma.OfferUncheckedCreateInput });
      await tx.offerEvent.create({ data: { offerId: created.id, action: 'CREATED', toStatus: 'DRAFT', actorUserId: admin.id } });
      return created;
    });
    await this.auditAction(admin, 'created', offer.id, { audience: offer.audience });
    return this.adminView(offer);
  }

  async update(admin: AuthenticatedUser, id: string, dto: UpdateOfferDto) {
    const view = await this.prisma.$transaction(async (tx) => {
      const current = await tx.offer.findUnique({ where: { id } });
      if (!current) throw notFound();
      if (current.status !== 'DRAFT' && current.status !== 'PAUSED') {
        throw conflict('INVALID_STATE', 'Pause the offer before editing it', { status: current.status });
      }
      const merged = await this.validated({
        audience: dto.audience ?? current.audience,
        titleAr: dto.titleAr !== undefined ? blank(dto.titleAr) : current.titleAr,
        titleEn: dto.titleEn !== undefined ? blank(dto.titleEn) : current.titleEn,
        descriptionAr: dto.descriptionAr !== undefined ? blank(dto.descriptionAr) : current.descriptionAr,
        descriptionEn: dto.descriptionEn !== undefined ? blank(dto.descriptionEn) : current.descriptionEn,
        termsAr: dto.termsAr !== undefined ? blank(dto.termsAr) : current.termsAr,
        termsEn: dto.termsEn !== undefined ? blank(dto.termsEn) : current.termsEn,
        startsAt: dto.startsAt ? new Date(dto.startsAt) : current.startsAt,
        endsAt: dto.endsAt ? new Date(dto.endsAt) : current.endsAt,
        cityId: dto.cityId !== undefined ? dto.cityId : current.cityId,
        serviceId: dto.serviceId !== undefined ? dto.serviceId : current.serviceId,
      });
      // The status is part of the UPDATE: an offer published a moment ago cannot be edited by a stale request.
      const moved = await tx.offer.updateMany({ where: { id, status: current.status }, data: { ...merged, updatedById: admin.id } });
      if (moved.count !== 1) throw conflict('INVALID_STATE', 'The offer was changed by someone else, please reload');
      await tx.offerEvent.create({ data: { offerId: id, action: 'UPDATED', actorUserId: admin.id } });
      return this.adminView(await tx.offer.findUniqueOrThrow({ where: { id } }));
    });
    await this.auditAction(admin, 'updated', id);
    return view;
  }

  async transition(admin: AuthenticatedUser, id: string, action: Action, now: Date = new Date()) {
    const rule = TRANSITIONS[action];
    const view = await this.prisma.$transaction(async (tx) => {
      const current = await tx.offer.findUnique({ where: { id } });
      if (!current) throw notFound();
      if (!rule.from.includes(current.status)) {
        throw conflict('INVALID_STATE', `Cannot ${action} an offer whose status is ${current.status}`, { status: current.status, allowedFrom: rule.from });
      }
      if (action === 'publish') {
        if (current.endsAt.getTime() <= now.getTime()) throw conflict('OFFER_ALREADY_ENDED', 'The offer has already ended; change its end time first');
        const hasText = Boolean((current.titleAr ?? current.titleEn) && (current.descriptionAr ?? current.descriptionEn));
        if (!hasText) throw conflict('OFFER_INCOMPLETE', 'A title and a description (in at least one language) are required to publish');
      }
      const moved = await tx.offer.updateMany({
        where: { id, status: { in: rule.from } },
        data: { status: rule.to, updatedById: admin.id, ...(action === 'publish' && !current.publishedAt ? { publishedAt: now } : {}) },
      });
      if (moved.count !== 1) throw conflict('INVALID_STATE', 'The offer was changed by someone else, please reload');
      await tx.offerEvent.create({ data: { offerId: id, action: action.toUpperCase(), fromStatus: current.status, toStatus: rule.to, actorUserId: admin.id } });
      return this.adminView(await tx.offer.findUniqueOrThrow({ where: { id } }));
    });
    await this.auditAction(admin, action, id, { beforeStatus: rule.from.join('|'), afterStatus: rule.to });
    return view;
  }

  async adminList(q: AdminListOffersQueryDto, now: Date = new Date()): Promise<Page<ReturnType<OffersService['adminView']>>> {
    const phase: Prisma.OfferWhereInput =
      q.phase === 'ACTIVE' ? { status: 'PUBLISHED', startsAt: { lte: now }, endsAt: { gt: now } } : q.phase === 'SCHEDULED' ? { status: 'PUBLISHED', startsAt: { gt: now } } : q.phase === 'EXPIRED' ? { status: 'PUBLISHED', endsAt: { lte: now } } : {};
    const where: Prisma.OfferWhereInput = {
      ...phase,
      ...(q.status ? { status: q.status } : {}),
      ...(q.audience ? { audience: q.audience } : {}),
      ...(q.q ? { OR: [{ titleEn: { contains: q.q, mode: 'insensitive' } }, { titleAr: { contains: q.q } }] } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.offer.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: q.skip, take: q.limit }),
      this.prisma.offer.count({ where }),
    ]);
    return toPage(rows.map((r) => this.adminView(r, now)), total, q);
  }

  async adminGet(id: string, now: Date = new Date()) {
    const offer = await this.prisma.offer.findUnique({ where: { id }, include: { events: { orderBy: { createdAt: 'asc' } } } });
    if (!offer) throw notFound();
    return {
      ...this.adminView(offer, now),
      history: offer.events.map((e) => ({ action: e.action, fromStatus: e.fromStatus, toStatus: e.toStatus, actorUserId: e.actorUserId, createdAt: e.createdAt.toISOString() })),
    };
  }

  // ---------------------------------------------------------------------------------- people (read-only)

  /**
   * Offers the caller may see right now. The audience comes from the caller's acting role in the token, never from the
   * request. For workers, city and service restrictions are checked against what the worker actually serves; for
   * customers the optional cityId/serviceId only NARROW the list (the server does not know where a customer will book).
   */
  async listEligible(user: AuthenticatedUser, q: ListOffersQueryDto, now: Date = new Date()) {
    const base: Prisma.OfferWhereInput = {
      status: 'PUBLISHED',
      startsAt: { lte: now },
      endsAt: { gt: now },
      audience: { in: user.role === 'WORKER' ? ['WORKERS', 'ALL'] : ['CUSTOMERS', 'ALL'] },
    };
    const and: Prisma.OfferWhereInput[] = [];

    if (user.role === 'WORKER') {
      const worker = await this.prisma.workerProfile.findUnique({
        where: { userId: user.id },
        select: { serviceAreas: { select: { cityId: true } }, services: { select: { serviceId: true } } },
      });
      const cities = worker?.serviceAreas.map((a) => a.cityId) ?? [];
      const services = worker?.services.map((s) => s.serviceId) ?? [];
      and.push({ OR: [{ cityId: null }, { cityId: { in: cities } }] }, { OR: [{ serviceId: null }, { serviceId: { in: services } }] });
    }
    if (q.cityId) and.push({ OR: [{ cityId: null }, { cityId: q.cityId }] });
    if (q.serviceId) and.push({ OR: [{ serviceId: null }, { serviceId: q.serviceId }] });

    const where: Prisma.OfferWhereInput = and.length ? { AND: [base, ...and] } : base;
    const [rows, total, locale] = await Promise.all([
      this.prisma.offer.findMany({ where, orderBy: [{ startsAt: 'desc' }, { id: 'desc' }], skip: q.skip, take: q.limit }),
      this.prisma.offer.count({ where }),
      this.localeOf(user.id, q.locale),
    ]);
    return toPage(rows.map((r) => this.publicView(r, locale)), total, q);
  }

  // ---------------------------------------------------------------------------------- helpers

  private async validated(v: {
    audience: Offer['audience'];
    titleAr?: string | null; titleEn?: string | null;
    descriptionAr?: string | null; descriptionEn?: string | null;
    termsAr?: string | null; termsEn?: string | null;
    startsAt: Date; endsAt: Date;
    cityId?: string | null; serviceId?: string | null;
  }) {
    if (Number.isNaN(v.startsAt.getTime()) || Number.isNaN(v.endsAt.getTime())) throw badRequest('INVALID_WINDOW', 'startsAt and endsAt must be valid times');
    if (v.endsAt.getTime() <= v.startsAt.getTime()) throw badRequest('INVALID_WINDOW', 'endsAt must be after startsAt');
    const clean = {
      audience: v.audience,
      titleAr: blank(v.titleAr) ?? null, titleEn: blank(v.titleEn) ?? null,
      descriptionAr: blank(v.descriptionAr) ?? null, descriptionEn: blank(v.descriptionEn) ?? null,
      termsAr: blank(v.termsAr) ?? null, termsEn: blank(v.termsEn) ?? null,
      startsAt: v.startsAt, endsAt: v.endsAt,
      cityId: v.cityId ?? null, serviceId: v.serviceId ?? null,
    };
    if (!clean.titleAr && !clean.titleEn) throw badRequest('TITLE_REQUIRED', 'Give the offer a title in Arabic, English or both');
    if (clean.cityId && !(await this.prisma.city.findUnique({ where: { id: clean.cityId }, select: { id: true } }))) throw badRequest('CITY_NOT_FOUND', 'Unknown city');
    if (clean.serviceId && !(await this.prisma.service.findUnique({ where: { id: clean.serviceId }, select: { id: true } }))) throw badRequest('SERVICE_NOT_FOUND', 'Unknown service');
    return clean;
  }

  private async localeOf(userId: string, override?: string): Promise<Locale> {
    const explicit = parseLocale(override);
    if (explicit) return explicit;
    return (await this.prisma.user.findUnique({ where: { id: userId }, select: { locale: true } }))?.locale ?? 'AR';
  }

  private adminView(o: Offer, now: Date = new Date()) {
    return {
      id: o.id, status: o.status, phase: offerPhase(o, now), audience: o.audience,
      titleAr: o.titleAr, titleEn: o.titleEn, descriptionAr: o.descriptionAr, descriptionEn: o.descriptionEn, termsAr: o.termsAr, termsEn: o.termsEn,
      startsAt: o.startsAt.toISOString(), endsAt: o.endsAt.toISOString(), cityId: o.cityId, serviceId: o.serviceId,
      publishedAt: o.publishedAt?.toISOString() ?? null, createdAt: o.createdAt.toISOString(), updatedAt: o.updatedAt.toISOString(),
      /** Always false in this phase: see the class comment. */
      redemptionEnabled: false,
    };
  }

  private publicView(o: Offer, locale: Locale) {
    const pick = (pair: LocalizedPair) => pickLocalized(locale, pair);
    const title = pick({ ar: o.titleAr, en: o.titleEn });
    return {
      id: o.id,
      title: title.text,
      description: pick({ ar: o.descriptionAr, en: o.descriptionEn }).text,
      terms: pick({ ar: o.termsAr, en: o.termsEn }).text,
      /** The language the title was actually rendered in (differs from the requested one when a translation is missing). */
      locale: title.locale,
      startsAt: o.startsAt.toISOString(),
      endsAt: o.endsAt.toISOString(),
      cityId: o.cityId,
      serviceId: o.serviceId,
    };
  }
}
