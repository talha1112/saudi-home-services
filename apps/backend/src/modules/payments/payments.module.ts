import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_CONFIG, type AppConfig } from '../../config/app.config.js';
import { PaymentProviderName } from '../../config/env.validation.js';
import { AuthModule } from '../auth/auth.module.js';
import { BookingsModule } from '../bookings/bookings.module.js';
import { LedgerService } from './ledger.service.js';
import { PaymentEventsService } from './payment-events.service.js';
import { PaymentSimulationService, SimulationEnabledGuard } from './payment-simulation.service.js';
import { PaymentsAdminService } from './payments-admin.service.js';
import { PaymentsMaintenanceService } from './payments-maintenance.service.js';
import {
  AdminLedgerController,
  AdminPaymentsController,
  AdminRefundsController,
  BookingPaymentsController,
  DevPaymentSimulationController,
  MyPaymentsController,
  PaymentWebhookController,
} from './payments.controllers.js';
import { PaymentsService } from './payments.service.js';
import { DisabledPaymentProvider } from './provider/disabled-payment.provider.js';
import { MockPaymentProvider } from './provider/mock-payment.provider.js';
import { PaymentProvider } from './provider/payment-provider.js';
import { RefundsService } from './refunds.service.js';

/**
 * Chooses the adapter. Exported so the production guard can be tested directly: a mock provider in a
 * production process is a startup error, never a silent fallback.
 */
export function selectPaymentProvider(app: AppConfig, mock: PaymentProvider, disabled: PaymentProvider): PaymentProvider {
  if (app.payments.provider === PaymentProviderName.Mock) {
    if (app.isProduction) throw new Error('The mock payment provider must not be used in production');
    return mock;
  }
  return disabled;
}

/**
 * Payments, refund requests and the ledger. Provider-neutral: choose the adapter with
 * PAYMENT_PROVIDER. To add a real gateway: implement `PaymentProvider`, add its name to
 * `PaymentProviderName` and the switch below, and document its settings in `.env.example`.
 */
@Module({
  imports: [AuthModule, BookingsModule],
  controllers: [
    BookingPaymentsController,
    PaymentWebhookController,
    MyPaymentsController,
    AdminPaymentsController,
    AdminRefundsController,
    AdminLedgerController,
    DevPaymentSimulationController,
  ],
  providers: [
    MockPaymentProvider,
    DisabledPaymentProvider,
    {
      provide: PaymentProvider,
      inject: [ConfigService, MockPaymentProvider, DisabledPaymentProvider],
      useFactory: (config: ConfigService, mock: MockPaymentProvider, disabled: DisabledPaymentProvider): PaymentProvider =>
        selectPaymentProvider(config.getOrThrow<AppConfig>(APP_CONFIG), mock, disabled),
    },
    LedgerService,
    PaymentsService,
    PaymentEventsService,
    RefundsService,
    PaymentsAdminService,
    PaymentsMaintenanceService,
    PaymentSimulationService,
    SimulationEnabledGuard,
  ],
  exports: [PaymentProvider],
})
export class PaymentsModule {}
