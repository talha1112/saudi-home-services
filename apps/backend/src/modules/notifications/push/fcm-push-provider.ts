import { Logger, type OnModuleDestroy } from '@nestjs/common';
// Type-only: the Firebase SDK is loaded on first use (see client()), so importing this file, as every test that boots the application does,
// never loads firebase-admin. (Jest's module loader cannot load it; Node can.)
import type { App } from 'firebase-admin/app';
import type { Message } from 'firebase-admin/messaging';
import type { FirebaseServiceAccountJson } from '../../../config/env.validation.js';
import { PushError, PushProvider, type PushMessage } from './push-provider.js';

/** The one SDK call this adapter makes, so tests can stand in for Firebase. */
export interface FcmMessagingClient {
  send(message: Message, dryRun?: boolean): Promise<string>;
}

/** How long FCM may hold a message for an offline phone. Booking updates are useless after a day. */
const TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Maps a Firebase Admin messaging error to the delivery pipeline's vocabulary.
 *
 *  INVALID_TOKEN: the DEVICE is gone or the token is garbage: the pipeline revokes that one device. Only the two codes that say exactly that
 *    (and an "invalid argument" whose text names the registration token) qualify.
 *  PERMANENT: do not retry. Configuration or credential problems (wrong service account, missing APNs key, project mismatch), a payload FCM
 *    refuses, anything ambiguous. Crucially these NEVER revoke a device: a misconfiguration must not wipe every user's push registration.
 *  TRANSIENT: try again later with backoff (FCM unavailable or internal error, rate or quota limits, network trouble). Unknown errors are
 *    treated as transient: the pipeline caps the attempts, so a surprise cannot loop forever.
 */
export function classifyFcmError(err: unknown): PushError {
  const code = typeof (err as { code?: unknown } | null)?.code === 'string' ? (err as { code: string }).code : '';
  switch (code) {
    case 'messaging/registration-token-not-registered':
    case 'messaging/invalid-registration-token':
      return new PushError('INVALID_TOKEN');
    case 'messaging/invalid-argument': {
      // FCM answers a malformed token with a generic "invalid argument"; only its wording tells it apart from a bad payload.
      // The text is inspected for this decision and is never logged or stored.
      const text = typeof (err as { message?: unknown }).message === 'string' ? (err as { message: string }).message.toLowerCase() : '';
      return new PushError(text.includes('registration token') ? 'INVALID_TOKEN' : 'PERMANENT');
    }
    case 'messaging/authentication-error':
    case 'messaging/third-party-auth-error':
    case 'messaging/mismatched-credential': // wrong service account / permission denied / token of another sender: ambiguous, so never revoke
    case 'messaging/invalid-apns-credentials':
    case 'messaging/invalid-package-name':
    case 'messaging/invalid-recipient':
    case 'messaging/invalid-payload':
    case 'messaging/invalid-data-payload-key':
    case 'messaging/invalid-options':
    case 'messaging/payload-size-limit-exceeded':
    case 'app/invalid-credential':
    case 'app/invalid-app-options':
    case 'app/duplicate-app':
      return new PushError('PERMANENT');
    default:
      // messaging/server-unavailable, internal-error, unknown-error, message-rate-exceeded, device-message-rate-exceeded,
      // topics-message-rate-exceeded, quota-exceeded, app/network-error, app/network-timeout, and anything new.
      return new PushError('TRANSIENT');
  }
}

export interface FcmSettings {
  projectId: string;
  /** SECRET. Used only to create the SDK credential; never logged. */
  serviceAccount: FirebaseServiceAccountJson;
  /** Firebase validates the message and answers, but delivers nothing. */
  dryRun: boolean;
}

/**
 * Push through Firebase Cloud Messaging (Android; iOS through APNs). Only FCM tokens are accepted: a device registered with another vendor
 * (APNS, HMS) is a PERMANENT failure here, not an attempt.
 *
 * Nothing sensitive is logged: not the device token, not the title, body or data, not the service account, and not the SDK's error text
 * (which can echo a token). On a failure only the SDK's error CODE is logged. The service-account key is read from configuration, becomes an
 * SDK credential on first use and never leaves this process.
 */
export class FcmPushProvider extends PushProvider implements OnModuleDestroy {
  readonly supported = true;
  private readonly logger = new Logger(FcmPushProvider.name);
  private messaging?: FcmMessagingClient;
  private app?: App;

  constructor(
    private readonly settings: FcmSettings,
    private readonly clientFactory?: () => FcmMessagingClient,
  ) {
    super();
  }

  async send(message: PushMessage): Promise<{ messageId: string }> {
    if (message.provider !== 'FCM') throw new PushError('PERMANENT');
    const payload: Message = {
      token: message.token,
      notification: { title: message.title, body: message.body },
      data: message.data,
      android: { priority: 'high', ttl: TTL_MS },
      apns: { headers: { 'apns-priority': '10' }, payload: { aps: { sound: 'default' } } },
    };
    try {
      const messageId = await (await this.client()).send(payload, this.settings.dryRun);
      return { messageId };
    } catch (err) {
      const failure = classifyFcmError(err);
      const code = typeof (err as { code?: unknown } | null)?.code === 'string' ? (err as { code: string }).code : 'no-code';
      this.logger.warn(`FCM send failed (${code}) -> ${failure.kind}`); // the code only
      throw failure;
    }
  }

  /** Created on first use, so start-up never depends on Firebase. */
  private async client(): Promise<FcmMessagingClient> {
    if (this.messaging) return this.messaging;
    if (this.clientFactory) {
      this.messaging = this.clientFactory();
      return this.messaging;
    }
    const { cert, getApps, initializeApp } = await import('firebase-admin/app');
    const { getMessaging } = await import('firebase-admin/messaging');
    const { projectId, serviceAccount: sa } = this.settings;
    const name = `hs-firebase-fcm-${projectId}`;
    this.app =
      getApps().find((a) => a.name === name) ??
      initializeApp({ projectId, credential: cert({ projectId: sa.project_id, clientEmail: sa.client_email, privateKey: sa.private_key }) }, name);
    this.messaging = getMessaging(this.app);
    return this.messaging;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.app) {
      const { deleteApp } = await import('firebase-admin/app');
      await deleteApp(this.app).catch(() => undefined);
    }
  }
}
