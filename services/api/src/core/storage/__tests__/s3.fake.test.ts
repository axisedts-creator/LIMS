// T0B-STORAGE-1: the fake S3 server is not vacuous. A reference signer written here (checked against the AWS published vector first)
// signs requests; the fake accepts the right one and refuses each wrong one for the right reason. Independent of ../s3.ts.
import { createHash, createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enc, sendVia, startFakeS3, TEST_ACCESS_KEY_ID, TEST_BUCKET, TEST_REGION, TEST_SECRET, type FakeS3 } from './s3.fake.js';

const H = (k: string | Buffer, d: string) => createHmac('sha256', k).update(d).digest();
function ref(o: { method: string; host: string; path: string; query?: Record<string, string>; headers?: Record<string, string>; payload?: string; akid: string; secret: string; region: string; now: number; expires: number }): string {
  const amz = new Date(o.now).toISOString().replace(/[-:]|\.\d{3}/g, ''); const day = amz.slice(0, 8);
  const hdrs: Record<string, string> = { host: o.host, ...Object.fromEntries(Object.entries(o.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])) };
  const names = Object.keys(hdrs).sort();
  const q: Record<string, string> = { ...o.query, 'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': `${o.akid}/${day}/${o.region}/s3/aws4_request`, 'X-Amz-Date': amz, 'X-Amz-Expires': String(o.expires), 'X-Amz-SignedHeaders': names.join(';') };
  const cq = Object.entries(q).map(([k, v]) => [enc(k), enc(v)] as const).sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('&');
  const canon = [o.method, o.path.split('/').map(enc).join('/'), cq, names.map((n) => `${n}:${hdrs[n]}\n`).join(''), names.join(';'), o.payload ?? 'UNSIGNED-PAYLOAD'].join('\n');
  const sts = ['AWS4-HMAC-SHA256', amz, `${day}/${o.region}/s3/aws4_request`, createHash('sha256').update(canon).digest('hex')].join('\n');
  const sig = H(H(H(H(H(`AWS4${o.secret}`, day), o.region), 's3'), 'aws4_request'), sts).toString('hex');
  return `http://${o.host}${o.path.split('/').map(enc).join('/')}?${cq}&X-Amz-Signature=${sig}`;
}

describe('reference signer matches the AWS published vector', () => {
  it('aeeed9bb...d404', () => {
    const u = ref({ method: 'GET', host: 'examplebucket.s3.amazonaws.com', path: '/test.txt', akid: 'AKIAIOSFODNN7EXAMPLE', secret: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1', now: Date.parse('2013-05-24T00:00:00Z'), expires: 86400 });
    expect(u).toContain('X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
  });
});

describe('fake S3 server verifies like S3 (path style)', () => {
  const T0 = Date.parse('2026-11-17T06:00:00Z'); const clock = { t: T0 };
  let fake: FakeS3; let host: string;
  const body = Buffer.from('synthetic bytes');
  const sha = createHash('sha256').update(body).digest('hex');
  const sign = (o: Partial<Parameters<typeof ref>[0]> = {}) => ref({ method: 'PUT', host, path: `/${TEST_BUCKET}/k/a b.pdf`, headers: { 'content-length': String(body.length), 'x-amz-content-sha256': sha, 'if-none-match': '*' }, akid: TEST_ACCESS_KEY_ID, secret: TEST_SECRET, region: TEST_REGION, now: clock.t, expires: 60, ...o });
  const hdrs = { 'content-length': String(body.length), 'x-amz-content-sha256': sha, 'if-none-match': '*' };
  beforeAll(async () => { fake = await startFakeS3({ style: 'path', clock: () => clock.t }); host = `localhost:${fake.port}`; });
  afterAll(async () => { await fake.close(); });
  const req = async (url: string, h: Record<string, string>, b: Buffer | undefined = body, method = 'PUT') => (await sendVia(fake.port)(url, { method, headers: h, ...(b ? { body: b } : {}) })).status;

  it('accepts the right signature, stores the object, then refuses an overwrite (412)', async () => {
    clock.t = T0; fake.objects.clear();
    expect(await req(sign(), hdrs)).toBe(200); expect(fake.objects.get('k/a b.pdf')?.bytes.equals(body)).toBe(true);
    expect(await req(sign(), hdrs)).toBe(412);
  });
  it('refuses: wrong secret, altered header, altered body, expired, wrong key in path', async () => {
    clock.t = T0; fake.objects.clear();
    expect(await req(sign({ secret: TEST_SECRET + 'x' }), hdrs)).toBe(403);
    expect(await req(sign(), { ...hdrs, 'if-none-match': 'x' })).toBe(403);
    expect(await req(sign(), hdrs, Buffer.from('synthetic bytez'))).toBe(400);
    expect(await req(sign({ path: '/other/k.pdf' }), hdrs)).toBe(404);
    const u = sign(); clock.t = T0 + 61_000;
    expect(await req(u, hdrs)).toBe(403); expect(fake.requests.at(-1)?.reason).toBe('expired');
    expect(fake.objects.size).toBe(0);
  });
});
