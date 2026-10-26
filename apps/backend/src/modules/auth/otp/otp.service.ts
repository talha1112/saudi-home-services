import { createHash, createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiError,
  badRequest,
  tooManyRequests,
  unauthorized,
  unavailable,
} from '../../../common/errors/api-error.js';
import { APP_CONFIG, type AppConfig, type AuthConfig } from '../../../config/app.config.js';
import { KeyValueStore } from '../../../database/key-value.store.js';
import { SmsProvider } from '../sms/sms-provider.js';

export type OtpLocale = 'AR' | 'EN';

/** Wrong-guess counters reset after this long, so every lock is temporary. */
const ATTEMPT_WINDOW_SECONDS = 15 * 60;
/** Codes that may be valid at once for a number, so a later request cannot kill the code a user is typing. */
const MAX_LIVE_CODES = 3;
/** The number-wide wrong-guess budget, as a multiple of the per-client budget. */
const GLOBAL_ATTEMPT_FACTOR = 3;

/**
 * One-time codes for phone sign-in.
 *
 * Storage: only HMACs of (phone + code) are kept, in Redis, with a TTL. The code
 * itself exists only in the SMS, so a leaked Redis dump reveals no usable code
 * and the 6-digit space cannot be brute-forced offline without the HMAC key.
 *
 * Abuse limits are layered so that an attacker cannot easily lock a real user out:
 *
 * Sending:
 *   - one client IP may trigger at most half of a number's hourly sends, so a
 *     single attacker cannot use up the whole budget (SMS cost cap still holds);
 *   - 60 s resend cooldown per number.
 * Guessing:
 *   - wrong guesses are counted per (number, client IP) and per number;
 *   - exceeding either only pauses guessing for 15 minutes. It never destroys the
 *     real user's code, and a correct code from a client under its own limit is
 *     still accepted;
 *   - up to 3 recent codes stay valid, so an attacker requesting a new code does
 *     not invalidate the one the user already received.
 * Brute force stays infeasible: at most `OTP_MAX_ATTEMPTS * 3` wrong guesses per
 * number per 15 minutes against a 1,000,000-value code space.
 */
@Injectable()
export class OtpService {
  private readonly cfg: AuthConfig;

  constructor(
    config: ConfigService,
    private readonly store: KeyValueStore,
    private readonly sms: SmsProvider,
  ) {
    this.cfg = config.getOrThrow<AppConfig>(APP_CONFIG).auth;
  }

  async request(
    phone: string,
    ip = 'unknown',
    locale: OtpLocale = 'AR',
  ): Promise<{ expiresInSeconds: number; resendAfterSeconds: number }> {
    const { otp } = this.cfg;
    const keys = this.keys(phone, ip);
    const perIpMax = Math.max(1, Math.floor(otp.maxSendsPerHour / 2));

    if (!(await this.store.setIfAbsent(keys.cooldown, '1', otp.resendCooldownSeconds))) {
      throw tooManyRequests(
        'OTP_RESEND_COOLDOWN',
        'Please wait before requesting another code',
        await this.store.ttl(keys.cooldown),
      );
    }
    // Per-client budget first: a rejected client must not eat into the number-wide budget.
    if ((await this.store.increment(keys.sendsByIp, 3600)) > perIpMax) {
      throw tooManyRequests(
        'OTP_HOURLY_LIMIT',
        'Too many codes requested from this device, try again later',
        await this.store.ttl(keys.sendsByIp),
      );
    }
    if ((await this.store.increment(keys.sends, 3600)) > otp.maxSendsPerHour) {
      throw tooManyRequests(
        'OTP_HOURLY_LIMIT',
        'Too many codes requested for this number, try again later',
        await this.store.ttl(keys.sends),
      );
    }

    const code = String(randomInt(0, 10 ** otp.length)).padStart(otp.length, '0');
    const previous = await this.readHashes(keys.code);
    const hashes = [...previous, this.digest(phone, code)].slice(-MAX_LIVE_CODES);
    await this.store.set(keys.code, JSON.stringify(hashes), otp.ttlSeconds);

    try {
      await this.sms.send({ to: phone, body: this.message(code, locale) });
    } catch (err) {
      // Nothing was delivered: forget the new code (keep earlier ones) and allow an immediate retry.
      if (previous.length > 0) await this.store.set(keys.code, JSON.stringify(previous), otp.ttlSeconds);
      else await this.store.del(keys.code);
      await this.store.del(keys.cooldown);
      if (err instanceof ApiError) throw err;
      throw unavailable('SMS_DELIVERY_FAILED', 'We could not send the verification code, please try again');
    }
    return { expiresInSeconds: otp.ttlSeconds, resendAfterSeconds: otp.resendCooldownSeconds };
  }

  /** Resolves when the code is correct (and consumes it); throws an ApiError otherwise. */
  async verify(phone: string, code: string, ip = 'unknown'): Promise<void> {
    const { otp } = this.cfg;
    const keys = this.keys(phone, ip);

    const hashes = await this.readHashes(keys.code);
    if (hashes.length === 0) {
      throw badRequest('OTP_EXPIRED', 'The code has expired or was not requested. Request a new one');
    }

    // Peek, do not increment: only wrong guesses are counted, so a correct code never uses up budget.
    const byIp = Number((await this.store.get(keys.guessesByIp)) ?? 0);
    if (byIp >= otp.maxAttempts) {
      throw tooManyRequests(
        'OTP_ATTEMPTS_EXCEEDED',
        'Too many incorrect attempts. Try again later',
        await this.store.ttl(keys.guessesByIp),
      );
    }
    const overall = Number((await this.store.get(keys.guesses)) ?? 0);
    if (overall >= otp.maxAttempts * GLOBAL_ATTEMPT_FACTOR) {
      throw tooManyRequests(
        'OTP_ATTEMPTS_EXCEEDED',
        'Too many incorrect attempts for this number. Try again later',
        await this.store.ttl(keys.guesses),
      );
    }

    const candidate = this.digest(phone, code);
    // Compare against every live code without short-circuiting.
    const matched = hashes.map((h) => this.matches(h, candidate)).some(Boolean);
    if (!matched) {
      const used = await this.store.increment(keys.guessesByIp, ATTEMPT_WINDOW_SECONDS);
      await this.store.increment(keys.guesses, ATTEMPT_WINDOW_SECONDS);
      throw new ApiError(401, 'OTP_INVALID', 'The code is incorrect', {
        attemptsRemaining: Math.max(0, otp.maxAttempts - used),
      });
    }

    // Consume exactly once, even if two correct submissions race.
    if (!(await this.store.take(keys.code))) {
      throw unauthorized('OTP_INVALID', 'The code is incorrect');
    }
    await this.store.del(keys.guessesByIp);
  }

  private async readHashes(key: string): Promise<string[]> {
    const raw = await this.store.get(key);
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((h): h is string => typeof h === 'string') : [];
    } catch {
      return [];
    }
  }

  private keys(phone: string, ip: string) {
    // Hash identifiers so no phone number or IP appears in Redis key names.
    const p = createHash('sha256').update(phone).digest('hex').slice(0, 32);
    const c = createHash('sha256').update(ip).digest('hex').slice(0, 16);
    return {
      code: `otp:code:${p}`,
      cooldown: `otp:cooldown:${p}`,
      sends: `otp:sends:${p}`,
      sendsByIp: `otp:sends:${p}:${c}`,
      guesses: `otp:guesses:${p}`,
      guessesByIp: `otp:guesses:${p}:${c}`,
    };
  }

  private digest(phone: string, code: string): string {
    return createHmac('sha256', this.cfg.otpHmacSecret).update(`${phone}:${code}`).digest('hex');
  }

  private matches(a: string, b: string): boolean {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
  }

  private message(code: string, locale: OtpLocale): string {
    const minutes = Math.round(this.cfg.otp.ttlSeconds / 60);
    return locale === 'EN'
      ? `Your Home Services verification code is ${code}. It expires in ${minutes} minutes. Do not share it with anyone.`
      : `رمز التحقق الخاص بك في خدمات المنزل هو ${code}. ينتهي خلال ${minutes} دقائق. لا تشاركه مع أي شخص.`;
  }
}
