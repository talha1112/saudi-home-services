import { NodeEnv, databaseUrlProblems, firebaseCheckRevoked, parseFirebaseServiceAccount, parseOrigins, redisUrlProblems, validateEnv } from './env.validation.js';

const required = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  REDIS_URL: 'redis://:pass@localhost:6379',
  JWT_ACCESS_SECRET: 'a'.repeat(40),
  OTP_HMAC_SECRET: 'b'.repeat(40),
};

describe('validateEnv', () => {
  it('applies defaults for an empty environment', () => {
    const env = validateEnv({ ...required });
    expect(env).toMatchObject({
      NODE_ENV: NodeEnv.Development,
      PORT: 3001,
      API_PREFIX: 'api',
      API_DEFAULT_VERSION: '1',
      LOG_LEVEL: 'info',
      REQUEST_TIMEOUT_MS: 30000,
    });
    expect(env.SWAGGER_ENABLED).toBeUndefined();
  });

  it('coerces numeric and boolean strings', () => {
    const env = validateEnv({ ...required, PORT: '8080', SWAGGER_ENABLED: 'false', REQUEST_TIMEOUT_MS: '5000' });
    expect(env.PORT).toBe(8080);
    expect(env.SWAGGER_ENABLED).toBe(false);
    expect(env.REQUEST_TIMEOUT_MS).toBe(5000);
  });

  it.each([
    [{ NODE_ENV: 'staging' }, 'NODE_ENV'],
    [{ PORT: 'abc' }, 'PORT'],
    [{ PORT: '70000' }, 'PORT'],
    [{ LOG_LEVEL: 'loud' }, 'LOG_LEVEL'],
  ])('rejects invalid values %j', (raw, property) => {
    expect(() => validateEnv({ ...required, ...raw })).toThrow(property);
  });

  it('rejects a wildcard CORS origin in production only', () => {
    expect(() => validateEnv({ ...required, NODE_ENV: 'production', CORS_ORIGINS: '*' })).toThrow('CORS_ORIGINS');
    expect(() => validateEnv({ ...required, NODE_ENV: 'development', CORS_ORIGINS: '*' })).not.toThrow();
  });
});

describe('validateEnv — data stores', () => {
  it('requires DATABASE_URL and REDIS_URL', () => {
    expect(() => validateEnv({})).toThrow('DATABASE_URL');
    expect(() => validateEnv({ DATABASE_URL: required.DATABASE_URL })).toThrow('REDIS_URL');
  });

  it('rejects connection strings with the wrong scheme', () => {
    expect(() => validateEnv({ ...required, DATABASE_URL: 'mysql://u:p@h/db' })).toThrow('DATABASE_URL');
    expect(() => validateEnv({ ...required, REDIS_URL: 'http://h' })).toThrow('REDIS_URL');
  });

  it('never echoes credentials in the error message', () => {
    try {
      validateEnv({ ...required, DATABASE_URL: 'mysql://u:supersecret@h/db' });
    } catch (e) {
      expect(String(e)).not.toContain('supersecret');
    }
  });
});

describe('parseOrigins', () => {
  it('splits, trims and drops empties', () => {
    expect(parseOrigins(' https://a.example , ,https://b.example ')).toEqual(['https://a.example', 'https://b.example']);
    expect(parseOrigins(undefined)).toEqual([]);
  });

  describe('authentication settings', () => {
    it('requires long secrets', () => {
      expect(() => validateEnv({ ...required, JWT_ACCESS_SECRET: 'short' })).toThrow('JWT_ACCESS_SECRET');
      expect(() => validateEnv({ ...required, OTP_HMAC_SECRET: undefined })).toThrow('OTP_HMAC_SECRET');
    });

    it('rejects the dev SMS provider in production', () => {
      expect(() => validateEnv({ ...required, NODE_ENV: 'production', SMS_PROVIDER: 'dev' })).toThrow('SMS_PROVIDER');
      expect(() => validateEnv({ ...required, NODE_ENV: 'production', TRUST_PROXY_HOPS: '1', SMS_PROVIDER: 'disabled' })).not.toThrow();
      expect(() => validateEnv({ ...required, NODE_ENV: 'development', SMS_PROVIDER: 'dev' })).not.toThrow();
    });

    it('rejects placeholder secrets everywhere except tests, and shared secrets in production', () => {
      const placeholder = 'CHANGE_ME_' + 'x'.repeat(30);
      expect(() => validateEnv({ ...required, NODE_ENV: 'production', JWT_ACCESS_SECRET: placeholder })).toThrow('placeholder');
      expect(() => validateEnv({ ...required, NODE_ENV: 'development', OTP_HMAC_SECRET: placeholder })).toThrow('placeholder');
      expect(() => validateEnv({ ...required, NODE_ENV: 'test', OTP_HMAC_SECRET: placeholder })).not.toThrow();
      const prod = { ...required, NODE_ENV: 'production', TRUST_PROXY_HOPS: '1' };
      expect(() => validateEnv({ ...prod, OTP_HMAC_SECRET: required.JWT_ACCESS_SECRET })).toThrow('differ');
    });

    it('has safe OTP defaults', () => {
      const env = validateEnv({ ...required });
      expect(env).toMatchObject({
        ACCESS_TOKEN_TTL_SECONDS: 900,
        OTP_TTL_SECONDS: 300,
        OTP_MAX_ATTEMPTS: 5,
        OTP_RESEND_COOLDOWN_SECONDS: 60,
        DEFAULT_PHONE_REGION: 'SA',
      });
    });
  });

  describe('production connection safeguards', () => {
    const prod = { ...required, NODE_ENV: 'production', TRUST_PROXY_HOPS: '1' };

    it('requires TRUST_PROXY_HOPS to be set explicitly in production, and allows an explicit 0', () => {
      const { TRUST_PROXY_HOPS: _omit, ...withoutHops } = prod;
      expect(() => validateEnv(withoutHops)).toThrow('TRUST_PROXY_HOPS');
      expect(() => validateEnv({ ...prod, TRUST_PROXY_HOPS: '' })).toThrow('TRUST_PROXY_HOPS');
      expect(() => validateEnv({ ...prod, TRUST_PROXY_HOPS: '0' })).not.toThrow();
      expect(() => validateEnv({ ...required, TRUST_PROXY_HOPS: undefined })).not.toThrow(); // development keeps its default
    });

    it('requires TLS and a password for a database that is not on this machine', () => {
      expect(databaseUrlProblems('postgresql://u:p@db.example.com:5432/app')).toHaveLength(1); // no sslmode
      expect(databaseUrlProblems('postgresql://u@db.example.com:5432/app?sslmode=require')).toHaveLength(1); // no password
      expect(databaseUrlProblems('postgresql://u:p@db.example.com:5432/app?sslmode=disable')).toHaveLength(1);
      expect(databaseUrlProblems('postgresql://u:p@db.example.com:5432/app?sslmode=prefer')).toHaveLength(1);
      for (const mode of ['require', 'verify-ca', 'verify-full']) expect(databaseUrlProblems(`postgresql://u:p@db.example.com:5432/app?sslmode=${mode}`)).toEqual([]);
      expect(databaseUrlProblems('postgresql://u:p@localhost:5432/app')).toEqual([]);
      expect(databaseUrlProblems('postgresql://u:p@127.0.0.1:5432/app')).toEqual([]);
    });

    it('requires TLS and a password for a Redis that is not on this machine', () => {
      expect(redisUrlProblems('redis://:p@cache.example.com:6379')).toHaveLength(1); // plaintext
      expect(redisUrlProblems('rediss://cache.example.com:6379')).toHaveLength(1); // no password
      expect(redisUrlProblems('rediss://:p@cache.example.com:6379')).toEqual([]);
      expect(redisUrlProblems('redis://127.0.0.1:6379')).toEqual([]);
    });

    it('rejects an insecure remote database or Redis at startup without echoing the URL', () => {
      let message = '';
      try {
        validateEnv({ ...prod, DATABASE_URL: 'postgresql://app:Sup3rSecret@db.example.com:5432/app' });
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toContain('DATABASE_URL must use TLS');
      expect(message).not.toContain('Sup3rSecret');
      expect(() => validateEnv({ ...prod, REDIS_URL: 'redis://:pw@cache.example.com:6379' })).toThrow('REDIS_URL must use TLS');
      expect(() => validateEnv({ ...prod, DATABASE_URL: 'postgresql://app:pw@db.example.com:5432/app?sslmode=verify-full', REDIS_URL: 'rediss://:pw@cache.example.com:6379' })).not.toThrow();
    });
  });

  describe('Firebase phone sign-in settings', () => {
    const account = (over: Record<string, unknown> = {}) =>
      Buffer.from(JSON.stringify({ type: 'service_account', project_id: 'hs-demo-project', client_email: 'svc@hs-demo-project.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----\nTESTONLY-NOT-A-KEY\n-----END PRIVATE KEY-----\n', ...over })).toString('base64');
    const on = { ...required, FIREBASE_AUTH_ENABLED: 'true', FIREBASE_PROJECT_ID: 'hs-demo-project' };
    const prodOn = { ...on, NODE_ENV: 'production', TRUST_PROXY_HOPS: '1' };

    it('is off by default and then ignores every Firebase value, even malformed ones (only enabled features are validated)', () => {
      const env = validateEnv({ ...required, FIREBASE_SERVICE_ACCOUNT_BASE64: 'not-base64!!', FIREBASE_PROJECT_ID: 'Bad Project', FIREBASE_CHECK_REVOKED: 'true' });
      expect(env.FIREBASE_AUTH_ENABLED).toBe(false);
      expect(() => validateEnv({ ...required, NODE_ENV: 'production', TRUST_PROXY_HOPS: '1', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' })).not.toThrow();
    });

    it('needs a well-formed project id, and nothing else, outside production', () => {
      expect(() => validateEnv({ ...required, FIREBASE_AUTH_ENABLED: 'true' })).toThrow('FIREBASE_PROJECT_ID');
      expect(() => validateEnv({ ...required, FIREBASE_AUTH_ENABLED: 'true', FIREBASE_PROJECT_ID: 'Not A Project' })).toThrow('FIREBASE_PROJECT_ID');
      const env = validateEnv(on);
      expect(env.FIREBASE_MAX_AUTH_AGE_SECONDS).toBe(300);
      expect(env.FIREBASE_ALLOW_PHONE_ACCOUNT_ADOPTION).toBe(false);
      expect(firebaseCheckRevoked(env)).toBe(false);
    });

    it('checks revocation by default in production, which then needs the service account; an explicit false (or empty = unset) is respected', () => {
      expect(() => validateEnv(prodOn)).toThrow('FIREBASE_SERVICE_ACCOUNT_BASE64');
      expect(() => validateEnv({ ...prodOn, FIREBASE_SERVICE_ACCOUNT_BASE64: account() })).not.toThrow();
      expect(() => validateEnv({ ...prodOn, FIREBASE_CHECK_REVOKED: 'false' })).not.toThrow();
      expect(() => validateEnv({ ...prodOn, FIREBASE_CHECK_REVOKED: '' })).toThrow('FIREBASE_SERVICE_ACCOUNT_BASE64'); // blank means "not set", never "off"
      expect(() => validateEnv({ ...on, FIREBASE_CHECK_REVOKED: 'true' })).toThrow('FIREBASE_SERVICE_ACCOUNT_BASE64');
    });

    it('rejects a service account that is not a key file or belongs to another project, without echoing it', () => {
      for (const bad of ['%%%', Buffer.from('{"nope":1}').toString('base64'), Buffer.from('plain text').toString('base64')]) {
        expect(() => validateEnv({ ...on, FIREBASE_SERVICE_ACCOUNT_BASE64: bad })).toThrow('FIREBASE_SERVICE_ACCOUNT_BASE64');
      }
      let message = '';
      try {
        validateEnv({ ...on, FIREBASE_SERVICE_ACCOUNT_BASE64: account({ project_id: 'another-project' }) });
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toContain('different Firebase project');
      expect(message).not.toMatch(/PRIVATE KEY|TESTONLY|svc@/);
    });

    it('cannot turn on account adoption by accident in production: a stray "true" is refused, it needs the exact project id as a second step', () => {
      const adopt = { ...prodOn, FIREBASE_SERVICE_ACCOUNT_BASE64: account(), FIREBASE_ALLOW_PHONE_ACCOUNT_ADOPTION: 'true' };
      for (const value of ['true', '1', 'yes', 'TRUE']) expect(() => validateEnv({ ...adopt, FIREBASE_ALLOW_PHONE_ACCOUNT_ADOPTION: value })).toThrow('FIREBASE_ADOPTION_CONFIRM_PROJECT');
      expect(() => validateEnv({ ...adopt, FIREBASE_ADOPTION_CONFIRM_PROJECT: 'true' })).toThrow('FIREBASE_ADOPTION_CONFIRM_PROJECT');
      expect(() => validateEnv({ ...adopt, FIREBASE_ADOPTION_CONFIRM_PROJECT: 'another-project' })).toThrow('FIREBASE_ADOPTION_CONFIRM_PROJECT');
      expect(() => validateEnv({ ...adopt, FIREBASE_ADOPTION_CONFIRM_PROJECT: 'hs-demo-project' })).not.toThrow(); // deliberate, for a demo project
      expect(() => validateEnv({ ...prodOn, FIREBASE_SERVICE_ACCOUNT_BASE64: account(), FIREBASE_ADOPTION_CONFIRM_PROJECT: 'hs-demo-project' }).FIREBASE_ALLOW_PHONE_ACCOUNT_ADOPTION).not.toThrow();
      expect(validateEnv({ ...prodOn, FIREBASE_SERVICE_ACCOUNT_BASE64: account() }).FIREBASE_ALLOW_PHONE_ACCOUNT_ADOPTION).toBe(false); // off unless set
      expect(() => validateEnv({ ...on, FIREBASE_ALLOW_PHONE_ACCOUNT_ADOPTION: 'true' })).not.toThrow(); // development / test need no second step
    });

    it('refuses the Auth Emulator in production (the SDK would accept unsigned tokens) but allows it elsewhere', () => {
      expect(() => validateEnv({ ...prodOn, FIREBASE_SERVICE_ACCOUNT_BASE64: account(), FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' })).toThrow('FIREBASE_AUTH_EMULATOR_HOST');
      expect(() => validateEnv({ ...on, FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' })).not.toThrow();
    });

    it('decodes the service account only for an enabled feature, and the decoded key is never part of an error', () => {
      expect(parseFirebaseServiceAccount(account()).project_id).toBe('hs-demo-project');
      expect(() => parseFirebaseServiceAccount(Buffer.from('{"project_id":"p","client_email":"e","private_key":"short"}').toString('base64'))).toThrow('not a service-account key file');
    });

    it('is independent of push notifications: Firebase sign-in on does not require FCM, and PUSH_PROVIDER keeps its own rules', () => {
      const env = validateEnv(on);
      expect(env.PUSH_PROVIDER).toBeUndefined();
      expect(env.DEVICE_TOKEN_ENCRYPTION_KEY).toBeUndefined();
    });
  });

  describe('Firebase Cloud Messaging settings (independent of phone sign-in)', () => {
    const account = (over: Record<string, unknown> = {}) =>
      Buffer.from(JSON.stringify({ type: 'service_account', project_id: 'hs-demo-project', client_email: 'svc@hs-demo-project.iam.gserviceaccount.com', private_key: 'x PRIVATE KEY x TESTONLY', ...over })).toString('base64');
    const key = Buffer.alloc(32, 7).toString('base64');
    const fcm = { ...required, PUSH_PROVIDER: 'fcm', FIREBASE_PROJECT_ID: 'hs-demo-project', FIREBASE_SERVICE_ACCOUNT_BASE64: account(), DEVICE_TOKEN_ENCRYPTION_KEY: key };

    it('is off by default: push stays unset (disabled) and nothing Firebase is required or read', () => {
      const env = validateEnv({ ...required, FIREBASE_SERVICE_ACCOUNT_BASE64: 'garbage', FIREBASE_PROJECT_ID: 'Bad Project' });
      expect(env.PUSH_PROVIDER).toBeUndefined();
      expect(env.FCM_DRY_RUN).toBe(false);
      expect(() => validateEnv({ ...required, PUSH_PROVIDER: 'disabled' })).not.toThrow();
    });

    it('works with phone sign-in OFF (the default), and phone sign-in works with FCM off', () => {
      const env = validateEnv(fcm);
      expect(env.PUSH_PROVIDER).toBe('fcm');
      expect(env.FIREBASE_AUTH_ENABLED).toBe(false);
      const signInOnly = validateEnv({ ...required, FIREBASE_AUTH_ENABLED: 'true', FIREBASE_PROJECT_ID: 'hs-demo-project' });
      expect(signInOnly.PUSH_PROVIDER).toBeUndefined();
      expect(() => validateEnv({ ...fcm, FIREBASE_AUTH_ENABLED: 'true', FIREBASE_CHECK_REVOKED: 'true' })).not.toThrow(); // both at once share the project and key
    });

    it('needs the project, a valid service account of that project, and the device-token key, each named in the error', () => {
      const without = (name: string) => {
        const copy: Record<string, unknown> = { ...fcm };
        delete copy[name];
        return copy;
      };
      expect(() => validateEnv(without('FIREBASE_PROJECT_ID'))).toThrow('FIREBASE_PROJECT_ID');
      expect(() => validateEnv({ ...fcm, FIREBASE_PROJECT_ID: 'Not A Project' })).toThrow('FIREBASE_PROJECT_ID');
      expect(() => validateEnv(without('FIREBASE_SERVICE_ACCOUNT_BASE64'))).toThrow('FIREBASE_SERVICE_ACCOUNT_BASE64');
      expect(() => validateEnv({ ...fcm, FIREBASE_SERVICE_ACCOUNT_BASE64: '%%%' })).toThrow('FIREBASE_SERVICE_ACCOUNT_BASE64');
      expect(() => validateEnv(without('DEVICE_TOKEN_ENCRYPTION_KEY'))).toThrow('DEVICE_TOKEN_ENCRYPTION_KEY');
      expect(() => validateEnv({ ...fcm, DEVICE_TOKEN_ENCRYPTION_KEY: Buffer.alloc(16).toString('base64') })).toThrow('exactly 32 bytes');
    });

    it('refuses a service account of another project without echoing the key', () => {
      let message = '';
      try {
        validateEnv({ ...fcm, FIREBASE_SERVICE_ACCOUNT_BASE64: account({ project_id: 'another-project' }) });
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toContain('different Firebase project');
      expect(message).not.toMatch(/PRIVATE KEY|TESTONLY|svc@/);
    });

    it('is allowed in production (it is the real provider) while the mock still is not', () => {
      const prod = { ...fcm, NODE_ENV: 'production', TRUST_PROXY_HOPS: '1' };
      expect(() => validateEnv(prod)).not.toThrow();
      expect(() => validateEnv({ ...prod, PUSH_PROVIDER: 'mock' })).toThrow('PUSH_PROVIDER=mock');
    });

    it('reads FCM_DRY_RUN as an explicit boolean that defaults to a real send', () => {
      expect(validateEnv(fcm).FCM_DRY_RUN).toBe(false);
      expect(validateEnv({ ...fcm, FCM_DRY_RUN: 'true' }).FCM_DRY_RUN).toBe(true);
    });
  });
});
