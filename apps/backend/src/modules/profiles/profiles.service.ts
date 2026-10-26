import { HttpStatus, Injectable } from '@nestjs/common';
import { ApiError } from '../../common/errors/api-error.js';
import { PrismaService } from '../../database/prisma.service.js';
import type { AdminUserSummaryDto, CustomerProfileDto, WorkerProfileDto } from './profiles.dto.js';

const notFound = (what: string) => new ApiError(HttpStatus.NOT_FOUND, 'NOT_FOUND', `${what} not found`);

/** Read models that hand out explicit fields only (never password hashes or token data). */
@Injectable()
export class ProfilesService {
  constructor(private readonly prisma: PrismaService) {}

  async customerProfile(userId: string): Promise<CustomerProfileDto> {
    const profile = await this.prisma.customerProfile.findUnique({
      where: { userId },
      include: { user: { select: { fullName: true } } },
    });
    if (!profile) throw notFound('Customer profile');
    return {
      userId,
      fullName: profile.user.fullName,
      marketingOptIn: profile.marketingOptIn,
      createdAt: profile.createdAt.toISOString(),
    };
  }

  /** The customer sets or corrects their own name. Nothing else about the account changes here. */
  async updateCustomerName(userId: string, fullName: string): Promise<CustomerProfileDto> {
    await this.prisma.user.update({ where: { id: userId }, data: { fullName } });
    return this.customerProfile(userId);
  }

  async workerProfile(userId: string): Promise<WorkerProfileDto> {
    const profile = await this.prisma.workerProfile.findUnique({
      where: { userId },
      include: { user: { select: { fullName: true } } },
    });
    if (!profile) throw notFound('Worker profile');
    return {
      userId,
      fullName: profile.user.fullName,
      bio: profile.bio,
      yearsOfExperience: profile.yearsOfExperience,
      verificationStatus: profile.verificationStatus,
      verificationNote: profile.verificationNote,
      isOnline: profile.isOnline,
      acceptsUrgentJobs: profile.acceptsUrgentJobs,
    };
  }

  async adminUserSummary(userId: string): Promise<AdminUserSummaryDto> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { roles: true, workerProfile: { select: { verificationStatus: true } } },
    });
    if (!user) throw notFound('User');
    return {
      id: user.id,
      phone: user.phone,
      email: user.email,
      fullName: user.fullName,
      locale: user.locale,
      status: user.status,
      roles: user.roles.map((r) => r.role),
      workerVerificationStatus: user.workerProfile?.verificationStatus,
      createdAt: user.createdAt.toISOString(),
      lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    };
  }
}
