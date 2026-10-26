import { randomBytes } from 'node:crypto';
import { pickLocalized, parseLocale } from '../../common/i18n/localize.js';
import { offerPhase } from '../offers/offers.service.js';
import { deliveryBackoffMs } from './notification-delivery.service.js';
import { NOTIFICATION_TEMPLATES, isNotificationType, renderNotification } from './notification-templates.js';
import { MockPushProvider, PushError } from './push/push-provider.js';
import { decryptToken, encryptToken, hashToken } from './push/token-cipher.js';

describe('notification templates', () => {
  it('every template has Arabic and English text and uses only the {ref} parameter', () => {
    for (const [type, t] of Object.entries(NOTIFICATION_TEMPLATES)) {
      if (type === 'admin.announcement') continue; // the one template whose text is written by an administrator (tested below)
      for (const lang of ['ar', 'en'] as const) {
        expect({ type, lang, title: t[lang].title.length > 0, body: t[lang].body.length > 0 }).toEqual({ type, lang, title: true, body: true });
        for (const placeholder of `${t[lang].title} ${t[lang].body}`.match(/\{(\w+)\}/g) ?? []) expect(placeholder).toBe('{ref}');
      }
      expect(t.ar.title).toMatch(/[؀-ۿ]/);
      expect(t.en.title).not.toMatch(/[؀-ۿ]/);
    }
  });

  it('renders in the reader\'s language, fills the reference, and degrades safely', () => {
    expect(renderNotification('work.started', 'EN', { ref: 'BK-1' })).toEqual({ title: 'Work has started', body: 'The worker started work on booking BK-1.' });
    expect(renderNotification('work.started', 'AR', { ref: 'BK-1' }).body).toContain('BK-1');
    expect(renderNotification('work.started', 'EN', {}).body).toContain('#'); // a missing parameter never prints "undefined"
    expect(renderNotification('work.started', 'EN', { ref: 42 }).body).not.toContain('42'); // only strings are substituted
    expect(renderNotification('from.the.future', 'EN', { ref: 'x' }).title).toBe('Update');
    expect(renderNotification('from.the.future', 'AR', {}).title).toBe('تحديث');
    expect(isNotificationType('work.started')).toBe(true);
    expect(isNotificationType('constructor')).toBe(false);
  });
});

describe('localization helpers', () => {
  it('falls back deterministically between languages and never invents text', () => {
    expect(pickLocalized('AR', { ar: 'مرحبا', en: 'Hello' })).toEqual({ text: 'مرحبا', locale: 'AR' });
    expect(pickLocalized('EN', { ar: 'مرحبا', en: 'Hello' })).toEqual({ text: 'Hello', locale: 'EN' });
    expect(pickLocalized('AR', { en: 'Hello' })).toEqual({ text: 'Hello', locale: 'EN' });
    expect(pickLocalized('EN', { ar: 'مرحبا', en: '   ' })).toEqual({ text: 'مرحبا', locale: 'AR' });
    expect(pickLocalized('EN', { ar: null, en: null })).toEqual({ text: null, locale: null });
  });
  it('parses only ar/en', () => {
    expect(parseLocale('ar')).toBe('AR');
    expect(parseLocale(' EN ')).toBe('EN');
    for (const bad of ['fr', '', undefined, null, 5, 'arabic']) expect(parseLocale(bad)).toBeUndefined();
  });
});

describe('device token protection', () => {
  const key = randomBytes(32);
  it('round-trips, uses a fresh nonce each time, and never stores the token in the clear', () => {
    const token = 'fcm-token-very-secret-1234567890';
    const a = encryptToken(key, token);
    const b = encryptToken(key, token);
    expect(a).not.toBe(b);
    expect(a).not.toContain(token);
    expect(Buffer.from(a, 'base64').toString('latin1')).not.toContain(token);
    expect(decryptToken(key, a)).toBe(token);
  });
  it('detects tampering and a wrong key', () => {
    const stored = encryptToken(key, 'token-token-token-token');
    const raw = Buffer.from(stored, 'base64');
    raw[raw.length - 1]! ^= 1;
    expect(() => decryptToken(key, raw.toString('base64'))).toThrow();
    expect(() => decryptToken(randomBytes(32), stored)).toThrow();
  });
  it('hashes stably for lookup', () => {
    expect(hashToken('abc')).toBe(hashToken('abc'));
    expect(hashToken('abc')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken('abc')).not.toBe(hashToken('abd'));
  });
});

describe('push test double', () => {
  const msg = (token: string) => ({ provider: 'FCM' as const, platform: 'ANDROID' as const, token, title: 't', body: 'b', data: {} });
  it('accepts, and simulates invalid and transient token failures; it never records the full token', async () => {
    const push = new MockPushProvider();
    expect((await push.send(msg('good-token-12345678'))).messageId).toMatch(/^mock-/);
    expect(push.accepted[0]!.tokenHashPrefix).toBe('good');
    expect(JSON.stringify(push.accepted)).not.toContain('good-token-12345678');
    await expect(push.send(msg('invalid-x'))).rejects.toMatchObject({ kind: 'INVALID_TOKEN' });
    await expect(push.send(msg('transient-x'))).rejects.toBeInstanceOf(PushError);
  });
});

describe('delivery backoff', () => {
  it('grows from 2 seconds, is capped at 10 minutes, and jitters by at most 20 percent', () => {
    const mid = () => 0.5;
    expect([1, 2, 3, 4].map((n) => deliveryBackoffMs(n, mid))).toEqual([2000, 4000, 8000, 16000]);
    expect(deliveryBackoffMs(40, mid)).toBe(600_000);
    expect(deliveryBackoffMs(3, () => 0)).toBe(6400);
    expect(deliveryBackoffMs(3, () => 1)).toBe(9600);
  });
});

describe('offer phase', () => {
  const now = new Date('2026-11-01T10:00:00.000Z');
  const at = (h: number) => new Date(now.getTime() + h * 3_600_000);
  it('derives scheduled / live / expired from the clock for published offers only', () => {
    expect(offerPhase({ status: 'PUBLISHED', startsAt: at(-1), endsAt: at(1) }, now)).toBe('LIVE');
    expect(offerPhase({ status: 'PUBLISHED', startsAt: at(1), endsAt: at(2) }, now)).toBe('SCHEDULED');
    expect(offerPhase({ status: 'PUBLISHED', startsAt: at(-2), endsAt: at(-1) }, now)).toBe('EXPIRED');
    expect(offerPhase({ status: 'PUBLISHED', startsAt: at(-2), endsAt: now }, now)).toBe('EXPIRED'); // the end is exclusive
    expect(offerPhase({ status: 'PUBLISHED', startsAt: now, endsAt: at(1) }, now)).toBe('LIVE'); // the start is inclusive
    for (const status of ['DRAFT', 'PAUSED', 'ARCHIVED'] as const) expect(offerPhase({ status, startsAt: at(-1), endsAt: at(1) }, now)).toBe(status);
  });
});
