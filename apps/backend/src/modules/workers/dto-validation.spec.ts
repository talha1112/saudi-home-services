import { ArgumentMetadata, ValidationPipe } from '@nestjs/common';
import { ListServicesQueryDto, CreateCategoryDto, CreateCityDto, UpdateServiceDto } from '../catalog/dto/catalog.dto.js';
import { ListWorkersQueryDto, ReviewDocumentDto } from './dto/admin-workers.dto.js';
import { DiscoverWorkersQueryDto } from './dto/discovery.dto.js';
import {
  RegisterDocumentDto,
  SetWorkerAreasDto,
  SetWorkerAvailabilityDto,
  SetWorkerServicesDto,
  UpdateWorkerProfileDto,
} from './dto/worker-onboarding.dto.js';

// Same options as app.setup.ts.
const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, transformOptions: { enableImplicitConversion: false } });
const body = (metatype: new () => object): ArgumentMetadata => ({ type: 'body', metatype });
const query = (metatype: new () => object): ArgumentMetadata => ({ type: 'query', metatype });
const ID = '6f1c2f0e-6d4a-4a39-9d1e-0f6b1a9a0001';

const ok = (value: unknown, meta: ArgumentMetadata) => pipe.transform(value, meta);
const bad = async (value: unknown, meta: ArgumentMetadata) => {
  await expect(pipe.transform(value, meta)).rejects.toMatchObject({ status: 400 });
};

describe('catalog DTOs', () => {
  it('accepts a bilingual city and trims text', async () => {
    const dto = (await ok({ slug: 'riyadh', nameEn: ' Riyadh ', nameAr: 'الرياض' }, body(CreateCityDto))) as CreateCityDto;
    expect(dto.nameEn).toBe('Riyadh');
  });

  it.each(['Riyadh', 'riyadh_city', '-riyadh', 'riyadh-', 'ri yadh', '', 'ریاض'])('rejects the slug %j', async (slug) => {
    await bad({ slug, nameEn: 'Riyadh', nameAr: 'الرياض' }, body(CreateCityDto));
  });

  it('rejects unknown fields and missing Arabic names', async () => {
    await bad({ slug: 'jeddah', nameEn: 'Jeddah', nameAr: 'جدة', isAdmin: true }, body(CreateCityDto));
    await bad({ slug: 'jeddah', nameEn: 'Jeddah' }, body(CreateCityDto));
  });

  it('treats an empty optional description as cleared and validates the icon key', async () => {
    const dto = (await ok({ slug: 'plumbing', nameEn: 'Plumbing', nameAr: 'السباكة', descriptionEn: '  ' }, body(CreateCategoryDto))) as CreateCategoryDto;
    expect(dto.descriptionEn).toBeNull();
    await bad({ slug: 'plumbing', nameEn: 'Plumbing', nameAr: 'السباكة', iconKey: 'Bad Key!' }, body(CreateCategoryDto));
  });

  it('does not allow changing a slug', async () => {
    await bad({ slug: 'new-slug' }, body(UpdateServiceDto));
    await expect(ok({ nameAr: 'اسم جديد', isActive: false }, body(UpdateServiceDto))).resolves.toBeDefined();
  });

  it('parses and bounds list filters', async () => {
    const q = (await ok({ page: '2', limit: '50', isActive: 'false', categoryId: ID, q: ' ac ' }, query(ListServicesQueryDto))) as ListServicesQueryDto;
    expect(q).toMatchObject({ page: 2, limit: 50, isActive: false, categoryId: ID, q: 'ac' });
    expect(q.skip).toBe(50);
    await bad({ limit: '101' }, query(ListServicesQueryDto));
    await bad({ page: '0' }, query(ListServicesQueryDto));
    await bad({ isActive: 'sometimes' }, query(ListServicesQueryDto));
    await bad({ categoryId: 'not-a-uuid' }, query(ListServicesQueryDto));
  });
});

describe('worker onboarding DTOs', () => {
  it('bounds the profile fields', async () => {
    await expect(ok({ fullName: 'Ahmed', yearsOfExperience: 0, bio: '' }, body(UpdateWorkerProfileDto))).resolves.toMatchObject({ bio: null, yearsOfExperience: 0 });
    await bad({ yearsOfExperience: 61 }, body(UpdateWorkerProfileDto));
    await bad({ yearsOfExperience: -1 }, body(UpdateWorkerProfileDto));
    await bad({ fullName: 'A' }, body(UpdateWorkerProfileDto));
    await bad({ bio: 'x'.repeat(1001) }, body(UpdateWorkerProfileDto));
  });

  it('refuses clients that try to set server-controlled fields', async () => {
    for (const field of ['verificationStatus', 'isOnline', 'userId', 'verifiedAt', 'role', 'status']) {
      await bad({ fullName: 'Ahmed', [field]: 'APPROVED' }, body(UpdateWorkerProfileDto));
    }
  });

  it('validates the service list', async () => {
    await expect(ok({ services: [{ serviceId: ID, yearsOfExperience: 5 }] }, body(SetWorkerServicesDto))).resolves.toBeDefined();
    await bad({ services: [] }, body(SetWorkerServicesDto));
    await bad({ services: [{ serviceId: 'x' }] }, body(SetWorkerServicesDto));
    await bad({ services: [{ serviceId: ID, yearsOfExperience: 80 }] }, body(SetWorkerServicesDto));
    await bad({ services: Array.from({ length: 21 }, () => ({ serviceId: ID })) }, body(SetWorkerServicesDto));
  });

  it('validates the city list', async () => {
    await expect(ok({ cityIds: [ID] }, body(SetWorkerAreasDto))).resolves.toBeDefined();
    await bad({ cityIds: [] }, body(SetWorkerAreasDto));
    await bad({ cityIds: [ID, ID] }, body(SetWorkerAreasDto));
    await bad({ cityIds: ['x'] }, body(SetWorkerAreasDto));
  });

  it('validates the weekly schedule shape', async () => {
    const window = { dayOfWeek: 1, startTime: '08:00', endTime: '17:00' };
    await expect(ok({ windows: [window] }, body(SetWorkerAvailabilityDto))).resolves.toBeDefined();
    await bad({ windows: [] }, body(SetWorkerAvailabilityDto));
    await bad({ windows: [{ ...window, dayOfWeek: 7 }] }, body(SetWorkerAvailabilityDto));
    await bad({ windows: [{ ...window, startTime: '8:00' }] }, body(SetWorkerAvailabilityDto));
    await bad({ windows: Array.from({ length: 29 }, () => window) }, body(SetWorkerAvailabilityDto));
  });

  it('only accepts safe document metadata', async () => {
    const doc = { type: 'IQAMA', fileName: 'iqama.jpg', mimeType: 'image/jpeg', sizeBytes: 1000 };
    await expect(ok(doc, body(RegisterDocumentDto))).resolves.toBeDefined();
    await bad({ ...doc, mimeType: 'application/x-msdownload' }, body(RegisterDocumentDto));
    await bad({ ...doc, mimeType: 'text/html' }, body(RegisterDocumentDto));
    await bad({ ...doc, sizeBytes: 10 * 1024 * 1024 + 1 }, body(RegisterDocumentDto));
    await bad({ ...doc, sizeBytes: 0 }, body(RegisterDocumentDto));
    await bad({ ...doc, type: 'PASSPORT' }, body(RegisterDocumentDto));
    await bad({ ...doc, fileName: '../../etc/passwd' }, body(RegisterDocumentDto));
    await bad({ ...doc, fileName: 'a\\b.jpg' }, body(RegisterDocumentDto));
    await bad({ ...doc, expiresOn: 'tomorrow' }, body(RegisterDocumentDto));
    await bad({ ...doc, storageKey: 'workers/other/documents/x' }, body(RegisterDocumentDto)); // clients cannot choose storage keys
  });
});

describe('admin and discovery query DTOs', () => {
  it('parses status filters (CSV, case-insensitive) and defaults sorting', async () => {
    const q = (await ok({ status: 'submitted, under_review' }, query(ListWorkersQueryDto))) as ListWorkersQueryDto;
    expect(q.status).toEqual(['SUBMITTED', 'UNDER_REVIEW']);
    expect(q.sort).toBe('oldest');
    expect(q.limit).toBe(20);
    await expect(ok({ status: 'ALL' }, query(ListWorkersQueryDto))).resolves.toBeDefined();
    await bad({ status: 'APPROVED,HACKED' }, query(ListWorkersQueryDto));
    await bad({ sort: 'random' }, query(ListWorkersQueryDto));
    await bad({ cityId: 'x' }, query(ListWorkersQueryDto));
  });

  it('validates document review decisions', async () => {
    await expect(ok({ status: 'ACCEPTED' }, body(ReviewDocumentDto))).resolves.toBeDefined();
    await expect(ok({ status: 'REJECTED', note: 'blurry' }, body(ReviewDocumentDto))).resolves.toBeDefined();
    await bad({ status: 'PENDING_UPLOAD' }, body(ReviewDocumentDto));
    await bad({ status: 'UPLOADED' }, body(ReviewDocumentDto));
  });

  it('parses discovery filters', async () => {
    const q = (await ok({ cityId: ID, onlineOnly: 'true', limit: '5' }, query(DiscoverWorkersQueryDto))) as DiscoverWorkersQueryDto;
    expect(q).toMatchObject({ cityId: ID, onlineOnly: true, limit: 5 });
    await bad({ onlineOnly: '1' }, query(DiscoverWorkersQueryDto));
    await bad({ verified: 'false' }, query(DiscoverWorkersQueryDto)); // cannot ask for unverified workers
  });
});
