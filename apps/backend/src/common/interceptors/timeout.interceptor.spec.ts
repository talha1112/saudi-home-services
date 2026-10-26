import { jest } from '@jest/globals';
import { CallHandler, ExecutionContext, RequestTimeoutException } from '@nestjs/common';
import { NEVER, firstValueFrom, of } from 'rxjs';
import { TimeoutInterceptor } from './timeout.interceptor.js';

const ctx = {} as ExecutionContext;

describe('TimeoutInterceptor', () => {
  it('passes values through when fast enough', async () => {
    const handler: CallHandler = { handle: () => of('ok') };
    await expect(firstValueFrom(new TimeoutInterceptor(100).intercept(ctx, handler))).resolves.toBe('ok');
  });

  it('throws RequestTimeoutException when the handler is too slow', async () => {
    const handler: CallHandler = { handle: () => NEVER };
    await expect(firstValueFrom(new TimeoutInterceptor(10).intercept(ctx, handler))).rejects.toBeInstanceOf(
      RequestTimeoutException,
    );
  });

  it('is disabled when the timeout is 0', () => {
    const handle = jest.fn(() => of('ok'));
    new TimeoutInterceptor(0).intercept(ctx, { handle });
    expect(handle).toHaveBeenCalledTimes(1);
  });
});
