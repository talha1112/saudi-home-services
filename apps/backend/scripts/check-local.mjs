/**
 * Read-only health check of the local development setup. Never prints secrets and never
 * changes data: it only reads, plus one self-expiring key to prove Redis GETDEL works.
 *
 *   npm run check:local            # environment + PostgreSQL + migrations + Redis
 *
 * Exit code 0 only when everything needed to run the API is in place.
 */
import { existsSync, readdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import 'dotenv/config';
import pg from 'pg';
import { Redis } from 'ioredis';

let failures = 0;
const ok = (msg) => console.log(`  [ OK ] ${msg}`);
const warn = (msg) => console.log(`  [WARN] ${msg}`);
const fail = (msg) => {
  failures++;
  console.log(`  [FAIL] ${msg}`);
};
const section = (title) => console.log(`\n${title}`);

const PLACEHOLDER = /change_?me/i;

// ---------------------------------------------------------------- environment
section('1. Environment (names only, values are never printed)');
if (!existsSync('.env')) fail('apps/backend/.env does not exist. Run: Copy-Item .env.example .env ; .\\scripts\\setup-local-env.ps1');
const required = ['DATABASE_URL', 'REDIS_URL', 'JWT_ACCESS_SECRET', 'OTP_HMAC_SECRET'];
for (const name of required) {
  const v = process.env[name];
  if (!v) fail(`${name} is missing`);
  else if (PLACEHOLDER.test(v)) fail(`${name} still contains the CHANGE_ME placeholder`);
  else ok(`${name} is set`);
}
for (const name of ['JWT_ACCESS_SECRET', 'OTP_HMAC_SECRET']) {
  if (process.env[name] && process.env[name].length < 32) fail(`${name} must be at least 32 characters`);
}
if (process.env.JWT_ACCESS_SECRET && process.env.JWT_ACCESS_SECRET === process.env.OTP_HMAC_SECRET) {
  fail('JWT_ACCESS_SECRET and OTP_HMAC_SECRET must be different');
}
if ((process.env.NODE_ENV ?? 'development') === 'production' && process.env.SMS_PROVIDER === 'dev') {
  fail('SMS_PROVIDER=dev is not allowed in production');
}

// ----------------------------------------------------------------- PostgreSQL
section('2. PostgreSQL');
const dbUrl = process.env.DATABASE_URL;
if (!dbUrl || PLACEHOLDER.test(dbUrl)) {
  fail('Skipped: DATABASE_URL is not configured yet');
} else {
  let target;
  try {
    target = new URL(dbUrl);
  } catch {
    fail('DATABASE_URL is not a valid URL (URL-encode special characters in the password)');
  }
  if (target) {
    const dbName = decodeURIComponent(target.pathname.slice(1));
    console.log(`  target: host=${target.hostname} port=${target.port || 5432} database=${dbName} user=${decodeURIComponent(target.username)}`);
    if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(target.hostname)) {
      warn('The database host is not local. Make sure this is the intended development database.');
    }
    const client = new pg.Client({ connectionString: dbUrl, connectionTimeoutMillis: 5000 });
    try {
      await client.connect();
      const info = await client.query('select current_database() as db, current_user as usr, version() as v');
      ok(`connected as ${info.rows[0].usr} to ${info.rows[0].db} (${info.rows[0].v.split(',')[0]})`);

      const enc = (await client.query('show server_encoding')).rows[0].server_encoding;
      if (enc !== 'UTF8') {
        fail(`database encoding is ${enc}, but Arabic text needs UTF8. Recreate the (empty) database: see README "One-time PostgreSQL setup"`);
      } else {
        ok('database encoding is UTF8 (Arabic text is safe)');
      }

      const hasTable = (await client.query("select to_regclass('public._prisma_migrations') as t")).rows[0].t;
      const migrationsDir = join('prisma', 'migrations');
      const onDisk = readdirSync(migrationsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort();
      if (!hasTable) {
        warn(`No migrations applied yet. Pending: ${onDisk.join(', ')}`);
        console.log('         Apply with: npm run db:migrate:deploy   (only on the database shown above)');
      } else {
        const applied = (await client.query('select migration_name, finished_at, rolled_back_at from _prisma_migrations order by migration_name')).rows;
        const done = new Set(applied.filter((m) => m.finished_at && !m.rolled_back_at).map((m) => m.migration_name));
        const stuck = applied.filter((m) => !m.finished_at && !m.rolled_back_at);
        const pending = onDisk.filter((m) => !done.has(m));
        const unknown = [...done].filter((m) => !onDisk.includes(m));
        if (stuck.length) fail(`Failed/unfinished migrations: ${stuck.map((m) => m.migration_name).join(', ')}`);
        if (unknown.length) warn(`Database has migrations not in this repo: ${unknown.join(', ')}`);
        if (pending.length) {
          warn(`Pending migrations: ${pending.join(', ')}`);
          console.log('         Apply with: npm run db:migrate:deploy   (only on the database shown above)');
        } else if (!stuck.length) {
          ok(`all ${onDisk.length} migrations are applied`);
        }
      }
    } catch (err) {
      const code = err.code ? ` (${err.code})` : '';
      fail(`cannot use PostgreSQL${code}: ${String(err.message).replace(/password=\S+/gi, 'password=***')}`);
    } finally {
      await client.end().catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------- Redis
section('3. Redis-compatible store (Memurai)');
const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
  fail('Skipped: REDIS_URL is not configured');
} else {
  const redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 4000, retryStrategy: () => null });
  redis.on('error', () => {});
  try {
    await redis.connect();
    const pong = await redis.ping();
    const info = await redis.info('server');
    const version = /redis_version:(\S+)/.exec(info)?.[1] ?? 'unknown';
    const memurai = /memurai_version:(\S+)/.exec(info)?.[1];
    ok(`PING -> ${pong} (redis_version ${version}${memurai ? `, Memurai ${memurai}` : ''})`);
    const [major, minor] = version.split('.').map(Number);
    if (major < 6 || (major === 6 && minor < 2)) fail('GETDEL needs Redis 6.2 or newer');
    const key = `healthcheck:${randomBytes(6).toString('hex')}`;
    await redis.set(key, 'x', 'EX', 10);
    const first = await redis.getdel(key);
    const second = await redis.getdel(key);
    if (first === 'x' && second === null) ok('GETDEL consumes a value exactly once');
    else fail('GETDEL did not behave atomically');
  } catch (err) {
    fail(`cannot use Redis: ${String(err.message).replace(/:[^:@/]+@/g, ':***@')}`);
  } finally {
    redis.disconnect();
  }
}

console.log(`\n${failures === 0 ? 'RESULT: ready to run the API.' : `RESULT: ${failures} problem(s) to fix first.`}`);
process.exit(failures === 0 ? 0 : 1);
