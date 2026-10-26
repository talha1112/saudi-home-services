import { createHmac, timingSafeEqual } from 'node:crypto';

export interface LocalUrlParts {
  op: 'put' | 'get';
  key: string;
  /** Unix seconds. */
  exp: number;
  /** For uploads: the exact byte length the signature allows. */
  size?: number;
  /** For uploads: the exact Content-Type the signature allows. */
  type?: string;
}

const canonical = (p: LocalUrlParts) => `v1\n${p.op}\n${p.key}\n${p.exp}\n${p.size ?? ''}\n${p.type ?? ''}`;

export function signLocalUrl(secret: string, parts: LocalUrlParts): string {
  return createHmac('sha256', secret).update(canonical(parts)).digest('hex');
}

/** Constant-time check that `sig` matches the parts AND the link has not expired. */
export function verifyLocalUrl(secret: string, parts: LocalUrlParts, sig: string, nowMs: number = Date.now()): boolean {
  if (!Number.isFinite(parts.exp) || parts.exp * 1000 <= nowMs) return false;
  const expected = Buffer.from(signLocalUrl(secret, parts), 'hex');
  let given: Buffer;
  try {
    given = Buffer.from(sig, 'hex');
  } catch {
    return false;
  }
  return given.length === expected.length && timingSafeEqual(given, expected);
}
