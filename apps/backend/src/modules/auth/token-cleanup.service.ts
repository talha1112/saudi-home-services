import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { describeError } from '../../common/logging/safe-error.js';
import { NodeEnv } from '../../config/env.validation.js';
import { APP_CONFIG, type AppConfig } from '../../config/app.config.js';
import { SessionsService } from './sessions.service.js';

const FIRST_RUN_DELAY_MS = 60_000;
const INTERVAL_MS = 6 * 3600 * 1000;

/**
 * Keeps refresh_tokens from growing forever by periodically deleting rows that are
 * expired, revoked or spent more than a week ago. Safe to run on several instances at
 * once (the deletes are idempotent) and it never runs in tests. Failures are logged only.
 */
@Injectable()
export class TokenCleanupService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(TokenCleanupService.name);
  private first?: NodeJS.Timeout;
  private timer?: NodeJS.Timeout;
  private readonly enabled: boolean;

  constructor(
    config: ConfigService,
    private readonly sessions: SessionsService,
  ) {
    this.enabled = config.getOrThrow<AppConfig>(APP_CONFIG).env !== NodeEnv.Test;
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) return;
    this.first = setTimeout(() => void this.run(), FIRST_RUN_DELAY_MS);
    this.timer = setInterval(() => void this.run(), INTERVAL_MS);
    this.first.unref();
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearTimeout(this.first);
    clearInterval(this.timer);
  }

  async run(): Promise<void> {
    try {
      // First revoke registrations of sessions that ended by expiry, then purge: purging deletes the very rows that prove a session ended.
      const revoked = await this.sessions.revokeDevicesOfEndedSessions();
      if (revoked.bound + revoked.legacy > 0) this.logger.log(`Revoked ${revoked.bound + revoked.legacy} push registrations of ended sessions (${JSON.stringify(revoked)})`);
      const removed = await this.sessions.purgeStale();
      const total = removed.expired + removed.revoked + removed.spent;
      if (total > 0) this.logger.log(`Purged ${total} stale refresh tokens (${JSON.stringify(removed)})`);
    } catch (err) {
      this.logger.warn(`Refresh-token cleanup failed: ${describeError(err)}`);
    }
  }
}
