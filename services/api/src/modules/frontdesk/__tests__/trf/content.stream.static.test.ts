// T0B-FILESTREAM-1 (LD-312) done_when 1, 2, 3: TRF download (F21a) streams with Range / 304 and no-store. Static on purpose: the behavioural tests of this
// module need the database (helpers.ts appTx); the streaming behaviour itself is proved on the same core ctx.download.stream in
// core/storage/__tests__/download.stream.test.ts, and the existing content.test.ts keeps proving the gates (clean only, trf.view row, headers).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const dir = fileURLToPath(new URL('../..', import.meta.url));
const read = (f: string) => readFileSync(join(dir, f), 'utf8');
const code = (t: string) => t.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

describe('F21a getTrfAttachmentContent', () => {
  it('the handler passes the request headers on (Range, If-None-Match, If-Range) instead of only req.params', () => {
    expect(code(read('handlers/getTrfAttachmentContent.ts'))).toMatch(/req\.headers/);
  });
  it('the service hands them to ctx.download.stream as requestHeaders and keeps the default no-store (a TRF is a patient document; never max-age, never public)', () => {
    const t = code(read('service/trf.service.ts'));
    expect(t).toMatch(/requestHeaders/); expect(t).not.toMatch(/max-age|privateMaxAgeSeconds|public/);
  });
  it('the TRF download never reads the whole object itself and never builds a Storage URL', () => {
    const t = code(read('service/trf.service.ts'));
    expect(t).not.toMatch(/storage\.read\(|\.arrayBuffer\(|signedUrl|signedDownloadUrl/);
  });
  it('the TRF upload still goes through ctx.uploads.accept (scan, magic byte and quarantine rules live there)', () => {
    expect(code(read('service/trf.service.ts'))).toMatch(/uploads\.accept\(/);
  });
});
