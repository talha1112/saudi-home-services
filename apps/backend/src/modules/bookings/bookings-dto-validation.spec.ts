import { ArgumentMetadata, ValidationPipe } from '@nestjs/common';
import { CreatePricingSettingDto } from '../pricing/dto/pricing.dto.js';
import {
  AcceptQuoteDto,
  AdminCancelBookingDto,
  AdminListBookingsQueryDto,
  CancelBookingDto,
  CreateBookingDto,
  CreateQuoteDto,
  ListBookingsQueryDto,
  ListQuotesQueryDto,
  ListRequestsQueryDto,
  RegisterBookingPhotoDto,
  UpdateQuoteDto,
} from './dto/bookings.dto.js';

// Same options as app.setup.ts.
const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, transformOptions: { enableImplicitConversion: false } });
const body = (metatype: new () => object): ArgumentMetadata => ({ type: 'body', metatype });
const query = (metatype: new () => object): ArgumentMetadata => ({ type: 'query', metatype });
const ID = '6f1c2f0e-6d4a-4a39-9d1e-0f6b1a9a0001';
const ok = (value: unknown, meta: ArgumentMetadata) => pipe.transform(value, meta);
const bad = async (value: unknown, meta: ArgumentMetadata) => {
  await expect(pipe.transform(value, meta)).rejects.toMatchObject({ status: 400 });
};

const booking = {
  serviceId: ID,
  cityId: ID,
  problemDescription: 'The kitchen outlet sparks when I plug anything in.',
  preferredStartAt: '2026-11-02T09:00:00+03:00',
  preferredEndAt: '2026-11-02T13:00:00+03:00',
  addressLine: '12 Prince Sultan Street',
};

describe('CreateBookingDto', () => {
  it('accepts a complete request and trims text', async () => {
    const dto = (await ok({ ...booking, problemDescription: `  ${booking.problemDescription}  `, latitude: 24.7, longitude: 46.6, district: '  ' }, body(CreateBookingDto))) as CreateBookingDto;
    expect(dto.problemDescription).toBe(booking.problemDescription);
    expect(dto.district).toBeUndefined();
  });

  it('rejects bad values', async () => {
    await bad({ ...booking, problemDescription: 'too short' }, body(CreateBookingDto));
    await bad({ ...booking, serviceId: 'x' }, body(CreateBookingDto));
    await bad({ ...booking, preferredStartAt: 'tomorrow' }, body(CreateBookingDto));
    await bad({ ...booking, addressLine: 'x' }, body(CreateBookingDto));
    await bad({ ...booking, latitude: 24.7 }, body(CreateBookingDto)); // longitude missing
    await bad({ ...booking, latitude: 91, longitude: 46 }, body(CreateBookingDto));
    await bad({ ...booking, longitude: 181, latitude: 24 }, body(CreateBookingDto));
  });

  it('refuses every field a client must not control', async () => {
    for (const field of ['status', 'reference', 'customerId', 'workerProfileId', 'acceptedQuoteId', 'expiresAt', 'totalAmountHalalas', 'serviceAmountHalalas', 'vatRateBps', 'currency']) {
      await bad({ ...booking, [field]: 'x' }, body(CreateBookingDto));
    }
  });
});

describe('CreateQuoteDto and UpdateQuoteDto: only the worker\'s own price is accepted', () => {
  const quote = { priceHalalas: 20000, proposedStartAt: '2026-11-02T09:00:00Z', proposedEndAt: '2026-11-02T11:00:00Z' };

  it('accepts a minimal quote', async () => {
    await expect(ok(quote, body(CreateQuoteDto))).resolves.toBeDefined();
    await expect(ok({ ...quote, estimatedDurationMinutes: 90, message: ' hello ', validForHours: 12 }, body(CreateQuoteDto))).resolves.toMatchObject({ message: 'hello' });
  });

  it('accepts only whole halalas for the price', async () => {
    for (const price of [0, -5, 12.5, 'abc', null, 1_000_000_001]) await bad({ ...quote, priceHalalas: price }, body(CreateQuoteDto));
    await expect(ok({ ...quote, priceHalalas: '20000' }, body(CreateQuoteDto))).resolves.toMatchObject({ priceHalalas: 20000 });
  });

  it('refuses any attempt to set VAT, commission, totals or identities', async () => {
    const forbidden = ['vatHalalas', 'vatAmountHalalas', 'totalHalalas', 'totalAmountHalalas', 'commissionHalalas', 'commissionAmountHalalas', 'commissionRateBps', 'vatRateBps', 'workerPayoutHalalas', 'payoutHalalas', 'status', 'version', 'isAccepted', 'bookingId', 'workerProfileId', 'pricingSettingId', 'validUntil'];
    for (const field of forbidden) {
      await bad({ ...quote, [field]: 1 }, body(CreateQuoteDto));
      await bad({ priceHalalas: 6000, [field]: 1 }, body(UpdateQuoteDto));
    }
  });

  it('validates durations, validity and message length', async () => {
    await bad({ ...quote, estimatedDurationMinutes: 1 }, body(CreateQuoteDto));
    await bad({ ...quote, validForHours: 0 }, body(CreateQuoteDto));
    await bad({ ...quote, message: 'x'.repeat(1001) }, body(CreateQuoteDto));
  });
});

describe('accepting and cancelling', () => {
  it('lets the customer send only the version they saw when accepting', async () => {
    await expect(ok({}, body(AcceptQuoteDto))).resolves.toBeDefined();
    await expect(ok({ expectedVersion: 3 }, body(AcceptQuoteDto))).resolves.toMatchObject({ expectedVersion: 3 });
    await bad({ expectedVersion: 0 }, body(AcceptQuoteDto));
    for (const field of ['priceHalalas', 'totalAmountHalalas', 'workerProfileId', 'status']) await bad({ [field]: 1 }, body(AcceptQuoteDto));
  });

  it('keeps ADMIN_ACTION away from customers', async () => {
    await expect(ok({ reason: 'CHANGED_MIND' }, body(CancelBookingDto))).resolves.toBeDefined();
    await bad({ reason: 'ADMIN_ACTION' }, body(CancelBookingDto));
    await bad({ reason: 'because' }, body(CancelBookingDto));
    await bad({}, body(CancelBookingDto));
  });

  it('requires a meaningful note from administrators', async () => {
    await expect(ok({ note: 'Safety issue reported' }, body(AdminCancelBookingDto))).resolves.toBeDefined();
    await bad({ note: '  ' }, body(AdminCancelBookingDto));
    await bad({ note: 'ab' }, body(AdminCancelBookingDto));
    await bad({}, body(AdminCancelBookingDto));
  });
});

describe('photos', () => {
  it('only accepts small JPEG/PNG metadata', async () => {
    await expect(ok({ fileName: 'a.jpg', mimeType: 'image/jpeg', sizeBytes: 1000 }, body(RegisterBookingPhotoDto))).resolves.toBeDefined();
    await bad({ fileName: 'a.pdf', mimeType: 'application/pdf', sizeBytes: 1000 }, body(RegisterBookingPhotoDto));
    await bad({ fileName: 'a.jpg', mimeType: 'image/jpeg', sizeBytes: 9 * 1024 * 1024 }, body(RegisterBookingPhotoDto));
    await bad({ fileName: 'a.jpg', mimeType: 'image/jpeg', sizeBytes: 100, storageKey: 'x' }, body(RegisterBookingPhotoDto));
  });
});

describe('list queries', () => {
  it('parses status CSV case-insensitively and applies defaults', async () => {
    const q = (await ok({ status: 'open, payment_pending' }, query(ListBookingsQueryDto))) as ListBookingsQueryDto;
    expect(q.status).toEqual(['OPEN', 'PAYMENT_PENDING']);
    expect(q).toMatchObject({ page: 1, limit: 20, sort: 'newest' });
    await bad({ status: 'OPEN,BOGUS' }, query(ListBookingsQueryDto));
    await bad({ limit: '101' }, query(ListBookingsQueryDto));
    await bad({ sort: 'cheapest' }, query(ListBookingsQueryDto));
    await bad({ createdFrom: 'yesterday' }, query(ListBookingsQueryDto));
  });

  it('upper-cases the admin reference filter and validates ids', async () => {
    const q = (await ok({ reference: ' bk-ab12 ', customerId: ID }, query(AdminListBookingsQueryDto))) as AdminListBookingsQueryDto;
    expect(q.reference).toBe('BK-AB12');
    await bad({ workerId: 'x' }, query(AdminListBookingsQueryDto));
  });

  it('validates quote and request filters', async () => {
    await expect(ok({ sort: 'price_desc', status: 'submitted,accepted' }, query(ListQuotesQueryDto))).resolves.toMatchObject({ status: ['SUBMITTED', 'ACCEPTED'] });
    await bad({ sort: 'best' }, query(ListQuotesQueryDto));
    await expect(ok({ urgentOnly: 'true', sort: 'soonest', startFrom: '2026-11-01T00:00:00Z' }, query(ListRequestsQueryDto))).resolves.toMatchObject({ urgentOnly: true });
    await bad({ urgentOnly: 'maybe' }, query(ListRequestsQueryDto));
  });
});

describe('CreatePricingSettingDto', () => {
  it('takes integers in basis points and halalas only', async () => {
    const dto = { vatRateBps: 1500, commissionRateBps: 1500, minServiceChargeHalalas: 5000 };
    await expect(ok(dto, body(CreatePricingSettingDto))).resolves.toBeDefined();
    await bad({ ...dto, vatRateBps: 15.5 }, body(CreatePricingSettingDto));
    await bad({ ...dto, vatRateBps: 6000 }, body(CreatePricingSettingDto));
    await bad({ ...dto, commissionRateBps: -1 }, body(CreatePricingSettingDto));
    await bad({ ...dto, minServiceChargeHalalas: 0.5 }, body(CreatePricingSettingDto));
    await bad({ ...dto, isProvisional: false }, body(CreatePricingSettingDto));
  });
});
