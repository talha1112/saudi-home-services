/**
 * Manual run of the refresh-token cleanup (the API also does this every 6 hours).
 *
 *   npm run build
 *   npm run tokens:purge
 *
 * Deletes only refresh-token rows that are expired, revoked or spent more than 7 days ago.
 */
import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import appConfig from '../config/app.config.js';
import { DatabaseModule } from '../database/database.module.js';
import { AuthModule } from '../modules/auth/auth.module.js';
import { SessionsService } from '../modules/auth/sessions.service.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [appConfig], envFilePath: ['.env.local', '.env'] }),
    DatabaseModule,
    AuthModule,
  ],
})
class CliModule {}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(CliModule, { logger: ['error', 'warn'] });
  try {
    const removed = await app.get(SessionsService).purgeStale();
    console.log(`Removed ${removed.expired} expired, ${removed.revoked} revoked and ${removed.spent} spent refresh tokens.`);
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error('Cleanup failed:', (err as Error).message);
  process.exitCode = 1;
});
