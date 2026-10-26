import { describeError, describeErrorForLog, scrubSensitiveText } from './safe-error.js';

describe('scrubSensitiveText', () => {
  it('removes credentials, tokens and signed links, and bounds the length', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdef';
    const out = scrubSensitiveText(`connect postgresql://app:Sup3rSecret@db.example.com/x Bearer ${jwt} ${jwt} https://s.example/f?X-Amz-Signature=deadbeef&a=1 password=hunter2 token: abc123`);
    for (const leaked of ['Sup3rSecret', jwt, 'deadbeef', 'hunter2', 'abc123']) expect(out).not.toContain(leaked);
    expect(out).toContain('db.example.com');
    expect(scrubSensitiveText('x'.repeat(1000)).length).toBe(303);
  });

  it('leaves ordinary text alone', () => {
    expect(scrubSensitiveText('connect ECONNREFUSED 127.0.0.1:6379')).toBe('connect ECONNREFUSED 127.0.0.1:6379');
  });
});

describe('describeError', () => {
  it('never quotes the text of a database error, only its class and code', () => {
    class PrismaClientKnownRequestError extends Error {
      code = 'P2002';
      clientVersion = '7.0.0';
    }
    const err = new PrismaClientKnownRequestError('Unique constraint failed on phone "+966512345678" for token abc');
    expect(describeError(err)).toBe('PrismaClientKnownRequestError:P2002');
    const driver = Object.assign(new Error('duplicate key value violates unique constraint; Key (phone)=(+966512345678) already exists'), { severity: 'ERROR', code: '23505' });
    expect(describeError(driver)).toBe('Error:23505');
  });

  it('keeps a scrubbed message for other errors and copes with non-errors', () => {
    expect(describeError(new TypeError('bad value for password=hunter2'))).toBe('TypeError: bad value for password=<redacted>');
    expect(describeError('boom')).toBe('non-error thrown');
  });

  it('logs frames without the message line', () => {
    const err = new Error('secret message token=abc');
    const out = describeErrorForLog(err);
    expect(out.stack ?? '').not.toContain('secret message');
    expect(out.stack ?? '').toContain('at ');
  });
});
