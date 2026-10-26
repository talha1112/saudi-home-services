import { Global, Module } from '@nestjs/common';
import { KeyValueStore } from './key-value.store.js';
import { PrismaService } from './prisma.service.js';
import { RedisKeyValueStore } from './redis-key-value.store.js';
import { RedisService } from './redis.service.js';

/** Provides the PostgreSQL (Prisma) and Redis clients to every feature module. */
@Global()
@Module({
  providers: [PrismaService, RedisService, { provide: KeyValueStore, useClass: RedisKeyValueStore }],
  exports: [PrismaService, RedisService, KeyValueStore],
})
export class DatabaseModule {}
