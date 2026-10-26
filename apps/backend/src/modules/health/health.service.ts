import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { APP_CONFIG, type AppConfig } from '../../config/app.config.js';
import { PrismaService } from '../../database/prisma.service.js';
import { RedisService } from '../../database/redis.service.js';
import { JobsService } from '../realtime/jobs/jobs.service.js';
import { HealthResponseDto } from './dto/health-response.dto.js';
import type { DependencyState, ReadinessResponseDto } from './dto/readiness-response.dto.js';

const CHECK_TIMEOUT_MS = 2000;

@Injectable()
export class HealthService {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly moduleRef: ModuleRef,
  ) {}

  /** Liveness: the process is up. Does not touch any dependency. */
  check(): HealthResponseDto {
    const app = this.config.getOrThrow<AppConfig>(APP_CONFIG);
    return {
      status: 'ok',
      environment: app.env,
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }

  /** Readiness: PostgreSQL and Redis answer within a short timeout. */
  async readiness(): Promise<ReadinessResponseDto> {
    const [database, redis] = await Promise.all([
      this.probe(() => this.prisma.$queryRaw`SELECT 1`),
      this.probe(() => this.redis.ping()),
    ]);
    return {
      status: database === 'up' && redis === 'up' ? 'ok' : 'degraded',
      checks: { database, redis },
      ...this.jobsInfo(),
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Background jobs are reported for visibility but do NOT make the service "degraded": the API still serves
   * requests without them, and a probe that restarted the process would not fix an unreachable Redis.
   */
  private jobsInfo(): { jobs?: string } {
    try {
      const { state } = this.moduleRef.get(JobsService, { strict: false }).status();
      return state === 'disabled' ? {} : { jobs: state };
    } catch {
      return {}; // jobs module not part of this application
    }
  }

  private async probe(fn: () => Promise<unknown>): Promise<DependencyState> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        fn(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), CHECK_TIMEOUT_MS);
        }),
      ]);
      return 'up';
    } catch {
      return 'down';
    } finally {
      clearTimeout(timer);
    }
  }
}
