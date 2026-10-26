import { Readable } from 'node:stream';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_CONFIG, type AppConfig, type StorageConfig } from '../../../config/app.config.js';
import { DocumentStorage, type DownloadTarget, type ObjectInspection, type UploadTarget } from '../../workers/storage/document-storage.js';
import { STORAGE_KEY_RE } from './local-document-storage.js';
import { awsEncode, presignQuery, signedHeaders } from './sigv4.js';

const REQUEST_TIMEOUT_MS = 10_000;
/** Whole-object reads for the scanner (up to the upload ceiling) get a longer overall limit than metadata calls. */
const STREAM_TIMEOUT_MS = 120_000;
/** Reads, HEADs and DELETEs are idempotent, so a transient failure is retried a couple of times before it is reported. */
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 150;
/** Throttling and server-side failures that normally succeed on a repeat (S3 answers 503 SlowDown under load). */
const TRANSIENT_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/**
 * S3-compatible object storage (AWS S3, MinIO, and other services that speak SigV4 for S3).
 *
 * Unit tests cover AWS's published SigV4 test vector, URL shapes, request signing, retries and failure mapping.
 * Real-provider behaviour is only proven by `npm run test:s3-smoke` (see docs/STORAGE_NOTIFICATIONS_OFFERS.md); run it
 * against the staging bucket before relying on this adapter.
 *
 * Rules: the bucket must be PRIVATE (block public access at the bucket/account level); all access is through
 * presigned URLs of a few minutes. Uploads sign Content-Type and Content-Length, so a client cannot upload a
 * different type or size than the API registered. Credentials come from the environment and are never logged.
 */
@Injectable()
export class S3DocumentStorage extends DocumentStorage {
  private readonly logger = new Logger(S3DocumentStorage.name);
  private readonly cfg: StorageConfig['s3'];
  private readonly clock: () => Date;

  constructor(config: ConfigService, clock: () => Date = () => new Date()) {
    super();
    this.cfg = config.getOrThrow<AppConfig>(APP_CONFIG).storage.s3;
    this.clock = clock;
  }

  private target(key: string): { host: string; path: string; origin: string } {
    if (!STORAGE_KEY_RE.test(key)) throw new Error('INVALID_STORAGE_KEY');
    const region = this.cfg.region!;
    const bucket = this.cfg.bucket!;
    const endpoint = new URL(this.cfg.endpoint ?? `https://s3.${region}.amazonaws.com`);
    const encodedKey = awsEncode(key, true);
    if (this.cfg.forcePathStyle) {
      return { host: endpoint.host, path: `/${bucket}/${encodedKey}`, origin: endpoint.origin };
    }
    const host = `${bucket}.${endpoint.host}`;
    return { host, path: `/${encodedKey}`, origin: `${endpoint.protocol}//${host}` };
  }

  private presign(method: 'GET' | 'PUT', key: string, ttlSeconds: number, signed: Record<string, string> = {}, extraQuery: Record<string, string> = {}): { url: string; expiresAt: Date } {
    const { host, path, origin } = this.target(key);
    const now = this.clock();
    const qs = presignQuery({
      method,
      host,
      path,
      accessKeyId: this.cfg.accessKeyId!,
      secretAccessKey: this.cfg.secretAccessKey!,
      region: this.cfg.region!,
      expiresSeconds: ttlSeconds,
      now,
      signedHeaders: signed,
      extraQuery,
    });
    return { url: `${origin}${path}?${qs}`, expiresAt: new Date(now.getTime() + ttlSeconds * 1000) };
  }

  async createUploadTarget(input: { storageKey: string; mimeType: string; sizeBytes: number; ttlSeconds: number }): Promise<UploadTarget> {
    const { url, expiresAt } = this.presign('PUT', input.storageKey, input.ttlSeconds, {
      'content-type': input.mimeType,
      'content-length': String(input.sizeBytes),
    });
    return { uploadUrl: url, method: 'PUT', headers: { 'Content-Type': input.mimeType, 'Content-Length': String(input.sizeBytes) }, expiresAt };
  }

  async createDownloadTarget(storageKey: string, ttlSeconds: number): Promise<DownloadTarget> {
    return this.presign('GET', storageKey, ttlSeconds, {}, { 'response-content-disposition': 'attachment' });
  }

  /** One signed request with a bounded retry on network errors and transient statuses. The final response is returned as is. */
  private async request(method: 'GET' | 'HEAD' | 'DELETE', key: string, headers: Record<string, string> = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
    const { host, path, origin } = this.target(key);
    for (let attempt = 1; ; attempt++) {
      const signed = signedHeaders({
        method,
        host,
        path,
        accessKeyId: this.cfg.accessKeyId!,
        secretAccessKey: this.cfg.secretAccessKey!,
        region: this.cfg.region!,
        now: this.clock(), // signed afresh on each attempt
        headers,
      });
      try {
        const res = await fetch(`${origin}${path}`, { method, headers: signed, signal: AbortSignal.timeout(timeoutMs) });
        if (!TRANSIENT_STATUS.has(res.status) || attempt >= MAX_ATTEMPTS) return res;
        await res.body?.cancel().catch(() => undefined); // release the connection before retrying
      } catch (err) {
        this.logger.warn(`Object storage request failed (attempt ${attempt}): ${(err as Error).name}`); // never the URL
        if (attempt >= MAX_ATTEMPTS) throw new Error('STORAGE_UNREACHABLE');
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * attempt));
    }
  }

  async exists(storageKey: string): Promise<boolean> {
    const res = await this.request('HEAD', storageKey);
    if (res.status === 404) return false;
    if (!res.ok) throw new Error(`STORAGE_ERROR_${res.status}`);
    return true;
  }

  async inspect(storageKey: string): Promise<ObjectInspection | null> {
    const head = await this.request('HEAD', storageKey);
    if (head.status === 404) return null;
    if (!head.ok) throw new Error(`STORAGE_ERROR_${head.status}`);
    const sizeBytes = Number(head.headers.get('content-length'));
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) throw new Error('STORAGE_BAD_RESPONSE');
    const res = await this.request('GET', storageKey, { range: 'bytes=0-127' });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`STORAGE_ERROR_${res.status}`);
    try {
      return { sizeBytes, head: Buffer.from(await res.arrayBuffer()).subarray(0, 128) };
    } catch (err) {
      this.logger.warn(`Object storage read failed: ${(err as Error).name}`); // a dropped connection mid-body
      throw new Error('STORAGE_UNREACHABLE');
    }
  }

  async openReadStream(storageKey: string): Promise<Readable> {
    const res = await this.request('GET', storageKey, {}, STREAM_TIMEOUT_MS);
    if (res.status === 404) throw new Error('STORAGE_OBJECT_MISSING');
    if (!res.ok || !res.body) throw new Error(`STORAGE_ERROR_${res.status}`);
    return Readable.fromWeb(res.body as never);
  }

  async delete(storageKey: string): Promise<void> {
    const res = await this.request('DELETE', storageKey);
    if (res.status === 404 || res.ok) return; // S3 answers 204 for a missing key too; both mean "gone"
    throw new Error(`STORAGE_ERROR_${res.status}`);
  }
}
