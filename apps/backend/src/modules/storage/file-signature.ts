/**
 * File type detection by content ("magic bytes"), so a file is judged by what it IS, not by the name
 * or Content-Type the client claimed. Only the formats we accept are recognised; everything else is "unknown".
 */
export type DetectedMime = 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf';

export function detectMime(head: Buffer): DetectedMime | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (head.length >= 12 && head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (head.length >= 5 && head.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  return null;
}

export type ContentProblem = 'MISSING_SIZE' | 'TOO_LARGE' | 'SIZE_MISMATCH' | 'UNKNOWN_TYPE' | 'TYPE_MISMATCH' | 'TYPE_NOT_ALLOWED';

/** Pure check of an inspected object against what the client declared and what the category allows. */
export function checkContent(input: {
  declaredMime: string;
  declaredSize: number;
  actualSize: number;
  head: Buffer;
  maxBytes: number;
  allowed: readonly string[];
}): ContentProblem | null {
  if (!Number.isFinite(input.actualSize) || input.actualSize <= 0) return 'MISSING_SIZE';
  if (input.actualSize > input.maxBytes) return 'TOO_LARGE';
  if (input.actualSize !== input.declaredSize) return 'SIZE_MISMATCH';
  const detected = detectMime(input.head);
  if (!detected) return 'UNKNOWN_TYPE';
  if (!input.allowed.includes(detected)) return 'TYPE_NOT_ALLOWED';
  if (detected !== input.declaredMime) return 'TYPE_MISMATCH';
  return null;
}
