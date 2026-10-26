import { ConfigService } from '@nestjs/config';
import type { AppConfig, AuthConfig } from '../config/app.config.js';
import { DocumentStorageName, FileScannerName, NodeEnv, PaymentProviderName, PushProviderMode, SmsProviderName } from '../config/env.validation.js';
import { SmsMessage, SmsProvider } from '../modules/auth/sms/sms-provider.js';

export function testAuthConfig(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return {
    jwtAccessSecret: 'test-access-secret-test-access-secret-0123456789',
    otpHmacSecret: 'test-otp-secret-test-otp-secret-0123456789abc',
    accessTokenTtlSeconds: 900,
    refreshTokenTtlSeconds: 30 * 24 * 3600,
    adminRefreshTokenTtlSeconds: 12 * 3600,
    otp: { ttlSeconds: 300, maxAttempts: 5, resendCooldownSeconds: 60, maxSendsPerHour: 6, length: 6 },
    defaultPhoneRegion: 'SA',
    smsProvider: SmsProviderName.Dev,
    ...overrides,
  };
}

export function testConfigService(auth: Partial<AuthConfig> = {}): ConfigService {
  const app = {
    env: NodeEnv.Test,
    isProduction: false,
    auth: testAuthConfig(auth),
    workers: { requireIdentityDocument: true, documentStorage: DocumentStorageName.Dev, documentUrlTtlSeconds: 900 },
    storage: {
      maxFileBytes: 10485760,
      localDir: './.storage-test',
      signingSecret: 'test-storage-signing-secret-0123456789abcdef',
      publicApiUrl: 'http://127.0.0.1:3000',
      s3: { forcePathStyle: false },
      scanner: FileScannerName.Disabled,
      requireCleanScan: false,
      deletionMaxAttempts: 8,
      deletionPollSeconds: 30,
      allowUnscanned: false,
      urlTtl: { upload: 900, bookingPhotoView: 900, identityDocumentView: 300 },
      scan: { maxAttempts: 5, pollSeconds: 15, leaseSeconds: 300 },
      abandonedUploads: { minAgeMinutes: 1440, pollMinutes: 10 },
      deletionRetentionDays: 7,
    },
    notifications: { pushProvider: PushProviderMode.Disabled, maxAttempts: 6, maxDevicesPerUser: 10 },
    firebase: { fcm: { enabled: false, dryRun: false }, auth: { enabled: true, projectId: 'hs-test-project', checkRevoked: false, maxAuthAgeSeconds: 300, allowAccountAdoption: false } },
    realtime: {
      enabled: true,
      redisAdapter: false,
      maxMessageBytes: 16384,
      maxSocketsPerUser: 5,
      tokenGraceSeconds: 30,
      revalidateSeconds: 60,
      location: { ttlSeconds: 120, minIntervalMs: 2000, rateLimitPerMinute: 30, maxAgeSeconds: 30, maxClockSkewSeconds: 10, maxSpeedMps: 70, maxAccuracyMeters: 500, sharingLeadMinutes: 180 },
      chat: { maxBodyChars: 2000, rateLimitPerMinute: 30, pageSizeMax: 100 },
      jobs: { enabled: false, queuePrefix: 'hs-test', outboxPollIntervalMs: 1000, outboxBatchSize: 50, outboxMaxAttempts: 8, outboxRetentionDays: 7, outboxStaleAfterMinutes: 5 },
    },
    payments: {
      provider: PaymentProviderName.Mock,
      checkoutTtlMinutes: 20,
      staleAfterMinutes: 30,
      webhookMaxBodyBytes: 65536,
      webhookLeaseSeconds: 120,
      returnUrlOrigins: [],
    },
    bookings: {
      requestTtlHours: 48,
      minLeadMinutes: 30,
      maxOpenPerCustomer: 10,
      maxQuotesPerBooking: 10,
      maxPhotos: 5,
      quoteDefaultValidityHours: 24,
      quoteMaxValidityHours: 72,
      quoteMaxPriceHalalas: 5_000_000,
      paymentWindowMinutes: 30,
    },
  } as unknown as AppConfig;
  return { getOrThrow: () => app } as unknown as ConfigService;
}

/** Records messages instead of sending them, so tests can read the OTP like a user would. */
export class CapturingSmsProvider extends SmsProvider {
  messages: SmsMessage[] = [];
  failWith?: Error;

  async send(message: SmsMessage): Promise<void> {
    if (this.failWith) throw this.failWith;
    this.messages.push(message);
  }

  /** The most recent 6-digit code sent to the number. */
  lastCode(to: string): string {
    const last = [...this.messages].reverse().find((m) => m.to === to);
    const code = last?.body.match(/\d{6}/)?.[0];
    if (!code) throw new Error(`No code was sent to ${to}`);
    return code;
  }
}
