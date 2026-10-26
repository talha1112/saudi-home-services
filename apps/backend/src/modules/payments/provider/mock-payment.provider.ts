import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  type CheckoutRequest,
  type CheckoutSession,
  InvalidWebhookSignatureError,
  type NormalizedPaymentEvent,
  PaymentProvider,
  ProviderNotSupportedError,
  type ProviderPaymentSnapshot,
} from './payment-provider.js';

/**
 * DEVELOPMENT AND TESTS ONLY. Simulates a checkout; no money ever moves.
 *
 * - Everything it creates is flagged `isSimulated`.
 * - It does NOT accept webhooks: simulated outcomes are injected through the admin-only,
 *   non-production simulation endpoint, a separate path that cannot be mistaken for a provider.
 * - Environment validation and PaymentsModule refuse it when NODE_ENV=production.
 */
@Injectable()
export class MockPaymentProvider extends PaymentProvider {
  readonly name = 'mock';
  readonly isSimulated = true;
  readonly isAvailable = true;
  readonly acceptsPublicWebhooks = false;

  async createCheckout(request: CheckoutRequest): Promise<CheckoutSession> {
    // Derived from the idempotency key, so repeating the call returns the same "payment" like a real provider would.
    const id = createHash('sha256').update(`mock:${request.idempotencyKey}`).digest('hex').slice(0, 24);
    return {
      providerPaymentId: `mock_pay_${id}`,
      checkoutUrl: `https://mock-checkout.invalid/pay/${id}`,
      isSimulated: true,
    };
  }

  async getPayment(): Promise<ProviderPaymentSnapshot | null> {
    return null; // the mock keeps no state of its own
  }

  verifyWebhook(): NormalizedPaymentEvent {
    throw new InvalidWebhookSignatureError('The mock provider does not accept webhooks');
  }

  async requestRefund(): Promise<{ providerRefundId: string }> {
    throw new ProviderNotSupportedError('Refund execution is not implemented in this phase');
  }
}
