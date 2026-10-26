/**
 * Operator CLI for administrator accounts. Not reachable over HTTP.
 *
 *   npm run build
 *   ADMIN_EMAIL=... ADMIN_PASSWORD=... npm run admin:bootstrap
 *   ADMIN_EMAIL=... ADMIN_PASSWORD=... npm run admin:reset-password
 *
 * Passwords are read from the environment only (never from argv, which shows in process lists)
 * and are never printed.
 */
import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import appConfig from '../config/app.config.js';
import { DatabaseModule } from '../database/database.module.js';
import { AdminBootstrapService, AdminSetupError } from '../modules/auth/admin/admin-bootstrap.service.js';
import { AuthModule } from '../modules/auth/auth.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [appConfig], envFilePath: ['.env.local', '.env'] }),
    DatabaseModule,
    AuthModule,
  ],
})
class CliModule {}

async function main(): Promise<void> {
  const command = process.argv[2];
  const email = process.env['ADMIN_EMAIL'] ?? '';
  const password = process.env['ADMIN_PASSWORD'] ?? '';
  if (command !== 'bootstrap' && command !== 'reset-password') {
    console.error('Usage: admin.cli.js <bootstrap|reset-password>   (set ADMIN_EMAIL and ADMIN_PASSWORD)');
    process.exitCode = 2;
    return;
  }
  if (!email || !password) {
    console.error('ADMIN_EMAIL and ADMIN_PASSWORD must be set in the environment.');
    process.exitCode = 2;
    return;
  }

  const app = await NestFactory.createApplicationContext(CliModule, { logger: ['error', 'warn'] });
  try {
    const admin = app.get(AdminBootstrapService);
    if (command === 'bootstrap') {
      const created = await admin.createInitialAdmin({ email, password, fullName: process.env['ADMIN_NAME'] });
      console.log(`Administrator created: ${created.email}. A password change is required at first sign-in.`);
    } else {
      await admin.resetPassword(email, password);
      console.log(`Password reset for ${email}. All sessions were revoked and a password change is required at next sign-in.`);
    }
  } catch (err) {
    if (err instanceof AdminSetupError) {
      console.error(`Error: ${err.message}`);
      process.exitCode = 1;
    } else {
      throw err;
    }
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error('Unexpected failure:', (err as Error).message);
  process.exitCode = 1;
});
