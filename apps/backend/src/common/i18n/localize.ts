import type { Locale } from '../../generated/prisma/client.js';

export type LocalizedPair = { ar?: string | null; en?: string | null };

/**
 * Deterministic fallback for two-language content: the reader's language if that text exists, otherwise the
 * other language, otherwise null. Never invents or machine-translates text.
 */
export function pickLocalized(locale: Locale, pair: LocalizedPair): { text: string | null; locale: Locale | null } {
  const order: Locale[] = locale === 'AR' ? ['AR', 'EN'] : ['EN', 'AR'];
  for (const l of order) {
    const value = (l === 'AR' ? pair.ar : pair.en)?.trim();
    if (value) return { text: value, locale: l };
  }
  return { text: null, locale: null };
}

/** Accepts `ar`/`en` (any case) from a query string; anything else is ignored so the stored preference applies. */
export function parseLocale(value: unknown): Locale | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.trim().toUpperCase();
  return v === 'AR' || v === 'EN' ? v : undefined;
}
