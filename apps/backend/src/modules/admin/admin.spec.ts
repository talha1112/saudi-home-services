import { REDACTED, redactAuditMetadata } from '../auth/audit.service.js';
import { average } from '../reviews/reviews.service.js';
import { MAX_RANGE_DAYS, resolveRange } from '../reports/reports.service.js';
import { maskEmail, maskPhone } from './admin-users.service.js';

describe('audit redaction', () => {
  it('redacts credential-like keys whatever their value, and leaves ordinary context alone', () => {
    const out = redactAuditMetadata({
      password: 'p', newPassword: 'p', accessToken: 'a', refresh_token: 'r', clientSecret: 's', apiSecret: 's', authorization: 'x', cookie: 'c',
      signedUrl: 'https://a', downloadUrl: 'https://a', otpCode: '123456', storageKey: 'workers/x', signature: 'sig',
      beforeStatus: 'ACTIVE', afterStatus: 'SUSPENDED', reason: 'Because', count: 3, flag: false, nothing: null,
    })!;
    for (const k of ['password', 'newPassword', 'accessToken', 'refresh_token', 'clientSecret', 'apiSecret', 'authorization', 'cookie', 'signedUrl', 'downloadUrl', 'otpCode', 'storageKey', 'signature']) {
      expect({ k, v: out[k] }).toEqual({ k, v: REDACTED });
    }
    expect(out).toMatchObject({ beforeStatus: 'ACTIVE', afterStatus: 'SUSPENDED', reason: 'Because', count: 3, flag: false, nothing: null });
  });

  it('redacts credential-looking VALUES under innocent keys and truncates long text', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc';
    const out = redactAuditMetadata({ a: `Bearer ${jwt}`, b: jwt, c: 'https://x.example/f?X-Amz-Signature=deadbeef', d: 'see https://x.example/f?sig=abc', e: '-----BEGIN PRIVATE KEY-----', f: 'x'.repeat(1000), g: 'a normal sentence' })!;
    for (const k of ['a', 'b', 'c', 'd', 'e']) expect(out[k]).toBe(REDACTED);
    expect((out['f'] as string).length).toBe(303);
    expect(out['g']).toBe('a normal sentence');
  });

  it('passes undefined through and never mutates its input', () => {
    expect(redactAuditMetadata(undefined)).toBeUndefined();
    const input = { token: 't', ok: 'fine' };
    redactAuditMetadata(input);
    expect(input).toEqual({ token: 't', ok: 'fine' });
  });
});

describe('masking', () => {
  it('shows only the start and end of a phone number and the first letter of an e-mail', () => {
    expect(maskPhone('+966512345678')).toBe('+9665••••5678');
    expect(maskPhone(null)).toBeNull();
    expect(maskEmail('layla@example.com')).toBe('l•••@example.com');
    expect(maskEmail(null)).toBeNull();
    expect(maskPhone('+966512345678')).not.toContain('1234');
  });
});

describe('report ranges', () => {
  const now = new Date('2026-11-01T12:00:00.000Z');
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return (e as { code?: string }).code;
    }
    return 'ok';
  };

  it('defaults to the last 30 days ending now', () => {
    const r = resolveRange(undefined, undefined, now);
    expect(r.to).toEqual(now);
    expect(now.getTime() - r.from.getTime()).toBe(30 * 86_400_000);
    expect(resolveRange('2026-10-01T00:00:00Z', undefined, now).to).toEqual(now);
  });

  it('rejects empty, inverted, invalid and over-long ranges, and accepts exactly the maximum', () => {
    expect(code(() => resolveRange('2026-11-02T00:00:00Z', '2026-11-01T00:00:00Z'))).toBe('INVALID_RANGE');
    expect(code(() => resolveRange('2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z'))).toBe('INVALID_RANGE');
    expect(code(() => resolveRange('garbage', undefined, now))).toBe('INVALID_RANGE');
    expect(code(() => resolveRange('2025-01-01T00:00:00Z', '2026-11-01T00:00:00Z'))).toBe('INVALID_RANGE');
    const to = new Date('2026-11-01T00:00:00Z');
    expect(code(() => resolveRange(new Date(to.getTime() - MAX_RANGE_DAYS * 86_400_000).toISOString(), to.toISOString()))).toBe('ok');
    expect(code(() => resolveRange(new Date(to.getTime() - MAX_RANGE_DAYS * 86_400_000 - 1).toISOString(), to.toISOString()))).toBe('INVALID_RANGE');
  });
});

describe('rating average', () => {
  it('rounds to two decimals and is null without reviews', () => {
    expect(average(0, 0)).toBeNull();
    expect(average(14, 3)).toBe(4.67);
    expect(average(10, 3)).toBe(3.33);
    expect(average(9, 2)).toBe(4.5);
    expect(average(5, 1)).toBe(5);
  });
});
