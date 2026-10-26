import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { APP_CONFIG, type AppConfig } from '../src/config/app.config.js';

describe('API (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.LOG_LEVEL = 'silent';
    process.env.CORS_ORIGINS = 'http://allowed.example';
    process.env.SWAGGER_ENABLED = 'true';
    // Unreachable on purpose: e2e must not need running data stores.
    process.env.DATABASE_URL = 'postgresql://nobody:nopass@127.0.0.1:1/none';
    process.env.REDIS_URL = 'redis://:nopass@127.0.0.1:1';
    process.env.JWT_ACCESS_SECRET = 'e2e-access-secret-e2e-access-secret-0123456789';
    process.env.OTP_HMAC_SECRET = 'e2e-otp-secret-e2e-otp-secret-0123456789abcdef';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, app.get(ConfigService).getOrThrow<AppConfig>(APP_CONFIG));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/v1/health returns ok and a request id header', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health').expect(200);
    expect(res.body).toMatchObject({ status: 'ok', environment: 'test' });
    expect(res.headers['x-request-id']).toBeDefined();
  });

  it('GET /api/v1/health/ready returns 503 with both dependencies down', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health/ready').expect(503);
    expect(res.body).toMatchObject({ status: 'degraded', checks: { database: 'down', redis: 'down' } });
  });

  it('answers 503 (not 500) when Redis is unreachable during sign-in', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/otp/request')
      .send({ phone: '0501234567', app: 'customer' })
      .expect(503);
    expect(res.body).toMatchObject({ statusCode: 503, code: 'SERVICE_UNAVAILABLE' });
    // No internals leak to the client.
    expect(JSON.stringify(res.body)).not.toMatch(/ECONN|redis|127\.0\.0\.1|stack/i);
  }, 20000);

  it('echoes an incoming x-request-id', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health').set('x-request-id', 'abc-123');
    expect(res.headers['x-request-id']).toBe('abc-123');
  });

  it('is not served without the version segment', async () => {
    await request(app.getHttpServer()).get('/api/health').expect(404);
  });

  it('returns the shared error shape for unknown routes', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/nope').expect(404);
    expect(res.body).toMatchObject({ statusCode: 404, path: '/api/v1/nope' });
    expect(res.body.timestamp).toBeDefined();
  });

  it('sets security headers', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('allows only configured CORS origins', async () => {
    const allowed = await request(app.getHttpServer()).get('/api/v1/health').set('Origin', 'http://allowed.example');
    expect(allowed.headers['access-control-allow-origin']).toBe('http://allowed.example');
    const blocked = await request(app.getHttpServer()).get('/api/v1/health').set('Origin', 'http://evil.example');
    expect(blocked.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('serves the OpenAPI document', async () => {
    const res = await request(app.getHttpServer()).get('/api/docs-json').expect(200);
    expect(res.body.openapi).toBeDefined();
    expect(res.body.paths['/api/v1/health']).toBeDefined();
  });
});
