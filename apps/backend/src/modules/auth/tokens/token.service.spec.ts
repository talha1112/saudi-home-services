import { jest } from '@jest/globals';
import { SignJWT } from 'jose';
import { Role } from '../../../generated/prisma/client.js';
import { testConfigService } from '../../../testing/test-support.js';
import { TokenService } from './token.service.js';

const claims = { userId: 'u-1', sessionId: 's-1', role: Role.CUSTOMER };

describe('TokenService', () => {
  const service = new TokenService(testConfigService());

  afterEach(() => jest.useRealTimers());

  it('round-trips access token claims', async () => {
    const { token, expiresInSeconds } = await service.signAccessToken(claims);
    expect(expiresInSeconds).toBe(900);
    const verified = await service.verifyAccessToken(token);
    expect(verified).toEqual({ ...claims, expiresAtMs: expect.any(Number) });
    // the expiry the sockets rely on is the token's own exp (900 s from now)
    expect(verified.expiresAtMs! - Date.now()).toBeGreaterThan(890_000);
    expect(verified.expiresAtMs! - Date.now()).toBeLessThanOrEqual(900_000);
  });

  it('rejects an expired token with TOKEN_EXPIRED', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-22T10:00:00Z') });
    const { token } = await service.signAccessToken(claims);
    jest.setSystemTime(new Date('2026-10-22T10:16:00Z'));
    await expect(service.verifyAccessToken(token)).rejects.toMatchObject({ code: 'TOKEN_EXPIRED' });
  });

  it('rejects a tampered token', async () => {
    const { token } = await service.signAccessToken(claims);
    const [h, p, s] = token.split('.');
    const forgedPayload = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url').toString()), role: 'ADMIN' })).toString('base64url');
    await expect(service.verifyAccessToken(`${h}.${forgedPayload}.${s}`)).rejects.toMatchObject({ code: 'TOKEN_INVALID' });
  });

  it('rejects a token signed with another secret', async () => {
    const forged = await new SignJWT({ sid: 's', role: 'ADMIN' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('u-1')
      .setIssuer('home-services-api')
      .setAudience('home-services')
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode('x'.repeat(48)));
    await expect(service.verifyAccessToken(forged)).rejects.toMatchObject({ code: 'TOKEN_INVALID' });
  });

  it('rejects unsigned (alg none) tokens and garbage', async () => {
    const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{"sub":"u","role":"ADMIN","sid":"s"}').toString('base64url')}.`;
    await expect(service.verifyAccessToken(none)).rejects.toMatchObject({ code: 'TOKEN_INVALID' });
    await expect(service.verifyAccessToken('garbage')).rejects.toMatchObject({ code: 'TOKEN_INVALID' });
  });

  it('rejects a token with the wrong audience or an unknown role', async () => {
    const key = new TextEncoder().encode('test-access-secret-test-access-secret-0123456789');
    const wrongRole = await new SignJWT({ sid: 's', role: 'SUPERUSER' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('u-1')
      .setIssuer('home-services-api')
      .setAudience('home-services')
      .setExpirationTime('5m')
      .sign(key);
    await expect(service.verifyAccessToken(wrongRole)).rejects.toMatchObject({ code: 'TOKEN_INVALID' });
  });

  it('creates unique opaque refresh tokens and stores only a hash', () => {
    const a = service.newRefreshToken();
    const b = service.newRefreshToken();
    expect(a.token).not.toBe(b.token);
    expect(a.token.length).toBeGreaterThanOrEqual(43);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.hash).not.toContain(a.token);
    expect(service.hashRefreshToken(a.token)).toBe(a.hash);
  });
});
