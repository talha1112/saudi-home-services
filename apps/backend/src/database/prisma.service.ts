import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { APP_CONFIG, type AppConfig } from '../config/app.config.js';
import { PrismaClient } from '../generated/prisma/client.js';

/**
 * Application-wide Prisma client (Prisma 7 uses a driver adapter for PostgreSQL).
 *
 * The client connects lazily on the first query, so the API can boot while the
 * database is still starting; `GET /api/v1/health/ready` reports the real state.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor(config: ConfigService) {
    const { databaseUrl } = config.getOrThrow<AppConfig>(APP_CONFIG);
    // Pin every session to UTC. The adapter sends JavaScript Dates as zone-less UTC text, and PostgreSQL reads such text in the
    // SESSION time zone: on a server whose zone is not UTC (a Windows cluster follows the machine's zone, e.g. Asia/Karachi) every
    // timestamp the application wrote was silently shifted by the server's offset and no longer matched now(). This is a per-connection
    // startup option, not a change to the server's configuration. (A connection pooler that forbids startup options must be configured
    // with UTC instead.)
    super({ adapter: new PrismaPg({ connectionString: databaseUrl, options: '-c TimeZone=UTC' }) });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
