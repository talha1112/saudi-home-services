import { Injectable } from '@nestjs/common';
import { unavailable } from '../../../common/errors/api-error.js';
import {
  InvalidWebhookSignatureError,
  type NormalizedPaymentEvent,
  PaymentProvider,
  ProviderNotSupportedError,
  type ProviderPaymentSnapshot,
  type CheckoutSession,
} from './payment-provider.js';

/** Used when no provider is configured (the default). Fails closed: nothing can be paid. */
@Injectable()
export class DisabledPaymentProvider extends PaymentProvider {
  readonly name = 'disabled';
  readonly isSimulated = false;
  readonly isAvailable = false;
  readonly acceptsPublicWebhooks = false;

  async createCheckout(): Promise<CheckoutSession> {
    throw unavailable('PAYMENT_PROVIDER_NOT_CONFIGURED', 'Online payment is temporarily unavailable');
  }

  async getPayment(): Promise<ProviderPaymentSnapshot | null> {
    return null;
  }

  verifyWebhook(): NormalizedPaymentEvent {
    throw new InvalidWebhookSignatureError('No payment provider is configured');
  }

  async requestRefund(): Promise<{ providerRefundId: string }> {
    throw new ProviderNotSupportedError('No payment provider is configured');
  }
}
