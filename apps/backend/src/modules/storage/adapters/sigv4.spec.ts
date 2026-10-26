import { amzDate, awsEncode, presignQuery, signedHeaders } from './sigv4.js';

// AWS documentation, "Authenticating Requests: Using Query Parameters (AWS Signature Version 4)" example.
const ACCESS = 'AKIAIOSFODNN7EXAMPLE';
const SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const NOW = new Date('2013-05-24T00:00:00.000Z');

describe('SigV4', () => {
  it('reproduces the signature AWS publishes for its presigned GET example', () => {
    const qs = presignQuery({
      method: 'GET',
      host: 'examplebucket.s3.amazonaws.com',
      path: '/test.txt',
      accessKeyId: ACCESS,
      secretAccessKey: SECRET,
      region: 'us-east-1',
      expiresSeconds: 86400,
      now: NOW,
    });
    expect(qs).toContain('X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
    expect(qs).toContain('X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request');
    expect(qs).toContain('X-Amz-SignedHeaders=host');
  });

  it('formats the timestamp and encodes like AWS', () => {
    expect(amzDate(NOW)).toBe('20130524T000000Z');
    expect(awsEncode('a b/c+d~e')).toBe('a%20b%2Fc%2Bd~e');
    expect(awsEncode('a b/c', true)).toBe('a%20b/c');
    expect(awsEncode("it's(1)*")).toBe('it%27s%281%29%2A');
  });

  it('signs extra headers into a presigned upload, so the client cannot change type or size', () => {
    const base = { method: 'PUT' as const, host: 'b.s3.example.com', path: '/k', accessKeyId: ACCESS, secretAccessKey: SECRET, region: 'us-east-1', expiresSeconds: 300, now: NOW };
    const a = presignQuery({ ...base, signedHeaders: { 'content-type': 'image/png', 'content-length': '100' } });
    const b = presignQuery({ ...base, signedHeaders: { 'content-type': 'image/png', 'content-length': '101' } });
    const c = presignQuery({ ...base, signedHeaders: { 'content-type': 'image/jpeg', 'content-length': '100' } });
    expect(a).toContain('X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost');
    const sig = (q: string) => /X-Amz-Signature=([0-9a-f]+)/.exec(q)![1];
    expect(new Set([sig(a), sig(b), sig(c)]).size).toBe(3);
  });

  it('header-signs bodiless requests with an Authorization header and no host header to send', () => {
    const h = signedHeaders({ method: 'GET', host: 'examplebucket.s3.amazonaws.com', path: '/test.txt', accessKeyId: ACCESS, secretAccessKey: SECRET, region: 'us-east-1', now: NOW, headers: { range: 'bytes=0-9' } });
    expect(h['Authorization']).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20130524\/us-east-1\/s3\/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    expect(h['host']).toBeUndefined();
    expect(h['x-amz-date']).toBe('20130524T000000Z');
  });
});
