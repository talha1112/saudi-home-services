export interface SmsMessage {
  /** Destination in E.164 format. */
  to: string;
  body: string;
}

/**
 * Contract for delivering text messages. Production adapters (Unifonic, Taqnyat,
 * Twilio, ...) implement this class and are selected in `sms.module.ts`.
 *
 * Adapter rules:
 * - read credentials from the environment, never from code;
 * - never log `message.body` (it contains the one-time code);
 * - throw on delivery failure so the caller can roll back the OTP.
 */
export abstract class SmsProvider {
  abstract send(message: SmsMessage): Promise<void>;
}
