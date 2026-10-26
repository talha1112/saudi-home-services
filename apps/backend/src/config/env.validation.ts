import { plainToInstance, Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

export enum NodeEnv {
  Development = 'development',
  Test = 'test',
  Production = 'production',
}

export enum LogLevel {
  Fatal = 'fatal',
  Error = 'error',
  Warn = 'warn',
  Info = 'info',
  Debug = 'debug',
  Trace = 'trace',
  Silent = 'silent',
}

export enum SmsProviderName {
  /** Development only: writes the message (including the OTP) to the log. */
  Dev = 'dev',
  /** No provider configured: OTP requests fail with 503. The production default until a provider is added. */
  Disabled = 'disabled',
}

export enum FileScannerName {
  /** Test double (marks files CLEAN unless the name says otherwise). Refused in production. */
  Mock = 'mock',
  /** Test double that reads the WHOLE object through the asynchronous scan queue (marks files CLEAN unless they contain the test marker). Refused in production. */
  MockAsync = 'mock-async',
  /** No scanner: files stay NOT_SCANNED. The default everywhere. */
  Disabled = 'disabled',
}

export enum PushProviderMode {
  /** Accepts every message and sends nothing. Refused in production. */
  Mock = 'mock',
  /** Firebase Cloud Messaging through the Firebase Admin SDK (Android, and iOS through APNs). Explicit opt-in; needs the Firebase project and a service account. */
  Fcm = 'fcm',
  /** No push provider: deliveries are recorded as UNSUPPORTED. The default everywhere. */
  Disabled = 'disabled',
}

export enum DocumentStorageName {
  /** Development only: issues fake upload URLs and pretends every file exists. */
  Dev = 'dev',
  /** No object storage configured: document endpoints return 503. The production default. */
  Disabled = 'disabled',
  /** Real bytes on local disk behind HMAC-signed API URLs. Development/test only; refused in production. */
  Local = 'local',
  /** S3-compatible object storage (private bucket, SigV4 signed URLs). */
  S3 = 's3',
}

export enum PaymentProviderName {
  /** Development/test only: simulated checkout, never real money. Refused in production. */
  Mock = 'mock',
  /** No provider configured (the default everywhere): payment initiation answers 503. */
  Disabled = 'disabled',
}

const toInt = (fallback: number) => ({ value }: { value: unknown }) =>
  value === undefined || value === '' ? fallback : Number(value);

const toBoolean = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? ['true', '1', 'yes'].includes(value.toLowerCase()) : value;

/**
 * Shape and defaults of the process environment. Anything not declared here is
 * ignored; invalid values stop the application from booting.
 */
export class EnvironmentVariables {
  @IsEnum(NodeEnv)
  NODE_ENV: NodeEnv = NodeEnv.Development;

  @Transform(({ value }) => (value === undefined || value === '' ? 3001 : Number(value)))
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT: number = 3001;

  @IsString()
  HOST: string = '0.0.0.0';

  @IsString()
  API_PREFIX: string = 'api';

  @IsString()
  API_DEFAULT_VERSION: string = '1';

  /** Comma-separated browser origins. Empty disables CORS entirely. */
  @IsString()
  @IsOptional()
  CORS_ORIGINS: string = '';

  @IsEnum(LogLevel)
  LOG_LEVEL: LogLevel = LogLevel.Info;

  /** Undefined means "on outside production". */
  @Transform(toBoolean)
  @IsBoolean()
  @IsOptional()
  SWAGGER_ENABLED?: boolean;

  @Transform(({ value }) => (value === undefined || value === '' ? 30000 : Number(value)))
  @IsInt()
  @Min(0)
  REQUEST_TIMEOUT_MS: number = 30000;

  /** PostgreSQL connection string. Required; contains credentials, so never log it. */
  @Matches(/^postgres(ql)?:\/\/.+/, { message: 'DATABASE_URL must be a postgresql:// connection string' })
  DATABASE_URL: string;

  /** Redis connection string (redis:// or rediss://). Required; may contain a password. */
  @Matches(/^rediss?:\/\/.+/, { message: 'REDIS_URL must be a redis:// or rediss:// connection string' })
  REDIS_URL: string;

  /** Signs access tokens (HS256). At least 32 characters; generate with `openssl rand -hex 32`. */
  @IsString()
  @MinLength(32)
  JWT_ACCESS_SECRET: string;

  /** Keys the HMAC that protects stored OTPs. Independent from the JWT secret. */
  @IsString()
  @MinLength(32)
  OTP_HMAC_SECRET: string;

  @Transform(toInt(900))
  @IsInt()
  @Min(60)
  @Max(3600)
  ACCESS_TOKEN_TTL_SECONDS: number = 900;

  /** Refresh-token lifetime for the mobile apps. */
  @Transform(toInt(30))
  @IsInt()
  @Min(1)
  @Max(90)
  REFRESH_TOKEN_TTL_DAYS: number = 30;

  /** Refresh-token lifetime for the admin portal (shorter on purpose). */
  @Transform(toInt(12))
  @IsInt()
  @Min(1)
  @Max(168)
  ADMIN_REFRESH_TOKEN_TTL_HOURS: number = 12;

  @Transform(toInt(300))
  @IsInt()
  @Min(60)
  @Max(900)
  OTP_TTL_SECONDS: number = 300;

  @Transform(toInt(5))
  @IsInt()
  @Min(1)
  @Max(10)
  OTP_MAX_ATTEMPTS: number = 5;

  @Transform(toInt(60))
  @IsInt()
  @Min(10)
  @Max(600)
  OTP_RESEND_COOLDOWN_SECONDS: number = 60;

  /** Maximum OTP messages per phone number per hour (one client IP may use at most half of it). */
  @Transform(toInt(6))
  @IsInt()
  @Min(2)
  @Max(20)
  OTP_MAX_SENDS_PER_HOUR: number = 6;

  /** Region used to interpret national numbers such as 0501234567. */
  @Matches(/^[A-Z]{2}$/)
  DEFAULT_PHONE_REGION: string = 'SA';

  /** `dev` is refused in production. Defaults to `dev` outside production and `disabled` in production. */
  @IsEnum(SmsProviderName)
  @IsOptional()
  SMS_PROVIDER?: SmsProviderName;

  /** `dev` is refused in production. Defaults to `dev` outside production and `disabled` in production. */
  @IsEnum(DocumentStorageName)
  @IsOptional()
  DOCUMENT_STORAGE?: DocumentStorageName;

  /** When true a worker must have an uploaded identity document (national ID or iqama) to submit for review. */
  @Transform(({ value }) => (value === undefined || value === '' ? true : toBoolean({ value })))
  @IsBoolean()
  WORKER_REQUIRE_IDENTITY_DOCUMENT: boolean = true;

  @Transform(toInt(900))
  @IsInt()
  @Min(60)
  @Max(3600)
  DOCUMENT_URL_TTL_SECONDS: number = 900;

  /** How long a booking request stays open for quotes. */
  @Transform(toInt(48))
  @IsInt()
  @Min(1)
  @Max(720)
  BOOKING_REQUEST_TTL_HOURS: number = 48;

  /** A preferred start must be at least this far in the future. */
  @Transform(toInt(30))
  @IsInt()
  @Min(0)
  @Max(10080)
  BOOKING_MIN_LEAD_MINUTES: number = 30;

  /** Open requests one customer may have at the same time. */
  @Transform(toInt(10))
  @IsInt()
  @Min(1)
  @Max(100)
  BOOKING_MAX_OPEN_PER_CUSTOMER: number = 10;

  /** Live quotes allowed on one request. */
  @Transform(toInt(10))
  @IsInt()
  @Min(1)
  @Max(100)
  BOOKING_MAX_QUOTES: number = 10;

  /** Problem photos per booking. */
  @Transform(toInt(5))
  @IsInt()
  @Min(0)
  @Max(20)
  BOOKING_MAX_PHOTOS: number = 5;

  /** How long a quote stays acceptable when the worker does not say. */
  @Transform(toInt(24))
  @IsInt()
  @Min(1)
  @Max(168)
  QUOTE_DEFAULT_VALIDITY_HOURS: number = 24;

  /** Longest validity a worker may choose. */
  @Transform(toInt(72))
  @IsInt()
  @Min(1)
  @Max(720)
  QUOTE_MAX_VALIDITY_HOURS: number = 72;

  /** Highest service price a worker may quote, in halalas (5,000,000 = SAR 50,000). */
  @Transform(toInt(5000000))
  @IsInt()
  @Min(100)
  @Max(1000000000)
  QUOTE_MAX_PRICE_HALALAS: number = 5000000;

  /** Time the customer has to pay after accepting a quote (used by the payments phase). */
  @Transform(toInt(30))
  @IsInt()
  @Min(1)
  @Max(1440)
  PAYMENT_WINDOW_MINUTES: number = 30;

  /** `mock` is refused in production. The default is `disabled` in EVERY environment: simulation is opt-in. */
  @IsEnum(PaymentProviderName)
  @IsOptional()
  PAYMENT_PROVIDER?: PaymentProviderName;

  /** How long a hosted checkout stays valid (also capped by the booking's payment deadline). */
  @Transform(toInt(20))
  @IsInt()
  @Min(1)
  @Max(1440)
  PAYMENT_CHECKOUT_TTL_MINUTES: number = 20;

  /** A payment still PROCESSING after this long is reported as stale (never auto-resolved). */
  @Transform(toInt(30))
  @IsInt()
  @Min(1)
  @Max(10080)
  PAYMENT_STALE_AFTER_MINUTES: number = 30;

  /** Webhook bodies larger than this are rejected before any parsing or signature work. */
  @Transform(toInt(65536))
  @IsInt()
  @Min(1024)
  @Max(1048576)
  PAYMENT_WEBHOOK_MAX_BODY_BYTES: number = 65536;

  /** A webhook event stuck in PROCESSING longer than this may be claimed again. */
  @Transform(toInt(120))
  @IsInt()
  @Min(10)
  @Max(3600)
  PAYMENT_WEBHOOK_LEASE_SECONDS: number = 120;

  /** Comma-separated origins a checkout may return the customer to. Empty = no returnUrl accepted. */
  @IsString()
  @IsOptional()
  PAYMENT_RETURN_URL_ORIGINS: string = '';

  // ---- Phase 7: realtime, location, chat, background jobs ----

  /** Turns the Socket.IO server on or off. */
  @Transform(toBoolean)
  @IsBoolean()
  REALTIME_ENABLED: boolean = true;

  /** Use the Socket.IO Redis adapter so several API instances share rooms. Needs Redis; with one instance it may be turned off. */
  @Transform(toBoolean)
  @IsBoolean()
  REALTIME_REDIS_ADAPTER: boolean = true;

  /** Largest single socket message accepted (maxHttpBufferSize). */
  @Transform(toInt(16384))
  @IsInt()
  @Min(1024)
  @Max(262144)
  REALTIME_MAX_MESSAGE_BYTES: number = 16384;

  /** Open sockets per account on one instance; the oldest is closed when exceeded. */
  @Transform(toInt(5))
  @IsInt()
  @Min(1)
  @Max(50)
  REALTIME_MAX_SOCKETS_PER_USER: number = 5;

  /** After the access token expires a socket may stay open this long waiting for auth.refresh, then it is closed. */
  @Transform(toInt(30))
  @IsInt()
  @Min(0)
  @Max(600)
  REALTIME_TOKEN_GRACE_SECONDS: number = 30;

  /** How often an open socket re-checks its session and every booking room it sits in (access revoked = removed). */
  @Transform(toInt(60))
  @IsInt()
  @Min(1)
  @Max(3600)
  REALTIME_REVALIDATE_SECONDS: number = 60;

  /** The latest worker position disappears from Redis this long after the last accepted update. */
  @Transform(toInt(120))
  @IsInt()
  @Min(10)
  @Max(3600)
  LOCATION_TTL_SECONDS: number = 120;

  /** Updates closer together than this are rejected (per booking). */
  @Transform(toInt(2000))
  @IsInt()
  @Min(0)
  @Max(60000)
  LOCATION_MIN_INTERVAL_MS: number = 2000;

  /** Publish attempts per booking per minute (accepted or not). */
  @Transform(toInt(30))
  @IsInt()
  @Min(1)
  @Max(600)
  LOCATION_RATE_LIMIT_PER_MINUTE: number = 30;

  /** A position whose recordedAt is older than this is rejected as stale. */
  @Transform(toInt(30))
  @IsInt()
  @Min(1)
  @Max(600)
  LOCATION_MAX_AGE_SECONDS: number = 30;

  /** A recordedAt this far in the future is tolerated; more is rejected. */
  @Transform(toInt(10))
  @IsInt()
  @Min(0)
  @Max(120)
  LOCATION_MAX_CLOCK_SKEW_SECONDS: number = 10;

  /** Movement faster than this between two accepted positions is rejected as implausible (70 m/s = 252 km/h). */
  @Transform(toInt(70))
  @IsInt()
  @Min(1)
  @Max(340)
  LOCATION_MAX_SPEED_MPS: number = 70;

  /** Positions reporting a worse accuracy radius are rejected. */
  @Transform(toInt(500))
  @IsInt()
  @Min(1)
  @Max(100000)
  LOCATION_MAX_ACCURACY_METERS: number = 500;

  /** For a CONFIRMED booking, sharing is allowed only from this long before the preferred start time. 0 = no limit. IN_PROGRESS is always allowed. */
  @Transform(toInt(180))
  @IsInt()
  @Min(0)
  @Max(10080)
  LOCATION_SHARING_LEAD_MINUTES: number = 180;

  /** Longest chat message in characters (the database caps it at 2000). */
  @Transform(toInt(2000))
  @IsInt()
  @Min(1)
  @Max(2000)
  CHAT_MAX_BODY_CHARS: number = 2000;

  /** Messages one account may send per minute. */
  @Transform(toInt(30))
  @IsInt()
  @Min(1)
  @Max(600)
  CHAT_RATE_LIMIT_PER_MINUTE: number = 30;

  /** Largest page of chat history one request may return. */
  @Transform(toInt(100))
  @IsInt()
  @Min(1)
  @Max(200)
  CHAT_PAGE_SIZE_MAX: number = 100;

  /** Run the BullMQ workers (outbox delivery, cleanup, reports) in this process. Under NODE_ENV=test they stay off unless the JOBS_ENABLED variable is set to true. */
  @Transform(toBoolean)
  @IsBoolean()
  JOBS_ENABLED: boolean = true;

  /** Redis key prefix of the job queues (lets several environments share one Redis safely). */
  @IsString()
  @Matches(/^[a-zA-Z0-9_-]{1,40}$/)
  QUEUE_PREFIX: string = 'hs';

  /** How often pending realtime events are looked for. */
  @Transform(toInt(1000))
  @IsInt()
  @Min(200)
  @Max(60000)
  OUTBOX_POLL_INTERVAL_MS: number = 1000;

  /** Events delivered per run. */
  @Transform(toInt(50))
  @IsInt()
  @Min(1)
  @Max(500)
  OUTBOX_BATCH_SIZE: number = 50;

  /** Delivery attempts before an event is marked dead (reported, not retried forever). */
  @Transform(toInt(8))
  @IsInt()
  @Min(1)
  @Max(50)
  OUTBOX_MAX_ATTEMPTS: number = 8;

  /** Delivered or dead outbox rows are deleted after this many days. */
  @Transform(toInt(7))
  @IsInt()
  @Min(1)
  @Max(365)
  OUTBOX_RETENTION_DAYS: number = 7;

  /** An undelivered event older than this is reported as stale. */
  @Transform(toInt(5))
  @IsInt()
  @Min(1)
  @Max(1440)
  OUTBOX_STALE_AFTER_MINUTES: number = 5;

  // ---- Phase 8: private storage, scanning, notifications ----

  /** Hard ceiling for any uploaded file. Each category may allow less (booking photos 8 MiB). */
  @Transform(toInt(10485760))
  @IsInt()
  @Min(1024)
  @Max(104857600)
  STORAGE_MAX_FILE_BYTES: number = 10485760;

  /** Folder for DOCUMENT_STORAGE=local (development/test only). Default ./.storage (git-ignored). */
  @IsString()
  @IsOptional()
  STORAGE_LOCAL_DIR?: string;

  /** HMAC secret (>= 32 chars) that signs the short-lived URLs of DOCUMENT_STORAGE=local. Never logged. */
  @IsString()
  @IsOptional()
  @MinLength(32)
  STORAGE_SIGNING_SECRET?: string;

  /** Public base URL of this API (used to build signed URLs for DOCUMENT_STORAGE=local), e.g. http://127.0.0.1:3000. */
  @IsString()
  @IsOptional()
  PUBLIC_API_URL?: string;

  /** S3-compatible endpoint (https://...). Empty = AWS S3 in S3_REGION. */
  @IsString()
  @IsOptional()
  S3_ENDPOINT?: string;

  /** S3 region, e.g. me-south-1. */
  @IsString()
  @IsOptional()
  S3_REGION?: string;

  /** PRIVATE bucket name. Public access must stay blocked on the bucket. */
  @IsString()
  @IsOptional()
  S3_BUCKET?: string;

  /** S3 credentials come from the platform secret store. Never logged. */
  @IsString()
  @IsOptional()
  S3_ACCESS_KEY_ID?: string;

  /** S3 credentials come from the platform secret store. Never logged. */
  @IsString()
  @IsOptional()
  S3_SECRET_ACCESS_KEY?: string;

  /** Use https://endpoint/bucket/key instead of https://bucket.endpoint/key (MinIO and some S3-compatible services). */
  @Transform(toBoolean)
  @IsBoolean()
  S3_FORCE_PATH_STYLE: boolean = false;

  /** `mock` is a test double (refused in production). The default is `disabled`: files are never marked scanned. */
  @IsEnum(FileScannerName)
  @IsOptional()
  FILE_SCANNER?: FileScannerName;

  /** When true a file can only be downloaded once its scan result is CLEAN. Needs a scanner (not `disabled`). */
  @Transform(toBoolean)
  @IsBoolean()
  STORAGE_REQUIRE_CLEAN_SCAN: boolean = false;

  /**
   * Production only: explicit acknowledgement that files are served although they were never scanned (FILE_SCANNER=disabled).
   * Without it, production with DOCUMENT_STORAGE=s3 refuses to start until a scanner is integrated.
   */
  @Transform(toBoolean)
  @IsBoolean()
  STORAGE_ALLOW_UNSCANNED_FILES: boolean = false;

  /** Lifetime of upload links (booking photos and worker documents). Falls back to DOCUMENT_URL_TTL_SECONDS. */
  @Transform(toInt(0))
  @IsInt()
  @Min(0)
  @Max(3600)
  STORAGE_UPLOAD_URL_TTL_SECONDS: number = 0;

  /** Lifetime of booking-photo view links. 0 = use DOCUMENT_URL_TTL_SECONDS. */
  @Transform(toInt(0))
  @IsInt()
  @Min(0)
  @Max(3600)
  BOOKING_PHOTO_URL_TTL_SECONDS: number = 0;

  /** Lifetime of worker identity/licence document view links (administrators only). 0 = 300 seconds, or DOCUMENT_URL_TTL_SECONDS when that is shorter. Never above 900. */
  @Transform(toInt(0))
  @IsInt()
  @Min(0)
  @Max(900)
  IDENTITY_DOCUMENT_URL_TTL_SECONDS: number = 0;

  /** Scan attempts (including lease-expiry retries) before a file is parked as ERROR (never served). */
  @Transform(toInt(5))
  @IsInt()
  @Min(1)
  @Max(20)
  FILE_SCAN_MAX_ATTEMPTS: number = 5;

  /** How often the scan job looks for queued files. */
  @Transform(toInt(15))
  @IsInt()
  @Min(1)
  @Max(3600)
  FILE_SCAN_POLL_SECONDS: number = 15;

  /** A claimed scan that has not reported within this time is considered abandoned and may be claimed again. */
  @Transform(toInt(300))
  @IsInt()
  @Min(30)
  @Max(3600)
  FILE_SCAN_LEASE_SECONDS: number = 300;

  /** An upload that was never confirmed becomes eligible for cleanup after this many minutes. Must exceed the longest upload link (60 minutes) with margin. */
  @Transform(toInt(1440))
  @IsInt()
  @Min(120)
  @Max(43200)
  STORAGE_ABANDONED_UPLOAD_MIN_AGE_MINUTES: number = 1440;

  /** How often the abandoned-upload cleanup runs. */
  @Transform(toInt(10))
  @IsInt()
  @Min(1)
  @Max(1440)
  STORAGE_ABANDONED_UPLOAD_POLL_MINUTES: number = 10;

  /** Provider delete attempts before a stored-object removal is parked as dead (reported). */
  @Transform(toInt(8))
  @IsInt()
  @Min(1)
  @Max(50)
  STORAGE_DELETION_MAX_ATTEMPTS: number = 8;

  /** How often the job that removes stored objects runs. */
  @Transform(toInt(30))
  @IsInt()
  @Min(1)
  @Max(3600)
  STORAGE_DELETION_POLL_SECONDS: number = 30;

  /** Finished removal records are kept this long. */
  @Transform(toInt(7))
  @IsInt()
  @Min(1)
  @Max(365)
  STORAGE_DELETION_RETENTION_DAYS: number = 7;

  /**
   * `fcm` sends through Firebase Cloud Messaging (explicit opt-in, needs FIREBASE_PROJECT_ID, FIREBASE_SERVICE_ACCOUNT_BASE64 and
   * DEVICE_TOKEN_ENCRYPTION_KEY). `mock` accepts messages without sending anything (refused in production). Unset / `disabled` marks every
   * push UNSUPPORTED. Independent of FIREBASE_AUTH_ENABLED.
   */
  @IsEnum(PushProviderMode)
  @IsOptional()
  PUSH_PROVIDER?: PushProviderMode;

  /** With PUSH_PROVIDER=fcm: ask Firebase to validate every message WITHOUT delivering it (safe end-to-end check of credentials and payloads). */
  @Transform(toBoolean)
  @IsBoolean()
  FCM_DRY_RUN: boolean = false;

  /** Base64 of 32 random bytes; encrypts stored push tokens (AES-256-GCM). Without it device registration answers 503. Never logged. */
  @IsString()
  @IsOptional()
  DEVICE_TOKEN_ENCRYPTION_KEY?: string;

  /** Delivery attempts per notification target before it is marked FAILED. */
  @Transform(toInt(6))
  @IsInt()
  @Min(1)
  @Max(20)
  NOTIFICATION_MAX_ATTEMPTS: number = 6;

  /** Active push tokens per account; registering more revokes the oldest. */
  @Transform(toInt(10))
  @IsInt()
  @Min(1)
  @Max(50)
  MAX_DEVICE_TOKENS_PER_USER: number = 10;

  /** Number of reverse proxies in front of the API (for the real client IP). 0 = none. */
  @Transform(toInt(0))
  @IsInt()
  @Min(0)
  @Max(10)
  TRUST_PROXY_HOPS: number = 0;

  /**
   * Sign in with Firebase Phone Authentication: the app sends a Firebase ID token to POST /auth/firebase/phone and the server verifies it
   * with the Firebase Admin SDK. Off by default (the endpoint then answers 503). Independent of push notifications (PUSH_PROVIDER).
   */
  @Transform(toBoolean)
  @IsBoolean()
  FIREBASE_AUTH_ENABLED: boolean = false;

  /**
   * The Firebase project ID. Used by phone sign-in (the token audience, required when FIREBASE_AUTH_ENABLED=true) and by FCM (required when
   * PUSH_PROVIDER=fcm). Not a secret. Each feature is validated only when it is switched on.
   */
  @IsString()
  @IsOptional()
  FIREBASE_PROJECT_ID?: string;

  /**
   * Base64 of a Firebase service-account JSON file. SECRET: backend only, never in a mobile app, never logged. Needed for FCM
   * (PUSH_PROVIDER=fcm) and for the revocation check (FIREBASE_CHECK_REVOKED); not needed to verify ID tokens.
   */
  @IsString()
  @IsOptional()
  FIREBASE_SERVICE_ACCOUNT_BASE64?: string;

  /** Ask Firebase whether the user was disabled or the token revoked. Unset = on in production, off elsewhere. Needs the service account. */
  @Transform(({ value }) => (value === undefined || value === '' ? undefined : toBoolean({ value })))
  @IsBoolean()
  @IsOptional()
  FIREBASE_CHECK_REVOKED?: boolean;

  /** An ID token is exchanged only if the person verified their phone this recently (seconds). */
  @Transform(toInt(300))
  @IsInt()
  @Min(30)
  @Max(3600)
  FIREBASE_MAX_AUTH_AGE_SECONDS: number = 300;

  /**
   * DEMO ONLY. When false (default) a verified phone can sign in only to an account this Firebase sign-in flow created, or one it has
   * already signed in to with the SAME Firebase identity. When true, an existing account that has no recorded Firebase identity may be
   * adopted by phone match (still never an administrator, never an unverified phone). See docs/FIREBASE_SETUP.md, "Account linking".
   */
  @Transform(toBoolean)
  @IsBoolean()
  FIREBASE_ALLOW_PHONE_ACCOUNT_ADOPTION: boolean = false;

  /**
   * In production mode, adoption is refused unless this holds the EXACT value of FIREBASE_PROJECT_ID. A deliberate, mistake-proof second step
   * (a stray "true" is not enough): it is meant for a demo/staging Firebase project that runs in production mode, never for real users.
   */
  @IsString()
  @IsOptional()
  FIREBASE_ADOPTION_CONFIRM_PROJECT?: string;
}

const FIREBASE_PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

export interface FirebaseServiceAccountJson {
  project_id: string;
  client_email: string;
  private_key: string;
}

/** Decodes FIREBASE_SERVICE_ACCOUNT_BASE64. Errors never include any part of the value. */
export function parseFirebaseServiceAccount(base64: string): FirebaseServiceAccountJson {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
  } catch {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_BASE64 is not base64 of a JSON file');
  }
  const o = parsed as Partial<FirebaseServiceAccountJson> | null;
  if (!o || typeof o.project_id !== 'string' || typeof o.client_email !== 'string' || typeof o.private_key !== 'string' || !o.private_key.includes('PRIVATE KEY')) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_BASE64 is not a service-account key file (project_id, client_email, private_key)');
  }
  return { project_id: o.project_id, client_email: o.client_email, private_key: o.private_key };
}

/** Whether the revocation check is on: the setting, or (when unset) on in production. */
export function firebaseCheckRevoked(config: Pick<EnvironmentVariables, 'FIREBASE_CHECK_REVOKED' | 'NODE_ENV'>): boolean {
  return config.FIREBASE_CHECK_REVOKED ?? config.NODE_ENV === NodeEnv.Production;
}

/**
 * AWS's own variable names are accepted as fallbacks for the S3 settings, so a `.env` written from AWS's instructions works.
 * The S3_* name wins when both are set. Only used by DOCUMENT_STORAGE=s3.
 */
const AWS_ALIASES = {
  S3_REGION: 'AWS_REGION',
  S3_BUCKET: 'AWS_S3_BUCKET',
  S3_ACCESS_KEY_ID: 'AWS_ACCESS_KEY_ID',
  S3_SECRET_ACCESS_KEY: 'AWS_SECRET_ACCESS_KEY',
} as const;

function withAwsAliases(raw: Record<string, unknown>): Record<string, unknown> {
  const out = { ...raw };
  for (const [s3Name, awsName] of Object.entries(AWS_ALIASES)) {
    const value = out[s3Name];
    if ((value === undefined || value === '') && typeof raw[awsName] === 'string' && raw[awsName] !== '') out[s3Name] = raw[awsName];
  }
  return out;
}

export function validateEnv(input: Record<string, unknown>): EnvironmentVariables {
  const raw = withAwsAliases(input);
  const config = plainToInstance(EnvironmentVariables, raw, {
    enableImplicitConversion: false,
    exposeDefaultValues: true,
  });
  const errors = validateSync(config, { skipMissingProperties: false, whitelist: true });
  if (errors.length > 0) {
    const details = errors
      .map((e) => `${e.property}: ${Object.values(e.constraints ?? {}).join(', ')}`)
      .join('; ');
    throw new Error(`Invalid environment configuration — ${details}`);
  }

  const origins = parseOrigins(config.CORS_ORIGINS);
  if (config.NODE_ENV === NodeEnv.Production && origins.includes('*')) {
    throw new Error('Invalid environment configuration — CORS_ORIGINS must not contain "*" in production');
  }
  if (config.NODE_ENV !== NodeEnv.Test) {
    // Fails fast when the example placeholder was never replaced (see scripts/setup-local-env.ps1).
    for (const key of ['JWT_ACCESS_SECRET', 'OTP_HMAC_SECRET'] as const) {
      if (/change_?me/i.test(config[key])) {
        throw new Error(`Invalid environment configuration — ${key} still has the example placeholder value`);
      }
    }
  }
  if (config.NODE_ENV === NodeEnv.Production) {
    if (config.SMS_PROVIDER === SmsProviderName.Dev) {
      throw new Error('Invalid environment configuration — SMS_PROVIDER=dev is not allowed in production');
    }
    if (config.PAYMENT_PROVIDER === PaymentProviderName.Mock) {
      throw new Error('Invalid environment configuration — PAYMENT_PROVIDER=mock is not allowed in production');
    }
    if (config.DOCUMENT_STORAGE === DocumentStorageName.Dev || config.DOCUMENT_STORAGE === DocumentStorageName.Local) {
      throw new Error(`Invalid environment configuration — DOCUMENT_STORAGE=${config.DOCUMENT_STORAGE} is not allowed in production`);
    }
    if (config.FILE_SCANNER === FileScannerName.Mock || config.FILE_SCANNER === FileScannerName.MockAsync) {
      throw new Error(`Invalid environment configuration — FILE_SCANNER=${config.FILE_SCANNER} is not allowed in production`);
    }
    if (config.PUSH_PROVIDER === PushProviderMode.Mock) {
      throw new Error('Invalid environment configuration — PUSH_PROVIDER=mock is not allowed in production');
    }
    if (
      config.DOCUMENT_STORAGE === DocumentStorageName.S3 &&
      (config.FILE_SCANNER ?? FileScannerName.Disabled) === FileScannerName.Disabled &&
      !config.STORAGE_ALLOW_UNSCANNED_FILES
    ) {
      throw new Error(
        'Invalid environment configuration — production with DOCUMENT_STORAGE=s3 and FILE_SCANNER=disabled would serve unscanned files; integrate a scanner, or set STORAGE_ALLOW_UNSCANNED_FILES=true to accept that risk explicitly',
      );
    }
    if (config.JWT_ACCESS_SECRET === config.OTP_HMAC_SECRET) {
      throw new Error('Invalid environment configuration — JWT_ACCESS_SECRET and OTP_HMAC_SECRET must differ');
    }
    // Per-IP rate limits and audit IPs are only meaningful if the API knows how many proxies sit in front of it.
    const hops = raw['TRUST_PROXY_HOPS'];
    if (hops === undefined || hops === null || String(hops).trim() === '') {
      throw new Error('Invalid environment configuration — TRUST_PROXY_HOPS must be set explicitly in production (0 only when clients connect directly)');
    }
    for (const problem of [...databaseUrlProblems(config.DATABASE_URL), ...redisUrlProblems(config.REDIS_URL)]) {
      throw new Error(`Invalid environment configuration — ${problem}`);
    }
  }
  if (config.DOCUMENT_STORAGE === DocumentStorageName.Local && !config.STORAGE_SIGNING_SECRET) {
    throw new Error('Invalid environment configuration — DOCUMENT_STORAGE=local needs STORAGE_SIGNING_SECRET (at least 32 characters)');
  }
  if (config.DOCUMENT_STORAGE === DocumentStorageName.S3) {
    const missing = (['S3_REGION', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const).filter((k) => !config[k]);
    if (missing.length > 0) throw new Error(`Invalid environment configuration — DOCUMENT_STORAGE=s3 needs ${missing.join(', ')}`);
    if (config.S3_ENDPOINT && !/^https:\/\//.test(config.S3_ENDPOINT) && config.NODE_ENV === NodeEnv.Production) {
      throw new Error('Invalid environment configuration — S3_ENDPOINT must use https in production');
    }
  }
  if (config.STORAGE_REQUIRE_CLEAN_SCAN && (config.FILE_SCANNER ?? FileScannerName.Disabled) === FileScannerName.Disabled) {
    throw new Error('Invalid environment configuration — STORAGE_REQUIRE_CLEAN_SCAN=true needs a file scanner (FILE_SCANNER)');
  }
  if (config.DEVICE_TOKEN_ENCRYPTION_KEY && Buffer.from(config.DEVICE_TOKEN_ENCRYPTION_KEY, 'base64').length !== 32) {
    throw new Error('Invalid environment configuration — DEVICE_TOKEN_ENCRYPTION_KEY must be base64 of exactly 32 bytes');
  }
  // Firebase Cloud Messaging: only validated when PUSH_PROVIDER=fcm, and independent of phone sign-in.
  if (config.PUSH_PROVIDER === PushProviderMode.Fcm) {
    if (!config.FIREBASE_PROJECT_ID || !FIREBASE_PROJECT_ID_PATTERN.test(config.FIREBASE_PROJECT_ID)) {
      throw new Error('Invalid environment configuration — PUSH_PROVIDER=fcm needs FIREBASE_PROJECT_ID (the Firebase project ID, for example my-app-staging)');
    }
    if (!config.FIREBASE_SERVICE_ACCOUNT_BASE64) {
      throw new Error('Invalid environment configuration — PUSH_PROVIDER=fcm needs FIREBASE_SERVICE_ACCOUNT_BASE64 (a service-account key, backend only)');
    }
    let account: FirebaseServiceAccountJson;
    try {
      account = parseFirebaseServiceAccount(config.FIREBASE_SERVICE_ACCOUNT_BASE64);
    } catch (err) {
      throw new Error(`Invalid environment configuration — ${(err as Error).message}`);
    }
    if (account.project_id !== config.FIREBASE_PROJECT_ID) {
      throw new Error('Invalid environment configuration — the service account belongs to a different Firebase project than FIREBASE_PROJECT_ID');
    }
    if (!config.DEVICE_TOKEN_ENCRYPTION_KEY) {
      throw new Error('Invalid environment configuration — PUSH_PROVIDER=fcm needs DEVICE_TOKEN_ENCRYPTION_KEY (device tokens are stored encrypted)');
    }
  }
  // Firebase phone sign-in: only validated when it is switched on, and only the settings it needs.
  if (config.FIREBASE_AUTH_ENABLED) {
    if (!config.FIREBASE_PROJECT_ID || !FIREBASE_PROJECT_ID_PATTERN.test(config.FIREBASE_PROJECT_ID)) {
      throw new Error('Invalid environment configuration — FIREBASE_AUTH_ENABLED=true needs FIREBASE_PROJECT_ID (the Firebase project ID, for example my-app-staging)');
    }
    const revoked = firebaseCheckRevoked(config);
    if (config.FIREBASE_SERVICE_ACCOUNT_BASE64) {
      let account: FirebaseServiceAccountJson;
      try {
        account = parseFirebaseServiceAccount(config.FIREBASE_SERVICE_ACCOUNT_BASE64);
      } catch (err) {
        throw new Error(`Invalid environment configuration — ${(err as Error).message}`);
      }
      if (account.project_id !== config.FIREBASE_PROJECT_ID) {
        throw new Error('Invalid environment configuration — the service account belongs to a different Firebase project than FIREBASE_PROJECT_ID');
      }
    } else if (revoked) {
      throw new Error('Invalid environment configuration — the Firebase revocation check needs FIREBASE_SERVICE_ACCOUNT_BASE64 (or set FIREBASE_CHECK_REVOKED=false outside production)');
    }
    if (config.NODE_ENV === NodeEnv.Production && config.FIREBASE_ALLOW_PHONE_ACCOUNT_ADOPTION && config.FIREBASE_ADOPTION_CONFIRM_PROJECT !== config.FIREBASE_PROJECT_ID) {
      throw new Error('Invalid environment configuration — FIREBASE_ALLOW_PHONE_ACCOUNT_ADOPTION is demo-only: in production mode it also needs FIREBASE_ADOPTION_CONFIRM_PROJECT set to exactly FIREBASE_PROJECT_ID');
    }
    // With the emulator variable set, the Admin SDK accepts UNSIGNED tokens. Never let that reach production.
    if (config.NODE_ENV === NodeEnv.Production && (raw['FIREBASE_AUTH_EMULATOR_HOST'] ?? '') !== '') {
      throw new Error('Invalid environment configuration — FIREBASE_AUTH_EMULATOR_HOST must not be set in production (the SDK would accept unsigned tokens)');
    }
  }
  return config;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function parseConnectionUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined; // the format check on the variable reports this
  }
}

/** Production rules for DATABASE_URL. Messages never include the URL itself (it holds the password). */
export function databaseUrlProblems(value: string): string[] {
  const url = parseConnectionUrl(value);
  if (!url || LOOPBACK_HOSTS.has(url.hostname)) return [];
  const problems: string[] = [];
  if (!url.password) problems.push('DATABASE_URL must include a password for a non-local database in production');
  const mode = url.searchParams.get('sslmode');
  if (!mode || !['require', 'verify-ca', 'verify-full'].includes(mode)) {
    problems.push('DATABASE_URL must use TLS (sslmode=require, verify-ca or verify-full) for a non-local database in production');
  }
  return problems;
}

/** Production rules for REDIS_URL. Messages never include the URL itself. */
export function redisUrlProblems(value: string): string[] {
  const url = parseConnectionUrl(value);
  if (!url || LOOPBACK_HOSTS.has(url.hostname)) return [];
  const problems: string[] = [];
  if (!url.password) problems.push('REDIS_URL must include a password for a non-local Redis in production');
  if (url.protocol !== 'rediss:') problems.push('REDIS_URL must use TLS (rediss://) for a non-local Redis in production');
  return problems;
}

export function parseOrigins(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}
