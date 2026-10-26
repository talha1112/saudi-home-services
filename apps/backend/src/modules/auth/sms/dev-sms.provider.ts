import { Injectable, Logger } from '@nestjs/common';
import { SmsMessage, SmsProvider } from './sms-provider.js';

/**
 * DEVELOPMENT ONLY. Writes the message, including the one-time code, to the
 * server log instead of sending an SMS. Environment validation and SmsModule
 * both refuse to enable it when NODE_ENV=production.
 */
@Injectable()
export class DevSmsProvider extends SmsProvider {
  private readonly logger = new Logger('DevSmsProvider');

  async send(message: SmsMessage): Promise<void> {
    this.logger.warn(`[DEV ONLY - not sent] SMS to ${message.to}: ${message.body}`);
  }
}
