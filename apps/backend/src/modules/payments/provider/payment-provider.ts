import type { ProviderEventKind } from '../payment-state.js';

/** The provider could not be reached or its answer is unknown. The attempt stays INITIATED and the same Idempotency-Key can be retried. */
export class ProviderUnavailableError extends Error {}

/** The provider definitively refused (bad request, declined merchant setup...). `code` must be safe to show. */
export class ProviderRejectedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** The signature did not match the exact raw body (or was missing/stale). Nothing may change. */
export class InvalidWebhookSignatureError extends Error {}

/** This adapter does not support the operation in the current phase. */
export class ProviderNotSupportedError extends Error {}

export interface CheckoutRequest {
  /** Our payment attempt id: put it in the provider's metadata/reference field. */
  paymentId: string;
  /** Stable per attempt. The adapter MUST send it as the provider's idempotency key, so retries never create a second checkout. */
  idempotencyKey: string;
  bookingReference: string;
  /** Integer halalas, copied from the booking snapshot. */
  amountHalalas: number;
  currency: string;
  expiresAt: Date;
  /** Already validated against PAYMENT_RETURN_URL_ORIGINS. */
  returnUrl: string | null;
}

export interface CheckoutSession {
  providerPaymentId: string;
  /** Hosted page for the customer, if the provider uses redirects. */
  checkoutUrl: string | null;
  isSimulated: boolean;
}

export interface ProviderPaymentSnapshot {
  providerPaymentId: string;
  state: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'EXPIRED' | 'UNKNOWN';
  amountHalalas: number | null;
  currency: string | null;
}

/** What every adapter reduces a verified provider event to. Nothing else is trusted or stored. */
export interface NormalizedPaymentEvent {
  providerEventId: string;
  /** Merchant/account the event belongs to ("default" when the provider has one). */
  accountScope: string;
  kind: ProviderEventKind;
  providerPaymentId: string | null;
  /** Integer halalas. A PAYMENT_SUCCEEDED event MUST carry amount and currency (the adapter calls getPayment() if the webhook omits them). */
  amountHalalas: number | null;
  currency: string | null;
  /** The provider's own time of the event (used to ignore stale ones). */
  occurredAt: Date;
  isSimulated: boolean;
  /** Safe, short machine code for failures. Never raw provider text. */
  failureCode?: string;
}

/**
 * Contract for a payment gateway. NO real gateway implements it yet: only `mock` (development)
 * and `disabled` exist. Rules every real adapter must follow:
 *  - credentials only from environment variables or the platform secret store;
 *  - `verifyWebhook` checks the provider's documented signature over the EXACT raw body, in constant
 *    time, with the provider's replay window, and throws InvalidWebhookSignatureError otherwise;
 *  - amounts are converted to integer halalas without floating point;
 *  - never log request/response bodies, card data or credentials;
 *  - `createCheckout` must be idempotent for the same `idempotencyKey`.
 */
export abstract class PaymentProvider {
  /** Short stable name, stored on every attempt (e.g. "mock"). Also the `:provider` segment of the webhook URL. */
  abstract readonly name: string;
  /** True only for the development mock. Its attempts, events and ledger rows are flagged as simulated. */
  abstract readonly isSimulated: boolean;
  /** False for `disabled`: payment initiation answers 503. */
  abstract readonly isAvailable: boolean;
  /** Whether verified events may arrive on the public webhook route. The mock must answer false. */
  abstract readonly acceptsPublicWebhooks: boolean;

  abstract createCheckout(request: CheckoutRequest): Promise<CheckoutSession>;

  /** Authoritative status from the provider, for reconciliation. Null when unknown to the provider. */
  abstract getPayment(providerPaymentId: string): Promise<ProviderPaymentSnapshot | null>;

  /** Verifies authenticity of the raw request and returns the normalised event. */
  abstract verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): NormalizedPaymentEvent;

  /** Not implemented in this phase by any adapter. A future phase adds refund execution here. */
  abstract requestRefund(providerPaymentId: string, amountHalalas: number, currency: string, idempotencyKey: string): Promise<{ providerRefundId: string }>;
}
