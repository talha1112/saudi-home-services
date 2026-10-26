import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { TEST_DATABASE_NAME, assertTestDatabaseMigrated, assertTestDatabaseName, databaseNameOf } from '../../test/migration-guard.js';

/**
 * Safety checks around the test database. Everything here is static or runs the migration script with arguments/URLs that must be refused
 * BEFORE any connection: the child process starts in an empty temp directory (no .env), with no database URL unless a test passes one that
 * the script has to reject by name, and a port nothing listens on. Nothing connects, nothing migrates.
 */
const SCRIPT = resolve(process.cwd(), 'scripts', 'migrate-test-db.mjs');

function runScript(args: string[], env: Record<string, string> = {}) {
  const res = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: tmpdir(), // no .env here
    env: { PATH: process.env['PATH'] ?? '', SystemRoot: process.env['SystemRoot'] ?? '', ...env },
    encoding: 'utf8',
    timeout: 20_000,
  });
  return { code: res.status, out: `${res.stdout}${res.stderr}` };
}

describe('scripts/migrate-test-db.mjs refuses before doing anything', () => {
  it.each([
    [[]],
    [['bogus']],
    [['deploy', 'extra']],
    [['status', '--force']],
    [['DEPLOY']],
    [['migrate']],
    [['reset']],
    [['']],
    [['resolve-applied']], // a migration name is required
    [['resolve-rolled-back']],
    [['resolve-applied', '20261101090000_device_session_binding', 'extra']],
    [['deploy', '20261101090000_device_session_binding']], // deploy takes no name
    [['resolve-applied', 'not-a-migration']],
    [['resolve-rolled-back', '20261101090000_does_not_exist']], // must be a real folder in prisma/migrations
    [['resolve-applied', '../20261101090000_device_session_binding']],
  ])('arguments %j: aborts, mentions the allowed commands, never reaches Prisma or a connection', (args) => {
    const { code, out } = runScript(args as string[]);
    expect(code).toBe(1);
    expect(out).toContain('ABORTED');
    expect(out).not.toContain('Target confirmed');
    expect(out).not.toContain('TEST_DATABASE_URL'); // the environment was not even consulted
  });

  it('the usage message lists exactly the supported commands', () => {
    const { out } = runScript(['bogus']);
    expect(out).toContain('status | deploy | resolve-applied <migration> | resolve-rolled-back <migration>');
  });

  it('a supported resolve command with a real migration name still stops at the missing database URL, before connecting', () => {
    for (const mode of ['resolve-applied', 'resolve-rolled-back']) {
      const { code, out } = runScript([mode, '20261101090000_device_session_binding']);
      expect(code).toBe(1);
      expect(out).toContain('TEST_DATABASE_URL is not set');
    }
  });

  it('with a supported argument but no TEST_DATABASE_URL it still stops before connecting', () => {
    for (const mode of ['status', 'deploy']) {
      const { code, out } = runScript([mode]);
      expect(code).toBe(1);
      expect(out).toContain('TEST_DATABASE_URL is not set');
    }
  });

  it.each(['saudi_home_services', 'other_test', 'home_services_test_2', 'Home_Services_Test', 'postgres'])(
    'refuses a TEST_DATABASE_URL naming "%s" (only home_services_test is allowed), before any connection and without printing the URL or password',
    (name) => {
      const { code, out } = runScript(['deploy'], { TEST_DATABASE_URL: `postgresql://user:SECRETPW@127.0.0.1:1/${name}` });
      expect(code).toBe(1);
      expect(out).toContain(`"${name}" is not "home_services_test"`);
      expect(out).not.toContain('SECRETPW');
      expect(out).not.toContain('Target confirmed');
    },
  );

  it('refuses when the test and development URLs name the same database', () => {
    const url = `postgresql://user:SECRETPW@127.0.0.1:1/${TEST_DATABASE_NAME}`;
    const { code, out } = runScript(['deploy'], { TEST_DATABASE_URL: url, DATABASE_URL: url });
    expect(code).toBe(1);
    expect(out).toContain('point at the same database');
    expect(out).not.toContain('SECRETPW');
  });

  it('checks the arguments before it loads the environment, and the database name before it creates any connection or starts Prisma (source order)', () => {
    const src = readFileSync(SCRIPT, 'utf8');
    const at = (needle: string) => {
      const i = src.indexOf(needle);
      expect(i).toBeGreaterThan(-1);
      return i;
    };
    expect(src).not.toMatch(/^import ['"]dotenv\/config['"]/m); // a static import would run before any check
    expect(at('Object.hasOwn(COMMANDS')).toBeLessThan(at("await import('dotenv/config')"));
    expect(at('the migration name must be exactly')).toBeLessThan(at("await import('dotenv/config')"));
    expect(at("await import('dotenv/config')")).toBeLessThan(at('new pg.Client'));
    expect(at('testName !== REQUIRED_DATABASE')).toBeLessThan(at('new pg.Client'));
    expect(at('actual !== REQUIRED_DATABASE')).toBeLessThan(at('spawnSync(process.execPath, [prismaCli'));
    expect(at('is not recorded as a failed migration')).toBeLessThan(at('spawnSync(process.execPath, [prismaCli'));
    expect(src).not.toMatch(/endsWith\('_test'\)/);
  });
});

describe('test-database name guards', () => {
  it('accept exactly the test database and nothing else', () => {
    expect(() => assertTestDatabaseName('home_services_test')).not.toThrow();
    for (const name of ['saudi_home_services', 'other_test', 'home_services_test2', 'home_services', '', 'HOME_SERVICES_TEST']) {
      expect(() => assertTestDatabaseName(name)).toThrow(/is not "home_services_test"/);
    }
  });

  it('parse the name from a URL without exposing the password', () => {
    expect(databaseNameOf('postgresql://u:p%40ss@127.0.0.1:5432/home_services_test?schema=public')).toBe('home_services_test');
    let message = '';
    try {
      assertTestDatabaseName(databaseNameOf('postgresql://u:SECRETPW@h/prod_db'));
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('prod_db');
    expect(message).not.toContain('SECRETPW');
  });

  it('the migration check verifies the database the connection REALLY reached, before reading migration state', async () => {
    const queries: string[] = [];
    const wrongDb = {
      $queryRawUnsafe: async <T>(q: string): Promise<T> => {
        queries.push(q);
        return [{ d: 'saudi_home_services' }] as T;
      },
    };
    await expect(assertTestDatabaseMigrated(wrongDb)).rejects.toThrow(/is not "home_services_test"/);
    expect(queries).toEqual(['select current_database() as d']); // nothing else was asked of it
  });
});
