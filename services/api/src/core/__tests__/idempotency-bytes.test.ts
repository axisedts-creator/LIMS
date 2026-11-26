// CR TENANT-LOGO-1 (multipart layer): an upload carries an Idempotency-Key, so its body (a file part with a Buffer) goes through the
// request hash. The bytes must count (another file under the same key is another request) and must be cheap (a 15 MiB file in well
// under a second; walking the Buffer key by key took minutes and gigabytes).
import { describe, expect, it } from 'vitest';
import { requestSha256 } from '../idempotency.js';

const req = (bytes: Uint8Array, over: Record<string, unknown> = {}) => requestSha256({
  method: 'POST', routeTemplate: '/v1/identity/settings/branding-assets', pathParams: {}, query: {},
  body: { kind: 'logo', file: { filename: 'logo.png', mimeType: 'image/png', bytes }, ...over },
}).toString('hex');

describe('request hash of an upload', () => {
  it('same bytes, same hash (Buffer or Uint8Array); one changed byte, another length or another field -> another hash', () => {
    const a = Buffer.from([1, 2, 3, 4]);
    expect(req(a)).toBe(req(Buffer.from([1, 2, 3, 4]))); expect(req(a)).toBe(req(new Uint8Array([1, 2, 3, 4])));
    expect(req(a)).not.toBe(req(Buffer.from([1, 2, 3, 5]))); expect(req(a)).not.toBe(req(Buffer.from([1, 2, 3])));
    expect(req(a)).not.toBe(req(a, { kind: 'letterhead_header' }));
  });
  it('bytes cannot be confused with a JSON body that spells the same digest object', () => {
    const a = Buffer.from([1, 2, 3, 4]);
    const asJson = requestSha256({ method: 'POST', routeTemplate: '/v1/identity/settings/branding-assets', pathParams: {}, query: {},
      body: { kind: 'logo', file: { filename: 'logo.png', mimeType: 'image/png', bytes: { 0: 1, 1: 2, 2: 3, 3: 4 } } } }).toString('hex');
    expect(req(a)).not.toBe(asJson);
  });
  it('a 15 MiB file is hashed in well under two seconds', () => {
    const big = Buffer.alloc(15 * 1024 * 1024, 7); const t0 = Date.now();
    expect(req(big)).toMatch(/^[0-9a-f]{64}$/); expect(Date.now() - t0).toBeLessThan(2000);
  });
});
