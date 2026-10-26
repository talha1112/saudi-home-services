import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_CONFIG, type AppConfig } from '../../../config/app.config.js';
import { NodeEnv } from '../../../config/env.validation.js';
import { PrismaService } from '../../../database/prisma.service.js';

/** The bits of pg_trigger.tgtype that matter here. */
const TG = { ROW: 1, BEFORE: 2, DELETE: 8, UPDATE: 16, TRUNCATE: 32 } as const;

/** The triggers migration 20261030090000_audit_log_integrity installs on audit_logs, and what each must do. */
const REQUIRED_TRIGGERS = [
  { name: 'audit_logs_append_only', fn: 'audit_logs_append_only', mask: TG.ROW | TG.BEFORE | TG.UPDATE | TG.DELETE, what: 'block UPDATE and DELETE' },
  { name: 'audit_logs_no_truncate', fn: 'audit_logs_append_only', mask: TG.BEFORE | TG.TRUNCATE, what: 'block TRUNCATE' },
] as const;

interface TriggerRow {
  name: string;
  /** pg_trigger.tgenabled: 'O' = fires normally, 'A' = always, 'R' = replica sessions only, 'D' = disabled. */
  enabled: string;
  type: number;
  fn: string;
}

/**
 * Firebase sign-in records which Firebase identity owns an account as an audit entry (see FirebasePhoneAuthService). That binding is only
 * trustworthy while audit_logs cannot be edited or deleted, which is what two database triggers enforce. A database that is missing the
 * migration, or where someone disabled a trigger, would silently weaken account ownership, so with Firebase sign-in switched ON the
 * application refuses to start unless both triggers exist, are enabled, call the expected function and fire on the expected events.
 *
 * Read-only (a catalog query). It runs once at start-up: it cannot notice a trigger disabled later, and a table owner or superuser can
 * always disable the triggers; this guards against a forgotten migration and casual changes, not against a malicious administrator.
 * Not run when Firebase sign-in is off, nor under NODE_ENV=test (the test database is migrated by the test tooling).
 */
@Injectable()
export class AuditIntegrityCheck implements OnApplicationBootstrap {
  private readonly logger = new Logger(AuditIntegrityCheck.name);
  private readonly required: boolean;

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    const app = config.getOrThrow<AppConfig>(APP_CONFIG);
    this.required = app.firebase.auth.enabled && app.env !== NodeEnv.Test;
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.required) return;
    await this.verify();
    this.logger.log('Audit-log integrity triggers are in place (Firebase identity binding is protected)');
  }

  /** Resolves when both triggers are healthy; otherwise throws an error that names what is wrong (never connection details). */
  async verify(): Promise<void> {
    let rows: TriggerRow[];
    try {
      rows = await this.prisma.$queryRaw<TriggerRow[]>`
        SELECT t.tgname AS name, t.tgenabled::text AS enabled, t.tgtype::int AS type, p.proname AS fn
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_proc p ON p.oid = t.tgfoid
        WHERE n.nspname = 'public' AND c.relname = 'audit_logs' AND NOT t.tgisinternal`;
    } catch {
      throw new Error('Firebase sign-in is enabled but the audit-log integrity triggers could not be checked (database query failed). Refusing to start');
    }

    const problems: string[] = [];
    for (const need of REQUIRED_TRIGGERS) {
      const row = rows.find((r) => r.name === need.name);
      if (!row) problems.push(`${need.name} is missing`);
      else if (row.enabled !== 'O' && row.enabled !== 'A') problems.push(`${need.name} is disabled`);
      else if (row.fn !== need.fn || (Number(row.type) & need.mask) !== need.mask) problems.push(`${need.name} does not ${need.what} as expected`);
    }
    if (problems.length > 0) {
      throw new Error(
        `Firebase sign-in is enabled but audit_logs is not protected against edits (${problems.join('; ')}). ` +
          'Apply migration 20261030090000_audit_log_integrity to this database, or set FIREBASE_AUTH_ENABLED=false. Refusing to start.',
      );
    }
  }
}
