import { parsePhoneNumberFromString } from 'libphonenumber-js/min';

/**
 * Normalises a phone number to E.164 (+9665XXXXXXXX). National numbers such as
 * 0501234567 are read in `defaultRegion`; anything with a leading + or 00 is
 * read as international. Returns null when the number is not valid.
 */
export function normalizePhone(input: unknown, defaultRegion = 'SA'): string | null {
  if (typeof input !== 'string') return null;
  const cleaned = input.trim().replace(/[\s().-]/g, '');
  if (cleaned.length === 0 || cleaned.length > 20) return null;
  const withPlus = cleaned.startsWith('00') ? `+${cleaned.slice(2)}` : cleaned;
  const parsed = parsePhoneNumberFromString(withPlus, withPlus.startsWith('+') ? undefined : (defaultRegion as never));
  return parsed?.isValid() ? parsed.number : null;
}

export const E164_PATTERN = /^\+[1-9]\d{6,14}$/;
