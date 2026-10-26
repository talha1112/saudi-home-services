import { randomUUID } from 'node:crypto';
import { CanActivate, HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiError } from '../../common/errors/api-error.js';
import { APP_CONFIG, type AppConfig } from '../../config/app.config.js';
import { PaymentProviderName } from '../../config/env.validation.js';
import { PrismaService } from '../../database/prisma.service.js';
import { AuditService } from '../auth/audit.service.js';
import type { ClientMeta } from '../auth/auth.types.js';
import { conflict, notFound } from '../bookings/booking-support.js';
import type { SimulatePaymentDto } from './dto/payments.dto.js';
import { type EventResult, PaymentEventsService } from './payment-events.service.js';
import type { ProviderEventKind } from './payment-state.js';
import type { NormalizedPaymentEvent } from './provider/payment-provider.js';

const NOT_FOUND = () => new ApiError(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Not found');

/** The simulation routes exist only while the mock provider is active outside production; otherwise they answer 404. */
@Injectable()
export class SimulationEnabledGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(): boolean {
    const app = this.config.getOrThrow<AppConfig>(APP_CONFIG);
    if (app.isProduction || app.payments.provider !== PaymentProviderName.Mock) throw NOT_FOUND();
    return true;
  }
}

const KIND: Record<SimulatePaymentDto['outcome'], ProviderEventKind> = {
  succeeded: 'PAYMENT_SUCCEEDED',
  failed: 'PAYMENT_FAILED',
  cancelled: 'PAYMENT_CANCELLED',
  expired: 'PAYMENT_EXPIRED',
};

/**
 * DEVELOPMENT ONLY. Lets an administrator rehearse the outcome of a MOCK payment.
 *
 * It is not a webhook: it is a separate, authenticated, admin-only route that exists only for the
 * mock provider outside production. The event it builds is flagged `isSimulated`, so it can only
 * ever touch simulated attempts, and everything it creates (event row, ledger entry) is marked
 * simulated. It then runs through the same processing path as a genuine verified event.
 */
@Injectable()
export class PaymentSimulationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: PaymentEventsService,
    private readonly audit: AuditService,
  ) {}

  async simulate(adminId: string, paymentId: string, dto: SimulatePaymentDto, meta: ClientMeta): Promise<{ result: EventResult; eventId: string }> {
    const attempt = await this.prisma.paymentAttempt.findUnique({ where: { id: paymentId } });
    if (!attempt) throw notFound('Payment');
    if (!attempt.isSimulated || attempt.provider !== 'mock' || !attempt.providerPaymentId) {
      throw conflict('NOT_A_SIMULATED_PAYMENT', 'Only mock payments that already have a checkout can be simulated');
    }
    const eventId = dto.eventId ?? `sim_${randomUUID()}`;
    const event: NormalizedPaymentEvent = {
      providerEventId: eventId,
      accountScope: 'default',
      kind: KIND[dto.outcome],
      providerPaymentId: attempt.providerPaymentId,
      amountHalalas: dto.amountHalalas ?? attempt.amountHalalas,
      currency: dto.currency ?? attempt.currency,
      occurredAt: new Date(),
      isSimulated: true,
      ...(dto.outcome === 'failed' ? { failureCode: 'SIMULATED_FAILURE' } : {}),
    };
    const result = await this.events.handleVerified('mock', event, null);
    await this.audit.record({
      action: 'payment.simulated_event',
      actorUserId: adminId,
      entityType: 'payment_attempt',
      entityId: attempt.id,
      metadata: { outcome: dto.outcome, result },
      ipAddress: meta.ip,
      userAgent: meta.userAgent,
    });
    return { result, eventId };
  }
}
