/**
 * REAL POSTGRESQL, FULL HTTP STACK: the service location of a booking, from what the customer app sends to what a worker may see.
 *
 * The request fields come from test/fixtures/picked-location-booking-fields.json, which the customer app's own contract test also checks
 * against PickedLocation.toBookingFields(). Needs TEST_DATABASE_URL (migrations applied). See bookings-harness.ts.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BookingLifecycleService } from '../src/modules/bookings/booking-lifecycle.service.js';
import { type Harness, type Worker, bootHarness } from './support/bookings-harness.js';

const run = process.env['TEST_DATABASE_URL'] ? describe : describe.skip;
if (!process.env['TEST_DATABASE_URL']) console.warn('booking-location.integration-spec: TEST_DATABASE_URL is not set, suite skipped');

const FIELDS = (JSON.parse(readFileSync(join(process.cwd(), 'test', 'fixtures', 'picked-location-booking-fields.json'), 'utf8')) as { fields: Record<string, unknown> }).fields;

run('booking service location (real PostgreSQL, full HTTP stack)', () => {
  let h: Harness;
  let ref: Awaited<ReturnType<Harness['seedReferenceData']>>;
  let worker: Worker;
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  // The booking body the app builds: the generic booking fields plus exactly the location fields from the fixture. The harness's own
  // address/coordinates are removed first so nothing but the fixture decides the place.
  const body = (extra: object = {}) => {
    const { addressLine, district, building, latitude, longitude, ...rest } = h.bookingBody(ref) as Record<string, unknown>;
    void addressLine; void district; void building; void latitude; void longitude;
    return { ...rest, ...FIELDS, ...extra };
  };
  const create = (customer: { accessToken: string }, extra: object = {}) => h.api().post('/api/v1/bookings').set(bearer(customer.accessToken)).send(body(extra));

  /** A booking with an accepted quote, optionally paid, plus the assigned worker. */
  async function accepted(extra: object = {}, pay = false) {
    const customer = await h.makeCustomer();
    const booking = (await create(customer, extra).expect(201)).body;
    const wk = await h.makeWorker([ref.service.id], [ref.city.id]);
    const quote = await h.submitQuote(wk, booking.id, { priceHalalas: 40000 });
    await h.api().post(`/api/v1/bookings/${booking.id}/quotes/${quote.id}/accept`).set(bearer(customer.accessToken)).send({ expectedVersion: 1 }).expect(200);
    if (pay) await h.app.get(BookingLifecycleService).confirmPayment(booking.id, { note: 'itest payment' });
    return { customer, booking, wk };
  }

  beforeAll(async () => {
    h = await bootHarness({ phonePrefix: '+9665970', slugPrefix: 'itest-bl-', adminEmailPrefix: 'itest-bl-admin' });
    ref = await h.seedReferenceData();
    worker = await h.makeWorker([ref.service.id], [ref.city.id]);
  });

  afterAll(async () => {
    if (h) await h.close();
  });

  describe('what the customer app sends is stored and returned to its owner', () => {
    it('accepts exactly the fields the app sends, stores them with numeric coordinates and returns them to the owner', async () => {
      const customer = await h.makeCustomer();
      const res = await create(customer).expect(201);
      expect(res.body.location).toMatchObject({
        addressLine: FIELDS['addressLine'],
        district: FIELDS['district'],
        building: FIELDS['building'],
        locationNotes: FIELDS['locationNotes'],
        latitude: FIELDS['latitude'],
        longitude: FIELDS['longitude'],
      });
      expect(typeof res.body.location.latitude).toBe('number');
      expect(typeof res.body.location.longitude).toBe('number');

      const row = await h.prisma.booking.findUniqueOrThrow({ where: { id: res.body.id } });
      expect(row).toMatchObject({ addressLine: FIELDS['addressLine'], district: FIELDS['district'], building: FIELDS['building'], locationNotes: FIELDS['locationNotes'], latitude: FIELDS['latitude'], longitude: FIELDS['longitude'] });

      const again = await h.api().get(`/api/v1/bookings/${res.body.id}`).set(bearer(customer.accessToken)).expect(200);
      expect(again.body.location).toMatchObject({ latitude: FIELDS['latitude'], longitude: FIELDS['longitude'], addressLine: FIELDS['addressLine'] });
    });

    it('a booking without coordinates is valid: the place is stored without them and returned as missing, never as 0,0', async () => {
      const customer = await h.makeCustomer();
      const { latitude, longitude, ...withoutPoint } = FIELDS;
      void latitude; void longitude;
      const res = await h.api().post('/api/v1/bookings').set(bearer(customer.accessToken)).send({ ...body(), ...withoutPoint, latitude: undefined, longitude: undefined }).expect(201);
      expect(res.body.location.latitude ?? null).toBeNull();
      expect(res.body.location.longitude ?? null).toBeNull();
      const row = await h.prisma.booking.findUniqueOrThrow({ where: { id: res.body.id } });
      expect(row.latitude).toBeNull();
      expect(row.longitude).toBeNull();
    });

    it('rejects coordinates that are out of range, half given, or not numbers, and fields the app must never send', async () => {
      const customer = await h.makeCustomer();
      for (const bad of [
        { latitude: 91 }, { latitude: -91 }, { longitude: 181 }, { longitude: -181 },
        { latitude: 'abc' }, { longitude: 'abc' }, { latitude: null, longitude: 46.6 }, { latitude: Number.NaN },
        { longitude: undefined }, // latitude without longitude
        { label: 'Home' }, // the label stays on the phone
        { userId: customer.userId }, { customerId: customer.userId }, // ownership comes from the token, never the body
        { addressLine: 'ab' }, { addressLine: 'x'.repeat(256) }, { building: 'b'.repeat(121) }, { locationNotes: 'n'.repeat(501) }, { district: 'd'.repeat(121) },
      ]) {
        const res = await create(customer, bad);
        expect([400]).toContain(res.status); // rejected: bad input
      }
      expect(await h.prisma.booking.count({ where: { customerId: customer.userId } })).toBe(0);
    });

    it('the booking belongs to the signed-in customer, whatever the body says', async () => {
      const a = await h.makeCustomer();
      const b = await h.makeCustomer();
      const res = await create(a).expect(201);
      expect((await h.prisma.booking.findUniqueOrThrow({ where: { id: res.body.id } })).customerId).toBe(a.userId);
      await h.api().get(`/api/v1/bookings/${res.body.id}`).set(bearer(b.accessToken)).expect(404); // another customer cannot read the address
    });
  });

  describe('what a worker may see, and when', () => {
    it('an open request shows only the city and district: no street, building, notes or coordinates', async () => {
      const customer = await h.makeCustomer();
      const booking = (await create(customer).expect(201)).body;
      const detail = (await h.api().get(`/api/v1/workers/me/requests/${booking.id}`).set(bearer(worker.accessToken)).expect(200)).body;
      const list = (await h.api().get('/api/v1/workers/me/requests').set(bearer(worker.accessToken)).expect(200)).body;
      expect(detail.location).toMatchObject({ district: FIELDS['district'] });
      const everything = JSON.stringify([detail, list]);
      for (const secret of [String(FIELDS['addressLine']), String(FIELDS['building']), String(FIELDS['locationNotes']), 'latitude', 'longitude', '24.7136', '46.6753']) {
        expect(everything).not.toContain(secret);
      }
    });

    it('after the quote is accepted but before payment, the assigned worker still has no address or coordinates', async () => {
      const { booking, wk } = await accepted();
      const pending = (await h.api().get(`/api/v1/workers/me/bookings/${booking.id}`).set(bearer(wk.accessToken)).expect(200)).body;
      expect(pending.status).toBe('PAYMENT_PENDING');
      expect(pending.location.district).toBe(FIELDS['district']);
      const text = JSON.stringify(pending);
      for (const secret of [String(FIELDS['addressLine']), String(FIELDS['locationNotes']), 'latitude', 'longitude']) expect(text).not.toContain(secret);
    });

    it('once the booking is paid, the assigned worker gets the exact point as numbers, and nobody else does', async () => {
      const { booking, wk } = await accepted({}, true);
      const paid = (await h.api().get(`/api/v1/workers/me/bookings/${booking.id}`).set(bearer(wk.accessToken)).expect(200)).body;
      expect(paid.status).toBe('CONFIRMED');
      expect(paid.location).toMatchObject({
        addressLine: FIELDS['addressLine'],
        building: FIELDS['building'],
        locationNotes: FIELDS['locationNotes'],
        latitude: FIELDS['latitude'],
        longitude: FIELDS['longitude'],
      });
      expect(typeof paid.location.latitude).toBe('number');
      // a different (approved) worker, and a different customer, get nothing
      const stranger = await h.makeWorker([ref.service.id], [ref.city.id]);
      expect([403, 404]).toContain((await h.api().get(`/api/v1/workers/me/bookings/${booking.id}`).set(bearer(stranger.accessToken))).status);
      const otherCustomer = await h.makeCustomer();
      await h.api().get(`/api/v1/bookings/${booking.id}`).set(bearer(otherCustomer.accessToken)).expect(404);
      // a customer token cannot use the worker route
      expect([403, 404]).toContain((await h.api().get(`/api/v1/workers/me/bookings/${booking.id}`).set(bearer(otherCustomer.accessToken))).status);
    });

    it('a paid booking created without coordinates reaches the worker with the address but no point (the app then has no pin to show)', async () => {
      const { booking, wk } = await accepted({ latitude: undefined, longitude: undefined }, true);
      const paid = (await h.api().get(`/api/v1/workers/me/bookings/${booking.id}`).set(bearer(wk.accessToken)).expect(200)).body;
      expect(paid.location.addressLine).toBe(FIELDS['addressLine']);
      expect(paid.location.latitude ?? null).toBeNull();
      expect(paid.location.longitude ?? null).toBeNull();
    });
  });
});
