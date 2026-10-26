import { Injectable } from '@nestjs/common';
import type { DevicePlatform, PushProviderName } from '../../../generated/prisma/client.js';

export interface PushMessage {
  provider: PushProviderName;
  platform: DevicePlatform;
  /** The device token. Secret-like: never log it. */
  token: string;
  title: string;
  body: string;
  /** Small string map for the app to route the tap (notification id, resource type/id). No personal data. */
  data: Record<string, string>;
}

/** `TRANSIENT` = retry later; `INVALID_TOKEN` = the device is gone, revoke the token; `PERMANENT` = do not retry. */
export class PushError extends Error {
  constructor(readonly kind: 'TRANSIENT' | 'INVALID_TOKEN' | 'PERMANENT') {
    super(`PUSH_${kind}`);
  }
}

/**
 * Mobile push contract. The FCM adapter (fcm-push-provider.ts) is implemented; APNs (direct) and Huawei Push Kit (HMS) are not. Each vendor needs
 * its own account and credentials, and not every device is reachable through one provider. An adapter must:
 *  - route by `message.provider` (it may support only some of FCM / APNS / HMS and throw PERMANENT for the rest);
 *  - map vendor errors to PushError kinds (unregistered token => INVALID_TOKEN, 5xx/timeout => TRANSIENT);
 *  - return a messageId only when the vendor ACCEPTED the message (that is SENT, never DELIVERED: delivery
 *    receipts need a vendor feature that is not wired up);
 *  - read credentials from the environment/secret store and never log tokens, bodies or credentials.
 */
export abstract class PushProvider {
  /** False for the disabled provider: deliveries are recorded UNSUPPORTED and nothing is attempted. */
  abstract readonly supported: boolean;
  abstract send(message: PushMessage): Promise<{ messageId: string }>;
}

@Injectable()
export class DisabledPushProvider extends PushProvider {
  readonly supported = false;
  async send(): Promise<never> {
    throw new PushError('PERMANENT');
  }
}

/**
 * TEST DOUBLE (refused in production). Accepts a message and sends nothing. Tokens starting with `invalid-` answer
 * INVALID_TOKEN and tokens starting with `transient-` fail transiently, so retry paths can be exercised.
 */
@Injectable()
export class MockPushProvider extends PushProvider {
  readonly supported = true;
  readonly accepted: Array<Pick<PushMessage, 'provider' | 'platform' | 'title' | 'body' | 'data'> & { tokenHashPrefix: string }> = [];
  private counter = 0;

  async send(message: PushMessage): Promise<{ messageId: string }> {
    if (message.token.startsWith('invalid-')) throw new PushError('INVALID_TOKEN');
    if (message.token.startsWith('transient-')) throw new PushError('TRANSIENT');
    this.accepted.push({ provider: message.provider, platform: message.platform, title: message.title, body: message.body, data: message.data, tokenHashPrefix: message.token.slice(0, 4) });
    return { messageId: `mock-${++this.counter}` };
  }
}
