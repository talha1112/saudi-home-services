import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  RequestTimeoutException,
} from '@nestjs/common';
import { Observable, TimeoutError, catchError, throwError, timeout } from 'rxjs';

/** Fails requests that exceed `timeoutMs` with a 408. A value of 0 disables it. */
@Injectable()
export class TimeoutInterceptor implements NestInterceptor {
  constructor(private readonly timeoutMs: number) {}

  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (this.timeoutMs <= 0) return next.handle();
    return next.handle().pipe(
      timeout(this.timeoutMs),
      catchError((err: unknown) =>
        err instanceof TimeoutError ? throwError(() => new RequestTimeoutException()) : throwError(() => err),
      ),
    );
  }
}
