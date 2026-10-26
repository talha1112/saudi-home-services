import { Reflector } from '@nestjs/core';
import { Role } from '../generated/prisma/client.js';
import { AdminAuthController } from '../modules/auth/admin/admin-auth.controller.js';
import { AuthController } from '../modules/auth/auth.controller.js';
import { AdminCatalogController, CatalogController } from '../modules/catalog/catalog.controllers.js';
import { AdminBookingsController, CustomerBookingsController, WorkerBookingsController } from '../modules/bookings/bookings.controllers.js';
import { HealthController } from '../modules/health/health.controller.js';
import { SimulationEnabledGuard } from '../modules/payments/payment-simulation.service.js';
import {
  AdminLedgerController,
  AdminPaymentsController,
  AdminRefundsController,
  BookingPaymentsController,
  DevPaymentSimulationController,
  MyPaymentsController,
  PaymentWebhookController,
} from '../modules/payments/payments.controllers.js';
import { AdminPricingController } from '../modules/pricing/pricing.module.js';
import { AdminAccountsController, AdminAuditController } from '../modules/admin/admin.controllers.js';
import { AdminDisputesController, DisputesController } from '../modules/disputes/disputes.module.js';
import { AdminReportsController } from '../modules/reports/reports.module.js';
import { AdminReviewsController, ReviewsController } from '../modules/reviews/reviews.module.js';
import { DevicesController, NotificationsController } from '../modules/notifications/notifications.controllers.js';
import { AdminOffersController, OffersController } from '../modules/offers/offers.module.js';
import { LocalStorageController } from '../modules/storage/adapters/local-storage.controller.js';
import { BookingChatController, BookingLocationController } from '../modules/realtime/realtime.controllers.js';
import { AdminUsersController, CustomersController, WorkersController } from '../modules/profiles/profiles.controllers.js';
import { AdminWorkersController, WorkerDiscoveryController, WorkerOnboardingController } from '../modules/workers/workers.controllers.js';
import { IS_PUBLIC_KEY } from './decorators/public.decorator.js';
import { ROLES_KEY } from './decorators/roles.decorator.js';

/**
 * Guards against the most common authorisation mistake: adding an endpoint and forgetting its
 * role. Reads the decorator metadata of every controller, so it fails the moment a new route is
 * added to one of these controllers without @Roles(...) / @Public().
 */
const reflector = new Reflector();

type Ctor = new (...args: never[]) => object;

function routes(controller: Ctor) {
  const proto = controller.prototype as Record<string, unknown>;
  return Object.getOwnPropertyNames(proto)
    .filter((name) => name !== 'constructor' && typeof proto[name] === 'function')
    .map((name) => ({ name, handler: proto[name] as object }))
    .filter(({ handler }) => Reflect.getMetadata('method', handler) !== undefined);
}

function rolesOf(controller: Ctor, handler: object): Role[] | undefined {
  return reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [handler as never, controller]);
}

function isPublic(controller: Ctor, handler: object): boolean {
  return Boolean(reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [handler as never, controller]));
}

const pathOf = (controller: Ctor): string => Reflect.getMetadata('path', controller) as string;

const ROLE_PROTECTED: Ctor[] = [
  CustomersController,
  WorkersController,
  AdminUsersController,
  AdminCatalogController,
  WorkerOnboardingController,
  WorkerDiscoveryController,
  AdminWorkersController,
  CustomerBookingsController,
  WorkerBookingsController,
  AdminBookingsController,
  AdminPricingController,
  BookingPaymentsController,
  MyPaymentsController,
  AdminPaymentsController,
  AdminRefundsController,
  AdminLedgerController,
  DevPaymentSimulationController,
  BookingChatController,
  BookingLocationController,
  NotificationsController,
  DevicesController,
  AdminOffersController,
  OffersController,
  AdminAccountsController,
  AdminAuditController,
  DisputesController,
  AdminDisputesController,
  ReviewsController,
  AdminReviewsController,
  AdminReportsController,
];

describe('authorization coverage of controllers', () => {
  it('finds routes (sanity check of the reflection helper)', () => {
    expect(routes(AdminWorkersController).length).toBeGreaterThan(8);
    expect(routes(WorkerOnboardingController).length).toBeGreaterThan(8);
  });

  it.each(ROLE_PROTECTED.map((c) => [c.name, c] as const))('%s: every route declares the roles allowed to call it', (_name, controller) => {
    for (const { name, handler } of routes(controller)) {
      const roles = rolesOf(controller, handler);
      expect({ route: `${controller.name}.${name}`, hasRoles: Boolean(roles && roles.length > 0) }).toEqual({
        route: `${controller.name}.${name}`,
        hasRoles: true,
      });
      expect(isPublic(controller, handler)).toBe(false);
    }
  });

  it.each(ROLE_PROTECTED.filter((c) => pathOf(c).startsWith('admin')).map((c) => [c.name, c] as const))(
    '%s lives under /admin and is reachable by administrators only',
    (_name, controller) => {
      for (const { name, handler } of routes(controller)) {
        expect({ route: name, roles: rolesOf(controller, handler) }).toEqual({ route: name, roles: [Role.ADMIN] });
      }
    },
  );

  it('keeps worker onboarding for the WORKER role only', () => {
    for (const { handler } of routes(WorkerOnboardingController)) {
      expect(rolesOf(WorkerOnboardingController, handler)).toEqual([Role.WORKER]);
    }
  });

  it('keeps worker discovery for customers and admins (not workers)', () => {
    for (const { handler } of routes(WorkerDiscoveryController)) {
      expect(rolesOf(WorkerDiscoveryController, handler)?.sort()).toEqual([Role.ADMIN, Role.CUSTOMER].sort());
    }
  });

  it('keeps booking chat for the two participants roles (no administrators) and the worker position for customers only', () => {
    for (const { handler } of routes(BookingChatController)) {
      expect(rolesOf(BookingChatController, handler)?.sort()).toEqual([Role.CUSTOMER, Role.WORKER].sort());
    }
    for (const { handler } of routes(BookingLocationController)) {
      expect(rolesOf(BookingLocationController, handler)).toEqual([Role.CUSTOMER]);
    }
  });

  it('makes only the intended routes public', () => {
    const publicRoutes = [AuthController, AdminAuthController, CatalogController, HealthController, PaymentWebhookController, LocalStorageController].flatMap((c) =>
      routes(c)
        .filter(({ handler }) => isPublic(c, handler))
        .map(({ name }) => `${c.name}.${name}`),
    );
    expect(publicRoutes.sort()).toEqual(
      [
        'AdminAuthController.login',
        'AuthController.firebasePhone',
        'AuthController.logout',
        'AuthController.refresh',
        'AuthController.requestOtp',
        'AuthController.verifyOtp',
        'CatalogController.cities',
        'CatalogController.list',
        'HealthController.check',
        'HealthController.ready',
        // Only answer while DOCUMENT_STORAGE=local (never in production); their sole credential is the HMAC signature in the URL.
        'LocalStorageController.download',
        'LocalStorageController.upload',
        'PaymentWebhookController.receive',
      ].sort(),
    );
  });

  it('exposes no admin path outside the admin controllers', () => {
    const adminPaths = [...ROLE_PROTECTED, AuthController, AdminAuthController, CatalogController, HealthController]
      .filter((c) => pathOf(c).startsWith('admin'))
      .map((c) => c.name)
      .sort();
    expect(adminPaths).toEqual([
      'AdminAccountsController',
      'AdminAuditController',
      'AdminBookingsController',
      'AdminCatalogController',
      'AdminDisputesController',
      'AdminLedgerController',
      'AdminOffersController',
      'AdminPaymentsController',
      'AdminPricingController',
      'AdminRefundsController',
      'AdminReportsController',
      'AdminReviewsController',
      'AdminUsersController',
      'AdminWorkersController',
    ]);
  });

  it('keeps booking creation and quote acceptance for customers, quoting for approved workers', () => {
    for (const { handler } of routes(CustomerBookingsController)) expect(rolesOf(CustomerBookingsController, handler)).toEqual([Role.CUSTOMER]);
    for (const { handler } of routes(WorkerBookingsController)) expect(rolesOf(WorkerBookingsController, handler)).toEqual([Role.WORKER]);
  });

  it('puts the approved-worker guard on every worker booking route', () => {
    const guards = Reflect.getMetadata('__guards__', WorkerBookingsController) as unknown[] | undefined;
    expect(guards?.map((g) => (g as { name: string }).name)).toContain('ApprovedWorkerGuard');
  });

  it('exposes no HTTP route that can mark a booking as paid', () => {
    const all = [CustomerBookingsController, WorkerBookingsController, AdminBookingsController, AdminPricingController];
    for (const controller of all) {
      for (const { name } of routes(controller)) expect(name).not.toMatch(/payment|paid|confirmPayment|pay$/i);
    }
  });

  it('keeps starting and listing payments for customers, and everything else about money for administrators', () => {
    for (const c of [BookingPaymentsController, MyPaymentsController]) {
      for (const { handler } of routes(c)) expect(rolesOf(c, handler)).toEqual([Role.CUSTOMER]);
    }
    for (const c of [AdminPaymentsController, AdminRefundsController, AdminLedgerController, DevPaymentSimulationController]) {
      for (const { handler } of routes(c)) expect(rolesOf(c, handler)).toEqual([Role.ADMIN]);
    }
  });

  it('exposes no HTTP route that creates, edits or deletes ledger entries', () => {
    const methods = routes(AdminLedgerController).map(({ handler }) => Reflect.getMetadata('method', handler));
    expect(methods).toEqual([0]); // RequestMethod.GET only
  });

  it('guards the development simulation route and gives the webhook route no authentication but a rate limit', () => {
    const guards = Reflect.getMetadata('__guards__', DevPaymentSimulationController) as unknown[];
    expect(guards).toContain(SimulationEnabledGuard);
    expect(isPublic(PaymentWebhookController, PaymentWebhookController.prototype.receive)).toBe(true);
    expect(Reflect.getMetadata('auth:rate-limit', PaymentWebhookController)).toMatchObject({ name: 'payment-webhook' });
  });

  it('offers payment endpoints that cannot mark anything paid directly', () => {
    for (const c of [BookingPaymentsController, MyPaymentsController, AdminPaymentsController, AdminRefundsController]) {
      for (const { name } of routes(c)) expect(name).not.toMatch(/markPaid|setPaid|succeed|confirmPayment|capture/i);
    }
  });
});
