/**
 * REAL POSTGRESQL: races and database-level protections of the booking lifecycle.
 *
 * The HTTP calls below are fired at the same instant, so they really compete for the same rows
 * inside PostgreSQL. Whatever the timing, the invariants must hold: one accepted quote per
 * booking, snapshot equals the accepted quote, no half-applied transitions.
 */
import { randomUUID } from 'node:crypto';
import { QuoteStatus } from '../src/generated/prisma/client.js';
import { type Harness, type Session, type Worker, bootHarness } from './support/bookings-harness.js';

const run = process.env['TEST_DATABASE_URL'] ? describe : describe.skip;
if (!process.env['TEST_DATABASE_URL']) console.warn('bookings-concurrency.integration-spec: TEST_DATABASE_URL is not set, suite skipped');

run('booking concurrency and database constraints (real PostgreSQL)', () => {
  let h: Harness;
  let ref: Awaited<ReturnType<Harness['seedReferenceData']>>;
  let workers: Worker[];
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeAll(async () => {
    h = await bootHarness({ phonePrefix: '+9665993', slugPrefix: 'itest-bc-', adminEmailPrefix: 'itest-bc-admin' });
    ref = await h.seedReferenceData();
    workers = [];
    for (let i = 0; i < 6; i++) workers.push(await h.makeWorker([ref.service.id], [ref.city.id]));
  });

  afterAll(async () => {
    if (h) await h.close();
  });

  /** A fresh booking with one quote from each of the first `n` workers, prices 10000, 11000, ... */
  async function bookingWithQuotes(n: number) {
    const customer = await h.makeCustomer();
    const booking = await h.createBooking(customer, ref);
    const quotes = [];
    for (let i = 0; i < n; i++) quotes.push(await h.submitQuote(workers[i], booking.id, { priceHalalas: 10000 + i * 1000 }));
    return { customer, booking, quotes };
  }

  const accept = (customer: Session, bookingId: string, quoteId: string, body: object = {}) =>
    h.api().post(`/api/v1/bookings/${bookingId}/quotes/${quoteId}/accept`).set(bearer(customer.accessToken)).send(body);

  /** Invariants that must hold after any interleaving. */
  async function assertConsistent(bookingId: string) {
    const booking = await h.prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    const quotes = await h.prisma.quote.findMany({ where: { bookingId } });
    const accepted = quotes.filter((q) => q.status === QuoteStatus.ACCEPTED);
    expect(accepted.length).toBeLessThanOrEqual(1);
    expect(quotes.filter((q) => q.isAccepted === true).length).toBe(accepted.length);
    // A booking cancelled after acceptance keeps its accepted quote as the record of what was agreed.
    const wasAccepted = booking.status === 'PAYMENT_PENDING' || (booking.status === 'CANCELLED' && booking.acceptedQuoteId !== null);
    if (wasAccepted) {
      expect(accepted).toHaveLength(1);
      const q = accepted[0];
      expect(booking.acceptedQuoteId).toBe(q.id);
      expect(booking.workerProfileId).toBe(q.workerProfileId);
      // the stored snapshot is exactly the accepted quote, never a mixture
      expect(booking).toMatchObject({
        serviceAmountHalalas: q.priceHalalas,
        vatAmountHalalas: q.vatAmountHalalas,
        totalAmountHalalas: q.totalAmountHalalas,
        commissionAmountHalalas: q.commissionAmountHalalas,
        workerPayoutHalalas: q.workerPayoutHalalas,
      });
      expect(quotes.filter((o) => o.id !== q.id).every((o) => o.status !== QuoteStatus.ACCEPTED && o.status !== QuoteStatus.SUBMITTED)).toBe(true);
    } else {
      expect(accepted).toHaveLength(0);
      expect(booking.acceptedQuoteId).toBeNull();
    }
    return { booking, quotes };
  }

  it('lets exactly one of many simultaneous acceptances of DIFFERENT quotes win', async () => {
    for (let round = 0; round < 3; round++) {
      const { customer, booking, quotes } = await bookingWithQuotes(6);
      const results = await Promise.all(quotes.map((q: { id: string }) => accept(customer, booking.id, q.id)));
      const statuses = results.map((r) => r.status).sort();
      expect({ round, statuses }).toEqual({ round, statuses: [200, 409, 409, 409, 409, 409] });
      for (const r of results.filter((x) => x.status === 409)) expect(['INVALID_STATE', 'BOOKING_ALREADY_ACCEPTED', 'QUOTE_NOT_AVAILABLE']).toContain(r.body.code);

      const { booking: row, quotes: rows } = await assertConsistent(booking.id);
      expect(row.status).toBe('PAYMENT_PENDING');
      expect(rows.filter((q) => q.status === 'REJECTED')).toHaveLength(5);
      const winner = results.find((r) => r.status === 200)!;
      expect(winner.body.acceptedQuoteId).toBe(row.acceptedQuoteId);
      expect(await h.prisma.bookingEvent.count({ where: { bookingId: booking.id, type: 'QUOTE_ACCEPTED' } })).toBe(1);
    }
  });

  it('lets exactly one of many simultaneous acceptances of the SAME quote win', async () => {
    const { customer, booking, quotes } = await bookingWithQuotes(2);
    const results = await Promise.all(Array.from({ length: 8 }, () => accept(customer, booking.id, quotes[0].id)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(7);
    await assertConsistent(booking.id);
  });

  it('never accepts a quote that the worker is withdrawing at the same moment', async () => {
    for (let round = 0; round < 6; round++) {
      const { customer, booking, quotes } = await bookingWithQuotes(1);
      const [acc, wd] = await Promise.all([
        accept(customer, booking.id, quotes[0].id),
        h.api().post(`/api/v1/workers/me/quotes/${quotes[0].id}/withdraw`).set(bearer(workers[0].accessToken)),
      ]);
      const { booking: row, quotes: rows } = await assertConsistent(booking.id);
      if (acc.status === 200) {
        expect(wd.status).toBe(409);
        expect(rows[0].status).toBe('ACCEPTED');
        expect(row.status).toBe('PAYMENT_PENDING');
      } else {
        expect(wd.status).toBe(200);
        expect(acc.status).toBe(409);
        expect(rows[0].status).toBe('WITHDRAWN');
        expect(row.status).toBe('OPEN');
      }
    }
  });

  it('never accepts a different price than the customer saw when the worker edits at the same moment', async () => {
    for (let round = 0; round < 6; round++) {
      const { customer, booking, quotes } = await bookingWithQuotes(1);
      const [acc, edit] = await Promise.all([
        accept(customer, booking.id, quotes[0].id, { expectedVersion: 1 }),
        h.api().patch(`/api/v1/workers/me/quotes/${quotes[0].id}`).set(bearer(workers[0].accessToken)).send({ priceHalalas: 50000 }),
      ]);
      const { booking: row, quotes: rows } = await assertConsistent(booking.id);
      if (acc.status === 200) {
        // accepted the version the customer saw: the edit must have lost
        expect(edit.status).toBe(409);
        expect(row.serviceAmountHalalas).toBe(10000);
        expect(rows[0].version).toBe(1);
      } else {
        // the edit won: the customer is told the quote changed instead of paying 50000
        expect(acc.body.code).toBe('QUOTE_CHANGED');
        expect(edit.status).toBe(200);
        expect(row.status).toBe('OPEN');
        expect(rows[0]).toMatchObject({ priceHalalas: 50000, version: 2, status: 'SUBMITTED' });
      }
    }
  });

  it('keeps the snapshot equal to the stored quote even when the customer sends no expected version', async () => {
    for (let round = 0; round < 6; round++) {
      const { customer, booking, quotes } = await bookingWithQuotes(1);
      await Promise.all([
        accept(customer, booking.id, quotes[0].id),
        h.api().patch(`/api/v1/workers/me/quotes/${quotes[0].id}`).set(bearer(workers[0].accessToken)).send({ priceHalalas: 30000 }),
      ]);
      await assertConsistent(booking.id); // asserts snapshot === accepted quote row, whichever won
    }
  });

  it('never leaves a live quote on a booking that was accepted while new quotes were arriving', async () => {
    for (let round = 0; round < 4; round++) {
      const { customer, booking, quotes } = await bookingWithQuotes(1);
      const late = workers.slice(1, 5).map((w) => h.api().post(`/api/v1/workers/me/requests/${booking.id}/quote`).set(bearer(w.accessToken)).send(h.quoteBody()));
      const [acc, ...submitted] = await Promise.all([accept(customer, booking.id, quotes[0].id), ...late]);
      expect(acc.status).toBe(200);
      const { quotes: rows } = await assertConsistent(booking.id); // asserts nothing is SUBMITTED besides the winner
      expect(rows.filter((q) => q.status === 'SUBMITTED')).toHaveLength(0);
      for (const r of submitted) expect([201, 409]).toContain(r.status);
    }
  });

  it('allows only one quote per worker per request under simultaneous submissions', async () => {
    const customer = await h.makeCustomer();
    const booking = await h.createBooking(customer, ref);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => h.api().post(`/api/v1/workers/me/requests/${booking.id}/quote`).set(bearer(workers[0].accessToken)).send(h.quoteBody())),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409).every((r) => r.body.code === 'QUOTE_EXISTS')).toBe(true);
    expect(await h.prisma.quote.count({ where: { bookingId: booking.id } })).toBe(1);
    expect(await h.prisma.bookingEvent.count({ where: { bookingId: booking.id, type: 'QUOTE_SUBMITTED' } })).toBe(1);
  });

  it('resolves a cancel racing an acceptance into exactly one outcome', async () => {
    for (let round = 0; round < 6; round++) {
      const { customer, booking, quotes } = await bookingWithQuotes(1);
      const [acc, cancel] = await Promise.all([
        accept(customer, booking.id, quotes[0].id),
        h.api().post(`/api/v1/bookings/${booking.id}/cancel`).set(bearer(customer.accessToken)).send({ reason: 'CHANGED_MIND' }),
      ]);
      const { booking: row } = await assertConsistent(booking.id);
      const cancellation = await h.prisma.bookingCancellation.findUnique({ where: { bookingId: booking.id } });
      // The customer may legitimately cancel after accepting (PAYMENT_PENDING -> CANCELLED), so both
      // can succeed in sequence. What must never happen is an inconsistent mixture.
      if (row.status === 'CANCELLED') {
        expect(cancel.status).toBe(200);
        expect(cancellation).not.toBeNull();
        expect(cancellation!.previousStatus).toBe(acc.status === 200 ? 'PAYMENT_PENDING' : 'OPEN');
      } else {
        expect(row.status).toBe('PAYMENT_PENDING');
        expect(cancel.status).toBe(409);
        expect(cancellation).toBeNull();
      }
    }
  });

  it('records one cancellation when many cancels arrive together', async () => {
    const { customer, booking } = await bookingWithQuotes(2);
    const results = await Promise.all(
      Array.from({ length: 6 }, () => h.api().post(`/api/v1/bookings/${booking.id}/cancel`).set(bearer(customer.accessToken)).send({ reason: 'CHANGED_MIND' })),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(5);
    expect(await h.prisma.bookingCancellation.count({ where: { bookingId: booking.id } })).toBe(1);
    expect(await h.prisma.bookingEvent.count({ where: { bookingId: booking.id, type: 'BOOKING_CANCELLED' } })).toBe(1);
    expect(await h.prisma.quote.count({ where: { bookingId: booking.id, status: 'REJECTED' } })).toBe(2);
  });

  // ------------------------------------------------- PostgreSQL itself says no

  describe('database constraints', () => {
    it('refuses a second accepted quote for the same booking, even when written directly', async () => {
      const { customer, booking, quotes } = await bookingWithQuotes(2);
      await accept(customer, booking.id, quotes[0].id).expect(200);
      await expect(
        h.prisma.quote.update({ where: { id: quotes[1].id }, data: { status: 'ACCEPTED', isAccepted: true } }),
      ).rejects.toBeDefined();
      expect((await h.prisma.quote.findUniqueOrThrow({ where: { id: quotes[1].id } })).status).toBe('REJECTED');
    });

    it('refuses a quote that says ACCEPTED without the flag, or the flag without the status', async () => {
      const { quotes } = await bookingWithQuotes(1);
      await expect(h.prisma.quote.update({ where: { id: quotes[0].id }, data: { status: 'ACCEPTED' } })).rejects.toBeDefined();
      await expect(h.prisma.quote.update({ where: { id: quotes[0].id }, data: { isAccepted: true } })).rejects.toBeDefined();
    });

    it('refuses money that does not add up', async () => {
      const { booking, quotes } = await bookingWithQuotes(1);
      await expect(h.prisma.quote.update({ where: { id: quotes[0].id }, data: { totalAmountHalalas: 1 } })).rejects.toBeDefined();
      await expect(h.prisma.quote.update({ where: { id: quotes[0].id }, data: { workerPayoutHalalas: 999999 } })).rejects.toBeDefined();
      await expect(h.prisma.quote.update({ where: { id: quotes[0].id }, data: { priceHalalas: 0, totalAmountHalalas: 0, workerPayoutHalalas: -1 } })).rejects.toBeDefined();
      await expect(
        h.prisma.booking.update({ where: { id: booking.id }, data: { serviceAmountHalalas: 100, vatAmountHalalas: 15, totalAmountHalalas: 999, commissionAmountHalalas: 15, workerPayoutHalalas: 85 } }),
      ).rejects.toBeDefined();
    });

    it('refuses a booking that claims to be assigned without a quote and a worker', async () => {
      const { booking } = await bookingWithQuotes(1);
      for (const status of ['PAYMENT_PENDING', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED'] as const) {
        await expect(h.prisma.booking.update({ where: { id: booking.id }, data: { status } })).rejects.toBeDefined();
      }
      expect((await h.prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe('OPEN');
    });

    it('refuses impossible schedules, coordinates and pricing rates', async () => {
      const { booking, quotes } = await bookingWithQuotes(1);
      const t = new Date();
      await expect(h.prisma.booking.update({ where: { id: booking.id }, data: { preferredEndAt: new Date(0) } })).rejects.toBeDefined();
      await expect(h.prisma.booking.update({ where: { id: booking.id }, data: { latitude: 123 } })).rejects.toBeDefined();
      await expect(h.prisma.quote.update({ where: { id: quotes[0].id }, data: { proposedEndAt: new Date(0) } })).rejects.toBeDefined();
      await expect(h.prisma.pricingSetting.create({ data: { vatRateBps: 9999, commissionRateBps: 10, minServiceChargeHalalas: 1, note: 'itest bad', effectiveFrom: t } })).rejects.toBeDefined();
      await expect(h.prisma.pricingSetting.create({ data: { vatRateBps: 10, commissionRateBps: 10, minServiceChargeHalalas: -1, note: 'itest bad', effectiveFrom: t } })).rejects.toBeDefined();
    });

    it('keeps referential integrity: deleting a worker or customer with bookings is refused', async () => {
      const { customer, quotes } = await bookingWithQuotes(1);
      await expect(h.prisma.user.delete({ where: { id: customer.userId } })).rejects.toBeDefined();
      const q = await h.prisma.quote.findUniqueOrThrow({ where: { id: quotes[0].id } });
      await expect(h.prisma.workerProfile.delete({ where: { id: q.workerProfileId } })).rejects.toBeDefined();
    });

    it('enforces a unique booking reference and unique quote per worker', async () => {
      const { booking, quotes } = await bookingWithQuotes(1);
      const row = await h.prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
      await expect(
        h.prisma.booking.create({
          data: { ...pick(row), reference: row.reference, id: randomUUID() },
        }),
      ).rejects.toBeDefined();
      const q = await h.prisma.quote.findUniqueOrThrow({ where: { id: quotes[0].id } });
      await expect(h.prisma.quote.create({ data: { ...pickQuote(q), id: randomUUID() } })).rejects.toBeDefined();
    });
  });
});

function pick(b: any) {
  return {
    customerId: b.customerId, serviceId: b.serviceId, cityId: b.cityId, problemDescription: b.problemDescription,
    preferredStartAt: b.preferredStartAt, preferredEndAt: b.preferredEndAt, addressLine: b.addressLine, expiresAt: b.expiresAt,
  };
}

function pickQuote(q: any) {
  return {
    bookingId: q.bookingId, workerProfileId: q.workerProfileId, priceHalalas: q.priceHalalas, proposedStartAt: q.proposedStartAt,
    proposedEndAt: q.proposedEndAt, validUntil: q.validUntil, pricingSettingId: q.pricingSettingId, vatRateBps: q.vatRateBps,
    commissionRateBps: q.commissionRateBps, vatAmountHalalas: q.vatAmountHalalas, totalAmountHalalas: q.totalAmountHalalas,
    commissionAmountHalalas: q.commissionAmountHalalas, workerPayoutHalalas: q.workerPayoutHalalas,
  };
}
