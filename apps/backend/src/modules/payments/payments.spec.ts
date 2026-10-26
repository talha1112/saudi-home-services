import { ArgumentMetadata, ValidationPipe } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { PaymentProviderName, validateEnv } from '../../config/env.validation.js';
import type { AppConfig } from '../../config/app.config.js';
import { PaymentStatus } from '../../generated/prisma/client.js';
import {
  AdminListPaymentsQueryDto,
  InitiatePaymentDto,
  ListMyPaymentsQueryDto,
  RequestRefundDto,
  SimulatePaymentDto,
} from './dto/payments.dto.js';
import {
  CAPTURED_STATUSES,
  OPEN_STATUSES,
  PROVIDER_EVENT_KINDS,
  assertTransition,
  canTransition,
  decideEvent,
} from './payment-state.js';
import { SimulationEnabledGuard } from './payment-simulation.service.js';
import { parseIdempotencyKey, safeErrorSummary, sha256 } from './payments-support.js';
import { selectPaymentProvider } from './payments.module.js';
import { DisabledPaymentProvider } from './provider/disabled-payment.provider.js';
import { MockPaymentProvider } from './provider/mock-payment.provider.js';
import { InvalidWebhookSignatureError, ProviderNotSupportedError } from './provider/payment-provider.js';

const P = PaymentStatus;
const ALL = Object.values(P);
const t0 = new Date('2026-11-01T10:00:00Z');
const t1 = new Date('2026-11-01T10:05:00Z');

describe('payment state machine', () => {
  it('treats exactly INITIATED and PROCESSING as open and SUCCEEDED/CAPTURED_UNAPPLIED as captured', () => {
    expect(OPEN_STATUSES.sort()).toEqual([P.INITIATED, P.PROCESSING].sort());
    expect(CAPTURED_STATUSES.sort()).toEqual([P.SUCCEEDED, P.CAPTURED_UNAPPLIED].sort());
  });

  it('never leaves a captured state', () => {
    for (const from of CAPTURED_STATUSES) for (const to of ALL) expect(canTransition(from, to)).toBe(false);
  });

  it('lets only a capture follow a failure, cancellation or expiry (a late capture is a fact)', () => {
    for (const from of [P.FAILED, P.CANCELLED, P.EXPIRED]) {
      for (const to of ALL) expect({ from, to, ok: canTransition(from, to) }).toEqual({ from, to, ok: to === P.SUCCEEDED || to === P.CAPTURED_UNAPPLIED });
    }
  });

  it('never moves back to INITIATED and never skips the capture states from nowhere', () => {
    for (const from of ALL) expect(canTransition(from, P.INITIATED)).toBe(false);
    expect(canTransition(P.PROCESSING, P.INITIATED)).toBe(false);
    expect(() => assertTransition(P.SUCCEEDED, P.FAILED)).toThrow('Illegal payment transition');
    expect(() => assertTransition(P.PROCESSING, P.SUCCEEDED)).not.toThrow();
  });

  describe('decideEvent', () => {
    it.each([P.INITIATED, P.PROCESSING, P.FAILED, P.CANCELLED, P.EXPIRED])('applies a capture to a %s attempt', (status) => {
      expect(decideEvent(status, 'PAYMENT_SUCCEEDED', t1, null)).toEqual({ action: 'capture' });
    });

    it.each(CAPTURED_STATUSES)('treats a repeated capture on a %s attempt as a duplicate', (status) => {
      expect(decideEvent(status, 'PAYMENT_SUCCEEDED', t1, t0)).toEqual({ action: 'ignore', reason: 'DUPLICATE_EVENT' });
    });

    it.each(['PAYMENT_FAILED', 'PAYMENT_CANCELLED', 'PAYMENT_EXPIRED'] as const)('can never undo a capture (%s)', (kind) => {
      for (const status of CAPTURED_STATUSES) expect(decideEvent(status, kind, t1, null)).toEqual({ action: 'ignore', reason: 'STALE_EVENT' });
    });

    it('settles an open attempt with the matching outcome', () => {
      expect(decideEvent(P.PROCESSING, 'PAYMENT_FAILED', t1, null)).toEqual({ action: 'settle', to: 'FAILED' });
      expect(decideEvent(P.INITIATED, 'PAYMENT_CANCELLED', t1, null)).toEqual({ action: 'settle', to: 'CANCELLED' });
      expect(decideEvent(P.PROCESSING, 'PAYMENT_EXPIRED', t1, null)).toEqual({ action: 'settle', to: 'EXPIRED' });
    });

    it('ignores repeats and conflicting outcomes of an attempt that is already closed', () => {
      expect(decideEvent(P.FAILED, 'PAYMENT_FAILED', t1, null)).toEqual({ action: 'ignore', reason: 'DUPLICATE_EVENT' });
      expect(decideEvent(P.FAILED, 'PAYMENT_EXPIRED', t1, null)).toEqual({ action: 'ignore', reason: 'STALE_EVENT' });
      expect(decideEvent(P.EXPIRED, 'PAYMENT_CANCELLED', t1, null)).toEqual({ action: 'ignore', reason: 'STALE_EVENT' });
    });

    it('ignores a non-capturing event that is older than the newest one already applied', () => {
      expect(decideEvent(P.PROCESSING, 'PAYMENT_FAILED', t0, t1)).toEqual({ action: 'ignore', reason: 'STALE_EVENT' });
      expect(decideEvent(P.PROCESSING, 'PAYMENT_FAILED', t1, t0)).toEqual({ action: 'settle', to: 'FAILED' });
      expect(decideEvent(P.PROCESSING, 'PAYMENT_FAILED', t0, null)).toEqual({ action: 'settle', to: 'FAILED' });
    });

    it('ignores unknown event kinds and covers every status for every kind without throwing', () => {
      expect(decideEvent(P.PROCESSING, 'UNKNOWN', t1, null)).toEqual({ action: 'ignore', reason: 'UNSUPPORTED_EVENT' });
      for (const status of ALL) for (const kind of PROVIDER_EVENT_KINDS) expect(decideEvent(status, kind, t1, t0)).toBeDefined();
    });
  });
});

describe('provider selection and the production guard', () => {
  const mock = new MockPaymentProvider();
  const disabled = new DisabledPaymentProvider();
  const cfg = (provider: PaymentProviderName, isProduction: boolean) => ({ isProduction, payments: { provider } }) as unknown as AppConfig;

  it('uses the mock only outside production, and only when asked for', () => {
    expect(selectPaymentProvider(cfg(PaymentProviderName.Mock, false), mock, disabled)).toBe(mock);
    expect(selectPaymentProvider(cfg(PaymentProviderName.Disabled, false), mock, disabled)).toBe(disabled);
  });

  it('refuses to start with the mock provider in production', () => {
    expect(() => selectPaymentProvider(cfg(PaymentProviderName.Mock, true), mock, disabled)).toThrow('must not be used in production');
    expect(selectPaymentProvider(cfg(PaymentProviderName.Disabled, true), mock, disabled)).toBe(disabled);
  });

  describe('environment validation', () => {
    const base = {
      DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
      REDIS_URL: 'redis://127.0.0.1:6379',
      JWT_ACCESS_SECRET: 'a'.repeat(40),
      OTP_HMAC_SECRET: 'b'.repeat(40),
    };

    it('defaults to disabled in EVERY environment: simulation is opt-in', () => {
      expect(validateEnv({ ...base }).PAYMENT_PROVIDER).toBeUndefined();
      expect(validateEnv({ ...base, NODE_ENV: 'production', TRUST_PROXY_HOPS: '1' }).PAYMENT_PROVIDER).toBeUndefined();
    });

    it('rejects PAYMENT_PROVIDER=mock in production (the application will not boot) but allows it elsewhere', () => {
      expect(() => validateEnv({ ...base, NODE_ENV: 'production', TRUST_PROXY_HOPS: '1', PAYMENT_PROVIDER: 'mock' })).toThrow('PAYMENT_PROVIDER=mock is not allowed in production');
      expect(() => validateEnv({ ...base, NODE_ENV: 'production', TRUST_PROXY_HOPS: '1', PAYMENT_PROVIDER: 'disabled' })).not.toThrow();
      expect(() => validateEnv({ ...base, NODE_ENV: 'development', PAYMENT_PROVIDER: 'mock' })).not.toThrow();
      expect(() => validateEnv({ ...base, NODE_ENV: 'test', PAYMENT_PROVIDER: 'mock' })).not.toThrow();
    });

    it('rejects unknown providers and unreasonable limits', () => {
      expect(() => validateEnv({ ...base, PAYMENT_PROVIDER: 'stripe' })).toThrow('PAYMENT_PROVIDER');
      expect(() => validateEnv({ ...base, PAYMENT_WEBHOOK_MAX_BODY_BYTES: '10' })).toThrow('PAYMENT_WEBHOOK_MAX_BODY_BYTES');
      expect(() => validateEnv({ ...base, PAYMENT_STALE_AFTER_MINUTES: '0' })).toThrow('PAYMENT_STALE_AFTER_MINUTES');
      expect(validateEnv({ ...base })).toMatchObject({ PAYMENT_CHECKOUT_TTL_MINUTES: 20, PAYMENT_STALE_AFTER_MINUTES: 30, PAYMENT_WEBHOOK_MAX_BODY_BYTES: 65536, PAYMENT_WEBHOOK_LEASE_SECONDS: 120, PAYMENT_RETURN_URL_ORIGINS: '' });
    });
  });

  describe('the simulation guard', () => {
    const guard = (provider: PaymentProviderName, isProduction: boolean) =>
      new SimulationEnabledGuard({ getOrThrow: () => ({ isProduction, payments: { provider } }) } as unknown as ConfigService);

    it('exists only for the mock provider outside production, and otherwise answers 404', () => {
      expect(guard(PaymentProviderName.Mock, false).canActivate()).toBe(true);
      for (const [provider, prod] of [[PaymentProviderName.Mock, true], [PaymentProviderName.Disabled, false], [PaymentProviderName.Disabled, true]] as const) {
        expect(() => guard(provider, prod).canActivate()).toThrow('Not found');
      }
    });
  });
});

describe('built-in providers', () => {
  const request = { paymentId: 'p', idempotencyKey: 'pay_abc', bookingReference: 'BK-X', amountHalalas: 23000, currency: 'SAR', expiresAt: new Date(), returnUrl: null };

  it('the mock provider marks everything simulated and is idempotent for the same key', async () => {
    const mock = new MockPaymentProvider();
    expect(mock).toMatchObject({ name: 'mock', isSimulated: true, isAvailable: true, acceptsPublicWebhooks: false });
    const a = await mock.createCheckout(request);
    const b = await mock.createCheckout(request);
    const c = await mock.createCheckout({ ...request, idempotencyKey: 'pay_other' });
    expect(a).toEqual(b);
    expect(a.providerPaymentId).not.toBe(c.providerPaymentId);
    expect(a.isSimulated).toBe(true);
    expect(a.checkoutUrl).toContain('.invalid/');
  });

  it('the mock provider cannot verify webhooks or refund', async () => {
    const mock = new MockPaymentProvider();
    expect(() => mock.verifyWebhook()).toThrow(InvalidWebhookSignatureError);
    await expect(mock.requestRefund()).rejects.toBeInstanceOf(ProviderNotSupportedError);
  });

  it('the disabled provider is unavailable and fails closed for every operation', async () => {
    const disabled = new DisabledPaymentProvider();
    expect(disabled).toMatchObject({ name: 'disabled', isAvailable: false, acceptsPublicWebhooks: false, isSimulated: false });
    await expect(disabled.createCheckout()).rejects.toMatchObject({ code: 'PAYMENT_PROVIDER_NOT_CONFIGURED', status: 503 });
    expect(() => disabled.verifyWebhook()).toThrow(InvalidWebhookSignatureError);
    await expect(disabled.requestRefund()).rejects.toBeInstanceOf(ProviderNotSupportedError);
  });
});

describe('request helpers', () => {
  it('requires a well-formed Idempotency-Key', () => {
    expect(parseIdempotencyKey('abcdefgh')).toBe('abcdefgh');
    expect(parseIdempotencyKey(['a-b_c.d:e-1234'])).toBe('a-b_c.d:e-1234');
    for (const bad of [undefined, '', 'short', 'x'.repeat(129), 'has space here', 'semi;colon;!!', 'ünïcode-key-123']) {
      expect(() => parseIdempotencyKey(bad)).toThrow();
    }
  });

  it('hashes deterministically and never echoes error details', () => {
    expect(sha256('a')).toBe(sha256('a'));
    expect(sha256('a')).not.toBe(sha256('b'));
    expect(sha256('a')).toMatch(/^[0-9a-f]{64}$/);
    expect(safeErrorSummary(new Error('password=hunter2 at 10.0.0.5'))).toBe('Error');
    expect(safeErrorSummary(Object.assign(new TypeError('secret'), { code: 'P2002' }))).toBe('TypeError:P2002');
    expect(safeErrorSummary('plain string')).toBe('Error');
  });
});

describe('payment DTO validation', () => {
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, transformOptions: { enableImplicitConversion: false } });
  const body = (metatype: new () => object): ArgumentMetadata => ({ type: 'body', metatype });
  const query = (metatype: new () => object): ArgumentMetadata => ({ type: 'query', metatype });
  const bad = async (v: unknown, m: ArgumentMetadata) => expect(pipe.transform(v, m)).rejects.toMatchObject({ status: 400 });

  it('accepts only an optional returnUrl when starting a payment', async () => {
    await expect(pipe.transform({}, body(InitiatePaymentDto))).resolves.toBeDefined();
    await expect(pipe.transform({ returnUrl: 'https://app.example/done' }, body(InitiatePaymentDto))).resolves.toBeDefined();
    for (const field of ['amountHalalas', 'amount', 'currency', 'totalAmountHalalas', 'status', 'provider']) await bad({ [field]: 1 }, body(InitiatePaymentDto));
    for (const url of ['javascript:alert(1)', 'ftp://x.example', 'not a url', 'https://']) await bad({ returnUrl: url }, body(InitiatePaymentDto));
  });

  it('validates refund requests', async () => {
    await expect(pipe.transform({ amountHalalas: 100, reason: ' fine reason ' }, body(RequestRefundDto))).resolves.toMatchObject({ reason: 'fine reason' });
    for (const v of [{ amountHalalas: 0, reason: 'valid' }, { amountHalalas: -1, reason: 'valid' }, { amountHalalas: 1.5, reason: 'valid' }, { amountHalalas: 100 }, { amountHalalas: 100, reason: 'x' }, { amountHalalas: 100, reason: 'valid', status: 'SUCCEEDED' }, { amountHalalas: 2_000_000_000, reason: 'valid' }]) {
      await bad(v, body(RequestRefundDto));
    }
  });

  it('validates simulation requests', async () => {
    await expect(pipe.transform({ outcome: 'succeeded', currency: 'usd' }, body(SimulatePaymentDto))).resolves.toMatchObject({ currency: 'USD' });
    for (const v of [{}, { outcome: 'paid' }, { outcome: 'succeeded', amountHalalas: 0 }, { outcome: 'succeeded', currency: 'US' }, { outcome: 'succeeded', status: 'X' }]) await bad(v, body(SimulatePaymentDto));
  });

  it('validates list filters', async () => {
    await expect(pipe.transform({ status: 'processing,failed', page: '2' }, query(ListMyPaymentsQueryDto))).resolves.toMatchObject({ status: ['PROCESSING', 'FAILED'], page: 2 });
    await bad({ status: 'BOGUS' }, query(ListMyPaymentsQueryDto));
    await bad({ bookingId: 'x' }, query(ListMyPaymentsQueryDto));
    await bad({ limit: '101' }, query(AdminListPaymentsQueryDto));
    await expect(pipe.transform({ simulated: 'false', needsReconciliation: 'true' }, query(AdminListPaymentsQueryDto))).resolves.toMatchObject({ simulated: false, needsReconciliation: true });
    await bad({ simulated: 'maybe' }, query(AdminListPaymentsQueryDto));
  });
});
