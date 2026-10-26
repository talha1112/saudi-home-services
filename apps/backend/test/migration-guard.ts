import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/** The one database the integration tests and the test-migration script may use. Keep in sync with REQUIRED_DATABASE in scripts/migrate-test-db.mjs. */
export const TEST_DATABASE_NAME = 'home_services_test';

export function databaseNameOf(url: string): string {
  return decodeURIComponent(new URL(url).pathname.slice(1));
}

/** Throws unless [name] is exactly the test database. Pure string check: nothing is connected to, no credentials are involved. */
export function assertTestDatabaseName(name: string): void {
  if (name !== TEST_DATABASE_NAME) throw new Error(`Refusing to run: database "${name}" is not "${TEST_DATABASE_NAME}".`);
}

interface Queryable {
  $queryRawUnsafe<T = unknown>(query: string): Promise<T>;
}

/**
 * Fails fast, with the fix, when the test database has not been migrated, instead of letting
 * every test die with "table public.users does not exist". Read-only.
 */
export async function assertTestDatabaseMigrated(prisma: Queryable): Promise<void> {
  // The database this connection REALLY reached (not what the URL claims), checked before anything else is read or written.
  const actual = await prisma.$queryRawUnsafe<{ d: string }[]>('select current_database() as d');
  assertTestDatabaseName(actual[0]?.d ?? '');
  const onDisk = readdirSync(join(process.cwd(), 'prisma', 'migrations'), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  const exists = await prisma.$queryRawUnsafe<{ t: string | null }[]>("select to_regclass('public._prisma_migrations')::text as t");
  const help = 'Apply them to the TEST database only with: npm run db:migrate:test   (check first with: npm run db:migrate:test:status)';
  if (!exists[0]?.t) {
    throw new Error(`The test database has no migrations applied (expected ${onDisk.length}). ${help}`);
  }
  const rows = await prisma.$queryRawUnsafe<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }[]>(
    'select migration_name, finished_at, rolled_back_at from _prisma_migrations',
  );
  const done = new Set(rows.filter((r) => r.finished_at && !r.rolled_back_at).map((r) => r.migration_name));
  const pending = onDisk.filter((m) => !done.has(m));
  if (pending.length > 0) {
    throw new Error(`The test database is missing migrations: ${pending.join(', ')}. ${help}`);
  }
}
