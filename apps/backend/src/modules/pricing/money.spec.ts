import { applyBps, computeQuoteAmounts, isHalalas } from './money.js';

const rates = { vatRateBps: 1500, commissionRateBps: 1500 };

describe('applyBps (integer basis-point arithmetic, rounding half up)', () => {
  it.each([
    [10000, 1500, 1500], // SAR 100 -> 15%
    [20000, 1500, 3000],
    [33333, 1500, 5000], // 4999.95 rounds up
    [33330, 1500, 5000], // exactly 4999.5 rounds up (half up)
    [1, 1500, 0], // 0.15 halala rounds down
    [4, 1500, 1], // 0.6 rounds up
    [3, 1500, 0], // 0.45 rounds down
    [10, 1500, 2], // 1.5 rounds up (half up)
    [0, 1500, 0],
    [12345, 0, 0],
    [12345, 10000, 12345],
  ])('%i halalas at %i bps = %i', (amount, bps, expected) => {
    expect(applyBps(amount, bps)).toBe(expected);
  });

  it('is exact for large amounts where floating point would drift', () => {
    expect(applyBps(999_999_999, 1500)).toBe(150_000_000); // 149,999,999.85 -> 150,000,000
    expect(applyBps(5_000_000, 1500)).toBe(750_000);
    expect(applyBps(123_456_789, 4999)).toBe(Math.floor((123_456_789 * 4999 + 5000) / 10000));
  });

  it.each([-1, 1.5, NaN, Infinity, '100' as unknown as number, Number.MAX_SAFE_INTEGER + 1])('rejects the amount %p', (amount) => {
    expect(() => applyBps(amount, 1500)).toThrow(RangeError);
  });

  it.each([-1, 0.5, NaN])('rejects the rate %p', (bps) => {
    expect(() => applyBps(100, bps)).toThrow(RangeError);
  });
});

describe('computeQuoteAmounts', () => {
  it('splits a price into VAT, total, commission and payout', () => {
    expect(computeQuoteAmounts(20000, rates)).toEqual({
      priceHalalas: 20000,
      vatAmountHalalas: 3000,
      totalAmountHalalas: 23000,
      commissionAmountHalalas: 3000,
      workerPayoutHalalas: 17000,
    });
  });

  it('handles different VAT and commission rates', () => {
    expect(computeQuoteAmounts(10000, { vatRateBps: 500, commissionRateBps: 2000 })).toMatchObject({
      vatAmountHalalas: 500,
      totalAmountHalalas: 10500,
      commissionAmountHalalas: 2000,
      workerPayoutHalalas: 8000,
    });
    expect(computeQuoteAmounts(10000, { vatRateBps: 0, commissionRateBps: 0 })).toMatchObject({ totalAmountHalalas: 10000, workerPayoutHalalas: 10000 });
  });

  it('always returns integers that add up, for a wide sweep of prices and rates', () => {
    const rateSet = [0, 1, 1500, 4999, 5000];
    let checked = 0;
    for (let price = 1; price <= 200_000; price += price < 500 ? 1 : 997) {
      for (const vat of rateSet) {
        for (const commission of rateSet) {
          const a = computeQuoteAmounts(price, { vatRateBps: vat, commissionRateBps: commission });
          expect(Object.values(a).every((v) => Number.isInteger(v))).toBe(true);
          expect(a.totalAmountHalalas).toBe(a.priceHalalas + a.vatAmountHalalas);
          expect(a.workerPayoutHalalas).toBe(a.priceHalalas - a.commissionAmountHalalas);
          expect(a.commissionAmountHalalas).toBeGreaterThanOrEqual(0);
          expect(a.workerPayoutHalalas).toBeGreaterThanOrEqual(0);
          // never more than half a halala away from the exact rational value
          expect(Math.abs(a.vatAmountHalalas * 10000 - price * vat)).toBeLessThanOrEqual(5000);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(10_000);
  });
});

describe('isHalalas', () => {
  it('accepts only non-negative safe integers', () => {
    expect(isHalalas(0)).toBe(true);
    expect(isHalalas(5000)).toBe(true);
    for (const bad of [-1, 1.2, NaN, '5', null, undefined, Number.MAX_SAFE_INTEGER + 1]) expect(isHalalas(bad)).toBe(false);
  });
});
