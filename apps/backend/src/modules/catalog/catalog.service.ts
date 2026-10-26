import { HttpStatus, Injectable } from '@nestjs/common';
import { ApiError } from '../../common/errors/api-error.js';
import { type Page, toPage } from '../../common/pagination/pagination.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../auth/audit.service.js';
import type {
  CatalogDto,
  CityDto,
  CreateCategoryDto,
  CreateCityDto,
  CreateServiceDto,
  ListCategoriesQueryDto,
  ListCitiesQueryDto,
  ListServicesQueryDto,
  ServiceCategoryDto,
  ServiceDto,
  UpdateCategoryDto,
  UpdateCityDto,
  UpdateServiceDto,
} from './dto/catalog.dto.js';

const notFound = (what: string) => new ApiError(HttpStatus.NOT_FOUND, 'NOT_FOUND', `${what} not found`);
const slugTaken = () => new ApiError(HttpStatus.CONFLICT, 'SLUG_TAKEN', 'That slug is already in use');

const BY_ORDER = [{ sortOrder: 'asc' as const }, { nameEn: 'asc' as const }];

export const toCityDto = (c: CityDto): CityDto => ({
  id: c.id,
  slug: c.slug,
  nameEn: c.nameEn,
  nameAr: c.nameAr,
  isActive: c.isActive,
  sortOrder: c.sortOrder,
});

export const toServiceDto = (s: ServiceDto): ServiceDto => ({
  id: s.id,
  categoryId: s.categoryId,
  slug: s.slug,
  nameEn: s.nameEn,
  nameAr: s.nameAr,
  descriptionEn: s.descriptionEn,
  descriptionAr: s.descriptionAr,
  isActive: s.isActive,
  sortOrder: s.sortOrder,
});

export const toCategoryDto = (c: ServiceCategoryDto): ServiceCategoryDto => ({
  id: c.id,
  slug: c.slug,
  nameEn: c.nameEn,
  nameAr: c.nameAr,
  descriptionEn: c.descriptionEn,
  descriptionAr: c.descriptionAr,
  iconKey: c.iconKey,
  isActive: c.isActive,
  sortOrder: c.sortOrder,
});

function textSearch(q: string | undefined, fields: string[]) {
  if (!q) return {};
  return { OR: fields.map((f) => ({ [f]: { contains: q, mode: 'insensitive' as const } })) };
}

/** Catalog reads for the apps, plus admin management of categories, services and launch cities. */
@Injectable()
export class CatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ------------------------------------------------------------ public reads

  /** Active categories with their active services, in display order. */
  async publicCatalog(): Promise<CatalogDto> {
    const categories = await this.prisma.serviceCategory.findMany({
      where: { isActive: true },
      orderBy: BY_ORDER,
      include: { services: { where: { isActive: true }, orderBy: BY_ORDER } },
    });
    return {
      categories: categories.map((c) => ({ ...toCategoryDto(c), services: c.services.map(toServiceDto) })),
    };
  }

  async publicCities(): Promise<{ items: CityDto[] }> {
    const cities = await this.prisma.city.findMany({ where: { isActive: true }, orderBy: BY_ORDER });
    return { items: cities.map(toCityDto) };
  }

  // ------------------------------------------------------------------ cities

  async listCities(query: ListCitiesQueryDto): Promise<Page<CityDto>> {
    const where: Prisma.CityWhereInput = {
      ...(query.isActive === undefined ? {} : { isActive: query.isActive }),
      ...textSearch(query.q, ['slug', 'nameEn', 'nameAr']),
    };
    const [rows, total] = await Promise.all([
      this.prisma.city.findMany({ where, orderBy: BY_ORDER, skip: query.skip, take: query.limit }),
      this.prisma.city.count({ where }),
    ]);
    return toPage(rows.map(toCityDto), total, query);
  }

  async getCity(id: string): Promise<CityDto> {
    const city = await this.prisma.city.findUnique({ where: { id } });
    if (!city) throw notFound('City');
    return toCityDto(city);
  }

  async createCity(dto: CreateCityDto, actorId: string): Promise<CityDto> {
    const city = await this.guardSlug(() => this.prisma.city.create({ data: dto }));
    await this.record('catalog.city.created', actorId, 'city', city.id, { slug: city.slug });
    return toCityDto(city);
  }

  async updateCity(id: string, dto: UpdateCityDto, actorId: string): Promise<CityDto> {
    await this.getCity(id);
    const city = await this.prisma.city.update({ where: { id }, data: dto });
    await this.record('catalog.city.updated', actorId, 'city', id, { fields: Object.keys(dto).join(',') });
    return toCityDto(city);
  }

  // -------------------------------------------------------------- categories

  async listCategories(query: ListCategoriesQueryDto): Promise<Page<ServiceCategoryDto>> {
    const where: Prisma.ServiceCategoryWhereInput = {
      ...(query.isActive === undefined ? {} : { isActive: query.isActive }),
      ...textSearch(query.q, ['slug', 'nameEn', 'nameAr']),
    };
    const [rows, total] = await Promise.all([
      this.prisma.serviceCategory.findMany({ where, orderBy: BY_ORDER, skip: query.skip, take: query.limit }),
      this.prisma.serviceCategory.count({ where }),
    ]);
    return toPage(rows.map(toCategoryDto), total, query);
  }

  async getCategory(id: string): Promise<ServiceCategoryDto> {
    const category = await this.prisma.serviceCategory.findUnique({ where: { id } });
    if (!category) throw notFound('Service category');
    return toCategoryDto(category);
  }

  async createCategory(dto: CreateCategoryDto, actorId: string): Promise<ServiceCategoryDto> {
    const category = await this.guardSlug(() => this.prisma.serviceCategory.create({ data: dto }));
    await this.record('catalog.category.created', actorId, 'service_category', category.id, { slug: category.slug });
    return toCategoryDto(category);
  }

  async updateCategory(id: string, dto: UpdateCategoryDto, actorId: string): Promise<ServiceCategoryDto> {
    await this.getCategory(id);
    const category = await this.prisma.serviceCategory.update({ where: { id }, data: dto });
    await this.record('catalog.category.updated', actorId, 'service_category', id, { fields: Object.keys(dto).join(',') });
    return toCategoryDto(category);
  }

  // ---------------------------------------------------------------- services

  async listServices(query: ListServicesQueryDto): Promise<Page<ServiceDto>> {
    const where: Prisma.ServiceWhereInput = {
      ...(query.isActive === undefined ? {} : { isActive: query.isActive }),
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
      ...textSearch(query.q, ['slug', 'nameEn', 'nameAr']),
    };
    const [rows, total] = await Promise.all([
      this.prisma.service.findMany({ where, orderBy: BY_ORDER, skip: query.skip, take: query.limit }),
      this.prisma.service.count({ where }),
    ]);
    return toPage(rows.map(toServiceDto), total, query);
  }

  async getService(id: string): Promise<ServiceDto> {
    const service = await this.prisma.service.findUnique({ where: { id } });
    if (!service) throw notFound('Service');
    return toServiceDto(service);
  }

  async createService(dto: CreateServiceDto, actorId: string): Promise<ServiceDto> {
    await this.getCategory(dto.categoryId);
    const service = await this.guardSlug(() => this.prisma.service.create({ data: dto }));
    await this.record('catalog.service.created', actorId, 'service', service.id, { slug: service.slug });
    return toServiceDto(service);
  }

  async updateService(id: string, dto: UpdateServiceDto, actorId: string): Promise<ServiceDto> {
    await this.getService(id);
    if (dto.categoryId) await this.getCategory(dto.categoryId);
    const service = await this.prisma.service.update({ where: { id }, data: dto });
    await this.record('catalog.service.updated', actorId, 'service', id, { fields: Object.keys(dto).join(',') });
    return toServiceDto(service);
  }

  // ----------------------------------------------------------------- helpers

  /** Turns a unique-slug violation into a clean 409. */
  private async guardSlug<T>(create: () => Promise<T>): Promise<T> {
    try {
      return await create();
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') throw slugTaken();
      throw err;
    }
  }

  private record(action: string, actorId: string, entityType: string, entityId: string, metadata: Record<string, string>) {
    return this.audit.record({ action, actorUserId: actorId, entityType, entityId, metadata });
  }
}
