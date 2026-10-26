import { registerAs } from '@nestjs/config';
import {
  DocumentStorageName,
  FileScannerName,
  type FirebaseServiceAccountJson,
  NodeEnv,
  PaymentProviderName,
  PushProviderMode,
  SmsProviderName,
  firebaseCheckRevoked,
  parseFirebaseServiceAccount,
  parseOrigins,
  validateEnv,
} from './env.validation.js';

export interface AppConfig {
  env: NodeEnv;
  isProduction: boolean;
  port: number;
  host: string;
  apiPrefix: string;
  defaultVersion: string;
  corsOrigins: string[];
  logLevel: string;
  swaggerEnabled: boolean;
  requestTimeoutMs: number;
  /** Contains credentials: never log or return it. */
  databaseUrl: string;
  /** May contain a password: never log or return it. */
  redisUrl: string;
  trustProxyHops: number;
  auth: AuthConfig;
  workers: WorkersConfig;
  bookings: BookingsConfig;
  payments: PaymentsConfig;
  realtime: RealtimeConfig;
  storage: StorageConfig;
  notifications: NotificationsConfig;
  firebase: FirebaseConfig;
}

/** Firebase settings. Nothing here is read unless the matching feature is enabled. `serviceAccount` is a SECRET: never log or return it. */
export interface FirebaseConfig {
  /** Firebase Cloud Messaging; independent of `auth`. */
  fcm: { enabled: boolean; projectId?: string; dryRun: boolean };
  auth: {
    enabled: boolean;
    projectId?: string;
    checkRevoked: boolean;
    maxAuthAgeSeconds: number;
    allowAccountAdoption: boolean;
  };
  serviceAccount?: FirebaseServiceAccountJson;
}

export interface StorageConfig {
  maxFileBytes: number;
  /** Secrets below: never log or return them. */
  localDir: string;
  signingSecret?: string;
  publicApiUrl: string;
  s3: { endpoint?: string; region?: string; bucket?: string; accessKeyId?: string; secretAccessKey?: string; forcePathStyle: boolean };
  scanner: FileScannerName;
  requireCleanScan: boolean;
  deletionMaxAttempts: number;
  deletionPollSeconds: number;
  deletionRetentionDays: number;
  /** Production acknowledgement that unscanned files are served (see STORAGE_ALLOW_UNSCANNED_FILES). */
  allowUnscanned: boolean;
  /** Lifetimes (seconds) of the signed links, by purpose. Resolved from the specific setting, then DOCUMENT_URL_TTL_SECONDS. */
  urlTtl: { upload: number; bookingPhotoView: number; identityDocumentView: number };
  scan: { maxAttempts: number; pollSeconds: number; leaseSeconds: number };
  abandonedUploads: { minAgeMinutes: number; pollMinutes: number };
}

/**
 * Link lifetimes. Precedence per purpose: the specific variable, else the legacy DOCUMENT_URL_TTL_SECONDS (default 900);
 * identity/licence documents never inherit more than 300 seconds (a stricter legacy value still wins).
 */
export function resolveUrlTtls(env: { DOCUMENT_URL_TTL_SECONDS: number; STORAGE_UPLOAD_URL_TTL_SECONDS: number; BOOKING_PHOTO_URL_TTL_SECONDS: number; IDENTITY_DOCUMENT_URL_TTL_SECONDS: number }): StorageConfig['urlTtl'] {
  const legacy = env.DOCUMENT_URL_TTL_SECONDS;
  return {
    upload: env.STORAGE_UPLOAD_URL_TTL_SECONDS || legacy,
    bookingPhotoView: env.BOOKING_PHOTO_URL_TTL_SECONDS || legacy,
    identityDocumentView: env.IDENTITY_DOCUMENT_URL_TTL_SECONDS || Math.min(300, legacy),
  };
}

export interface NotificationsConfig {
  pushProvider: PushProviderMode;
  /** 32 raw bytes. Never log. */
  deviceTokenKey?: Buffer;
  maxAttempts: number;
  maxDevicesPerUser: number;
}

export interface RealtimeConfig {
  enabled: boolean;
  redisAdapter: boolean;
  maxMessageBytes: number;
  maxSocketsPerUser: number;
  tokenGraceSeconds: number;
  revalidateSeconds: number;
  location: {
    ttlSeconds: number;
    minIntervalMs: number;
    rateLimitPerMinute: number;
    maxAgeSeconds: number;
    maxClockSkewSeconds: number;
    maxSpeedMps: number;
    maxAccuracyMeters: number;
    sharingLeadMinutes: number;
  };
  chat: { maxBodyChars: number; rateLimitPerMinute: number; pageSizeMax: number };
  jobs: {
    enabled: boolean;
    queuePrefix: string;
    outboxPollIntervalMs: number;
    outboxBatchSize: number;
    outboxMaxAttempts: number;
    outboxRetentionDays: number;
    outboxStaleAfterMinutes: number;
  };
}

export interface PaymentsConfig {
  provider: PaymentProviderName;
  checkoutTtlMinutes: number;
  staleAfterMinutes: number;
  webhookMaxBodyBytes: number;
  webhookLeaseSeconds: number;
  returnUrlOrigins: string[];
}

export interface BookingsConfig {
  requestTtlHours: number;
  minLeadMinutes: number;
  maxOpenPerCustomer: number;
  maxQuotesPerBooking: number;
  maxPhotos: number;
  quoteDefaultValidityHours: number;
  quoteMaxValidityHours: number;
  /** Halalas (integer). */
  quoteMaxPriceHalalas: number;
  paymentWindowMinutes: number;
}

export interface WorkersConfig {
  requireIdentityDocument: boolean;
  documentStorage: DocumentStorageName;
  documentUrlTtlSeconds: number;
}

export interface AuthConfig {
  /** Secrets: never log or return them. */
  jwtAccessSecret: string;
  otpHmacSecret: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  adminRefreshTokenTtlSeconds: number;
  otp: {
    ttlSeconds: number;
    maxAttempts: number;
    resendCooldownSeconds: number;
    maxSendsPerHour: number;
    length: number;
  };
  defaultPhoneRegion: string;
  smsProvider: SmsProviderName;
}

export const APP_CONFIG = 'app';

/** Typed, validated application settings: `config.get<AppConfig>(APP_CONFIG)`. */
export default registerAs(APP_CONFIG, (): AppConfig => {
  const env = validateEnv(process.env);
  const isProduction = env.NODE_ENV === NodeEnv.Production;
  return {
    env: env.NODE_ENV,
    isProduction,
    port: env.PORT,
    host: env.HOST,
    apiPrefix: env.API_PREFIX,
    defaultVersion: env.API_DEFAULT_VERSION,
    corsOrigins: parseOrigins(env.CORS_ORIGINS),
    logLevel: env.LOG_LEVEL,
    swaggerEnabled: env.SWAGGER_ENABLED ?? !isProduction,
    requestTimeoutMs: env.REQUEST_TIMEOUT_MS,
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    trustProxyHops: env.TRUST_PROXY_HOPS,
    workers: {
      requireIdentityDocument: env.WORKER_REQUIRE_IDENTITY_DOCUMENT,
      documentStorage: env.DOCUMENT_STORAGE ?? (isProduction ? DocumentStorageName.Disabled : DocumentStorageName.Dev),
      documentUrlTtlSeconds: env.DOCUMENT_URL_TTL_SECONDS,
    },
    bookings: {
      requestTtlHours: env.BOOKING_REQUEST_TTL_HOURS,
      minLeadMinutes: env.BOOKING_MIN_LEAD_MINUTES,
      maxOpenPerCustomer: env.BOOKING_MAX_OPEN_PER_CUSTOMER,
      maxQuotesPerBooking: env.BOOKING_MAX_QUOTES,
      maxPhotos: env.BOOKING_MAX_PHOTOS,
      quoteDefaultValidityHours: env.QUOTE_DEFAULT_VALIDITY_HOURS,
      quoteMaxValidityHours: env.QUOTE_MAX_VALIDITY_HOURS,
      quoteMaxPriceHalalas: env.QUOTE_MAX_PRICE_HALALAS,
      paymentWindowMinutes: env.PAYMENT_WINDOW_MINUTES,
    },
    payments: {
      provider: env.PAYMENT_PROVIDER ?? PaymentProviderName.Disabled,
      checkoutTtlMinutes: env.PAYMENT_CHECKOUT_TTL_MINUTES,
      staleAfterMinutes: env.PAYMENT_STALE_AFTER_MINUTES,
      webhookMaxBodyBytes: env.PAYMENT_WEBHOOK_MAX_BODY_BYTES,
      webhookLeaseSeconds: env.PAYMENT_WEBHOOK_LEASE_SECONDS,
      returnUrlOrigins: parseOrigins(env.PAYMENT_RETURN_URL_ORIGINS),
    },
    storage: {
      maxFileBytes: env.STORAGE_MAX_FILE_BYTES,
      localDir: env.STORAGE_LOCAL_DIR || './.storage',
      signingSecret: env.STORAGE_SIGNING_SECRET,
      publicApiUrl: (env.PUBLIC_API_URL || `http://127.0.0.1:${env.PORT}`).replace(/\/+$/, ''),
      s3: {
        endpoint: env.S3_ENDPOINT || undefined,
        region: env.S3_REGION,
        bucket: env.S3_BUCKET,
        accessKeyId: env.S3_ACCESS_KEY_ID,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY,
        forcePathStyle: env.S3_FORCE_PATH_STYLE,
      },
      scanner: env.FILE_SCANNER ?? FileScannerName.Disabled,
      requireCleanScan: env.STORAGE_REQUIRE_CLEAN_SCAN,
      deletionMaxAttempts: env.STORAGE_DELETION_MAX_ATTEMPTS,
      deletionPollSeconds: env.STORAGE_DELETION_POLL_SECONDS,
      allowUnscanned: env.STORAGE_ALLOW_UNSCANNED_FILES,
      urlTtl: resolveUrlTtls(env),
      scan: { maxAttempts: env.FILE_SCAN_MAX_ATTEMPTS, pollSeconds: env.FILE_SCAN_POLL_SECONDS, leaseSeconds: env.FILE_SCAN_LEASE_SECONDS },
      abandonedUploads: { minAgeMinutes: env.STORAGE_ABANDONED_UPLOAD_MIN_AGE_MINUTES, pollMinutes: env.STORAGE_ABANDONED_UPLOAD_POLL_MINUTES },
      deletionRetentionDays: env.STORAGE_DELETION_RETENTION_DAYS,
    },
    notifications: {
      pushProvider: env.PUSH_PROVIDER ?? PushProviderMode.Disabled,
      deviceTokenKey: env.DEVICE_TOKEN_ENCRYPTION_KEY ? Buffer.from(env.DEVICE_TOKEN_ENCRYPTION_KEY, 'base64') : undefined,
      maxAttempts: env.NOTIFICATION_MAX_ATTEMPTS,
      maxDevicesPerUser: env.MAX_DEVICE_TOKENS_PER_USER,
    },
    firebase: {
      fcm: { enabled: env.PUSH_PROVIDER === PushProviderMode.Fcm, projectId: env.FIREBASE_PROJECT_ID, dryRun: env.FCM_DRY_RUN },
      auth: {
        enabled: env.FIREBASE_AUTH_ENABLED,
        projectId: env.FIREBASE_PROJECT_ID,
        checkRevoked: env.FIREBASE_AUTH_ENABLED && firebaseCheckRevoked(env),
        maxAuthAgeSeconds: env.FIREBASE_MAX_AUTH_AGE_SECONDS,
        allowAccountAdoption: env.FIREBASE_ALLOW_PHONE_ACCOUNT_ADOPTION,
      },
      // Decoded only for an enabled feature that needs it, so a stray value never breaks a feature that is off.
      serviceAccount:
        (env.FIREBASE_AUTH_ENABLED || env.PUSH_PROVIDER === PushProviderMode.Fcm) && env.FIREBASE_SERVICE_ACCOUNT_BASE64
          ? parseFirebaseServiceAccount(env.FIREBASE_SERVICE_ACCOUNT_BASE64)
          : undefined,
    },
    realtime: {
      enabled: env.REALTIME_ENABLED,
      redisAdapter: env.REALTIME_REDIS_ADAPTER,
      maxMessageBytes: env.REALTIME_MAX_MESSAGE_BYTES,
      maxSocketsPerUser: env.REALTIME_MAX_SOCKETS_PER_USER,
      tokenGraceSeconds: env.REALTIME_TOKEN_GRACE_SECONDS,
      revalidateSeconds: env.REALTIME_REVALIDATE_SECONDS,
      location: {
        ttlSeconds: env.LOCATION_TTL_SECONDS,
        minIntervalMs: env.LOCATION_MIN_INTERVAL_MS,
        rateLimitPerMinute: env.LOCATION_RATE_LIMIT_PER_MINUTE,
        maxAgeSeconds: env.LOCATION_MAX_AGE_SECONDS,
        maxClockSkewSeconds: env.LOCATION_MAX_CLOCK_SKEW_SECONDS,
        maxSpeedMps: env.LOCATION_MAX_SPEED_MPS,
        maxAccuracyMeters: env.LOCATION_MAX_ACCURACY_METERS,
        sharingLeadMinutes: env.LOCATION_SHARING_LEAD_MINUTES,
      },
      chat: { maxBodyChars: env.CHAT_MAX_BODY_CHARS, rateLimitPerMinute: env.CHAT_RATE_LIMIT_PER_MINUTE, pageSizeMax: env.CHAT_PAGE_SIZE_MAX },
      jobs: {
        // Background workers stay off under test (like the other schedulers) unless a suite sets JOBS_ENABLED explicitly.
        enabled: env.NODE_ENV === NodeEnv.Test ? process.env['JOBS_ENABLED'] === 'true' : env.JOBS_ENABLED,
        queuePrefix: env.QUEUE_PREFIX,
        outboxPollIntervalMs: env.OUTBOX_POLL_INTERVAL_MS,
        outboxBatchSize: env.OUTBOX_BATCH_SIZE,
        outboxMaxAttempts: env.OUTBOX_MAX_ATTEMPTS,
        outboxRetentionDays: env.OUTBOX_RETENTION_DAYS,
        outboxStaleAfterMinutes: env.OUTBOX_STALE_AFTER_MINUTES,
      },
    },
    auth: {
      jwtAccessSecret: env.JWT_ACCESS_SECRET,
      otpHmacSecret: env.OTP_HMAC_SECRET,
      accessTokenTtlSeconds: env.ACCESS_TOKEN_TTL_SECONDS,
      refreshTokenTtlSeconds: env.REFRESH_TOKEN_TTL_DAYS * 24 * 3600,
      adminRefreshTokenTtlSeconds: env.ADMIN_REFRESH_TOKEN_TTL_HOURS * 3600,
      otp: {
        ttlSeconds: env.OTP_TTL_SECONDS,
        maxAttempts: env.OTP_MAX_ATTEMPTS,
        resendCooldownSeconds: env.OTP_RESEND_COOLDOWN_SECONDS,
        maxSendsPerHour: env.OTP_MAX_SENDS_PER_HOUR,
        length: 6,
      },
      defaultPhoneRegion: env.DEFAULT_PHONE_REGION,
      smsProvider: env.SMS_PROVIDER ?? (isProduction ? SmsProviderName.Disabled : SmsProviderName.Dev),
    },
  };
});
