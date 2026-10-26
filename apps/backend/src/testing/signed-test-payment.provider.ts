import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  type CheckoutRequest,
  type CheckoutSession,
  InvalidWebhookSignatureError,
  type NormalizedPaymentEvent,
  PaymentProvider,
  ProviderNotSupportedError,
  type ProviderPaymentSnapshot,
  ProviderRejectedError,
  ProviderUnavailableError,
} from '../modules/payments/provider/payment-provider.js';
import type { ProviderEventKind } from '../modules/payments/payment-state.js';

export const TEST_WEBHOOK_SECRET = 'test-gateway-webhook-secret-not-a-real-secret';

const KINDS: Record<string, ProviderEventKind> = {
  'payment.succeeded': 'PAYMENT_SUCCEEDED',
  'payment.failed': 'PAYMENT_FAILED',
  'payment.cancelled': 'PAYMENT_CANCELLED',
  'payment.expired': 'PAYMENT_EXPIRED',
};

export interface TestWebhookPayload {
  id: string;
  type: string;
  paymentId: string | null;
  amount?: number | null;
  currency?: string | null;
  occurredAt?: string;
  account?: string;
  failureCode?: string;
}

/** Signs a payload exactly like the test gateway would, so tests can send "genuine" events. */
export function signTestWebhook(payload: TestWebhookPayload, secret = TEST_WEBHOOK_SECRET): { body: string; signature: string } {
  const body = JSON.stringify({ occurredAt: new Date().toISOString(), ...payload });
  return { body, signature: createHmac('sha256', secret).update(body).digest('hex') };
}

/**
 * TEST-ONLY gateway used by the integration suites to exercise the real webhook path (raw body,
 * signature, inbox, processing). It is not selectable through configuration and never ships:
 * tests inject it with overrideProvider(PaymentProvider).
 * It behaves like a real adapter: HMAC-SHA256 over the exact raw body, constant-time comparison,
 * idempotent checkout creation, and switchable failures.
 */
@Injectable()
export class SignedTestPaymentProvider extends PaymentProvider {
  readonly name = 'testgw';
  readonly isSimulated = false;
  readonly isAvailable = true;
  readonly acceptsPublicWebhooks = true;

  /** Make the next createCheckout fail: 'unavailable' (outcome unknown) or 'rejected' (definitive). */
  failNextCheckout?: 'unavailable' | 'rejected';
  /** Every createCheckout call, to prove idempotent retries. */
  readonly checkoutCalls: CheckoutRequest[] = [];

  async createCheckout(request: CheckoutRequest): Promise<CheckoutSession> {
    this.checkoutCalls.push(request);
    const failure = this.failNextCheckout;
    this.failNextCheckout = undefined;
    if (failure === 'unavailable') throw new ProviderUnavailableError('simulated outage');
    if (failure === 'rejected') throw new ProviderRejectedError('MERCHANT_DECLINED', 'simulated refusal');
    const id = createHash('sha256').update(`testgw:${request.idempotencyKey}`).digest('hex').slice(0, 24);
    return { providerPaymentId: `tg_${id}`, checkoutUrl: `https://testgw.invalid/pay/${id}`, isSimulated: false };
  }

  async getPayment(): Promise<ProviderPaymentSnapshot | null> {
    return null;
  }

  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): NormalizedPaymentEvent {
    const header = headers['x-testgw-signature'];
    const given = Array.isArray(header) ? header[0] : header;
    if (!given) throw new InvalidWebhookSignatureError('missing signature');
    const expected = createHmac('sha256', TEST_WEBHOOK_SECRET).update(rawBody).digest('hex');
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new InvalidWebhookSignatureError('bad signature');

    const p = JSON.parse(rawBody.toString('utf8')) as TestWebhookPayload;
    return {
      providerEventId: p.id,
      accountScope: p.account ?? 'default',
      kind: KINDS[p.type] ?? 'UNKNOWN',
      providerPaymentId: p.paymentId,
      amountHalalas: p.amount ?? null,
      currency: p.currency ?? null,
      occurredAt: new Date(p.occurredAt ?? Date.now()),
      isSimulated: false,
      ...(p.failureCode ? { failureCode: p.failureCode } : {}),
    };
  }

  async requestRefund(): Promise<{ providerRefundId: string }> {
    throw new ProviderNotSupportedError('not implemented in this phase');
  }
}
