import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * HttpException that carries a stable machine-readable `code` next to the
 * human-readable message, so clients can branch on the code and not on text.
 */
export class ApiError extends HttpException {
  constructor(
    status: HttpStatus,
    readonly code: string,
    message: string,
    extra: { retryAfterSeconds?: number; attemptsRemaining?: number; details?: Record<string, unknown> } = {},
  ) {
    super({ message, code, error: HttpStatus[status], ...extra }, status);
  }
}

export const unauthorized = (code: string, message: string) => new ApiError(HttpStatus.UNAUTHORIZED, code, message);
export const forbidden = (code: string, message: string) => new ApiError(HttpStatus.FORBIDDEN, code, message);
export const badRequest = (code: string, message: string) => new ApiError(HttpStatus.BAD_REQUEST, code, message);
export const badRequestWith = (code: string, message: string, details: Record<string, unknown>) =>
  new ApiError(HttpStatus.BAD_REQUEST, code, message, { details });
export const unavailable = (code: string, message: string) =>
  new ApiError(HttpStatus.SERVICE_UNAVAILABLE, code, message);
export const tooManyRequests = (code: string, message: string, retryAfterSeconds: number) =>
  new ApiError(HttpStatus.TOO_MANY_REQUESTS, code, message, { retryAfterSeconds: Math.max(1, retryAfterSeconds) });
