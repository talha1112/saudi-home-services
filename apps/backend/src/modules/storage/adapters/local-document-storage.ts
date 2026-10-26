import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { link, mkdir, open, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_CONFIG, type AppConfig, type StorageConfig } from '../../../config/app.config.js';
import { DocumentStorage, type DownloadTarget, type ObjectInspection, type UploadTarget } from '../../workers/storage/document-storage.js';
import { signLocalUrl } from './signed-url.js';

/** Only keys the API itself generates are accepted: no user-supplied name, no traversal, no odd characters. */
export const STORAGE_KEY_RE = /^(workers|bookings)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/(documents|photos)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class LocalStorageError extends Error {
  constructor(readonly code: 'INVALID_KEY' | 'TOO_LARGE' | 'SIZE_MISMATCH' | 'EXISTS') {
    super(code);
  }
}

/**
 * DEVELOPMENT / TEST ONLY (refused in production). Real bytes on local disk, reachable only through
 * short-lived HMAC-signed URLs served by StorageLocalController. It exercises the same flow, validation and
 * failure handling a real S3-compatible adapter goes through, without any account or Docker.
 *
 * Safety: keys must match STORAGE_KEY_RE; objects are written exclusively (an existing object is never
 * overwritten); the folder is outside any static-file route.
 */
@Injectable()
export class LocalDocumentStorage extends DocumentStorage {
  private readonly root: string;
  readonly cfg: StorageConfig;

  constructor(config: ConfigService) {
    super();
    this.cfg = config.getOrThrow<AppConfig>(APP_CONFIG).storage;
    this.root = resolve(this.cfg.localDir);
  }

  get secret(): string {
    if (!this.cfg.signingSecret) throw new Error('STORAGE_SIGNING_SECRET is not configured');
    return this.cfg.signingSecret;
  }

  pathFor(storageKey: string): string {
    if (!STORAGE_KEY_RE.test(storageKey)) throw new LocalStorageError('INVALID_KEY');
    const full = resolve(join(this.root, ...storageKey.split('/')));
    if (!full.startsWith(this.root + sep)) throw new LocalStorageError('INVALID_KEY'); // belt and braces
    return full;
  }

  private url(op: 'put' | 'get', key: string, ttlSeconds: number, extra: { size?: number; type?: string } = {}): { url: string; expiresAt: Date } {
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    const exp = Math.floor(expiresAt.getTime() / 1000);
    const sig = signLocalUrl(this.secret, { op, key, exp, ...extra });
    const q = new URLSearchParams({ op, key, exp: String(exp), ...(extra.size !== undefined ? { size: String(extra.size) } : {}), ...(extra.type ? { type: extra.type } : {}), sig });
    return { url: `${this.cfg.publicApiUrl}/api/v1/storage/local/objects?${q.toString()}`, expiresAt };
  }

  async createUploadTarget(input: { storageKey: string; mimeType: string; sizeBytes: number; ttlSeconds: number }): Promise<UploadTarget> {
    this.pathFor(input.storageKey);
    const { url, expiresAt } = this.url('put', input.storageKey, input.ttlSeconds, { size: input.sizeBytes, type: input.mimeType });
    return { uploadUrl: url, method: 'PUT', headers: { 'Content-Type': input.mimeType }, expiresAt };
  }

  async createDownloadTarget(storageKey: string, ttlSeconds: number): Promise<DownloadTarget> {
    this.pathFor(storageKey);
    return this.url('get', storageKey, ttlSeconds);
  }

  async exists(storageKey: string): Promise<boolean> {
    try {
      return (await stat(this.pathFor(storageKey))).isFile();
    } catch {
      return false;
    }
  }

  async inspect(storageKey: string): Promise<ObjectInspection | null> {
    const path = this.pathFor(storageKey);
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch {
      return null;
    }
    const handle = await open(path, 'r');
    try {
      const buf = Buffer.alloc(Math.min(128, size));
      await handle.read(buf, 0, buf.length, 0);
      return { sizeBytes: size, head: buf };
    } finally {
      await handle.close();
    }
  }

  async delete(storageKey: string): Promise<void> {
    await rm(this.pathFor(storageKey), { force: true }); // "already gone" is success
  }

  /** Writes the request body to a temp file, then links it into place; never overwrites. */
  async store(storageKey: string, body: Readable, expectedSize: number): Promise<void> {
    const final = this.pathFor(storageKey);
    await mkdir(dirname(final), { recursive: true });
    const tmp = `${final}.${randomUUID()}.part`;
    let received = 0;
    const guard = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        received += chunk.length;
        if (received > expectedSize) return cb(new LocalStorageError('TOO_LARGE'));
        cb(null, chunk);
      },
    });
    try {
      await pipeline(body, guard, createWriteStream(tmp, { flags: 'wx' }));
      if (received !== expectedSize) throw new LocalStorageError('SIZE_MISMATCH');
      try {
        await link(tmp, final); // fails if it already exists
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new LocalStorageError('EXISTS');
        throw err;
      }
    } finally {
      await rm(tmp, { force: true });
    }
  }

  openRead(storageKey: string): Readable {
    return createReadStream(this.pathFor(storageKey));
  }

  async openReadStream(storageKey: string): Promise<Readable> {
    if (!(await this.exists(storageKey))) throw new Error('STORAGE_OBJECT_MISSING');
    return this.openRead(storageKey);
  }
}
