import { jest } from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { Response } from 'express';
import { PrismaService } from '../../database/prisma.service.js';
import { RedisService } from '../../database/redis.service.js';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';

async function setup(db: () => Promise<unknown>, redis: () => Promise<unknown>) {
  const module = await Test.createTestingModule({
    controllers: [HealthController],
    providers: [
      HealthService,
      { provide: ConfigService, useValue: { getOrThrow: () => ({ env: 'test' }) } },
      { provide: PrismaService, useValue: { $queryRaw: db } },
      { provide: RedisService, useValue: { ping: redis } },
    ],
  }).compile();
  return module.get(HealthController);
}

function fakeResponse() {
  const status = jest.fn();
  return { res: { status } as unknown as Response, status };
}

describe('HealthController', () => {
  it('liveness reports ok with environment and uptime', async () => {
    const controller = await setup(async () => 1, async () => 'PONG');
    const result = controller.check();
    expect(result.status).toBe('ok');
    expect(result.environment).toBe('test');
    expect(result.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(new Date(result.timestamp).toString()).not.toBe('Invalid Date');
  });

  it('readiness is ok when both dependencies answer', async () => {
    const controller = await setup(async () => 1, async () => 'PONG');
    const { res, status } = fakeResponse();
    const result = await controller.ready(res);
    expect(result).toMatchObject({ status: 'ok', checks: { database: 'up', redis: 'up' } });
    expect(status).not.toHaveBeenCalled();
  });

  it('readiness is degraded with 503 when a dependency fails', async () => {
    const controller = await setup(
      async () => {
        throw new Error('connection refused');
      },
      async () => 'PONG',
    );
    const { res, status } = fakeResponse();
    const result = await controller.ready(res);
    expect(result).toMatchObject({ status: 'degraded', checks: { database: 'down', redis: 'up' } });
    expect(status).toHaveBeenCalledWith(503);
  });

  it('readiness marks a hanging dependency as down instead of waiting forever', async () => {
    jest.useFakeTimers();
    try {
      const controller = await setup(async () => 1, () => new Promise(() => undefined));
      const pending = controller.ready(fakeResponse().res);
      await jest.advanceTimersByTimeAsync(2500);
      await expect(pending).resolves.toMatchObject({ checks: { database: 'up', redis: 'down' } });
    } finally {
      jest.useRealTimers();
    }
  });
});
