// C16.T-P3 — E22 listMyReports + E23 downloadMyReport (patient): projection visibility, superseded listing, PDF stream with sha256 check, access log, 20/hour/link rate limit
// (06-PLAN row T-P3; 02-TRD §5 E22/E23, §6.2 (ReportingPort patient context), §6.7 / 04 §4 (report_download, key l:<link_id>), §9.4 (report.download only when the stream completed);
// 03-APP-FLOW §5.2 (partial failure: no access-log row, counter already counted); 01-PRD US-EN-08.1-5; 07-SECURITY P-L1 / P-L5 / P-L6, "signed URL never leaves the API", E23 row (corrupted file -> sha256)).
// Fails now: handlers/index.ts maps listMyReports / downloadMyReport to the T-01 placeholder (common.service_unavailable).
//
// SEAMS (spec fixes behaviour, not names; same convention as orders.handlers.test.ts):
//   handlers.listMyReports({params:{}, query:{profile_id?, order_id?, include_superseded?, limit?, cursor?}, headers}, ctx) -> {status:200, body:{data:PatientReport[], page:{next_cursor?, limit}}, headers:{cache-control:'no-store'}}
//   handlers.downloadMyReport({params:{report_id, version_no}, query:{}, headers}, ctx) -> {status:200, body:<the PDF bytes: Uint8Array | Buffer | Readable | ReadableStream | AsyncIterable>, headers:{content-type, content-disposition, cache-control, ...}}
//   ctx = world.patientCtx(account, {ports:{..., ReportingPort}, rateLimit}) (actor patient). IdentityPort.assertRole(ctx, {permission}) runs before any query / port call / rate-limit call:
//     E22 'reporting.portal.view', E23 'reporting.portal.download' (NOT engagement.self.read).
//   Reads engagement.patient_reports and the caller's account_patient_links in PLAIN SQL the world's fake can run (link.world.ts header; no JOIN). The world's RLS does NOT narrow patient_reports to the caller's links
//   (PAT_VIS does in real Postgres): the service must filter by the caller's own ACTIVE links and link.visible_from (released_at >= visible_from) itself, and bind tenant_id.
//   E23 order of work: assertRole -> projection row visible (else 404 BEFORE any port call) -> ctx.rateLimit.consume('report_download', `l:${link.id}`) -> ReportingPort.openReleasedReportFile(ctx, {reportId, versionNo}) (patient ctx, same ctx object)
//     -> bytes read from `signedUrl` with the global `fetch` (internal Storage URL; stubbed here with vi.stubGlobal) -> sha256 of the bytes == port.sha256 (hex) -> ctx.audit.access({action:'report.download', entityType:'report', entityId: report_id, outcome:'allowed'}) -> 200.
//   Rate-limit position (before/after the projection check for a foreign account) is not pinned beyond: account B never touches A's counter and never reaches the port.
// NOT pinned (spec silent): integrity-mismatch error code (any 5xx LimsError, no bytes, no access-log row); byteSize check; Content-Length; downloading a superseded version; the exact `detail` of the access-log row; cursor format.
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REPO_ROOT, loadSpec } from '../../../../core/module.js';
import { createRateLimiter, type RateLimitBackend, type RateLimitTier } from '../../../../core/ratelimit/index.js';
import { handlers } from '../../handlers/index.js';
import { ID, TENANT_B, T0, makeLinkWorld, type LinkWorld } from '../../__tests__/link.world.js';

const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/engagement.yaml'));
const requireAjv = createRequire(createRequire(import.meta.url).resolve('@fastify/ajv-compiler'));
const Ajv2020 = requireAjv('ajv/dist/2020.js').default as new (o: object) => any;
const ajv = new Ajv2020({ strict: false, allErrors: true });
const schemaErrors = (name: string, x: unknown): string[] => { const v = ajv.compile({ $ref: `#/components/schemas/${name}`, components: spec.components }); return v(x) ? [] : (v.errors as any[]).map((e) => `${e.instancePath} ${e.message}`); };
const opOf = (id: string): any => { for (const p of Object.values<any>(spec.paths)) for (const m of Object.values<any>(p)) if (m?.operationId === id) return m; };

const PHONE_A = '+99001000001', PHONE_B = '+99001000002';
const X = ID(0x800), Y = ID(0x801), X2 = ID(0x802); // patients: X (A1), Y (A2), X2 (A1, second profile)
const ORDER_X = ID(0x820), ORDER_X2 = ID(0x821), ORDER_Y = ID(0x822);
const DAY = 86_400_000, T = Date.parse(T0);
const iso = (offsetMs: number) => new Date(T + offsetMs).toISOString();
const HDR = { 'x-lims-app-version': '1.0.0', 'x-lims-app-platform': 'android' };
const SIGNED = (reportId: string, v: number) => `https://storage.internal.invalid/reports/${reportId}/${v}.pdf?X-Sig=SECRETSIG${v}`;
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const pdf = (tag: string) => Buffer.from(`%PDF-1.7\n% synthetic report ${tag}\n%%EOF\n`);
const rejection = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as any; } throw new Error('expected a rejection'); };
const shape = (e: any) => ({ code: e.code, statusCode: e.statusCode, detail: e.detail });
const hdr = (res: any, name: string): string | undefined => { const k = Object.keys(res?.headers ?? {}).find((h) => h.toLowerCase() === name.toLowerCase()); return k ? String(res.headers[k]) : undefined; };

/** Bytes of a handler body, whatever the streaming form. */
async function collect(body: any): Promise<Buffer> {
  if (body == null) return Buffer.alloc(0);
  if (typeof body === 'string') return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body);
  const parts: Buffer[] = [];
  if (typeof body.getReader === 'function') { const r = body.getReader(); for (;;) { const { done, value } = await r.read(); if (done) break; parts.push(Buffer.from(value)); } return Buffer.concat(parts); }
  if (typeof body[Symbol.asyncIterator] === 'function') { for await (const c of body) parts.push(Buffer.from(c)); return Buffer.concat(parts); }
  throw new Error(`unsupported body type ${typeof body}`);
}

// ---- in-memory report_download limiter: the REAL core limiter (04 §4: sliding window 20 / 3600 s, key `l:<link_id>`) over a fake backend with its own clock ----------------------------
function makeLimiter() {
  const clock = { s: 0 }; const hits = new Map<string, number[]>(); const calls: Array<{ tier: RateLimitTier; key: string }> = [];
  const backend: RateLimitBackend = {
    async slidingWindow(h, windowSeconds, limit) {
      const live = (hits.get(h) ?? []).filter((x) => x > clock.s - windowSeconds);
      if (live.length >= limit) { hits.set(h, live); return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(live[0]! + windowSeconds - clock.s)) }; }
      live.push(clock.s); hits.set(h, live); return { allowed: true, retryAfterSeconds: 0 };
    },
    async tokenBucket() { return { allowed: true, retryAfterSeconds: 0 }; }, async counter() { return { allowed: true, retryAfterSeconds: 0 }; },
  };
  const real = createRateLimiter({ backend, hmacKey: 'synthetic-test-key' });
  return { clock, calls, rateLimit: { consume: async (tier: RateLimitTier, key: string) => { calls.push({ tier, key }); return real.consume(tier, key); } } };
}

let seq = 0x900;
interface Fx {
  w: LinkWorld; a1: Record<string, any>; a2: Record<string, any>; linkX: Record<string, any>; linkY: Record<string, any>;
  report: (o?: Record<string, any>) => Record<string, any>;
  /** Registers the bytes the fake storage serves for (report, version) and what the fake ReportingPort answers. */
  file: (r: Record<string, any>, o?: { bytes?: Buffer; sha256?: string; storage?: 'ok' | 'down' | 'http500' | 'cut'; portError?: Error }) => Buffer;
  reporting: { calls: Array<{ ctx: any; input: any; at: number }>; fetches: string[] };
  limiter: ReturnType<typeof makeLimiter>;
  ctxOf: (who?: Record<string, any>) => any;
  list: (q?: Record<string, any>, who?: Record<string, any>) => Promise<any>;
  download: (r: { report_id: string; version_no: number }, who?: Record<string, any>) => Promise<any>;
}
const restore: Array<() => void> = [];
afterEach(() => { vi.unstubAllGlobals(); for (const f of restore.splice(0)) f(); });

/** Tenant A: account A1 linked to X (active, visible_from NULL), account A2 linked to Y. Reports are seeded straight into the read model (what T-P1 / backfill write). */
function setup(): Fx {
  const w = makeLinkWorld();
  const a1 = w.seedAccount(PHONE_A), a2 = w.seedAccount(PHONE_B);
  const linkX = w.seedLink(a1['id'], X), linkY = w.seedLink(a2['id'], Y);
  const limiter = makeLimiter();
  const reporting = { calls: [] as Array<{ ctx: any; input: any; at: number }>, fetches: [] as string[] };
  const files = new Map<string, { bytes: Buffer; sha256: string; storage: string; portError?: Error }>();
  const key = (id: unknown, v: unknown) => `${id}:${v}`;
  const port = {
    async openReleasedReportFile(ctx: any, input: { reportId: string; versionNo: number }) {
      reporting.calls.push({ ctx, input: structuredClone(input), at: w.stmts.length });
      const f = files.get(key(input.reportId, input.versionNo));
      if (f?.portError) throw f.portError;
      if (!f || ctx.actor?.type !== 'patient') throw Object.assign(new Error('not found'), { code: 'common.not_found' });
      return { reportVersionId: ID(0xa00), reportId: input.reportId, versionNo: input.versionNo, status: 'valid', contentType: 'application/pdf', byteSize: f.bytes.length, sha256: f.sha256, signedUrl: SIGNED(input.reportId, input.versionNo), expiresAt: iso(300_000) };
    },
  };
  vi.stubGlobal('fetch', async (url: unknown) => {
    const u = String(url); reporting.fetches.push(u);
    const m = /reports\/([^/]+)\/(\d+)\.pdf/.exec(u); const f = m ? files.get(key(m[1], Number(m[2]))) : undefined;
    if (!f || !u.includes('X-Sig=SECRETSIG')) return new Response('forbidden', { status: 403 });
    if (f.storage === 'down') throw new TypeError('fetch failed');
    if (f.storage === 'http500') return new Response('boom', { status: 500 });
    if (f.storage === 'cut') { let sent = false; return new Response(new ReadableStream({ pull(c) { if (!sent) { sent = true; c.enqueue(new Uint8Array(f.bytes.subarray(0, 8))); } else c.error(new Error('connection reset')); } }), { status: 200 }); }
    return new Response(new Uint8Array(f.bytes), { status: 200, headers: { 'content-type': 'application/pdf' } });
  });
  const report = (over: Record<string, any> = {}) => {
    const r: Record<string, any> = { tenant_id: w.tenantId, report_id: ID(++seq), version_no: 1, order_id: ORDER_X, patient_id: X, report_kind: 'final', status: 'valid', released_at: iso(-DAY), supersedes_version_no: null, panel_names: ['Synthetic Lipid Profile'],
      smart_summary_available: false, created_by: ID(0x7aa), updated_by: ID(0x7aa), created_at: w.now(), updated_at: w.now(), ...over };
    w.t['patient_reports']!.push(r); return r;
  };
  const file: Fx['file'] = (r, o = {}) => { const bytes = o.bytes ?? pdf(`${r['report_id']} v${r['version_no']}`); files.set(key(r['report_id'], r['version_no']), { bytes, sha256: o.sha256 ?? sha(bytes), storage: o.storage ?? 'ok', ...(o.portError ? { portError: o.portError } : {}) }); return bytes; };
  const ctxOf = (who: Record<string, any> = a1) => w.patientCtx(who, { ports: { ...w.ports, ReportingPort: port }, rateLimit: limiter.rateLimit });
  const list = (query: Record<string, any> = {}, who: Record<string, any> = a1) => w.inTx(() => (handlers as any).listMyReports({ params: {}, query, headers: { ...HDR } }, ctxOf(who)));
  const download = (r: { report_id: string; version_no: number }, who: Record<string, any> = a1) => w.inTx(() => (handlers as any).downloadMyReport({ params: { report_id: r.report_id, version_no: r.version_no }, query: {}, headers: { ...HDR } }, ctxOf(who)));
  return { w, a1, a2, linkX, linkY, report, file, reporting, limiter, ctxOf, list, download };
}
const ids = (res: any): string[] => res.body.data.map((d: any) => `${d.report_id}/${d.version_no}`);
const idOf = (r: Record<string, any>) => `${r['report_id']}/${r['version_no']}`;
const ref = (r: Record<string, any>) => ({ report_id: r['report_id'] as string, version_no: r['version_no'] as number });

describe('contract sanity (the spec is the source of permission, tier and error codes)', () => {
  it('E22: reporting.portal.view, general tier, no idempotency', () => {
    expect(opOf('listMyReports')).toMatchObject({ 'x-permission': 'reporting.portal.view', 'x-idempotency': 'none', 'x-rate-limit-tier': 'general' });
  });
  it('E23: reporting.portal.download, report_download tier, application/pdf with 404 / 429 / 503 declared', () => {
    const op = opOf('downloadMyReport');
    expect(op).toMatchObject({ 'x-permission': 'reporting.portal.download', 'x-idempotency': 'none', 'x-rate-limit-tier': 'report_download' });
    expect(Object.keys(op.responses)).toEqual(expect.arrayContaining(['200', '404', '429', '503']));
    expect(Object.keys(op.responses['200'].content)).toEqual(['application/pdf']);
    expect(op['x-error-codes']).toEqual(expect.arrayContaining(['common.not_found', 'common.rate_limited', 'common.dependency_unavailable']));
  });
});

describe('guards: the matching permission first, patient actors only', () => {
  const OPS = [['list', 'reporting.portal.view'], ['download', 'reporting.portal.download']] as const;
  for (const [op, permission] of OPS) {
    const run = (f: Fx, r: Record<string, any>, who?: Record<string, any>) => (op === 'list' ? f.list({}, who) : f.download(ref(r), who));
    it(`${op}: assertRole(${permission}) runs before any query, port call or rate-limit call`, async () => {
      const f = setup(); const r = f.report(); f.file(r); await run(f, r);
      const first = f.w.identity.calls[0]!; expect(first.permission).toBe(permission); expect(first.at).toBe(0);
      if (op === 'download') { expect(f.reporting.calls[0]!.at).toBeGreaterThan(0); expect(f.limiter.calls.length).toBe(1); }
    });
    it(`${op}: without ${permission} -> auth.forbidden and no statement, no port call, no fetch, no rate-limit hit, no access log`, async () => {
      const f = setup(); const r = f.report(); f.file(r); f.w.identity.grants = [];
      const e = await rejection(run(f, r)); expect(e.code).toBe('auth.forbidden');
      expect(f.w.stmts).toHaveLength(0); expect(f.reporting.calls).toHaveLength(0); expect(f.reporting.fetches).toHaveLength(0); expect(f.limiter.calls).toHaveLength(0); expect(f.w.audit).toEqual([]);
    });
    it(`${op}: holding only the OTHER report permission is not enough`, async () => {
      const f = setup(); const r = f.report(); f.file(r); f.w.identity.grants = [OPS.find((x) => x[0] !== op)![1]];
      expect((await rejection(run(f, r))).code).toBe('auth.forbidden');
    });
    it(`${op}: a non-patient actor (staff) is refused with auth.forbidden before any query`, async () => {
      const f = setup(); const r = f.report(); f.file(r);
      const staff = f.w.patientCtx(f.a1, { actor: { type: 'user', id: ID(0x7aa) }, rateLimit: f.limiter.rateLimit });
      const req = op === 'list' ? { params: {}, query: {}, headers: { ...HDR } } : { params: ref(r), query: {}, headers: { ...HDR } };
      const e = await rejection(f.w.inTx(() => (handlers as any)[op === 'list' ? 'listMyReports' : 'downloadMyReport'](req, staff))); expect(e.code).toBe('auth.forbidden');
      expect(f.w.stmts).toHaveLength(0); expect(f.reporting.calls).toHaveLength(0);
    });
  }
});

describe('E22 listMyReports (US-EN-08.1, 08.2)', () => {
  it('lists the caller\'s released reports newest first; DTO is schema-valid, profile_id = link id, no patient_id / storage details leak; Cache-Control no-store', async () => {
    const f = setup(); const r1 = f.report({ released_at: iso(-3 * DAY), report_kind: 'partial', panel_names: ['Synthetic CBC'] }), r2 = f.report({ released_at: iso(-1 * DAY), smart_summary_available: true, panel_names: ['Synthetic Lipid Profile', 'Synthetic Glucose'] }), r3 = f.report({ released_at: iso(-2 * DAY), report_kind: 'preliminary' });
    const res = await f.list();
    expect(res.status).toBe(200); expect(ids(res)).toEqual([idOf(r2), idOf(r3), idOf(r1)]);
    for (const d of res.body.data) { expect(schemaErrors('PatientReport', d)).toEqual([]); expect(d.profile_id).toBe(f.linkX['id']); expect(d.status).toBe('valid'); }
    expect(res.body.data[0]).toMatchObject({ report_id: r2['report_id'], version_no: 1, order_id: ORDER_X, kind: 'final', released_at: r2['released_at'], smart_summary_available: true, panel_names: ['Synthetic Lipid Profile', 'Synthetic Glucose'] });
    expect(JSON.stringify(res.body)).not.toMatch(/patient_id|storage|signed|sha256|X-Sig|pdf_object/i);
    expect(hdr(res, 'cache-control')).toMatch(/no-store/i); expect(schemaErrors('PageInfo', res.body.page)).toEqual([]);
  });
  it('an unknown report kind is passed through as stored (x-extensible)', async () => {
    const f = setup(); f.report({ report_kind: 'corrected_copy' }); const res = await f.list();
    expect(res.body.data[0].kind).toBe('corrected_copy'); expect(schemaErrors('PatientReport', res.body.data[0])).toEqual([]);
  });
  it('US-EN-08.2: v2 (amended, supersedes v1) is listed by default; v1 only with include_superseded=true, as `superseded`', async () => {
    const f = setup(); const rid = ID(0x950);
    const v1 = f.report({ report_id: rid, version_no: 1, status: 'superseded', released_at: iso(-3 * DAY) }), v2 = f.report({ report_id: rid, version_no: 2, report_kind: 'amended', supersedes_version_no: 1, released_at: iso(-1 * DAY) });
    const other = f.report({ released_at: iso(-2 * DAY) });
    expect(ids(await f.list())).toEqual([idOf(v2), idOf(other)]);
    expect(ids(await f.list({ include_superseded: false }))).toEqual([idOf(v2), idOf(other)]);
    const all = await f.list({ include_superseded: true }); expect(ids(all)).toEqual([idOf(v2), idOf(other), idOf(v1)]);
    const byId = Object.fromEntries(all.body.data.map((d: any) => [`${d.report_id}/${d.version_no}`, d]));
    expect(byId[idOf(v1)]).toMatchObject({ status: 'superseded' }); expect(byId[idOf(v2)]).toMatchObject({ status: 'valid', kind: 'amended', supersedes_version_no: 1 });
    for (const d of all.body.data) expect(schemaErrors('PatientReport', d)).toEqual([]);
  });
  it('profile_id narrows to one link, order_id to one order; a foreign profile_id never yields foreign reports', async () => {
    const f = setup(); const l2 = f.w.seedLink(f.a1['id'], X2, { relationship: 'child' });
    const a = f.report({ order_id: ORDER_X }), b = f.report({ patient_id: X2, order_id: ORDER_X2, released_at: iso(-2 * DAY) }), c = f.report({ patient_id: Y, order_id: ORDER_Y, released_at: iso(-3 * DAY) });
    expect(ids(await f.list({ profile_id: l2['id'] }))).toEqual([idOf(b)]); expect(ids(await f.list({ profile_id: f.linkX['id'] }))).toEqual([idOf(a)]);
    expect(ids(await f.list({ order_id: ORDER_X2 }))).toEqual([idOf(b)]); expect(ids(await f.list())).toEqual([idOf(a), idOf(b)]);
    expect(ids(await f.list({ order_id: ORDER_Y }))).toEqual([]);
    let leaked: string[] = []; try { leaked = ids(await f.list({ profile_id: f.linkY['id'] })); } catch (e: any) { expect(e.code).toBe('common.not_found'); }
    expect(leaked).toEqual([]); expect(leaked).not.toContain(idOf(c));
  });
  it('P-L1: account A2 (not linked to X) lists nothing of X; its own reports only', async () => {
    const f = setup(); const x = f.report(), y = f.report({ patient_id: Y, order_id: ORDER_Y });
    const res = await f.list({}, f.a2); expect(ids(res)).toEqual([idOf(y)]); expect(JSON.stringify(res.body)).not.toContain(String(x['report_id']));
  });
  it('rows of another tenant are never listed, even with a matching patient id (REQ-SEC-024)', async () => {
    const f = setup(); const mine = f.report(); f.report({ tenant_id: TENANT_B, report_id: ID(0x990) });
    expect(ids(await f.list({ include_superseded: true }))).toEqual([idOf(mine)]);
  });
  it('visible_from (P-L6): released 1 ms before is hidden, released at visible_from is shown (>=)', async () => {
    const f = setup(); f.linkX['visible_from'] = iso(-10 * DAY);
    const before = f.report({ released_at: new Date(T - 10 * DAY - 1).toISOString() }), edge = f.report({ released_at: iso(-10 * DAY) }), after = f.report({ released_at: iso(-5 * DAY) });
    const res = await f.list(); expect(ids(res)).toEqual([idOf(after), idOf(edge)]); expect(ids(res)).not.toContain(idOf(before));
  });
  it('suspended and revoked links hide that patient\'s reports (P-L5; 03-APP-FLOW §3.4)', async () => {
    const f = setup(); f.report(); const g = setup(); g.report();
    Object.assign(f.linkX, { status: 'suspended', suspend_reason: 'phone_mismatch', suspended_at: f.w.now() });
    Object.assign(g.linkX, { status: 'revoked', revoked_by_kind: 'patient', revoked_at: g.w.now(), is_active: false });
    for (const x of [f, g]) { let got: string[] = []; try { got = ids(await x.list()); } catch (e: any) { expect(['common.not_found', 'auth.forbidden']).toContain(e.code); } expect(got).toEqual([]); }
  });
  it('keyset paging: limit 2 over 5 reports walks every report once, newest first', async () => {
    const f = setup(); const all = [1, 2, 3, 4, 5].map((n) => f.report({ released_at: iso(-n * DAY) }));
    const seen: string[] = []; let cursor: string | undefined; let pages = 0;
    do { const res: any = await f.list({ limit: 2, ...(cursor ? { cursor } : {}) }); expect(res.body.data.length).toBeLessThanOrEqual(2); expect(res.body.page.limit).toBe(2); seen.push(...ids(res)); cursor = res.body.page.next_cursor; pages++; } while (cursor && pages < 10);
    expect(seen).toEqual(all.map(idOf)); expect(pages).toBe(3);
  });
  it('same released_at: ties are ordered stably and no report is skipped or repeated across a page boundary', async () => {
    const f = setup(); const same = iso(-DAY); const rows = [f.report({ released_at: same }), f.report({ released_at: same }), f.report({ released_at: same })];
    const first = await f.list({ limit: 2 }); const second = await f.list({ limit: 2, cursor: first.body.page.next_cursor });
    expect([...ids(first), ...ids(second)].sort()).toEqual(rows.map(idOf).sort());
  });
  it('is read-only and uses no port: no INSERT / UPDATE / DELETE, no access_log, no job, no ReportingPort call, no report_download hit; every read of the read model binds tenant_id', async () => {
    const f = setup(); const r = f.report(); f.file(r); await f.list();
    expect(f.w.writes()).toEqual([]); expect(f.w.audit).toEqual([]); expect(f.w.jobs()).toEqual([]); expect(f.reporting.calls).toEqual([]); expect(f.reporting.fetches).toEqual([]); expect(f.limiter.calls).toEqual([]);
    const reads = f.w.stmts.filter((s) => /patient_reports|account_patient_links/.test(s.text)); expect(reads.length).toBeGreaterThan(0);
    for (const s of reads) expect(s.text, s.text).toMatch(/tenant_id/);
  });
});

describe('E23 downloadMyReport: the stream (US-EN-08.3)', () => {
  it('streams the PDF bytes with the TRD headers and writes ONE access_log row report.download after the stream completed', async () => {
    const f = setup(); const r = f.report({ version_no: 2, supersedes_version_no: 1, report_kind: 'amended' }); const bytes = f.file(r);
    const res = await f.download(ref(r));
    expect(res.status).toBe(200);
    expect(hdr(res, 'content-type')).toMatch(/^application\/pdf\b/i);
    expect(hdr(res, 'content-disposition')).toMatch(/^attachment;\s*filename="report-2\.pdf"/); // TRD §5 E23: report-<version_no>.pdf
    expect(hdr(res, 'cache-control')).toMatch(/no-store/i);
    expect(hdr(res, 'x-content-type-options')).toBe('nosniff'); // 08 A13 P-2 download rules (core ctx.download.stream sets the same)
    expect((await collect(res.body)).equals(bytes)).toBe(true);
    expect(f.w.audit).toHaveLength(1);
    expect(f.w.audit[0]).toMatchObject({ action: 'report.download', entityType: 'report', entityId: r['report_id'], outcome: 'allowed' });
  });
  it('calls ReportingPort.openReleasedReportFile once, under the PATIENT context, with {reportId, versionNo}; the signed URL is fetched server-side only', async () => {
    const f = setup(); const r = f.report(); f.file(r); await f.download(ref(r));
    expect(f.reporting.calls).toHaveLength(1); expect(f.reporting.calls[0]!.input).toEqual({ reportId: r['report_id'], versionNo: 1 });
    expect(f.reporting.calls[0]!.ctx.actor.type).toBe('patient'); expect(f.reporting.calls[0]!.ctx.claims.membership_id).toBe(f.a1['membership_id']);
    expect(f.reporting.fetches).toEqual([SIGNED(r['report_id'], 1)]);
  });
  it('the signed URL never leaves the API: not in headers, body, access log, logs or metric labels (REQ-SEC-034/035; 07 §6.6)', async () => {
    const f = setup(); const r = f.report(); f.file(r); const res = await f.download(ref(r)); const body = (await collect(res.body)).toString('latin1');
    for (const s of [JSON.stringify(res.headers), body, f.w.observed()]) expect(s).not.toMatch(/storage\.internal|X-Sig|SECRETSIG|signedUrl/i);
    expect(JSON.stringify(res.headers)).not.toMatch(/location/i);
  });
  it('metric lims_engagement_report_downloads_total{outcome="ok"} on success; labels carry no ids', async () => {
    const f = setup(); const r = f.report(); f.file(r); await f.download(ref(r));
    const m = f.w.metricCalls.filter((c) => c.name === 'lims_engagement_report_downloads_total'); expect(m).toHaveLength(1); expect(m[0]!.labels).toEqual({ outcome: 'ok' });
  });
  it('sha256 mismatch (corrupted file): rejected with a 5xx error, NO bytes, NO access_log row, no commitOnError (07 E23 row)', async () => {
    const f = setup(); const r = f.report(); f.file(r, { sha256: sha(Buffer.from('some other file')) });
    const e = await rejection((async () => { const res = await f.download(ref(r)); await collect(res.body); return res; })());
    expect(['common.dependency_unavailable', 'common.internal']).toContain(e.code); expect(e.statusCode).toBeGreaterThanOrEqual(500); // not the T-01 placeholder: the file was really fetched and checked
    expect(f.reporting.calls).toHaveLength(1); expect(f.reporting.fetches).toHaveLength(1); expect(f.w.audit).toEqual([]); expect(f.w.commit.calls).toBe(0);
    expect(f.w.metricCalls.filter((c) => c.name === 'lims_engagement_report_downloads_total').every((c) => c.labels['outcome'] !== 'ok')).toBe(true);
  });
  it('a truncated file (bytes shorter than the digest was computed over) is also refused', async () => {
    const f = setup(); const r = f.report(); const full = pdf('full'); f.file(r, { bytes: full.subarray(0, 12), sha256: sha(full) });
    const e = await rejection((async () => { const res = await f.download(ref(r)); await collect(res.body); })()); expect(e.code).not.toBe('common.service_unavailable');
    expect(f.reporting.fetches).toHaveLength(1); expect(f.w.audit).toEqual([]);
  });
  it('storage unreachable -> 503 common.dependency_unavailable, no access_log row', async () => {
    for (const mode of ['down', 'http500'] as const) {
      const f = setup(); const r = f.report(); f.file(r, { storage: mode });
      const e = await rejection((async () => { const res = await f.download(ref(r)); await collect(res.body); })()); expect(e.code, mode).toBe('common.dependency_unavailable'); expect(e.statusCode).toBe(503); expect(f.w.audit).toEqual([]);
    }
  });
  it('the port reporting a storage error -> 503 common.dependency_unavailable (TRD §6.2 error table)', async () => {
    const f = setup(); const r = f.report(); f.file(r, { portError: Object.assign(new Error('storage'), { code: 'common.dependency_unavailable' }) });
    const e = await rejection(f.download(ref(r))); expect(e.code).toBe('common.dependency_unavailable'); expect(f.w.audit).toEqual([]);
  });
  it('the connection dying mid-stream aborts the response: no access_log row is committed for an unfinished download (03-APP-FLOW §5.2)', async () => {
    const f = setup(); const r = f.report(); f.file(r, { storage: 'cut' });
    const e = await rejection((async () => { const res = await f.download(ref(r)); await collect(res.body); })()); expect(e.code).not.toBe('common.service_unavailable');
    expect(f.reporting.fetches).toHaveLength(1); expect(f.w.audit).toEqual([]); expect(f.w.commit.calls).toBe(0);
  });
  it('the port answering common.not_found (e.g. report not in the patient\'s C6 policy) -> 404 common.not_found, no bytes, no access_log row', async () => {
    const f = setup(); const r = f.report(); f.file(r, { portError: Object.assign(new Error('nf'), { code: 'common.not_found' }) });
    const e = await rejection(f.download(ref(r))); expect(e.code).toBe('common.not_found'); expect(e.statusCode).toBe(404); expect(f.reporting.fetches).toEqual([]); expect(f.w.audit).toEqual([]);
  });
  it('the download writes only the access log: no UPDATE / DELETE, no job; the projection row is untouched', async () => {
    const f = setup(); const r = f.report(); f.file(r); const before = JSON.stringify(r); await f.download(ref(r));
    expect(f.w.writes()).toEqual([]); expect(f.w.jobs()).toEqual([]); expect(JSON.stringify(r)).toBe(before);
  });
});

describe('E23 downloadMyReport: who may fetch (US-EN-08.5; P-L1, P-L5, P-L6)', () => {
  it('account B (not linked to the patient) -> 404 common.not_found; ReportingPort, storage and the access log are never touched; A\'s counter is untouched', async () => {
    const f = setup(); const r = f.report(); f.file(r);
    const e = await rejection(f.download(ref(r), f.a2)); expect(e.code).toBe('common.not_found'); expect(e.statusCode).toBe(404);
    expect(f.reporting.calls).toEqual([]); expect(f.reporting.fetches).toEqual([]); expect(f.w.audit).toEqual([]); expect(f.limiter.calls.some((c) => c.key === `l:${f.linkX['id']}`)).toBe(false);
  });
  it('404 is identical for: unlinked account, unknown report id, unknown version, other tenant\'s report (no enumeration)', async () => {
    const f = setup(); const r = f.report(); f.file(r); const foreign = f.report({ tenant_id: TENANT_B, report_id: ID(0x991) }); f.file(foreign);
    const shapes = [
      shape(await rejection(f.download(ref(r), f.a2))), shape(await rejection(f.download({ report_id: ID(0x992), version_no: 1 }))),
      shape(await rejection(f.download({ report_id: r['report_id'], version_no: 7 }))), shape(await rejection(f.download(ref(foreign)))),
    ];
    for (const s of shapes) expect(s).toEqual(shapes[0]); expect(shapes[0]).toMatchObject({ code: 'common.not_found', statusCode: 404 });
    expect(f.reporting.calls).toEqual([]);
  });
  it('a report of ANOTHER linked profile of the same account is allowed (A1 has X and X2)', async () => {
    const f = setup(); f.w.seedLink(f.a1['id'], X2, { relationship: 'child' }); const r = f.report({ patient_id: X2, order_id: ORDER_X2 }); const bytes = f.file(r);
    const res = await f.download(ref(r)); expect((await collect(res.body)).equals(bytes)).toBe(true);
  });
  it('suspended / revoked link -> 404 for every download (P-L5), nothing leaves the API', async () => {
    const f = setup(); const r = f.report(); f.file(r); const g = setup(); const r2 = g.report(); g.file(r2);
    Object.assign(f.linkX, { status: 'suspended', suspend_reason: 'phone_mismatch', suspended_at: f.w.now() });
    Object.assign(g.linkX, { status: 'revoked', revoked_by_kind: 'patient', revoked_at: g.w.now(), is_active: false });
    for (const [x, rr] of [[f, r], [g, r2]] as const) { const e = await rejection(x.download(ref(rr))); expect(e.code).toBe('common.not_found'); expect(x.reporting.calls).toEqual([]); expect(x.reporting.fetches).toEqual([]); expect(x.w.audit).toEqual([]); }
  });
  it('visible_from (P-L6): a report released 1 ms before is 404, one released at visible_from is downloadable', async () => {
    const f = setup(); f.linkX['visible_from'] = iso(-10 * DAY);
    const before = f.report({ released_at: new Date(T - 10 * DAY - 1).toISOString() }), edge = f.report({ released_at: iso(-10 * DAY) }); f.file(before); const bytes = f.file(edge);
    expect((await rejection(f.download(ref(before)))).code).toBe('common.not_found'); expect(f.reporting.calls).toEqual([]);
    expect((await collect((await f.download(ref(edge))).body)).equals(bytes)).toBe(true);
  });
  it('every read of the read model binds tenant_id (REQ-SEC-024)', async () => {
    const f = setup(); const r = f.report(); f.file(r); await f.download(ref(r));
    const reads = f.w.stmts.filter((s) => /patient_reports|account_patient_links/.test(s.text)); expect(reads.length).toBeGreaterThan(0);
    for (const s of reads) expect(s.text, s.text).toMatch(/tenant_id/);
  });
});

describe('E23 downloadMyReport: report_download rate limit, 20 / hour / link (US-EN-08.4; 04 §4; REQ-SEC-078)', () => {
  it('downloads 1..20 succeed, the 21st -> 429 common.rate_limited with a Retry-After of 1..3600 s; the 21st reaches neither port nor storage', async () => {
    const f = setup(); const r = f.report(); f.file(r);
    for (let i = 1; i <= 20; i++) { const res = await f.download(ref(r)); expect(res.status, `download ${i}`).toBe(200); await collect(res.body); }
    expect(f.reporting.calls).toHaveLength(20); expect(f.w.audit).toHaveLength(20);
    const e = await rejection(f.download(ref(r))); expect(e.code).toBe('common.rate_limited'); expect(e.statusCode).toBe(429);
    expect(e.retryAfterSeconds).toBeGreaterThanOrEqual(1); expect(e.retryAfterSeconds).toBeLessThanOrEqual(3600);
    expect(f.reporting.calls).toHaveLength(20); expect(f.reporting.fetches).toHaveLength(20); expect(f.w.audit).toHaveLength(20);
  });
  it('uses tier report_download and key `l:<link_id>` (the link, not the account, the report or the patient)', async () => {
    const f = setup(); const r = f.report(); f.file(r); await f.download(ref(r));
    expect(f.limiter.calls).toEqual([{ tier: 'report_download', key: `l:${f.linkX['id']}` }]);
  });
  it('the counter is per link: another account is unaffected, and so is another profile (link) of the same account', async () => {
    const f = setup(); const l2 = f.w.seedLink(f.a1['id'], X2, { relationship: 'child' });
    const r = f.report(); f.file(r); const r2 = f.report({ patient_id: X2, order_id: ORDER_X2 }); f.file(r2); const ry = f.report({ patient_id: Y, order_id: ORDER_Y }); f.file(ry);
    for (let i = 0; i < 20; i++) await collect((await f.download(ref(r))).body);
    expect((await rejection(f.download(ref(r)))).code).toBe('common.rate_limited');
    expect((await f.download(ref(r2))).status).toBe(200); expect((await f.download(ref(ry), f.a2)).status).toBe(200);
    expect(f.limiter.calls.at(-2)).toEqual({ tier: 'report_download', key: `l:${l2['id']}` }); expect(f.limiter.calls.at(-1)).toEqual({ tier: 'report_download', key: `l:${f.linkY['id']}` });
  });
  it('the window slides: after an hour the link may download again', async () => {
    const f = setup(); const r = f.report(); f.file(r);
    for (let i = 0; i < 20; i++) await collect((await f.download(ref(r))).body);
    expect((await rejection(f.download(ref(r)))).code).toBe('common.rate_limited');
    f.limiter.clock.s += 3601; expect((await f.download(ref(r))).status).toBe(200);
  });
  it('failed attempts count (03-APP-FLOW §5.2: "the counter has already counted the attempt"): 20 corrupted downloads exhaust the hour', async () => {
    const f = setup(); const bad = f.report(); f.file(bad, { sha256: sha(Buffer.from('x')) }); const good = f.report(); f.file(good);
    for (let i = 0; i < 20; i++) await rejection((async () => { await collect((await f.download(ref(bad))).body); })());
    expect((await rejection(f.download(ref(good)))).code).toBe('common.rate_limited');
  });
  it('the rate-limit backend being down fails CLOSED for this tier (REQ-SEC-078): 503 common.dependency_unavailable, no bytes', async () => {
    const f = setup(); const r = f.report(); f.file(r);
    const down = createRateLimiter({ backend: { slidingWindow: async () => { throw new Error('redis down'); }, tokenBucket: async () => { throw new Error('x'); }, counter: async () => { throw new Error('x'); } }, hmacKey: 'k' });
    const ctx = f.ctxOf(); ctx.rateLimit = down;
    const e = await rejection(f.w.inTx(() => (handlers as any).downloadMyReport({ params: ref(r), query: {}, headers: { ...HDR } }, ctx))); expect(e.code).toBe('common.dependency_unavailable'); expect(f.reporting.calls).toEqual([]);
  });
  it('E22 listing is NOT under the download tier: 25 lists never hit report_download', async () => {
    const f = setup(); f.report(); for (let i = 0; i < 25; i++) await f.list();
    expect(f.limiter.calls.filter((c) => c.tier === 'report_download')).toEqual([]);
  });
});
