import { Controller, Get, HttpCode, Put, Query, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Public } from '../../../common/decorators/public.decorator.js';
import { RateLimit } from '../../../common/decorators/rate-limit.decorator.js';
import { ApiError, badRequest, forbidden } from '../../../common/errors/api-error.js';
import { DocumentStorage } from '../../workers/storage/document-storage.js';
import { detectMime } from '../file-signature.js';
import { LocalDocumentStorage, LocalStorageError, STORAGE_KEY_RE } from './local-document-storage.js';
import { verifyLocalUrl } from './signed-url.js';

/**
 * The two URLs that LocalDocumentStorage hands out (upload and download). Public routes whose ONLY credential is
 * the HMAC signature in the query (key, operation, expiry, exact size and type for uploads). They exist only
 * while DOCUMENT_STORAGE=local (never in production); with any other provider they answer 404.
 */
@ApiExcludeController()
@Public()
@Controller({ path: 'storage/local/objects', version: '1' })
export class LocalStorageController {
  constructor(private readonly storage: DocumentStorage) {}

  private local(): LocalDocumentStorage {
    if (!(this.storage instanceof LocalDocumentStorage)) throw new ApiError(404, 'NOT_FOUND', 'Not found');
    return this.storage;
  }

  private check(local: LocalDocumentStorage, op: 'put' | 'get', q: Record<string, string | undefined>) {
    const key = q['key'];
    const exp = Number(q['exp']);
    const sig = q['sig'];
    if (!key || !sig || q['op'] !== op || !STORAGE_KEY_RE.test(key)) throw forbidden('SIGNATURE_INVALID', 'The link is not valid');
    const size = q['size'] !== undefined ? Number(q['size']) : undefined;
    if (!verifyLocalUrl(local.secret, { op, key, exp, size, type: q['type'] }, sig)) {
      throw forbidden('SIGNATURE_INVALID', 'The link is invalid or has expired');
    }
    return { key, size, type: q['type'] };
  }

  @Put()
  @HttpCode(200)
  @RateLimit({ name: 'local-upload', limit: 120, windowSeconds: 600 })
  async upload(@Query() q: Record<string, string | undefined>, @Req() req: Request): Promise<{ stored: true }> {
    const local = this.local();
    const { key, size, type } = this.check(local, 'put', q);
    const contentType = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    if (!type || contentType !== type) throw badRequest('CONTENT_TYPE_MISMATCH', 'The Content-Type does not match the signed upload');
    if (size === undefined || Number(req.headers['content-length']) !== size) throw badRequest('CONTENT_LENGTH_MISMATCH', 'The Content-Length does not match the signed upload');
    try {
      await local.store(key, req, size);
    } catch (err) {
      if (err instanceof LocalStorageError) {
        if (err.code === 'EXISTS') throw new ApiError(409, 'OBJECT_EXISTS', 'An object already exists at this location');
        if (err.code === 'TOO_LARGE') throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'The upload is larger than allowed');
        throw badRequest('UPLOAD_INCOMPLETE', 'The upload did not match the signed size');
      }
      throw err;
    }
    return { stored: true };
  }

  @Get()
  @RateLimit({ name: 'local-download', limit: 300, windowSeconds: 600 })
  async download(@Query() q: Record<string, string | undefined>, @Res() res: Response): Promise<void> {
    const local = this.local();
    const { key } = this.check(local, 'get', q);
    const inspection = await local.inspect(key);
    if (!inspection) throw new ApiError(404, 'NOT_FOUND', 'Not found');
    res.setHeader('Content-Type', detectMime(inspection.head) ?? 'application/octet-stream');
    res.setHeader('Content-Length', String(inspection.sizeBytes));
    res.setHeader('Content-Disposition', 'attachment');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    local.openRead(key).pipe(res);
  }
}
