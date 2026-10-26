import { jest } from '@jest/globals';
import { ApiError } from '../../../common/errors/api-error.js';
import { buildAuthServices } from '../../../testing/harness.js';

const PHONE = '+966501234567';
const OWNER_IP = '203.0.113.10';
const ATTACKER_IP = '198.51.100.7';

async function failure(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (err) {
    return err as ApiError;
  }
  throw new Error('expected the call to fail');
}

const wrongCode = (real: string) => (real === '000000' ? '111111' : '000000');
const advance = (seconds: number) => jest.setSystemTime(Date.now() + seconds * 1000);

describe('OtpService', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-10-22T10:00:00Z') });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  describe('basics', () => {
    it('sends a 6 digit code and accepts it once', async () => {
      const { otp, sms } = buildAuthServices();
      const res = await otp.request(PHONE, OWNER_IP, 'EN');
      expect(res).toEqual({ expiresInSeconds: 300, resendAfterSeconds: 60 });
      expect(sms.messages).toHaveLength(1);
      const code = sms.lastCode(PHONE);
      expect(code).toMatch(/^\d{6}$/);

      await expect(otp.verify(PHONE, code, OWNER_IP)).resolves.toBeUndefined();
      // Single use: the same code cannot be replayed.
      expect((await failure(otp.verify(PHONE, code, OWNER_IP))).code).toBe('OTP_EXPIRED');
    });

    it('sends the message in Arabic by default', async () => {
      const { otp, sms } = buildAuthServices();
      await otp.request(PHONE, OWNER_IP);
      expect(sms.messages[0].body).toMatch(/رمز التحقق/);
    });

    it('never stores the code itself', async () => {
      const { otp, sms, store } = buildAuthServices();
      await otp.request(PHONE, OWNER_IP);
      const code = sms.lastCode(PHONE);
      const dump = JSON.stringify([...(store as unknown as { entries: Map<string, unknown> }).entries]);
      expect(dump).not.toContain(code);
      expect(dump).not.toContain(PHONE);
      expect(dump).not.toContain(OWNER_IP);
    });

    it('rejects a code after it expires', async () => {
      const { otp, sms } = buildAuthServices();
      await otp.request(PHONE, OWNER_IP);
      const code = sms.lastCode(PHONE);
      advance(301);
      const err = await failure(otp.verify(PHONE, code, OWNER_IP));
      expect(err.getStatus()).toBe(400);
      expect(err.code).toBe('OTP_EXPIRED');
    });

    it('still accepts the code just before it expires', async () => {
      const { otp, sms } = buildAuthServices();
      await otp.request(PHONE, OWNER_IP);
      const code = sms.lastCode(PHONE);
      advance(299);
      await expect(otp.verify(PHONE, code, OWNER_IP)).resolves.toBeUndefined();
    });

    it('fails when no code was requested', async () => {
      const { otp } = buildAuthServices();
      expect((await failure(otp.verify(PHONE, '123456', OWNER_IP))).code).toBe('OTP_EXPIRED');
    });

    it('keeps numbers independent', async () => {
      const { otp, sms } = buildAuthServices();
      await otp.request(PHONE, OWNER_IP);
      await otp.request('+966507654321', OWNER_IP);
      const err = await failure(otp.verify('+966507654321', sms.lastCode(PHONE), OWNER_IP));
      expect(err.code).toMatch(/OTP_INVALID/);
    });

    it('does not keep a code when delivery fails and allows an immediate retry', async () => {
      const { otp, sms } = buildAuthServices();
      sms.failWith = new Error('provider down');
      const err = await failure(otp.request(PHONE, OWNER_IP));
      expect(err.getStatus()).toBe(503);
      expect(err.code).toBe('SMS_DELIVERY_FAILED');
      expect((await failure(otp.verify(PHONE, '123456', OWNER_IP))).code).toBe('OTP_EXPIRED');

      sms.failWith = undefined;
      await expect(otp.request(PHONE, OWNER_IP)).resolves.toBeDefined();
    });
  });

  describe('sending limits', () => {
    it('enforces the resend cooldown with a retry hint', async () => {
      const { otp } = buildAuthServices();
      await otp.request(PHONE, OWNER_IP);
      const err = await failure(otp.request(PHONE, OWNER_IP));
      expect(err.getStatus()).toBe(429);
      expect(err.code).toBe('OTP_RESEND_COOLDOWN');
      expect(JSON.stringify(err.getResponse())).toMatch(/"retryAfterSeconds":\d+/);

      advance(61);
      await expect(otp.request(PHONE, OWNER_IP)).resolves.toBeDefined();
    });

    it('lets one client IP use only half of a number\'s hourly budget', async () => {
      const { otp } = buildAuthServices(); // 6 per hour -> 3 per IP
      for (let i = 0; i < 3; i++) {
        await otp.request(PHONE, ATTACKER_IP);
        advance(61);
      }
      const err = await failure(otp.request(PHONE, ATTACKER_IP));
      expect(err.code).toBe('OTP_HOURLY_LIMIT');
      // The legitimate owner can still get a code: a single attacker IP cannot lock them out.
      advance(61);
      await expect(otp.request(PHONE, OWNER_IP)).resolves.toBeDefined();
    });

    it('caps the whole number at its hourly budget, and the cap ends after an hour', async () => {
      const { otp } = buildAuthServices();
      const ips = ['1.1.1.1', '1.1.1.2', '1.1.1.3', '1.1.1.4'];
      for (let i = 0; i < 6; i++) {
        await otp.request(PHONE, ips[Math.floor(i / 2)]);
        advance(61);
      }
      const err = await failure(otp.request(PHONE, '9.9.9.9'));
      expect(err.getStatus()).toBe(429);
      expect(err.code).toBe('OTP_HOURLY_LIMIT');

      advance(3600);
      await expect(otp.request(PHONE, '9.9.9.9')).resolves.toBeDefined();
    });

    it('a rejected client does not eat the number-wide budget', async () => {
      const { otp } = buildAuthServices();
      for (let i = 0; i < 3; i++) {
        await otp.request(PHONE, ATTACKER_IP);
        advance(61);
      }
      // Ten more attempts from the already-blocked IP.
      for (let i = 0; i < 10; i++) {
        await failure(otp.request(PHONE, ATTACKER_IP));
        advance(61);
      }
      // 3 of 6 sends were used by the attacker, so 3 remain for others.
      for (const ip of ['2.2.2.1', '2.2.2.2', '2.2.2.3']) {
        await expect(otp.request(PHONE, ip)).resolves.toBeDefined();
        advance(61);
      }
    });
  });

  describe('guessing limits', () => {
    it('rejects a wrong code and reports the attempts left', async () => {
      const { otp, sms } = buildAuthServices();
      await otp.request(PHONE, OWNER_IP);
      const err = await failure(otp.verify(PHONE, wrongCode(sms.lastCode(PHONE)), OWNER_IP));
      expect(err.getStatus()).toBe(401);
      expect(err.code).toBe('OTP_INVALID');
      expect(JSON.stringify(err.getResponse())).toContain('"attemptsRemaining":4');
    });

    it('pauses guessing from one IP after 5 wrong codes, without destroying the real code', async () => {
      const { otp, sms } = buildAuthServices();
      await otp.request(PHONE, OWNER_IP);
      const code = sms.lastCode(PHONE);
      for (let i = 0; i < 5; i++) {
        expect((await failure(otp.verify(PHONE, wrongCode(code), ATTACKER_IP))).code).toBe('OTP_INVALID');
      }
      const blocked = await failure(otp.verify(PHONE, wrongCode(code), ATTACKER_IP));
      expect(blocked.getStatus()).toBe(429);
      expect(blocked.code).toBe('OTP_ATTEMPTS_EXCEEDED');
      // Even the right code is refused to the blocked client (no oracle for the attacker)...
      expect((await failure(otp.verify(PHONE, code, ATTACKER_IP))).code).toBe('OTP_ATTEMPTS_EXCEEDED');
      // ...but the genuine user's code still works from their own device.
      await expect(otp.verify(PHONE, code, OWNER_IP)).resolves.toBeUndefined();
    });

    it('the pause is temporary', async () => {
      const { otp, sms } = buildAuthServices();
      await otp.request(PHONE, OWNER_IP);
      const code = sms.lastCode(PHONE);
      for (let i = 0; i < 5; i++) await failure(otp.verify(PHONE, wrongCode(code), OWNER_IP));
      expect((await failure(otp.verify(PHONE, code, OWNER_IP))).code).toBe('OTP_ATTEMPTS_EXCEEDED');
      advance(15 * 60 + 1);
      // The code itself expired meanwhile (5 min), so ask for a new one; the pause is over.
      await otp.request(PHONE, OWNER_IP);
      await expect(otp.verify(PHONE, sms.lastCode(PHONE), OWNER_IP)).resolves.toBeUndefined();
    });

    it('limits guesses per number across many IPs (brute force stays infeasible)', async () => {
      const { otp, sms } = buildAuthServices();
      await otp.request(PHONE, OWNER_IP);
      const code = sms.lastCode(PHONE);
      // 15 = 5 per IP x 3: spread over IPs, each under its own limit.
      for (let i = 0; i < 15; i++) {
        expect((await failure(otp.verify(PHONE, wrongCode(code), `10.0.0.${i + 1}`))).code).toBe('OTP_INVALID');
      }
      const err = await failure(otp.verify(PHONE, wrongCode(code), '10.0.0.200'));
      expect(err.getStatus()).toBe(429);
      expect(err.code).toBe('OTP_ATTEMPTS_EXCEEDED');
      // Temporary: after the window the number accepts attempts again.
      advance(15 * 60 + 1);
      await otp.request(PHONE, OWNER_IP);
      await expect(otp.verify(PHONE, sms.lastCode(PHONE), OWNER_IP)).resolves.toBeUndefined();
    });

    it('a correct code does not use up the guess budget', async () => {
      const { otp, sms } = buildAuthServices();
      // Requests come from different IPs only to stay under the per-IP send cap; guesses all use OWNER_IP.
      for (let round = 0; round < 3; round++) {
        await otp.request(PHONE, `7.7.7.${round}`);
        await otp.verify(PHONE, sms.lastCode(PHONE), OWNER_IP);
        advance(61);
      }
      await otp.request(PHONE, '7.7.7.9');
      const err = await failure(otp.verify(PHONE, wrongCode(sms.lastCode(PHONE)), OWNER_IP));
      expect(JSON.stringify(err.getResponse())).toContain('"attemptsRemaining":4');
    });

    it('a new request does not invalidate the code the user already holds', async () => {
      const { otp, sms } = buildAuthServices();
      await otp.request(PHONE, OWNER_IP);
      const usersCode = sms.lastCode(PHONE);
      advance(61);
      await otp.request(PHONE, ATTACKER_IP); // attacker triggers another SMS
      await expect(otp.verify(PHONE, usersCode, OWNER_IP)).resolves.toBeUndefined();
      // Consuming one clears the rest as well.
      expect((await failure(otp.verify(PHONE, sms.lastCode(PHONE), OWNER_IP))).code).toBe('OTP_EXPIRED');
    });

    it('keeps at most the 3 most recent codes valid', async () => {
      const { otp, sms } = buildAuthServices();
      const codes: string[] = [];
      for (let i = 0; i < 4; i++) {
        await otp.request(PHONE, `5.5.5.${i}`);
        codes.push(sms.lastCode(PHONE));
        advance(61);
      }
      if (new Set(codes).size === codes.length) {
        expect((await failure(otp.verify(PHONE, codes[0], OWNER_IP))).code).toBe('OTP_INVALID');
      }
      await expect(otp.verify(PHONE, codes[3], OWNER_IP)).resolves.toBeUndefined();
    });
  });
});
