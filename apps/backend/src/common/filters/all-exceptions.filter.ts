import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { describeErrorForLog } from '../logging/safe-error.js';

export interface ErrorResponseBody {
  statusCode: number;
  error: string;
  message: string | string[];
  /** Stable machine-readable code for clients, e.g. OTP_EXPIRED. */
  code?: string;
  retryAfterSeconds?: number;
  attemptsRemaining?: number;
  /** Machine-readable extras, e.g. the list of missing onboarding items. */
  details?: Record<string, unknown>;
  path: string;
  timestamp: string;
  requestId?: string;
}

interface Extra {
  retryAfterSeconds?: number;
  attemptsRemaining?: number;
  details?: Record<string, unknown>;
}

/** Prisma/driver errors that mean "the database cannot be reached", as opposed to a bug. */
const DB_UNAVAILABLE_PRISMA_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024']);
const DB_UNAVAILABLE_NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', '57P01', '57P03']);

function isDatabaseUnavailable(exception: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = exception;
  // Prisma wraps the driver error, so look through `cause` as well.
  while (current && typeof current === 'object' && !seen.has(current) && seen.size < 5) {
    seen.add(current);
    const { code, name, cause } = current as { code?: unknown; name?: unknown; cause?: unknown };
    if (typeof code === 'string' && (DB_UNAVAILABLE_PRISMA_CODES.has(code) || DB_UNAVAILABLE_NETWORK_CODES.has(code))) {
      return true;
    }
    if (name === 'PrismaClientInitializationError') return true;
    current = cause;
  }
  return false;
}

/**
 * Turns every thrown error into one JSON shape. Unexpected errors are logged
 * with their stack but never leak internals to the client.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request & { id?: string | number }>();
    // originalUrl keeps the global prefix; req.url is relative to it.
    const path = req.originalUrl ?? req.url;

    const { status, error, message, code, extra } = this.normalize(exception);
    if (extra.retryAfterSeconds) res.setHeader('Retry-After', String(extra.retryAfterSeconds));

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      // Never the raw error object: database errors quote failing rows, and any message may carry a URL or token.
      const { error, stack } = describeErrorForLog(exception);
      this.logger.error({ requestId: req.id, path, stack }, error);
    }

    const body: ErrorResponseBody = {
      statusCode: status,
      error,
      message,
      code,
      ...extra,
      path,
      timestamp: new Date().toISOString(),
      requestId: req.id === undefined ? undefined : String(req.id),
    };
    res.status(status).json(body);
  }

  private normalize(exception: unknown): {
    status: number;
    error: string;
    message: string | string[];
    code?: string;
    extra: Extra;
  } {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      if (typeof response === 'string') {
        return { status, error: HttpStatus[status] ?? 'Error', message: response, extra: {} };
      }
      const r = response as Extra & { message?: string | string[]; error?: string; code?: string };
      return {
        status,
        error: r.error ?? HttpStatus[status] ?? 'Error',
        message: r.message ?? exception.message,
        code: r.code,
        extra: { retryAfterSeconds: r.retryAfterSeconds, attemptsRemaining: r.attemptsRemaining, details: r.details },
      };
    }
    if (isDatabaseUnavailable(exception)) {
      return {
        status: HttpStatus.SERVICE_UNAVAILABLE,
        error: HttpStatus[HttpStatus.SERVICE_UNAVAILABLE],
        message: 'The service is temporarily unavailable. Please try again shortly',
        code: 'SERVICE_UNAVAILABLE',
        extra: {},
      };
    }
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      error: 'Internal Server Error',
      message: 'Something went wrong',
      extra: {},
    };
  }
}
