import { jest } from '@jest/globals';
import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../../../database/prisma.service.js';
import { AuditIntegrityCheck } from './audit-integrity-check.service.js';

// What PostgreSQL reports for the two real triggers: a row-level BEFORE UPDATE OR DELETE trigger is 1+2+8+16 = 27,
// a statement-level BEFORE TRUNCATE trigger is 2+32 = 34.
const HEALTHY = [
  { name: 'audit_logs_append_only', enabled: 'O', type: 27, fn: 'audit_logs_append_only' },
  { name: 'audit_logs_no_truncate', enabled: 'O', type: 34, fn: 'audit_logs_append_only' },
];

const make = (opts: { env?: string; firebase?: boolean; rows?: unknown[]; fail?: Error }) => {
  const query = jest.fn(async () => {
    if (opts.fail) throw opts.fail;
    return opts.rows ?? HEALTHY;
  });
  const config = { getOrThrow: () => ({ env: opts.env ?? 'production', firebase: { auth: { enabled: opts.firebase ?? true } } }) } as unknown as ConfigService;
  const check = new AuditIntegrityCheck(config, { $queryRaw: query } as unknown as PrismaService);
  return { check, query };
};

const message = async (p: Promise<unknown>) => ((await p.catch((e: unknown) => e)) as Error).message;

describe('AuditIntegrityCheck', () => {
  it('passes when both triggers exist, are enabled, call the expected function and fire on the expected events', async () => {
    const { check, query } = make({});
    await expect(check.verify()).resolves.toBeUndefined();
    await expect(check.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('accepts a trigger set to fire always, but not one that fires only in replica sessions', async () => {
    await expect(make({ rows: [{ ...HEALTHY[0]!, enabled: 'A' }, HEALTHY[1]!] }).check.verify()).resolves.toBeUndefined();
    expect(await message(make({ rows: [{ ...HEALTHY[0]!, enabled: 'R' }, HEALTHY[1]!] }).check.verify())).toContain('audit_logs_append_only is disabled');
  });

  it('refuses to start when a trigger is missing, naming it and the migration to apply', async () => {
    const noUpdate = await message(make({ rows: [HEALTHY[1]!] }).check.onApplicationBootstrap());
    expect(noUpdate).toContain('audit_logs_append_only is missing');
    expect(noUpdate).toContain('20261030090000_audit_log_integrity');
    expect(noUpdate).toContain('Refusing to start');
    expect(await message(make({ rows: [HEALTHY[0]!] }).check.onApplicationBootstrap())).toContain('audit_logs_no_truncate is missing');
    const none = await message(make({ rows: [] }).check.onApplicationBootstrap());
    expect(none).toContain('audit_logs_append_only is missing');
    expect(none).toContain('audit_logs_no_truncate is missing');
  });

  it('refuses to start when a trigger is disabled', async () => {
    for (const [i, name] of ['audit_logs_append_only', 'audit_logs_no_truncate'].entries()) {
      const rows = HEALTHY.map((r, k) => (k === i ? { ...r, enabled: 'D' } : r));
      expect(await message(make({ rows }).check.onApplicationBootstrap())).toContain(`${name} is disabled`);
    }
  });

  it('refuses a trigger that has the right name but the wrong function or the wrong events', async () => {
    expect(await message(make({ rows: [{ ...HEALTHY[0]!, fn: 'something_else' }, HEALTHY[1]!] }).check.verify())).toContain('audit_logs_append_only does not block UPDATE and DELETE');
    expect(await message(make({ rows: [{ ...HEALTHY[0]!, type: 2 + 4 }, HEALTHY[1]!] }).check.verify())).toContain('audit_logs_append_only does not block UPDATE and DELETE'); // an INSERT trigger
    expect(await message(make({ rows: [{ ...HEALTHY[0]!, type: 2 + 8 + 16 }, HEALTHY[1]!] }).check.verify())).toContain('does not block UPDATE and DELETE'); // statement-level, not per row
    expect(await message(make({ rows: [HEALTHY[0]!, { ...HEALTHY[1]!, type: 2 + 16 }] }).check.verify())).toContain('audit_logs_no_truncate does not block TRUNCATE');
    expect(await message(make({ rows: [HEALTHY[0]!, { ...HEALTHY[1]!, fn: 'x' }] }).check.verify())).toContain('audit_logs_no_truncate does not block TRUNCATE');
  });

  it('fails closed when the check itself cannot run, without repeating the database error', async () => {
    const m = await message(make({ fail: new Error('password authentication failed for user "app" (postgresql://app:Sup3rSecret@db/x)') }).check.onApplicationBootstrap());
    expect(m).toContain('could not be checked');
    expect(m).toContain('Refusing to start');
    expect(m).not.toMatch(/Sup3rSecret|postgresql:|password/i);
  });

  it('does nothing (and runs no query) when Firebase sign-in is off, even in production, or under NODE_ENV=test', async () => {
    for (const opts of [{ firebase: false, env: 'production' }, { firebase: false, env: 'development' }, { firebase: true, env: 'test' }]) {
      const { check, query } = make({ ...opts, rows: [] }); // an unhealthy database would fail the check if it ran
      await expect(check.onApplicationBootstrap()).resolves.toBeUndefined();
      expect(query).not.toHaveBeenCalled();
    }
  });

  it('is enforced in production and in development when Firebase sign-in is on', async () => {
    for (const env of ['production', 'development']) {
      const { check, query } = make({ env, rows: [] });
      await expect(check.onApplicationBootstrap()).rejects.toThrow('Refusing to start');
      expect(query).toHaveBeenCalledTimes(1);
    }
  });
});
