/**
 * Regression for a flaky 429 on "POST /auth/otp/request" while a test created several users at once.
 *
 * The OTP limits are keyed by PHONE (resend cooldown, hourly cap) and by IP (route limit, per-(phone,IP) cap). A fresh IP therefore
 * cannot help a request whose PHONE was already used: the only way a request for a "fresh" user gets 429 is a repeated phone number.
 * The harness used to draw numbers at random from a range of 80,000, so two accounts of one suite could share a number (about 5% per
 * suite of ~90 accounts). This suite proves (1) the harness now creates users reliably, in parallel, with unique numbers and IPs, and
 * (2) the throttling that failed the old test is still enforced exactly as before.
 */
import { type Harness, bootHarness } from './support/bookings-harness.js';

const run = process.env['TEST_DATABASE_URL'] ? describe : describe.skip;
if (!process.env['TEST_DATABASE_URL']) console.warn('otp-isolation.integration-spec: TEST_DATABASE_URL is not set, suite skipped');

run('OTP throttling and test-user isolation (real PostgreSQL)', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await bootHarness({ phonePrefix: '+9665988', slugPrefix: 'itest-ot-', adminEmailPrefix: 'itest-ot-admin' });
  });

  afterAll(async () => {
    if (h) await h.close();
  });

  const request = (phone: string, ip: string) => h.api().post('/api/v1/auth/otp/request').set('X-Forwarded-For', ip).send({ phone, app: 'customer' });

  describe('creating many users at once is reliable', () => {
    it('hands out numbers and addresses that never repeat, however many are requested', () => {
      const phones = Array.from({ length: 5000 }, () => h.freshPhone());
      expect(new Set(phones).size).toBe(5000);
      expect(phones.every((p) => /^\+9665988\d{5}$/.test(p))).toBe(true);
      const ips = Array.from({ length: 5000 }, () => h.freshIp());
      expect(new Set(ips).size).toBe(5000);
    });

    it('signs up 160 customers and workers in parallel bursts without one refusal or one duplicate account', async () => {
      const made = [];
      for (let burst = 0; burst < 20; burst++) {
        made.push(...(await Promise.all([h.makeCustomer(), h.makeCustomer(), h.makeCustomer(), h.makeCustomer(), h.makeCustomer(), h.makeCustomer(), h.makeCustomer(), h.makeCustomer()])));
      }
      expect(made).toHaveLength(160);
      expect(new Set(made.map((m) => m.phone)).size).toBe(160);
      expect(new Set(made.map((m) => m.userId)).size).toBe(160); // 160 distinct accounts
    });

    it('explains a refusal instead of hiding it behind a bare status', async () => {
      const phone = h.freshPhone();
      const results = await Promise.allSettled([h.otpSignIn('customer', phone), h.otpSignIn('customer', phone), h.otpSignIn('customer', phone)]); // forced collision
      const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(refused.length).toBeGreaterThanOrEqual(1);
      for (const r of refused) expect(String(r.reason.message)).toMatch(/OTP request refused: HTTP 429 OTP_RESEND_COOLDOWN \(ip 10\.3\.\d+\.\d+, phone \.\.\.\d{4}, customer\)/);
      expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
    });
  });

  describe('the protections that refuse a repeated phone or a noisy client are intact', () => {
    it('refuses a second code for the same phone during the resend cooldown, whatever the IP', async () => {
      const phone = h.freshPhone();
      expect((await request(phone, h.freshIp())).status).toBe(200);
      const again = await request(phone, h.freshIp()); // a brand-new address does not help
      expect(again.status).toBe(429);
      expect(again.body.code).toBe('OTP_RESEND_COOLDOWN');
      expect(again.body.retryAfterSeconds).toBeGreaterThan(0);
    });

    it('lets exactly one of several simultaneous requests for one phone through', async () => {
      const phone = h.freshPhone();
      const results = await Promise.all(Array.from({ length: 6 }, () => request(phone, h.freshIp())));
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status === 429).every((r) => r.body.code === 'OTP_RESEND_COOLDOWN')).toBe(true);
    });

    it('caps the codes per phone per hour even when the cooldown is waited out and the IP changes', async () => {
      const phone = h.freshPhone();
      const statuses: Array<{ status: number; code?: string }> = [];
      for (let i = 0; i < 8; i++) {
        h.store.deleteByPrefix('otp:cooldown:'); // as if the 60 s cooldown had passed
        const res = await request(phone, h.freshIp());
        statuses.push({ status: res.status, code: res.body.code });
      }
      expect(statuses.slice(0, 6).every((s) => s.status === 200)).toBe(true); // OTP_MAX_SENDS_PER_HOUR = 6
      expect(statuses.slice(6)).toEqual([
        { status: 429, code: 'OTP_HOURLY_LIMIT' },
        { status: 429, code: 'OTP_HOURLY_LIMIT' },
      ]);
    });

    it('limits one client address across different phones (route limit), and other addresses are unaffected', async () => {
      const noisy = h.freshIp();
      const statuses: number[] = [];
      for (let i = 0; i < 12; i++) statuses.push((await request(h.freshPhone(), noisy)).status);
      expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
      expect(statuses.slice(10)).toEqual([429, 429]);
      expect((await request(h.freshPhone(), h.freshIp())).status).toBe(200);
    });

    it('limits the codes one device may request for one phone', async () => {
      const phone = h.freshPhone();
      const ip = h.freshIp();
      const codes: Array<string | undefined> = [];
      for (let i = 0; i < 5; i++) {
        h.store.deleteByPrefix('otp:cooldown:');
        const res = await request(phone, ip);
        codes.push(res.status === 200 ? 'ok' : res.body.code);
      }
      expect(codes).toEqual(['ok', 'ok', 'ok', 'OTP_HOURLY_LIMIT', 'OTP_HOURLY_LIMIT']); // 3 per (phone, device) per hour
    });

    it('does not stay locked: a different phone from the same suite still signs in normally afterwards', async () => {
      const other = await h.otpSignIn('worker', h.freshPhone());
      expect(other.userId).toBeDefined();
    });
  });
});
