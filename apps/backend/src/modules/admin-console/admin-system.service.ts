import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_CONFIG, type AppConfig } from '../../config/app.config.js';
import { PrismaService } from '../../database/prisma.service.js';
import { Role } from '../../generated/prisma/client.js';

/**
 * Read-only facts for the settings screen: who the administrators are and how this deployment is configured. Only non-secret facts are
 * returned (modes and limits, never a key, URL with credentials or token).
 */
@Injectable()
export class AdminSystemService {
  private readonly cfg: AppConfig;

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.cfg = config.getOrThrow<AppConfig>(APP_CONFIG);
  }

  async admins() {
    const rows = await this.prisma.user.findMany({
      where: { roles: { some: { role: Role.ADMIN } } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, fullName: true, email: true, status: true, lastLoginAt: true, createdAt: true, mustChangePassword: true },
    });
    return rows.map((u) => ({
      id: u.id,
      fullName: u.fullName,
      email: u.email,
      status: u.status,
      mustChangePassword: u.mustChangePassword,
      lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
      createdAt: u.createdAt.toISOString(),
    }));
  }

  async overview() {
    const c = this.cfg;
    const [cities, categories, services, openRequests] = await Promise.all([
      this.prisma.city.findMany({ orderBy: [{ sortOrder: 'asc' }, { nameEn: 'asc' }], select: { id: true, slug: true, nameEn: true, nameAr: true, isActive: true } }),
      this.prisma.serviceCategory.count(),
      this.prisma.service.count({ where: { isActive: true } }),
      this.prisma.booking.count({ where: { status: 'OPEN' } }),
    ]);
    return {
      environment: c.env,
      cities,
      catalog: { categories, activeServices: services },
      bookings: {
        requestTtlHours: c.bookings.requestTtlHours,
        minLeadMinutes: c.bookings.minLeadMinutes,
        maxOpenPerCustomer: c.bookings.maxOpenPerCustomer,
        maxQuotesPerBooking: c.bookings.maxQuotesPerBooking,
        quoteDefaultValidityHours: c.bookings.quoteDefaultValidityHours,
        quoteMaxValidityHours: c.bookings.quoteMaxValidityHours,
        quoteMaxPriceHalalas: c.bookings.quoteMaxPriceHalalas,
        paymentWindowMinutes: c.bookings.paymentWindowMinutes,
        openRequestsNow: openRequests,
      },
      payments: { onlineProvider: c.payments.provider, cashOnDelivery: true, checkoutTtlMinutes: c.payments.checkoutTtlMinutes },
      notifications: { pushProvider: c.notifications.pushProvider, fcmEnabled: c.firebase.fcm.enabled, fcmDryRun: c.firebase.fcm.dryRun, maxDevicesPerUser: c.notifications.maxDevicesPerUser },
      signIn: { phoneSmsProvider: c.auth.smsProvider, firebasePhoneAuth: c.firebase.auth.enabled, defaultPhoneRegion: c.auth.defaultPhoneRegion },
      workers: { requireIdentityDocument: c.workers.requireIdentityDocument },
      realtime: { enabled: c.realtime.enabled },
    };
  }
}
