/**
 * Applies, inspects or repairs the Prisma migrations on the TEST database only.
 *
 *   npm run db:migrate:test:status                          read-only
 *   npm run db:migrate:test                                 applies pending migrations (never resets, drops or deletes)
 *   npm run db:migrate:test:resolve-applied     -- <name>   marks ONE failed migration as applied   (after checking its objects exist)
 *   npm run db:migrate:test:resolve-rolled-back -- <name>   marks ONE failed migration as rolled back (after removing what it half-created)
 *
 * Safety, in this order:
 *   1. the command line is validated first, using nothing but process.argv and the migrations folder: an unknown, missing or extra argument
 *      exits before any environment file is loaded, any connection is made or Prisma is started;
 *   2. only then is the environment loaded: TEST_DATABASE_URL must be set, its database name must be exactly "home_services_test" and differ
 *      from the DATABASE_URL database;
 *   3. a real connection must confirm current_database() is that exact name (read-only queries) BEFORE Prisma is started; for the resolve
 *      commands it must also find the named migration recorded as failed (started, not finished, not rolled back);
 *   4. only then DATABASE_URL is replaced, for the Prisma child process alone, with the test URL. Nothing is written to .env, no password
 *      is printed, and there is no fallback to DATABASE_URL (a missing TEST_DATABASE_URL aborts).
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fail = (msg) => {
  console.error(`ABORTED: ${msg}`);
  process.exit(1);
};

// ---- 1. command line (no environment, no network) -------------------------------------------------------------------------------------
const COMMANDS = { status: 0, deploy: 0, 'resolve-applied': 1, 'resolve-rolled-back': 1 }; // value = number of arguments after the command
const USAGE = 'status | deploy | resolve-applied <migration> | resolve-rolled-back <migration>';
const [command, ...rest] = process.argv.slice(2);
if (!Object.hasOwn(COMMANDS, command ?? '') || rest.length !== COMMANDS[command]) {
  fail(`expected one of: ${USAGE}  (use the npm scripts db:migrate:test:status, db:migrate:test, db:migrate:test:resolve-applied, db:migrate:test:resolve-rolled-back).`);
}
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'prisma', 'migrations');
const migrationName = rest[0];
if (migrationName !== undefined) {
  const onDisk = readdirSync(migrationsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  if (!/^\d{14}_[a-z0-9_]+$/.test(migrationName) || !onDisk.includes(migrationName)) {
    fail('the migration name must be exactly the name of a folder in prisma/migrations.');
  }
}

// The only database this script may ever touch. Keep in sync with TEST_DATABASE_NAME in test/migration-guard.ts.
const REQUIRED_DATABASE = 'home_services_test';

// ---- 2. environment ---------------------------------------------------------------------------------------------------------------------
await import('dotenv/config');
const { default: pg } = await import('pg');

const nameOf = (url) => {
  try {
    return decodeURIComponent(new URL(url).pathname.slice(1));
  } catch {
    return null;
  }
};

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) fail('TEST_DATABASE_URL is not set (uncomment and fill it in apps/backend/.env).');
const testName = nameOf(testUrl);
if (!testName) fail('TEST_DATABASE_URL is not a valid URL (URL-encode special characters in the password).');
if (testName !== REQUIRED_DATABASE) fail(`the target database "${testName}" is not "${REQUIRED_DATABASE}". Nothing was connected to or changed.`);
const devName = process.env.DATABASE_URL ? nameOf(process.env.DATABASE_URL) : null;
if (devName && devName === testName) fail(`TEST_DATABASE_URL and DATABASE_URL point at the same database ("${testName}").`);

// ---- 3. real connection, read-only checks ----------------------------------------------------------------------------------------------
const client = new pg.Client({ connectionString: testUrl, connectionTimeoutMillis: 5000 });
try {
  await client.connect();
  const actual = (await client.query('select current_database() as d')).rows[0].d;
  if (actual !== REQUIRED_DATABASE) fail(`connected to "${actual}", expected "${REQUIRED_DATABASE}".`);
  const enc = (await client.query('show server_encoding')).rows[0].server_encoding;
  if (enc !== 'UTF8') fail(`database "${testName}" has encoding ${enc}; Arabic text needs UTF8 (see README).`);
  if (migrationName !== undefined) {
    const rows = (
      await client.query('select finished_at, rolled_back_at from _prisma_migrations where migration_name = $1', [migrationName])
    ).rows;
    const failed = rows.filter((r) => r.finished_at === null && r.rolled_back_at === null);
    if (failed.length !== 1) {
      fail(`"${migrationName}" is not recorded as a failed migration in "${testName}" (found ${rows.length} record(s), ${failed.length} unfinished). Run status first.`);
    }
  }
} catch (err) {
  fail(`cannot connect to the test database: ${String(err.message).replace(/password=\S+/gi, 'password=***')}`);
} finally {
  await client.end().catch(() => {});
}

// ---- 4. Prisma, on the test database only ----------------------------------------------------------------------------------------------
console.log(`Target confirmed: database "${testName}" (development database "${devName ?? 'n/a'}" is not touched).`);
const prismaArgs = {
  status: ['migrate', 'status'],
  deploy: ['migrate', 'deploy'],
  'resolve-applied': ['migrate', 'resolve', '--applied', migrationName ?? ''],
  'resolve-rolled-back': ['migrate', 'resolve', '--rolled-back', migrationName ?? ''],
}[command];
const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');
const result = spawnSync(process.execPath, [prismaCli, ...prismaArgs], {
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: testUrl },
});
process.exit(result.status ?? 1);
