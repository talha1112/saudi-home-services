import { jest } from '@jest/globals';
import { ArgumentsHost, BadRequestException, HttpStatus, Logger, NotFoundException } from '@nestjs/common';
import { ApiError } from '../errors/api-error.js';
import { AllExceptionsFilter, type ErrorResponseBody } from './all-exceptions.filter.js';

function run(exception: unknown) {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const setHeader = jest.fn();
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ status, setHeader }),
      getRequest: () => ({ url: '/v1/thing', originalUrl: '/api/v1/thing', id: 'req-1' }),
    }),
  } as unknown as ArgumentsHost;
  new AllExceptionsFilter().catch(exception, host);
  return { status, setHeader, body: json.mock.calls[0][0] as ErrorResponseBody };
}

describe('AllExceptionsFilter', () => {
  beforeEach(() => {
    // Unexpected errors are logged on purpose; keep test output clean.
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('formats HttpExceptions with their status and message', () => {
    const { status, body } = run(new NotFoundException('No such booking'));
    expect(status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    expect(body).toMatchObject({ statusCode: 404, message: 'No such booking', path: '/api/v1/thing', requestId: 'req-1' });
  });

  it('keeps validation message arrays', () => {
    const { body } = run(new BadRequestException(['name must be a string']));
    expect(body.statusCode).toBe(400);
    expect(body.message).toEqual(['name must be a string']);
  });

  it('hides the details of unexpected errors', () => {
    const { status, body } = run(new Error('db password is hunter2'));
    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(body.message).toBe('Something went wrong');
    expect(JSON.stringify(body)).not.toContain('hunter2');
  });

  it('turns database-unreachable errors into a 503 without internals', () => {
    const wrapped = Object.assign(new Error('Cannot reach database server at 10.0.0.5:5432 user=app pass=hunter2'), { code: 'P1001' });
    const { status, body } = run(wrapped);
    expect(status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
    expect(body).toMatchObject({ statusCode: 503, code: 'SERVICE_UNAVAILABLE' });
    expect(JSON.stringify(body)).not.toMatch(/hunter2|10\.0\.0\.5|P1001/);

    const viaCause = run(Object.assign(new Error('query failed'), { cause: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }) }));
    expect(viaCause.body.statusCode).toBe(503);
  });

  it('does not treat other database errors (bugs, constraint violations) as outages', () => {
    const { body } = run(Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }));
    expect(body.statusCode).toBe(500);
  });

  it('exposes the stable code and Retry-After for rate limits', () => {
    const { setHeader, body } = run(new ApiError(429, 'RATE_LIMITED', 'Slow down', { retryAfterSeconds: 42 }));
    expect(setHeader).toHaveBeenCalledWith('Retry-After', '42');
    expect(body).toMatchObject({ statusCode: 429, code: 'RATE_LIMITED', retryAfterSeconds: 42 });
  });
});
