import { createHash, createHmac } from 'node:crypto';

/** Minimal AWS Signature Version 4 for S3 (query-string presigning and header signing). No SDK dependency. */

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest();

/** RFC 3986 encoding as AWS requires; `/` is kept only in the path. */
export const awsEncode = (value: string, keepSlash = false) =>
  encodeURIComponent(value)
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%2F/g, keepSlash ? '/' : '%2F');

export interface SigningKeyInput {
  secretAccessKey: string;
  /** yyyymmdd */
  date: string;
  region: string;
  service?: string;
}

export function signingKey({ secretAccessKey, date, region, service = 's3' }: SigningKeyInput): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, date), region), service), 'aws4_request');
}

export const amzDate = (d: Date) => d.toISOString().replace(/[:-]|\.\d{3}/g, ''); // 20130524T000000Z

export const EMPTY_SHA256 = sha256('');

interface CanonicalInput {
  method: string;
  /** Already-encoded absolute path starting with "/". */
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  payloadHash: string;
}

function canonicalRequest(i: CanonicalInput): { text: string; signedHeaders: string } {
  const names = Object.keys(i.headers).map((h) => h.toLowerCase()).sort();
  const lowered = Object.fromEntries(Object.entries(i.headers).map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, ' ')]));
  const canonicalHeaders = names.map((n) => `${n}:${lowered[n]}\n`).join('');
  const canonicalQuery = Object.keys(i.query)
    .sort()
    .map((k) => `${awsEncode(k)}=${awsEncode(i.query[k]!)}`)
    .join('&');
  const signedHeaders = names.join(';');
  return { text: [i.method, i.path, canonicalQuery, canonicalHeaders, signedHeaders, i.payloadHash].join('\n'), signedHeaders };
}

function signature(secretAccessKey: string, region: string, now: Date, canonical: string): { signature: string; scope: string } {
  const stamp = amzDate(now);
  const date = stamp.slice(0, 8);
  const scope = `${date}/${region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256(canonical)].join('\n');
  return { signature: createHmac('sha256', signingKey({ secretAccessKey, date, region })).update(toSign).digest('hex'), scope };
}

export interface PresignInput {
  method: 'GET' | 'PUT';
  host: string;
  /** Encoded path starting with "/". */
  path: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  expiresSeconds: number;
  now: Date;
  /** Extra headers that become part of the signature (the client must send them unchanged), besides host. */
  signedHeaders?: Record<string, string>;
  /** Extra query parameters that become part of the signature (for example response-content-disposition). */
  extraQuery?: Record<string, string>;
}

/** Returns the query string (without "?") of a presigned URL. */
export function presignQuery(i: PresignInput): string {
  const stamp = amzDate(i.now);
  const scope = `${stamp.slice(0, 8)}/${i.region}/s3/aws4_request`;
  const headers = { host: i.host, ...(i.signedHeaders ?? {}) };
  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const query: Record<string, string> = {
    ...(i.extraQuery ?? {}),
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${i.accessKeyId}/${scope}`,
    'X-Amz-Date': stamp,
    'X-Amz-Expires': String(i.expiresSeconds),
    'X-Amz-SignedHeaders': names.join(';'),
  };
  const { text } = canonicalRequest({ method: i.method, path: i.path, query, headers, payloadHash: 'UNSIGNED-PAYLOAD' });
  const { signature: sig } = signature(i.secretAccessKey, i.region, i.now, text);
  const all: Record<string, string> = { ...query, 'X-Amz-Signature': sig };
  return Object.keys(all)
    .sort()
    .map((k) => `${awsEncode(k)}=${awsEncode(all[k]!)}`)
    .join('&');
}

export interface HeaderSignInput {
  method: 'GET' | 'HEAD' | 'DELETE';
  host: string;
  path: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  now: Date;
  /** Extra headers to sign and send (for example Range). */
  headers?: Record<string, string>;
}

/** Headers (including Authorization) to send with a header-signed request that has no body. */
export function signedHeaders(i: HeaderSignInput): Record<string, string> {
  const stamp = amzDate(i.now);
  const headers: Record<string, string> = { host: i.host, 'x-amz-content-sha256': EMPTY_SHA256, 'x-amz-date': stamp, ...(i.headers ?? {}) };
  const { text, signedHeaders: names } = canonicalRequest({ method: i.method, path: i.path, query: {}, headers, payloadHash: EMPTY_SHA256 });
  const { signature: sig, scope } = signature(i.secretAccessKey, i.region, i.now, text);
  const { host: _host, ...send } = headers;
  return { ...send, Authorization: `AWS4-HMAC-SHA256 Credential=${i.accessKeyId}/${scope}, SignedHeaders=${names}, Signature=${sig}` };
}
