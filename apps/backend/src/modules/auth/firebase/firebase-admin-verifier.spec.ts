import { jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import type { FirebaseConfig } from '../../../config/app.config.js';
import { FirebaseAdminVerifier, type FirebaseTokenAuth, classifySdkError } from './firebase-admin-verifier.js';
import { FirebaseVerificationError } from './firebase-identity-verifier.js';

const PROJECT = 'hs-demo-project';
const TOKEN = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1aWQtMSJ9.c2lnbmF0dXJlLXNpZ25hdHVyZS1zaWduYXR1cmU';

const config = (over: Partial<FirebaseConfig['auth']> = {}): FirebaseConfig => ({
  fcm: { enabled: false, dryRun: false },
  auth: { enabled: true, projectId: PROJECT, checkRevoked: false, maxAuthAgeSeconds: 300, allowAccountAdoption: false, ...over },
});

const decoded = (over: Record<string, unknown> = {}) =>
  ({
    aud: PROJECT,
    iss: `https://securetoken.google.com/${PROJECT}`,
    sub: 'uid-1',
    uid: 'uid-1',
    iat: 1_800_000_000,
    exp: 1_800_003_600,
    auth_time: 1_799_999_990,
    phone_number: '+966501234567',
    firebase: { sign_in_provider: 'phone', identities: { phone: ['+966501234567'] } },
    ...over,
  }) as never;

const verifierWith = (fn: FirebaseTokenAuth['verifyIdToken'], cfg = config()) => new FirebaseAdminVerifier(cfg, () => ({ verifyIdToken: fn }));
const sdkError = (code: string, message = 'sdk message') => Object.assign(new Error(message), { code });
const kindOf = async (promise: Promise<unknown>) => ((await promise.catch((e: unknown) => e)) as FirebaseVerificationError).kind;

describe('FirebaseAdminVerifier', () => {
  let warn: ReturnType<typeof jest.spyOn>;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  it('turns a verified token into the identity the service decides on', async () => {
    const identity = await verifierWith(async () => decoded()).verify(TOKEN);
    expect(identity).toEqual({
      uid: 'uid-1',
      phoneNumber: '+966501234567',
      signInProvider: 'phone',
      authTime: new Date(1_799_999_990_000),
      issuedAt: new Date(1_800_000_000_000),
      expiresAt: new Date(1_800_003_600_000),
    });
  });

  it('reports a token without a phone claim or with another provider as such (the service refuses them)', async () => {
    const noPhone = await verifierWith(async () => decoded({ phone_number: undefined })).verify(TOKEN);
    expect(noPhone.phoneNumber).toBeUndefined();
    const google = await verifierWith(async () => decoded({ firebase: { sign_in_provider: 'google.com' } })).verify(TOKEN);
    expect(google.signInProvider).toBe('google.com');
  });

  it('refuses a token minted for ANOTHER Firebase project even if the SDK let it through', async () => {
    expect(await kindOf(verifierWith(async () => decoded({ aud: 'some-other-project' })).verify(TOKEN))).toBe('INVALID');
    expect(await kindOf(verifierWith(async () => decoded({ iss: 'https://securetoken.google.com/some-other-project' })).verify(TOKEN))).toBe('INVALID');
    expect(await kindOf(verifierWith(async () => decoded({ iss: 'https://evil.example/hs-demo-project' })).verify(TOKEN))).toBe('INVALID');
  });

  it('refuses tokens with a missing or absurd user id or unusable times', async () => {
    for (const over of [{ uid: '' }, { uid: undefined }, { uid: 'u'.repeat(129) }, { auth_time: undefined }, { exp: 'soon' }, { iat: NaN }]) {
      expect(await kindOf(verifierWith(async () => decoded(over)).verify(TOKEN))).toBe('INVALID');
    }
  });

  it('passes the revocation setting to the SDK', async () => {
    const fn = jest.fn(async (_t: string, _r?: boolean) => decoded());
    await verifierWith(fn, config({ checkRevoked: true })).verify(TOKEN);
    await verifierWith(fn, config({ checkRevoked: false })).verify(TOKEN);
    expect(fn.mock.calls.map((c) => c[1])).toEqual([true, false]);
  });

  it('maps the SDK failures to our kinds, and anything unexpected to UNAVAILABLE rather than to "bad token"', () => {
    const kinds = (code: string) => classifySdkError(sdkError(code)).kind;
    expect(kinds('auth/id-token-expired')).toBe('EXPIRED');
    expect(kinds('auth/id-token-revoked')).toBe('REVOKED');
    expect(kinds('auth/user-not-found')).toBe('REVOKED');
    expect(kinds('auth/user-disabled')).toBe('USER_DISABLED');
    expect(kinds('auth/argument-error')).toBe('INVALID');
    expect(kinds('auth/invalid-id-token')).toBe('INVALID');
    for (const code of ['auth/internal-error', 'app/network-error', 'auth/invalid-credential', 'something/else', '']) expect(kinds(code)).toBe('UNAVAILABLE');
    expect(classifySdkError(new Error('boom')).kind).toBe('UNAVAILABLE');
    expect(classifySdkError(undefined).kind).toBe('UNAVAILABLE');
  });

  it('never carries the SDK message (which can quote the token) into errors or logs; only the code is logged', async () => {
    const leaky = `Decoding Firebase ID token failed for ${TOKEN}`;
    const err = (await verifierWith(async () => {
      throw sdkError('auth/internal-error', leaky);
    })
      .verify(TOKEN)
      .catch((e: unknown) => e)) as FirebaseVerificationError;
    expect(err).toBeInstanceOf(FirebaseVerificationError);
    expect(err.message).toBe('FIREBASE_UNAVAILABLE');
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain('auth/internal-error');
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain('Decoding');
  });

  it('is not configured without a project id, and sets up the SDK lazily and once', async () => {
    expect(await kindOf(verifierWith(async () => decoded(), config({ projectId: undefined })).verify(TOKEN))).toBe('NOT_CONFIGURED');
    const factory = jest.fn(() => ({ verifyIdToken: async () => decoded() }));
    const v = new FirebaseAdminVerifier(config(), factory);
    expect(factory).not.toHaveBeenCalled(); // nothing happens at start-up
    await v.verify(TOKEN);
    await v.verify(TOKEN);
    expect(factory).toHaveBeenCalledTimes(1);
  });
});
