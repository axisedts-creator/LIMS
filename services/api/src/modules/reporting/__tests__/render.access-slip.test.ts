// C6-T40 — RenderPort key `partners.access_slip` (08 Addendum A5.1, CR-C13-014). 02-TRD §7.4 contract cases (6)-(10); 07-SECURITY 4b, 8d.
// Real createRenderPort over the HTTP renderer stand-in of render.helpers.ts (same harness as C6-T36). Synthetic data only.
// ASSUMED API (spec names no option): createRenderPort({ ..., env }) reads env.LIMS_ORIGIN_PORTAL at call time (as createNotificationPort does);
//   portalUrl must start with `${LIMS_ORIGIN_PORTAL}/r/` (02-TRD §7.4, same rule as the `url` message param); no origin configured => fails closed (template_invalid).
// The PDF-text and QR-decode half of case (6) needs the real renderer: services/renderer/src/templates/__tests__/access-slip.test.ts.
import { afterAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SLIP, SLIP_ORIGIN, TOKEN, makeRenderWorld, rejection, sha256hex, touched } from './render.helpers.js';

vi.setConfig({ testTimeout: 30_000 });
const worlds: Awaited<ReturnType<typeof makeRenderWorld>>[] = [];
const world = async (o: Parameters<typeof makeRenderWorld>[0] = {}) => { const w = await makeRenderWorld(o); worlds.push(w); return w; };
afterAll(async () => { await Promise.all(worlds.map((w) => w.stub.close())); });
const slip = (o: Record<string, unknown> = {}) => ({ templateKey: 'partners.access_slip' as const, data: { ...SLIP, ...o }, idempotencyKey: 'slip-1' });

describe('(6) partners.access_slip with valid data → PDF bytes (system actor, second /internal/render shape, nothing stored)', () => {
  it('returns base64 PDF + sha256/byteSize/pageCount; posts template_id partners.access_slip with exactly the slip data', async () => {
    const w = await world();
    const out = await w.port.renderPdf(w.harness.ctxFor('A:system'), slip());
    const bytes = Buffer.from(out.contentBase64, 'base64');
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(out.sha256).toBe(sha256hex(bytes)); expect(out.byteSize).toBe(bytes.length); expect(out.pageCount).toBe(2);
    expect(w.stub.seen).toHaveLength(1);
    const r = w.stub.seen[0]!;
    expect(r.url).toBe('/internal/render'); expect(r.authorization).toBe(`Bearer ${TOKEN}`);
    expect(Object.keys(r.body).sort()).toEqual(['assets', 'data', 'template_id']);
    expect(r.body.template_id).toBe('partners.access_slip');
    expect(r.body.data).toEqual(SLIP);   // portalUrl is passed through unchanged: the renderer draws the QR from it
    expect(touched).toEqual([]);
  });
  it('same idempotencyKey + same data → identical sha256; different data → different sha256', async () => {
    const w = await world();
    const a = await w.port.renderPdf(w.harness.ctxFor('A:system'), slip());
    const b = await w.port.renderPdf(w.harness.ctxFor('A:system'), slip());
    const c = await w.port.renderPdf(w.harness.ctxFor('A:system'), slip({ orderRef: '0001SY000002' }));
    expect(b.sha256).toBe(a.sha256); expect(c.sha256).not.toBe(a.sha256);
  });
});

describe('(7) extra property or missing / mistyped field → reporting.template_invalid, renderer not called', () => {
  const FIELDS = ['tenantDisplayName', 'partnerName', 'patientDisplayName', 'orderRef', 'portalUrl', 'expiresAtLocal', 'issuedAtLocal'] as const;
  it.each(FIELDS)('missing %s', async (f) => {
    const w = await world(); const { [f]: _drop, ...rest } = SLIP;
    const e = await rejection(w.port.renderPdf(w.harness.ctxFor('A:system'), { templateKey: 'partners.access_slip', data: rest, idempotencyKey: 's-1' }));
    expect(e.code).toBe('reporting.template_invalid'); expect(w.stub.seen).toHaveLength(0);
  });
  it.each([
    ['results (no results on a slip)', { results: 'Hb 9.1' }],
    ['patientPhone (no PHI beyond name and order ref)', { patientPhone: '+9779800000000' }],
    ['a case-variant of portalUrl', { portalURL: 'https://portal.invalid/r/x' }],
    ['__proto__-style key', JSON.parse('{"__proto__":{"x":1}}')],
  ])('extra property: %s', async (_n, extra) => {
    const w = await world();
    const e = await rejection(w.port.renderPdf(w.harness.ctxFor('A:system'), slip(extra)));
    expect(e.code).toBe('reporting.template_invalid'); expect(w.stub.seen).toHaveLength(0);
  });
  it.each([[15], [null], [['x']], [{ a: 1 }]])('non-string value %j in orderRef', async (v) => {
    const w = await world();
    const e = await rejection(w.port.renderPdf(w.harness.ctxFor('A:system'), slip({ orderRef: v })));
    expect(e.code).toBe('reporting.template_invalid'); expect(w.stub.seen).toHaveLength(0);
  });
  it('empty data object and array data', async () => {
    const w = await world();
    for (const data of [{}, [SLIP]]) {
      const e = await rejection(w.port.renderPdf(w.harness.ctxFor('A:system'), { templateKey: 'partners.access_slip', data: data as any, idempotencyKey: 's-2' }));
      expect(e.code).toBe('reporting.template_invalid');
    }
    expect(w.stub.seen).toHaveLength(0);
  });
});

describe('(8) portalUrl outside LIMS_ORIGIN_PORTAL + "/r/" → reporting.template_invalid, renderer not called', () => {
  it.each([
    ['other host', 'https://evil.invalid/r/tok0001'],
    ['look-alike host (suffix)', 'https://portal.invalid.evil.invalid/r/tok0001'],
    ['userinfo trick', 'https://portal.invalid@evil.invalid/r/tok0001'],
    ['http instead of https', 'http://portal.invalid/r/tok0001'],
    ['right origin, other path', 'https://portal.invalid/admin/tok0001'],
    ['right origin, path without /r/ segment', 'https://portal.invalid/rx/tok0001'],
    ['origin only', 'https://portal.invalid'],
    ['dot-segment escape', 'https://portal.invalid/r/../admin'],
    ['non-canonical (whitespace)', 'https://portal.invalid/r/tok 0001'],
    ['relative path', '/r/tok0001'],
    ['javascript: scheme', 'javascript:alert(1)'],
    ['data: scheme', 'data:text/html,<script>1</script>'],
    ['empty string', ''],
  ])('%s', async (_n, portalUrl) => {
    const w = await world();
    const e = await rejection(w.port.renderPdf(w.harness.ctxFor('A:system'), slip({ portalUrl })));
    expect(e.code).toBe('reporting.template_invalid'); expect(w.stub.seen).toHaveLength(0);
    if (portalUrl.length > 8) expect(JSON.stringify({ m: e.message, d: e.details, s: e.stack })).not.toContain(portalUrl);   // the rejected URL is not echoed
  });
  it('the allowed prefix passes (origin from env, read at call time)', async () => {
    const w = await world();
    await w.port.renderPdf(w.harness.ctxFor('A:system'), slip({ portalUrl: `${SLIP_ORIGIN}/r/anything-1` }));
    expect(w.stub.seen).toHaveLength(1);
  });
  it('another configured origin: the old origin is now rejected, the new one accepted', async () => {
    const w = await world({ env: { LIMS_ORIGIN_PORTAL: 'https://portal.other.invalid' } });
    const e = await rejection(w.port.renderPdf(w.harness.ctxFor('A:system'), slip()));
    expect(e.code).toBe('reporting.template_invalid');
    await w.port.renderPdf(w.harness.ctxFor('A:system'), slip({ portalUrl: 'https://portal.other.invalid/r/t1' }));
    expect(w.stub.seen).toHaveLength(1);
  });
  it('LIMS_ORIGIN_PORTAL not configured → fails closed (template_invalid), renderer not called', async () => {
    const w = await world({ env: {} });
    const e = await rejection(w.port.renderPdf(w.harness.ctxFor('A:system'), slip()));
    expect(e.code).toBe('reporting.template_invalid'); expect(w.stub.seen).toHaveLength(0);
  });
  it('the origin rule applies to partners.access_slip only (billing.invoice has no portalUrl)', async () => {
    const w = await world({ env: {} });
    const out = await w.port.renderPdf(w.harness.ctxFor('A:system'), { templateKey: 'billing.invoice', data: { invoiceNo: 'SYN-INV-1', patientDisplayName: 'Test Patient 0042', totalText: 'NPR 1.00' }, idempotencyKey: 'i-1' });
    expect(out.byteSize).toBeGreaterThan(0);
  });
});

describe('(10) non-system actor → auth.forbidden (decided first: no schema / origin oracle)', () => {
  it.each(['user', 'device', 'portal', 'patient', 'partner'])('%s actor', async (type) => {
    const w = await world();
    const e = await rejection(w.port.renderPdf(w.harness.ctxFor(`A:${type}`), slip()));
    expect(e.code).toBe('auth.forbidden'); expect(w.stub.seen).toHaveLength(0);
  });
  it('a partner actor with a hostile portalUrl / extra property still gets auth.forbidden', async () => {
    const w = await world();
    const e = await rejection(w.port.renderPdf(w.harness.ctxFor('A:partner'), slip({ portalUrl: 'https://evil.invalid/x', results: 'Hb 9.1' })));
    expect(e.code).toBe('auth.forbidden'); expect(w.stub.seen).toHaveLength(0);
  });
  it('the system actor is the only one that reaches the renderer', async () => {
    const w = await world();
    await w.port.renderPdf(w.harness.ctxFor('A:system'), slip());
    expect(w.stub.seen).toHaveLength(1);
  });
});

describe('(9) log scan — a planted portalUrl appears in no log, error, table or bucket write', () => {
  const PLANT = 'https://portal.invalid/r/PLANT-7c1e9b2a4d5f8e03';
  const NAME = 'Planted Patient Zq9';
  const needles = [PLANT, 'PLANT-7c1e9b2a4d5f8e03', NAME];
  const capture = () => {
    const out: string[] = [];
    const wr = (orig: any) => vi.spyOn(process[orig as 'stdout'], 'write').mockImplementation(((c: any) => { out.push(String(c)); return true; }) as any);
    const spies = [wr('stdout'), wr('stderr'),
      ...(['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map((m) => vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { out.push(JSON.stringify(a)); }))];
    return { out, stop: () => spies.forEach((s) => s.mockRestore()) };
  };

  it.each([
    ['success', 'ok', 'system', 'planted-ok'],
    ['renderer 503', { status: 503 }, 'system', 'planted-503'],
    ['renderer 422', { status: 422 }, 'system', 'planted-422'],
    ['renderer 401', { status: 401 }, 'system', 'planted-401'],
    ['non-system actor', 'ok', 'partner', 'planted-forb'],
  ] as const)('%s: zero hits in stdout / stderr / console, in the error, and no ctx.db / ctx.storage use', async (_n, mode, actor, idem) => {
    const w = await world(); w.stub.setMode(mode as any);
    const cap = capture();
    let outcome = '';
    try {
      try { await w.port.renderPdf(w.harness.ctxFor(`A:${actor}`), { templateKey: 'partners.access_slip', data: { ...SLIP, portalUrl: PLANT, patientDisplayName: NAME }, idempotencyKey: idem }); }
      catch (e: any) { outcome = JSON.stringify({ m: e.message, c: e.code, d: e.details, s: e.stack, k: Object.keys(e) }); }
    } finally { cap.stop(); }
    const hay = cap.out.join('\n') + outcome;
    for (const n of needles) expect(hay, `needle ${n}`).not.toContain(n);
    expect(touched).toEqual([]);
  });
  it('rejected-by-origin and rejected-by-schema paths echo nothing either', async () => {
    const w = await world(); const cap = capture(); const errs: string[] = [];
    try {
      for (const data of [{ ...SLIP, portalUrl: 'https://evil.invalid/r/PLANT-7c1e9b2a4d5f8e03', patientDisplayName: NAME }, { ...SLIP, portalUrl: PLANT, patientDisplayName: NAME, results: 'x' }]) {
        const e = await rejection(w.port.renderPdf(w.harness.ctxFor('A:system'), { templateKey: 'partners.access_slip', data, idempotencyKey: 'planted-bad' }));
        errs.push(JSON.stringify({ m: e.message, d: e.details, s: e.stack }));
      }
    } finally { cap.stop(); }
    const hay = cap.out.join('\n') + errs.join('\n');
    for (const n of needles) expect(hay, `needle ${n}`).not.toContain(n);
  });
  it('the renderer-side request is the only place the URL travels: C6 keeps no copy (no storage, db, fs, logger in the impl)', () => {
    const src = readFileSync(fileURLToPath(new URL('../ports/RenderPort.impl.ts', import.meta.url)), 'utf8');
    expect(src).not.toMatch(/console\.|logger\.|\.log\(|process\.std(out|err)/);
    expect(src).not.toMatch(/ctx\.(storage|db)\b|node:fs|writeFile|createWriteStream/);
  });
});
