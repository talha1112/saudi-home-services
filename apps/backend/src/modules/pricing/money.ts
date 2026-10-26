/**
 * Money helpers. Every amount is an INTEGER number of halalas (1 SAR = 100 halalas) and every
 * rate is an INTEGER number of basis points (1 bp = 0.01%, so 1500 = 15%). No floating-point
 * arithmetic is used for money: products and sums stay far below 2^53 (the validation limits
 * keep a price under 1e9 halalas and a rate under 1e4 bps), so all operations are exact.
 */

export const HALALAS_PER_SAR = 100;
export const BPS_DENOMINATOR = 10_000;

export interface PricingRates {
  vatRateBps: number;
  commissionRateBps: number;
  minServiceChargeHalalas: number;
}

export interface QuoteAmounts {
  /** What the worker charges, before VAT. */
  priceHalalas: number;
  vatAmountHalalas: number;
  /** What the customer pays: price + VAT. */
  totalAmountHalalas: number;
  /** Platform commission, taken out of the worker's price. */
  commissionAmountHalalas: number;
  /** What the worker receives: price - commission. */
  workerPayoutHalalas: number;
}

export function isHalalas(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * `amount * bps / 10000`, rounded half up, using integer arithmetic only
 * (the remainder is subtracted instead of relying on floating-point division).
 */
export function applyBps(amountHalalas: number, bps: number): number {
  if (!isHalalas(amountHalalas) || !Number.isSafeInteger(bps) || bps < 0) {
    throw new RangeError('amount must be a non-negative integer of halalas and bps a non-negative integer');
  }
  const scaled = amountHalalas * bps + BPS_DENOMINATOR / 2;
  return (scaled - (scaled % BPS_DENOMINATOR)) / BPS_DENOMINATOR;
}

/**
 * The only place that turns a worker's price into the amounts everyone sees. VAT is charged
 * to the customer on top of the price; commission is deducted from the worker's price.
 * (PROVISIONAL business assumption: confirm with the business before launch.)
 */
export function computeQuoteAmounts(priceHalalas: number, rates: Pick<PricingRates, 'vatRateBps' | 'commissionRateBps'>): QuoteAmounts {
  const vatAmountHalalas = applyBps(priceHalalas, rates.vatRateBps);
  const commissionAmountHalalas = applyBps(priceHalalas, rates.commissionRateBps);
  return {
    priceHalalas,
    vatAmountHalalas,
    totalAmountHalalas: priceHalalas + vatAmountHalalas,
    commissionAmountHalalas,
    workerPayoutHalalas: priceHalalas - commissionAmountHalalas,
  };
}
