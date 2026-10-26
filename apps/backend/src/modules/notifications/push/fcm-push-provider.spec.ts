import { jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import type { Message } from 'firebase-admin/messaging';
import type { AppConfig } from '../../../config/app.config.js';
import { PushProviderMode } from '../../../config/env.validation.js';
import { FcmPushProvider, type FcmMessagingClient, classifyFcmError } from './fcm-push-provider.js';
import { selectPushProvider } from './push-provider.factory.js';
import { DisabledPushProvider, MockPushProvider, PushError, type PushMessage } from './push-provider.js';

const SECRET_KEY = '-----BEGIN PRIVATE KEY-----\nTESTONLY-NOT-A-KEY\n-----END PRIVATE KEY-----\n';
const SERVICE_ACCOUNT = { project_id: 'hs-demo-project', client_email: 'svc@hs-demo-project.iam.gserviceaccount.com', private_key: SECRET_KEY };
const TOKEN = 'dGVzdC1kZXZpY2UtdG9rZW4tMTIzNDU2Nzg5MC1hYmNkZWY6QVBBOTFiLXRlc3Q';

const message = (over: Partial<PushMessage> = {}): PushMessage => ({
  provider: 'FCM',
  platform: 'ANDROID',
  token: TOKEN,
  title: 'Work has started',
  body: 'The worker started work on booking BK-SECRET01.',
  data: { notificationId: 'n-1', type: 'work.started', resourceType: 'booking', resourceId: 'r-1' },
  ...over,
});

const sdkError = (code: string, text = 'sdk text') => Object.assign(new Error(text), { code });
const fcm = (client: FcmMessagingClient, dryRun = false) => new FcmPushProvider({ projectId: 'hs-demo-project', serviceAccount: SERVICE_ACCOUNT, dryRun }, () => client);
const failure = async (p: Promise<unknown>) => (await p.catch((e: unknown) => e)) as PushError;

describe('classifyFcmError', () => {
  const kind = (code: string, text?: string) => classifyFcmError(sdkError(code, text)).kind;

  it('revokes a device only when FCM says exactly that the token is dead', () => {
    expect(kind('messaging/registration-token-not-registered')).toBe('INVALID_TOKEN');
    expect(kind('messaging/invalid-registration-token')).toBe('INVALID_TOKEN');
    expect(kind('messaging/invalid-argument', 'The registration token is not a valid FCM registration token')).toBe('INVALID_TOKEN');
  });

  it('does not revoke on a bad payload or an ambiguous credential error (a misconfiguration must not wipe every registration)', () => {
    expect(kind('messaging/invalid-argument', 'Invalid JSON payload received')).toBe('PERMANENT');
    expect(kind('messaging/invalid-argument')).toBe('PERMANENT');
    for (const code of [
      'messaging/authentication-error',
      'messaging/third-party-auth-error',
      'messaging/mismatched-credential',
      'messaging/invalid-apns-credentials',
      'messaging/invalid-package-name',
      'messaging/invalid-recipient',
      'messaging/invalid-payload',
      'messaging/invalid-data-payload-key',
      'messaging/invalid-options',
      'messaging/payload-size-limit-exceeded',
      'app/invalid-credential',
      'app/invalid-app-options',
    ]) {
      expect({ code, kind: kind(code) }).toEqual({ code, kind: 'PERMANENT' });
    }
  });

  it('retries outages, internal errors, rate and quota limits and network trouble', () => {
    for (const code of [
      'messaging/server-unavailable',
      'messaging/internal-error',
      'messaging/unknown-error',
      'messaging/message-rate-exceeded',
      'messaging/device-message-rate-exceeded',
      'messaging/topics-message-rate-exceeded',
      'messaging/quota-exceeded',
      'app/network-error',
      'app/network-timeout',
    ]) {
      expect({ code, kind: kind(code) }).toEqual({ code, kind: 'TRANSIENT' });
    }
  });

  it('treats anything unknown as transient (the pipeline caps the attempts), never as a revocation', () => {
    expect(classifyFcmError(new Error('boom')).kind).toBe('TRANSIENT');
    expect(classifyFcmError(undefined).kind).toBe('TRANSIENT');
    expect(classifyFcmError({ code: 42 }).kind).toBe('TRANSIENT');
    expect(classifyFcmError(sdkError('messaging/some-new-code')).kind).toBe('TRANSIENT');
  });
});

describe('FcmPushProvider', () => {
  let warn: ReturnType<typeof jest.spyOn>;
  let others: Array<ReturnType<typeof jest.spyOn>>;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    others = (['log', 'error', 'debug', 'verbose'] as const).map((l) => jest.spyOn(Logger.prototype, l).mockImplementation(() => undefined));
  });
  afterEach(() => {
    warn.mockRestore();
    others.forEach((s) => s.mockRestore());
  });

  it('is supported, and sends one well-formed FCM message through the client', async () => {
    const send = jest.fn(async (_m: Message, _d?: boolean) => 'projects/hs-demo-project/messages/123');
    const out = await fcm({ send }).send(message());
    expect(out).toEqual({ messageId: 'projects/hs-demo-project/messages/123' });
    expect(fcm({ send }).supported).toBe(true);
    const [sent, dryRun] = send.mock.calls[0]!;
    expect(dryRun).toBe(false);
    expect(sent).toMatchObject({
      token: TOKEN,
      notification: { title: 'Work has started', body: 'The worker started work on booking BK-SECRET01.' },
      data: { notificationId: 'n-1', type: 'work.started', resourceType: 'booking', resourceId: 'r-1' },
      android: { priority: 'high', ttl: 86_400_000 },
      apns: { headers: { 'apns-priority': '10' } },
    });
    expect(Object.values(sent.data ?? {}).every((v) => typeof v === 'string')).toBe(true); // FCM data values must be strings
  });

  it('can ask Firebase to validate without delivering (dry run)', async () => {
    const send = jest.fn(async (_m: Message, _d?: boolean) => 'projects/x/messages/fake_message_id');
    await fcm({ send }, true).send(message());
    expect(send.mock.calls[0]![1]).toBe(true);
  });

  it('refuses tokens of other vendors without calling Firebase', async () => {
    const send = jest.fn(async () => 'id');
    for (const [provider, platform] of [['APNS', 'IOS'], ['HMS', 'HUAWEI']] as const) {
      expect((await failure(fcm({ send }).send(message({ provider, platform })))).kind).toBe('PERMANENT');
    }
    expect(send).not.toHaveBeenCalled();
  });

  it('turns SDK failures into the pipeline vocabulary', async () => {
    const run = async (code: string) => (await failure(fcm({ send: async () => Promise.reject(sdkError(code)) }).send(message()))).kind;
    expect(await run('messaging/registration-token-not-registered')).toBe('INVALID_TOKEN');
    expect(await run('messaging/server-unavailable')).toBe('TRANSIENT');
    expect(await run('messaging/message-rate-exceeded')).toBe('TRANSIENT');
    expect(await run('messaging/third-party-auth-error')).toBe('PERMANENT');
    expect(await run('messaging/authentication-error')).toBe('PERMANENT');
  });

  it('logs only the SDK error code: never the token, title, body, payload, service account or the SDK message', async () => {
    const leaky = `Requested entity was not found for token ${TOKEN} body "${message().body}" key ${SECRET_KEY}`;
    const err = await failure(fcm({ send: async () => Promise.reject(sdkError('messaging/registration-token-not-registered', leaky)) }).send(message()));
    expect(err.message).toBe('PUSH_INVALID_TOKEN'); // the thrown error carries no text either
    const logged = [warn, ...others].flatMap((s) => (s.mock.calls as unknown[][]).map((c) => JSON.stringify(c))).join('\n');
    expect(logged).toContain('messaging/registration-token-not-registered');
    for (const secret of [TOKEN, 'BK-SECRET01', 'Work has started', 'PRIVATE KEY', 'TESTONLY', 'svc@hs-demo-project', 'Requested entity', 'notificationId']) expect(logged).not.toContain(secret);
  });

  it('sets up the SDK lazily and once', async () => {
    const factory = jest.fn(() => ({ send: async () => 'id' }));
    const p = new FcmPushProvider({ projectId: 'hs-demo-project', serviceAccount: SERVICE_ACCOUNT, dryRun: false }, factory);
    expect(factory).not.toHaveBeenCalled(); // nothing happens at start-up
    await p.send(message());
    await p.send(message());
    expect(factory).toHaveBeenCalledTimes(1);
  });
});

describe('selectPushProvider', () => {
  const disabled = new DisabledPushProvider();
  const mock = new MockPushProvider();
  const app = (over: { mode?: PushProviderMode | undefined; production?: boolean; fcm?: boolean; account?: boolean; key?: boolean; authOn?: boolean } = {}) =>
    ({
      isProduction: over.production ?? false,
      notifications: { pushProvider: over.mode, deviceTokenKey: over.key === false ? undefined : Buffer.alloc(32) },
      firebase: {
        fcm: { enabled: over.fcm ?? over.mode === PushProviderMode.Fcm, projectId: 'hs-demo-project', dryRun: false },
        auth: { enabled: over.authOn ?? false },
        serviceAccount: over.account === false ? undefined : SERVICE_ACCOUNT,
      },
    }) as unknown as AppConfig;

  it('is disabled unless a provider is explicitly chosen', () => {
    expect(selectPushProvider(app({ mode: undefined }), disabled, mock)).toBe(disabled);
    expect(selectPushProvider(app({ mode: PushProviderMode.Disabled }), disabled, mock)).toBe(disabled);
    expect(selectPushProvider(app({ mode: undefined, authOn: true, production: true }), disabled, mock)).toBe(disabled); // phone sign-in does not switch push on
  });

  it('chooses the mock only outside production', () => {
    expect(selectPushProvider(app({ mode: PushProviderMode.Mock }), disabled, mock)).toBe(mock);
    expect(() => selectPushProvider(app({ mode: PushProviderMode.Mock, production: true }), disabled, mock)).toThrow('mock push provider');
  });

  it('chooses FCM only when asked, and does not need phone sign-in', () => {
    const p = selectPushProvider(app({ mode: PushProviderMode.Fcm, authOn: false }), disabled, mock);
    expect(p).toBeInstanceOf(FcmPushProvider);
    expect(p.supported).toBe(true);
    expect(selectPushProvider(app({ mode: PushProviderMode.Fcm, production: true }), disabled, mock)).toBeInstanceOf(FcmPushProvider);
  });

  it('refuses to build FCM without what it needs (second line of defence behind the environment checks)', () => {
    expect(() => selectPushProvider(app({ mode: PushProviderMode.Fcm, account: false }), disabled, mock)).toThrow('FIREBASE_SERVICE_ACCOUNT_BASE64');
    expect(() => selectPushProvider(app({ mode: PushProviderMode.Fcm, key: false }), disabled, mock)).toThrow('DEVICE_TOKEN_ENCRYPTION_KEY');
  });
});
