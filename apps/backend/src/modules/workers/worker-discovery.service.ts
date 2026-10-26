import { HttpStatus, Injectable } from '@nestjs/common';
import { ApiError } from '../../common/errors/api-error.js';
import { type Page, toPage } from '../../common/pagination/pagination.js';
import { PrismaService } from '../../database/prisma.service.js';
import { Prisma, UserStatus, WorkerVerificationStatus } from '../../generated/prisma/client.js';
import type { DiscoverWorkersQueryDto, PublicWorkerDto } from './dto/discovery.dto.js';

/** Only workers a customer may see: approved, account active, with at least one live service and city. */
const VISIBLE: Prisma.WorkerProfileWhereInput = {
  verificationStatus: WorkerVerificationStatus.APPROVED,
  user: { status: UserStatus.ACTIVE },
  services: { some: { service: { isActive: true, category: { isActive: true } } } },
  serviceAreas: { some: { city: { isActive: true } } },
};

const PUBLIC_INCLUDE = {
  user: { select: { fullName: true, fullNameAr: true } },
  services: {
    where: { service: { isActive: true, category: { isActive: true } } },
    include: { service: true },
  },
  serviceAreas: { where: { city: { isActive: true } }, include: { city: true } },
} satisfies Prisma.WorkerProfileInclude;

type PublicProfile = Prisma.WorkerProfileGetPayload<{ include: typeof PUBLIC_INCLUDE }>;

@Injectable()
export class WorkerDiscoveryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: DiscoverWorkersQueryDto): Promise<Page<PublicWorkerDto>> {
    const where: Prisma.WorkerProfileWhereInput = {
      AND: [
        VISIBLE,
        query.cityId ? { serviceAreas: { some: { cityId: query.cityId, city: { isActive: true } } } } : {},
        query.serviceId ? { services: { some: { serviceId: query.serviceId, service: { isActive: true } } } } : {},
        query.categoryId
          ? { services: { some: { service: { categoryId: query.categoryId, isActive: true } } } }
          : {},
        query.onlineOnly ? { isOnline: true } : {},
      ],
    };
    const [rows, total] = await Promise.all([
      this.prisma.workerProfile.findMany({
        where,
        include: PUBLIC_INCLUDE,
        orderBy: [{ isOnline: 'desc' }, { yearsOfExperience: { sort: 'desc', nulls: 'last' } }, { id: 'asc' }],
        skip: query.skip,
        take: query.limit,
      }),
      this.prisma.workerProfile.count({ where }),
    ]);
    return toPage(rows.map(toPublicWorker), total, query);
  }

  async get(workerProfileId: string): Promise<PublicWorkerDto> {
    const profile = await this.prisma.workerProfile.findFirst({
      where: { AND: [VISIBLE, { id: workerProfileId }] },
      include: PUBLIC_INCLUDE,
    });
    // Unapproved, suspended and unknown workers are indistinguishable from outside.
    if (!profile) throw new ApiError(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Worker not found');
    return toPublicWorker(profile);
  }
}

/** Allow-list mapper: no phone, email, account id, documents or verification data. */
function toPublicWorker(p: PublicProfile): PublicWorkerDto {
  return {
    id: p.id,
    fullName: p.user.fullName,
    fullNameAr: p.user.fullNameAr,
    bio: p.bio,
    yearsOfExperience: p.yearsOfExperience,
    isOnline: p.isOnline,
    services: p.services.map((ws) => ({
      id: ws.service.id,
      categoryId: ws.service.categoryId,
      slug: ws.service.slug,
      nameEn: ws.service.nameEn,
      nameAr: ws.service.nameAr,
      yearsOfExperience: ws.yearsOfExperience,
    })),
    cities: p.serviceAreas.map((a) => ({ id: a.city.id, slug: a.city.slug, nameEn: a.city.nameEn, nameAr: a.city.nameAr })),
  };
}
