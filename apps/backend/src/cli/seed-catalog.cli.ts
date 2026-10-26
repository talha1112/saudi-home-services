/**
 * Creates the launch cities, categories and services that do not exist yet (matched by slug).
 * Existing rows are never changed, so edits made through the admin API survive re-runs.
 *
 *   npm run build
 *   npm run db:seed
 */
import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import appConfig from '../config/app.config.js';
import { DatabaseModule } from '../database/database.module.js';
import { PrismaService } from '../database/prisma.service.js';
import { SEED_CATEGORIES, SEED_CITIES, SEED_PRICING } from '../modules/catalog/seed-data.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [appConfig], envFilePath: ['.env.local', '.env'] }),
    DatabaseModule,
  ],
})
class CliModule {}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(CliModule, { logger: ['error', 'warn'] });
  try {
    const prisma = app.get(PrismaService);
    let created = 0;

    for (const city of SEED_CITIES) {
      const exists = await prisma.city.findUnique({ where: { slug: city.slug } });
      if (!exists) {
        await prisma.city.create({ data: city });
        created++;
      }
    }
    for (const { services, ...category } of SEED_CATEGORIES) {
      let row = await prisma.serviceCategory.findUnique({ where: { slug: category.slug } });
      if (!row) {
        row = await prisma.serviceCategory.create({ data: category });
        created++;
      }
      for (const service of services) {
        if (!(await prisma.service.findUnique({ where: { slug: service.slug } }))) {
          await prisma.service.create({ data: { ...service, categoryId: row.id } });
          created++;
        }
      }
    }
    if ((await prisma.pricingSetting.count()) === 0) {
      await prisma.pricingSetting.create({ data: SEED_PRICING });
      created++;
      console.log('Inserted PROVISIONAL pricing (VAT 15%, commission 15%, min SAR 50). Replace it via the admin pricing API.');
    }
    console.log(created === 0 ? 'Catalog already seeded; nothing to do.' : `Seeded ${created} missing catalog rows.`);
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error('Seeding failed:', (err as Error).message);
  process.exitCode = 1;
});
