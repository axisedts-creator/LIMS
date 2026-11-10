// C6-T12 — PDF sandbox HTTP service (02-TRD §5.2; REQ-SEC-083/087; AC-04.5, AC-04.6, AC-04.7, AC-03.2 page numbers).
// ASSUMED API (spec names no signatures; mirrors the renderer's server.ts):
//   sandbox/server.ts: startServer({ token: string, port?: number /*0 = ephemeral*/, host?: string,
//     workDir?: string /* per-job scratch root (tmpfs in the container); empty after every job */,
//     qpdfTimeoutMs?: number /* per-process qpdf timeout, default 30_000 */ }): Promise<{ url: string; close(): Promise<void> }>
//   Routes, bodies and reason codes are exactly 02-TRD §5.2. Assemble failures are 4xx (the TRD names no status): never 5xx, never 200.
//   qpdf 12.4.2 must be on PATH (the Dockerfile.sandbox image provides it; on a dev host install it first).
//   Extractor limit: assemble output must use classic xref tables (pdf-lib `save({ useObjectStreams: false })`), because the shared
//   test helper src/__tests__/helpers/pdf-text.ts does not read object streams.
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { norm, pdfPages } from '../../__tests__/helpers/pdf-text.js';
import * as fx from './helpers/make-pdf.js';
import { locateText, onScreen } from './helpers/stamp-pos.js';
import { startServer } from '../server.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const TOKEN = 'synthetic-sandbox-token-0123456789abcdef';
const MIB = 1024 * 1024;
const REASONS = ['encrypted', 'malformed', 'too_many_pages', 'timeout', 'not_pdf'];
let workDir: string;
let srv: Awaited<ReturnType<typeof startServer>>;

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'c6t12-work-'));
  srv = await startServer({ token: TOKEN, port: 0, host: '127.0.0.1', workDir });
});
afterAll(async () => {
  await srv?.close();
  rmSync(workDir, { recursive: true, force: true });
});

const auth = (token: string | null = TOKEN) => (token === null ? {} : { authorization: `Bearer ${token}` });
const sanitize = (bytes: Uint8Array, o: { url?: string; token?: string | null; field?: string } = {}) => {
  const fd = new FormData();
  fd.append(o.field ?? 'file', new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }), 'upload.pdf');
  return fetch((o.url ?? srv.url) + '/internal/sanitize', { method: 'POST', body: fd, headers: auth(o.token) });
};
const part = (kind: string, pdf: Uint8Array) => ({ kind, pdf_base64: Buffer.from(pdf).toString('base64'), sha256: fx.sha256(pdf) });
const STAMP = { page_label_format: 'Page {n} Of {m}', position: 'footer_right', font_size_pt: 8, markers: { plain: false, not_released: false } };
const assemble = (body: unknown, token: string | null = TOKEN) =>
  fetch(srv.url + '/internal/assemble', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...auth(token) } });
const asm = (parts: unknown[], stamp: object = {}) => assemble({ parts, stamp: { ...STAMP, ...stamp } });

type Ok = { ok: true; page_count: number; sha256: string; pdf_base64: string };
async function sanitizeOk(bytes: Uint8Array) {
  const res = await sanitize(bytes);
  expect(res.status).toBe(200);
  const body = (await res.json()) as Ok;
  return { body, pdf: Buffer.from(body.pdf_base64, 'base64') };
}
/** 422 with exactly the TRD body: { ok: false, reason } and nothing else (no paths, stack, qpdf stderr). */
async function expectRejected(res: Response, reason?: string) {
  expect(res.status).toBe(422);
  const body = (await res.json()) as Record<string, unknown>;
  expect(Object.keys(body).sort()).toEqual(['ok', 'reason']);
  expect(body.ok).toBe(false);
  if (reason) expect(body.reason).toBe(reason);
  else expect(REASONS).toContain(body.reason);
}
const pageTexts = (pdf: Uint8Array) => pdfPages(pdf).map(norm);

describe('auth and routing (constant-time bearer, 02-TRD §5.2)', () => {
  it.each(['/internal/sanitize', '/internal/assemble'])('POST %s without or with a wrong token → 401', async (path) => {
    for (const token of [null, 'wrong-token', '']) {
      const res = await fetch(srv.url + path, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', ...auth(token) } });
      expect(res.status).toBe(401);
    }
  });
  it('a sanitize call with a wrong token never parses the file (401, not 422)', async () => {
    expect((await sanitize(fx.encrypted(), { token: 'nope' })).status).toBe(401);
  });
  it('GET /internal/health is open and returns only a status word', async () => {
    const res = await fetch(srv.url + '/internal/health');
    expect(res.status).toBe(200);
    expect((await res.text()).length).toBeLessThan(20);
  });
  it('unknown path → 404; wrong method on a known path → 405', async () => {
    expect((await fetch(srv.url + '/internal/nope', { headers: auth() })).status).toBe(404);
    expect((await fetch(srv.url + '/internal/sanitize', { method: 'GET', headers: auth() })).status).toBe(405);
  });
  it('refuses to start with an empty token', async () => {
    await expect(startServer({ token: '', port: 0, host: '127.0.0.1' })).rejects.toThrow();
  });
});

describe('sanitize: accepted file (AC-04.3 sanitise profile, 02-TRD §5.2)', () => {
  it('returns { ok, page_count, sha256, pdf_base64 } with sha256 of the sanitised bytes', async () => {
    const { body, pdf } = await sanitizeOk(fx.simple('OUT', 3));
    expect(body.ok).toBe(true);
    expect(body.page_count).toBe(3);
    expect(body.sha256).toBe(fx.sha256(pdf));
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pageTexts(pdf).map((t) => /OUT-\d/.exec(t)?.[0])).toEqual(['OUT-1', 'OUT-2', 'OUT-3']);
  });
  it('step 4: the output is linearised and carries no /Encrypt', async () => {
    const { pdf } = await sanitizeOk(fx.simple('LIN', 2));
    const s = pdf.toString('latin1');
    expect(s).toMatch(/\/Linearized\s+1/);
    expect(s).not.toMatch(/\/Encrypt\b/);
  });
  it('step 4: incremental updates are not kept — the superseded revision is gone from the bytes', async () => {
    const input = fx.withIncrementalUpdate(fx.simple('INC', 1, { title: 'OLD-REVISION-TITLE' }), 'NEW-REVISION-TITLE');
    expect(input.toString('latin1')).toContain('OLD-REVISION-TITLE'); // fixture sanity
    const { pdf } = await sanitizeOk(input);
    const s = pdf.toString('latin1');
    expect(s).toContain('NEW-REVISION-TITLE');
    expect(s).not.toContain('OLD-REVISION-TITLE');
  });
  it('step 5: exactly 200 pages is accepted', async () => {
    const { body } = await sanitizeOk(fx.manyPages(200));
    expect(body.page_count).toBe(200);
  });
  it('a file just under the 15 MB limit is accepted', async () => {
    const big = fx.simple('BIG', 1, { hook: () => ({ objects: [`<< /Length 14000000 >>\nstream\n${'0'.repeat(14_000_000)}\nendstream`] }) });
    expect(big.length).toBeGreaterThan(14_000_000);
    const { body } = await sanitizeOk(big);
    expect(body.page_count).toBe(1);
  });
  it('concurrent jobs do not share state: every caller gets its own file back', async () => {
    const runs = await Promise.all([1, 2, 3, 4, 5, 6].map(async (k) => ({ k, ...(await sanitizeOk(fx.simple(`CONC${k}`, k))) })));
    for (const { k, body, pdf } of runs) {
      expect(body.page_count).toBe(k);
      expect(pageTexts(pdf)[0]).toContain(`CONC${k}-1`);
    }
  });
});

describe('sanitize: malformed corpus is rejected (AC-04.6; done_when "malformed corpus rejected")', () => {
  it('step 1: HTML, PNG, empty file → 422 not_pdf', async () => {
    for (const bytes of [fx.notPdf.html, fx.notPdf.png, fx.notPdf.empty]) await expectRejected(await sanitize(bytes), 'not_pdf');
  });
  it('step 1: polyglot — `%PDF-` is not at offset 0 → 422 not_pdf', async () => {
    await expectRejected(await sanitize(fx.notPdf.polyglot), 'not_pdf');
  });
  it('step 2: truncated file (no xref/trailer) → 422 malformed, even though qpdf could reconstruct it', async () => {
    await expectRejected(await sanitize(fx.truncated()), 'malformed');
  });
  it('step 2: corrupt structure (no /Root, broken objects) → 422 malformed', async () => {
    await expectRejected(await sanitize(fx.corruptStructure()), 'malformed');
  });
  it('step 3: encrypted file → 422 encrypted', async () => {
    await expectRejected(await sanitize(fx.encrypted()), 'encrypted');
  });
  it('step 5: 201 pages → 422 too_many_pages', async () => {
    await expectRejected(await sanitize(fx.manyPages(201)), 'too_many_pages');
  });
  it('JavaScript action (OpenAction and page /AA) → 422 (07-SECURITY A12)', async () => {
    await expectRejected(await sanitize(fx.javascriptAction()));
  });
  it('embedded file attachment → 422', async () => {
    await expectRejected(await sanitize(fx.embeddedFile()));
  });
  it('AcroForm /XFA (script without any /JS or /JavaScript name) → 422, array and single-stream forms (07-SECURITY A12)', async () => {
    for (const bytes of [fx.xfaForm(), fx.xfaFormSingleStream()]) {
      expect(bytes.toString('latin1')).not.toMatch(/\/(JS|JavaScript)\b/); // fixture sanity: only /XFA can trip the scan
      await expectRejected(await sanitize(bytes));
    }
  });
  it('> 15 MB → 413 (common.payload_too_large), never parsed', async () => {
    const huge = fx.simple('HUGE', 1, { hook: () => ({ objects: [`<< /Length ${15 * MIB}\n>>\nstream\n${' '.repeat(15 * MIB)}\nendstream`] }) });
    expect(huge.length).toBeGreaterThan(15 * MIB);
    expect((await sanitize(huge)).status).toBe(413);
  });
  it('missing multipart field `file` → 400 (not a 500, not a 422 reason)', async () => {
    const res = await sanitize(fx.simple('X'), { field: 'other' });
    expect(res.status).toBe(400);
  });
  it('a non-multipart body → 400', async () => {
    const res = await fetch(srv.url + '/internal/sanitize', { method: 'POST', body: '{"file":"x"}', headers: { 'content-type': 'application/json', ...auth() } });
    expect(res.status).toBe(400);
  });
});

describe('sanitize: timeout (AC-04.7)', () => {
  it('a qpdf run that exceeds the per-process timeout → 422 timeout', async () => {
    const slow = await startServer({ token: TOKEN, port: 0, host: '127.0.0.1', workDir, qpdfTimeoutMs: 1 });
    try {
      await expectRejected(await sanitize(fx.simple('SLOW', 2), { url: slow.url }), 'timeout');
    } finally {
      await slow.close();
    }
  });
});

describe('no network, no residue (REQ-SEC-087, done_when "no network")', () => {
  it('URI actions are never followed: the canary listener sees zero requests; the output keeps no /URI or is rejected', async () => {
    let hits = 0;
    const canary = http.createServer((_q, r) => (hits++, r.end('x')));
    await new Promise<void>((r) => canary.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(canary.address() as AddressInfo).port}/canary`;
    try {
      const pdf = fx.uriCanary(url);
      const res = await sanitize(pdf);
      if (res.status === 200) {
        const out = Buffer.from(((await res.json()) as Ok).pdf_base64, 'base64').toString('latin1');
        expect(out).not.toContain(url);
        expect(out).not.toMatch(/\/OpenAction\b/);
      } else await expectRejected(res);
      const merged = await asm([part('main', fx.simple('M')), part('outsourced', pdf)]);
      expect(merged.status === 200 || (merged.status >= 400 && merged.status < 500)).toBe(true);
      await new Promise((r) => setTimeout(r, 300));
      expect(hits).toBe(0);
    } finally {
      await new Promise((r) => canary.close(r));
    }
  });
  it('the per-job work dir holds nothing after accepted, rejected and timed-out jobs', async () => {
    await sanitize(fx.simple('RES', 2));
    await sanitize(fx.truncated());
    await sanitize(fx.encrypted());
    await asm([part('main', fx.simple('RES')), part('outsourced', fx.simple('RES2'))]);
    const slow = await startServer({ token: TOKEN, port: 0, host: '127.0.0.1', workDir, qpdfTimeoutMs: 1 });
    try {
      await sanitize(fx.simple('SLOW'), { url: slow.url });
    } finally {
      await slow.close();
    }
    expect(readdirSync(workDir)).toEqual([]);
  });
});

describe('assemble + stamp: "Page N Of M" over the merged document (AC-04.5, AC-03.2)', () => {
  it('main(3) + outsourced(2): 5 pages, our pages first, every page — outside ones too — stamped with the merged total', async () => {
    const res = await asm([part('main', fx.simple('MAIN', 3)), part('outsourced', fx.simple('OUT', 2))]);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/pdf');
    expect(res.headers.get('x-page-count')).toBe('5');
    const out = Buffer.from(await res.arrayBuffer());
    expect(out.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const pages = pageTexts(out);
    expect(pages).toHaveLength(5);
    const want = ['MAIN-1', 'MAIN-2', 'MAIN-3', 'OUT-1', 'OUT-2'];
    pages.forEach((t, i) => {
      expect(t).toContain(want[i]!);
      expect(t).toContain(`Page ${i + 1} Of 5`);
      expect(t.match(/Page \d+ Of \d+/g)).toHaveLength(1); // stamped once
    });
  });
  it('parts are printed in the order given, any kind first (main, outsourced, instrument_pdf)', async () => {
    const res = await asm([part('outsourced', fx.simple('OUT', 1)), part('main', fx.simple('MAIN', 1)), part('instrument_pdf', fx.simple('INS', 2))]);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-page-count')).toBe('4');
    const pages = pageTexts(Buffer.from(await res.arrayBuffer()));
    ['OUT-1', 'MAIN-1', 'INS-1', 'INS-2'].forEach((w, i) => {
      expect(pages[i]).toContain(w);
      expect(pages[i]).toContain(`Page ${i + 1} Of 4`);
    });
  });
  it('a one-page document reads "Page 1 Of 1"', async () => {
    const pages = pageTexts(Buffer.from(await (await asm([part('main', fx.simple('ONE'))])).arrayBuffer()));
    expect(pages).toHaveLength(1);
    expect(pages[0]).toContain('Page 1 Of 1');
  });
  it('a long outsourced file is counted: 1 + 50 pages → last page "Page 51 Of 51"', async () => {
    const res = await asm([part('main', fx.simple('MAIN')), part('outsourced', fx.manyPages(50))]);
    expect(res.headers.get('x-page-count')).toBe('51');
    const pages = pageTexts(Buffer.from(await res.arrayBuffer()));
    expect(pages[50]).toContain('Page 51 Of 51');
    expect(pages[0]).toContain('Page 1 Of 51');
  });
  it('page_label_format is honoured ({n} and {m} replaced)', async () => {
    const pages = pageTexts(Buffer.from(await (await asm([part('main', fx.simple('F', 2))], { page_label_format: 'Pg {n}/{m}' })).arrayBuffer()));
    expect(pages[1]).toContain('Pg 2/2');
  });
  it('markers.not_released=true puts "NOT RELEASED" on every page; false puts it on none', async () => {
    const parts = [part('main', fx.simple('MAIN', 2)), part('outsourced', fx.simple('OUT', 1))];
    const on = pageTexts(Buffer.from(await (await asm(parts, { markers: { plain: false, not_released: true } })).arrayBuffer()));
    expect(on).toHaveLength(3);
    for (const t of on) expect(t).toContain('NOT RELEASED');
    for (const t of pageTexts(Buffer.from(await (await asm(parts)).arrayBuffer()))) expect(t).not.toContain('NOT RELEASED');
  });
  it('the stamp does not remove or reorder the original page content', async () => {
    const pages = pageTexts(Buffer.from(await (await asm([part('main', fx.simple('KEEP', 4))])).arrayBuffer()));
    pages.forEach((t, i) => expect(t).toContain(`KEEP-${i + 1}`));
  });
  it('the real flow: sanitised outsourced bytes (sanitize → assemble) merge and are counted', async () => {
    const { body } = await sanitizeOk(fx.simple('OUTSAN', 2));
    const res = await asm([part('main', fx.simple('MAIN', 2)), { kind: 'outsourced', pdf_base64: body.pdf_base64, sha256: body.sha256 }]);
    expect(res.status).toBe(200);
    const pages = pageTexts(Buffer.from(await res.arrayBuffer()));
    expect(pages).toHaveLength(4);
    expect(pages[3]).toContain('OUTSAN-2');
    expect(pages[3]).toContain('Page 4 Of 4');
  });
  // Review item 2: the label must land inside the visible page whatever the page geometry (AC-04.5 "every page … carries Page N Of M").
  describe('stamp position follows the visible page (CropBox/MediaBox origin and /Rotate)', () => {
    const SLACK = 1; // pt
    const stampedPage = async (pdf: Buffer) => {
      const res = await asm([part('outsourced', pdf)], { markers: { plain: false, not_released: true } });
      expect(res.status).toBe(200);
      return Buffer.from(await res.arrayBuffer());
    };
    const inside = (g: ReturnType<typeof locateText>[number]) => {
      const f = g.found!;
      const [x0, y0, x1, y1] = g.box;
      expect(f.x).toBeGreaterThanOrEqual(x0 - SLACK);
      expect(f.x).toBeLessThanOrEqual(x1 + SLACK);
      expect(f.y).toBeGreaterThanOrEqual(y0 - SLACK);
      expect(f.y).toBeLessThanOrEqual(y1 + SLACK);
    };
    it('fixture sanity: the locator reads a plain page at the bottom-right (and NOT RELEASED bottom-left)', async () => {
      const out = await stampedPage(fx.simple('PLAIN'));
      const [lab] = locateText(out, 'Page 1 Of 1');
      const [nr] = locateText(out, 'NOT RELEASED');
      const s = onScreen(lab!)!;
      expect(s.sx).toBeGreaterThan(s.W / 2);
      expect(s.sy).toBeLessThan(60);
      expect(onScreen(nr!)!.sx).toBeLessThan(s.W / 2);
    });
    it('MediaBox [100 100 712 892] (origin ≠ 0,0): both labels are inside the box, near its bottom edge', async () => {
      const out = await stampedPage(fx.offsetBox('OFF'));
      for (const needle of ['Page 1 Of 1', 'NOT RELEASED']) {
        const [g] = locateText(out, needle);
        expect(g!.found, needle).toBeDefined();
        expect(g!.box).toEqual([100, 100, 712, 892]);
        inside(g!);
        expect(onScreen(g!)!.sy, needle).toBeLessThan(60);
      }
      const s = onScreen(locateText(out, 'Page 1 Of 1')[0]!)!;
      expect(s.sx).toBeGreaterThan(s.W / 2);
    });
    it('CropBox smaller than and offset inside the MediaBox: labels sit inside the CropBox (what is shown)', async () => {
      const out = await stampedPage(fx.offsetBox('CROP', '[0 0 800 1000]', '/CropBox [150 200 650 900]'));
      for (const needle of ['Page 1 Of 1', 'NOT RELEASED']) {
        const [g] = locateText(out, needle);
        expect(g!.found, needle).toBeDefined();
        expect(g!.box).toEqual([150, 200, 650, 900]);
        inside(g!);
        expect(onScreen(g!)!.sy, needle).toBeLessThan(60);
      }
    });
    it.each([90, 180, 270] as const)('/Rotate %i: labels are inside the box, upright on screen, bottom-right and bottom-left', async (angle) => {
      const out = await stampedPage(fx.rotated('ROT', angle));
      const [lab] = locateText(out, 'Page 1 Of 1');
      const [nr] = locateText(out, 'NOT RELEASED');
      for (const g of [lab!, nr!]) {
        expect(g.found).toBeDefined();
        expect(g.rotate).toBe(angle);
        inside(g);
        const s = onScreen(g)!;
        expect(s.dx).toBeGreaterThan(0.99); // reads left-to-right as displayed
        expect(Math.abs(s.dy)).toBeLessThan(0.01);
        expect(s.sy).toBeLessThan(60); // bottom of the displayed page
      }
      const a = onScreen(lab!)!;
      expect(a.sx).toBeGreaterThan(a.W / 2); // "Page N Of M" right
      expect(onScreen(nr!)!.sx).toBeLessThan(a.W / 2); // "NOT RELEASED" left
    });
    it('/Rotate 90 on an offset MediaBox: still inside the box and upright', async () => {
      const out = await stampedPage(fx.rotated('ROFF', 90, '[100 100 712 892]'));
      const [g] = locateText(out, 'Page 1 Of 1');
      expect(g!.found).toBeDefined();
      inside(g!);
      const s = onScreen(g!)!;
      expect(s.dx).toBeGreaterThan(0.99);
      expect(s.sy).toBeLessThan(60);
    });
    it('page numbering stays right across mixed geometries: main + rotated + offset → Page 1/2/3 Of 3', async () => {
      const res = await asm([part('main', fx.simple('M')), part('outsourced', fx.rotated('R', 90)), part('outsourced', fx.offsetBox('O'))]);
      expect(res.status).toBe(200);
      const out = Buffer.from(await res.arrayBuffer());
      pageTexts(out).forEach((t, i) => expect(t).toContain(`Page ${i + 1} Of 3`));
      locateText(out, 'Of 3').forEach((g) => {
        expect(g.found).toBeDefined();
        inside(g);
      });
    });
  });
  it('output carries no /Encrypt and no active content from a clean input', async () => {
    const s = Buffer.from(await (await asm([part('main', fx.simple('C'))])).arrayBuffer()).toString('latin1');
    expect(s).not.toMatch(/\/(Encrypt|JavaScript|JS|EmbeddedFiles?|Launch|OpenAction)\b/);
  });
});

describe('assemble: bad input is rejected, never a 200 and never a 5xx', () => {
  const ok = () => part('main', fx.simple('OK'));
  const rejected = async (res: Response) => {
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(await res.text()).not.toMatch(/stack|\bat .*\(|qpdf|c6t12|\.pdf/i);
  };
  it('empty parts → 4xx', async () => rejected(await asm([])));
  it('missing parts / missing stamp / non-JSON body → 4xx', async () => {
    await rejected(await assemble({ stamp: STAMP }));
    await rejected(await assemble({ parts: [ok()] }));
    await rejected(await fetch(srv.url + '/internal/assemble', { method: 'POST', body: 'not json', headers: { 'content-type': 'application/json', ...auth() } }));
  });
  it('unknown part kind → 4xx', async () => rejected(await asm([{ ...ok(), kind: 'attachment' }])));
  it('sha256 that does not match the bytes → 4xx', async () => rejected(await asm([{ ...ok(), sha256: '0'.repeat(64) }])));
  it('invalid base64 → 4xx', async () => rejected(await asm([{ ...ok(), pdf_base64: '***not*base64***' }])));
  it('a part that is not a PDF → 4xx (assemble re-parses untrusted bytes only inside the sandbox)', async () => rejected(await asm([ok(), part('outsourced', fx.notPdf.html)])));
  it('a truncated or encrypted part → 4xx', async () => {
    await rejected(await asm([ok(), part('outsourced', fx.truncated())]));
    await rejected(await asm([ok(), part('outsourced', fx.encrypted())]));
  });
  it('a stamp format that needs non-ASCII text (Devanagari) → 4xx: the stamper writes ASCII only', async () => {
    await rejected(await asm([ok()], { page_label_format: 'पृष्ठ {n} / {m}' }));
  });
});
