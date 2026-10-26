/**
 * Sensitive-data-safe error descriptions for logs.
 *
 * Database-driver errors can quote the row that failed (phone numbers, tokens, message text), and any error can carry a
 * connection string or a signed URL in its text. Logs are shipped to third parties, so they never receive raw error text
 * from the database layer, and text from other errors is scrubbed and bounded.
 */

const MAX_TEXT = 300;
const MAX_STACK_LINES = 8;

/** Credential-looking fragments that are removed from any text before it is logged. */
const SCRUBBERS: Array<[RegExp, string]> = [
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/gi, '<url-with-credentials>@'], // postgres://user:pass@host, redis://:pass@host
  [/\bBearer\s+[\w.~+/=-]+/gi, 'Bearer <redacted>'],
  [/\beyJ[\w-]+\.[\w-]+\.[\w-]*/g, '<jwt>'],
  [/([?&](?:X-Amz-[\w-]+|sig|signature|token|access_token|key)=)[^&\s"']+/gi, '$1<redacted>'],
  [/\b(password|passwd|pwd|secret|api[_-]?key|token)(\s*[=:]\s*)[^\s,;"']+/gi, '$1$2<redacted>'],
  [/-----BEGIN [A-Z ]+-----[\s\S]*?(-----END [A-Z ]+-----|$)/g, '<private-key>'],
];

export function scrubSensitiveText(text: string, max = MAX_TEXT): string {
  let out = text;
  for (const [pattern, replacement] of SCRUBBERS) out = out.replace(pattern, replacement);
  return out.length > max ? `${out.slice(0, max)}...` : out;
}

/** Prisma client errors and driver-adapter errors: their text can quote the failing query's values. */
function isDatabaseError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: unknown; clientVersion?: unknown; severity?: unknown; routine?: unknown };
  return (typeof e.name === 'string' && e.name.startsWith('PrismaClient')) || e.clientVersion !== undefined || e.severity !== undefined || e.routine !== undefined;
}

/**
 * One line that names the failure without quoting data: `Name`, `Name:CODE` for database errors (never their text), or
 * `Name: scrubbed message` for everything else.
 */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return 'non-error thrown';
  const name = err.constructor?.name || err.name || 'Error';
  const code = (err as { code?: unknown }).code;
  const codeText = typeof code === 'string' || typeof code === 'number' ? `:${String(code).slice(0, 30)}` : '';
  if (isDatabaseError(err)) return `${name}${codeText}`;
  return `${name}${codeText}: ${scrubSensitiveText(err.message)}`;
}

/**
 * Safe structured form for the 5xx handler. The stack is kept for diagnosis but its first lines (which repeat the message) are
 * dropped for database errors and scrubbed otherwise, and it is capped.
 */
export function describeErrorForLog(err: unknown): { error: string; stack?: string } {
  const error = describeError(err);
  if (!(err instanceof Error) || !err.stack) return { error };
  const frames = err.stack.split('\n').filter((line) => /^\s+at\s/.test(line)).slice(0, MAX_STACK_LINES);
  return { error, stack: scrubSensitiveText(frames.join('\n')).replace(/\.\.\.$/, '') };
}
