import { HttpStatus, Injectable } from '@nestjs/common';
import { ApiError, badRequest, unavailable } from '../../common/errors/api-error.js';
import { type Page, PageQueryDto, toPage } from '../../common/pagination/pagination.js';
import { PrismaService } from '../../database/prisma.service.js';
import { AuditService } from '../auth/audit.service.js';
import type { CreatePricingSettingDto, PricingSettingDto } from './dto/pricing.dto.js';

const toDto = (p: {
  id: string;
  vatRateBps: number;
  commissionRateBps: number;
  minServiceChargeHalalas: number;
  isProvisional: boolean;
  note: string | null;
  effectiveFrom: Date;
  createdAt: Date;
}): PricingSettingDto => ({
  id: p.id,
  vatRateBps: p.vatRateBps,
  commissionRateBps: p.commissionRateBps,
  minServiceChargeHalalas: p.minServiceChargeHalalas,
  isProvisional: p.isProvisional,
  note: p.note,
  effectiveFrom: p.effectiveFrom.toISOString(),
  createdAt: p.createdAt.toISOString(),
});

/** VAT, commission and the minimum service charge: versioned business settings, never hard-coded. */
@Injectable()
export class PricingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** The setting in force right now. 503 when the business has not configured any yet. */
  async current(now: Date = new Date()) {
    const setting = await this.prisma.pricingSetting.findFirst({
      where: { effectiveFrom: { lte: now } },
      orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
    });
    if (!setting) {
      throw unavailable('PRICING_NOT_CONFIGURED', 'Pricing has not been configured yet');
    }
    return setting;
  }

  async currentDto(): Promise<PricingSettingDto> {
    return toDto(await this.current());
  }

  async list(query: PageQueryDto): Promise<Page<PricingSettingDto>> {
    const [rows, total] = await Promise.all([
      this.prisma.pricingSetting.findMany({
        orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.pricingSetting.count(),
    ]);
    return toPage(rows.map(toDto), total, query);
  }

  /** Appends a new version. Old versions and the quotes that used them are never changed. */
  async create(dto: CreatePricingSettingDto, adminId: string): Promise<PricingSettingDto> {
    const effectiveFrom = dto.effectiveFrom ? new Date(dto.effectiveFrom) : new Date();
    if (effectiveFrom.getTime() < Date.now() - 60_000) {
      throw badRequest('EFFECTIVE_IN_PAST', 'A pricing change cannot be backdated');
    }
    const created = await this.prisma.pricingSetting.create({
      data: {
        vatRateBps: dto.vatRateBps,
        commissionRateBps: dto.commissionRateBps,
        minServiceChargeHalalas: dto.minServiceChargeHalalas,
        isProvisional: false,
        note: dto.note ?? null,
        effectiveFrom,
        createdById: adminId,
      },
    });
    await this.audit.record({
      action: 'pricing.setting.created',
      actorUserId: adminId,
      entityType: 'pricing_setting',
      entityId: created.id,
      metadata: {
        vatRateBps: created.vatRateBps,
        commissionRateBps: created.commissionRateBps,
        minServiceChargeHalalas: created.minServiceChargeHalalas,
      },
    });
    return toDto(created);
  }
}

export const pricingNotFound = () => new ApiError(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Pricing setting not found');
