// C8 AN-T15 — exports API: createAnalyticsExport #20, listAnalyticsExports #21, getAnalyticsExport #22, downloadAnalyticsExport #23.
// PRD US-17.1/.2/.4/.5/.6/.7/.8, US-15.1/15.2/15.4; 02-TRD §10.1, §10.3, §5 #20–#23; 07-SECURITY E1–E4, E7, P9, X2, X3, abuse cases 2/4/5; CR-C8-002 codes.
// Emulators + pinned seams: ./t15.helpers.ts and ../../export/__tests__/sqlFake.ts. Handlers/services are real.
// Assumptions pinned (writer may dispute via the reviewer): scope snapshot = the REQUEST's resolved scope; list page = {data: ExportDto[]}; a refused request writes no
// export row, no job and no access_log row; the BFF/core handles Idempotency-Key (not tested here).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isLimsError } from '../../../../core/errors.js';
import {
  A1, A2, B1, FINANCE, HOUR, LAB_MANAGER, MEMBER, NO_PERM, OWNER, OWNER_A1, OWNER_AAL1, OWNER_REVOKED, PARTNER, PARAMS, SHA, TA, TB,
  callExp, contractErrors, createBody, db15, exportId, expectLims, makeCtx15, okExp, rejection, seedQuota, seedReady,
} from './t15.helpers.js';
import { iso } from '../../export/__tests__/sqlFake.js';

beforeEach(() => { db15.reset(); vi.clearAllMocks(); });
afterEach(() => { delete process.env.LIMS_ANALYTICS_PDF_ENABLED; });

const untouched = () => { expect(db15.exports.size).toBe(0); expect(db15.jobs).toEqual([]); expect(db15.log).toEqual([]); };
const create = (ctx: any, body: unknown = createBody()) => callExp('createAnalyticsExport', ctx, { body });
const download = (ctx: any, n: number) => callExp('downloadAnalyticsExport', ctx, { params: { export_id: exportId(n) } });
const codeOf = async (p: Promise<unknown>) => { const e: any = await rejection(p); return e?.code as string; };

// ============================================================================================================== #20 create
describe('createAnalyticsExport — gate order (E1, REQ-SEC-062/067/100)', () => {
  it.each([['no permission', NO_PERM], ['partner', PARTNER], ['finance (no analytics.data.export)', FINANCE], ['lab_manager', LAB_MANAGER], ['owner with deactivated membership', OWNER_REVOKED]])(
    '%s -> 403 auth.forbidden before anything is read, written or logged', async (_n, who) => {
      const c = await makeCtx15(who);
      await expectLims(create(c.ctx), 'auth.forbidden', 403);
      untouched(); expect(c.entries).toEqual([]); expect(c.accessRows).toEqual([]);
      expect(c.assertRole.mock.calls[0]![1]).toEqual({ permission: 'analytics.data.export' });
    });

  it('owner at aal1 -> 403 auth.mfa_required; nothing written', async () => {
    const c = await makeCtx15(OWNER_AAL1);
    await expectLims(create(c.ctx), 'auth.mfa_required', 403);
    untouched(); expect(c.entries).toEqual([]);
  });

  it('a non-holder who also sends garbage still gets auth.forbidden (nothing is validated for strangers)', async () => {
    const c = await makeCtx15(NO_PERM);
    await expectLims(create(c.ctx, { report_code: 42, extra: 1 }), 'auth.forbidden', 403);
  });
});

describe('createAnalyticsExport — report permission (P-10 conditional) and registry', () => {
  it('asserts analytics.data.export FIRST, then the report permission of the registry entry named in the body', async () => {
    for (const [code, perm, opts] of [['income', 'analytics.dashboard.read', {}], ['collections', 'analytics.collections.read', {}], ['referral_incentive', 'analytics.referral_report.read', { flag: true }]] as const) {
      db15.reset(); vi.clearAllMocks();
      const c = await makeCtx15(OWNER, opts);
      await okExp('createAnalyticsExport', c.ctx, { body: createBody({ report_code: code }) }, 202);
      const perms = c.assertRole.mock.calls.map((x: any) => x[1].permission);
      expect(perms[0], code).toBe('analytics.data.export');
      expect(perms, code).toContain(perm);
    }
  });

  it.each(['no_such_report', '__proto__', 'constructor', 'INCOME', ''])('unknown report_code %j -> 404 analytics.report_unknown; no row, no job', async (code) => {
    const c = await makeCtx15(OWNER);
    const code2 = await codeOf(create(c.ctx, createBody({ report_code: code })));
    expect(['analytics.report_unknown', 'common.validation_failed']).toContain(code2);   // '' violates the body schema's minLength, the rest are unknown codes
    if (code !== '') expect(code2).toBe('analytics.report_unknown');
    untouched();
  });

  it('referral_incentive with the tenant flag OFF -> 403 common.feature_disabled; no row, no job, no log (E7)', async () => {
    for (const flag of [undefined, false]) {
      db15.reset();
      const c = await makeCtx15(OWNER, { flag });
      await expectLims(create(c.ctx, createBody({ report_code: 'referral_incentive' })), 'common.feature_disabled', 403);
      untouched(); expect(c.entries).toEqual([]);
    }
  });

  it('format pdf while RenderPort is not registered (LIMS_ANALYTICS_PDF_ENABLED unset) -> 403 common.feature_disabled (US-17.4)', async () => {
    const c = await makeCtx15(OWNER);
    await expectLims(create(c.ctx, createBody({ format: 'pdf' })), 'common.feature_disabled', 403);
    untouched();
  });

  it('format pdf is accepted once the feature is enabled', async () => {
    process.env.LIMS_ANALYTICS_PDF_ENABLED = 'true';
    const c = await makeCtx15(OWNER);
    const r = await okExp('createAnalyticsExport', c.ctx, { body: createBody({ format: 'pdf' }) }, 202);
    expect(r.body.format).toBe('pdf');
  });
});

describe('createAnalyticsExport — request handling (US-17.1, TRD §10.1 step 4/6)', () => {
  it('202 ExportDto status queued, 3 downloads allowed, contract-valid, no file/size/hash fields', async () => {
    const c = await makeCtx15(OWNER);
    const r = await okExp('createAnalyticsExport', c.ctx, { body: createBody() }, 202);
    expect(contractErrors('ExportDto', r.body)).toEqual([]);
    expect(r.body).toMatchObject({ report_code: 'income', format: 'xlsx', status: 'queued', downloads_used: 0, downloads_allowed: 3, params: PARAMS });
    for (const k of ['sha256', 'content', 'scope_centre_ids', 'requested_by_membership_id', 'tenant_id']) expect(r.body).not.toHaveProperty(k);
  });

  it('inserts the row (queued, snapshot scope, params, created_by), then writes the access log, then enqueues analytics.build_export keyed by the export id', async () => {
    const c = await makeCtx15(OWNER);
    const r = await okExp('createAnalyticsExport', c.ctx, { body: createBody({ format: 'csv' }) }, 202);
    const row = db15.exports.get(r.body.id)!;
    expect(row).toMatchObject({ tenant_id: TA, requested_by_membership_id: MEMBER[OWNER], report_code: 'income', format: 'csv', status: 'queued', scope_all_centres: true, downloads_allowed: 3, downloads_used: 0 });
    expect(row.scope_centre_ids).toEqual([]);
    expect(row.params).toEqual(PARAMS);
    expect(row.created_by).toBe(c.ctx.actor.id);
    expect(db15.jobs).toEqual([{ identifier: 'analytics.build_export', payload: { tenant_id: TA, export_id: r.body.id }, jobKey: r.body.id }]);
    expect(db15.events.filter((e) => /insert:exports|audit:request|enqueue/.test(e))).toEqual(['insert:exports', 'audit:request', 'enqueue']);
  });

  it('access log: exactly one data.export entry {report_code, format, phase:request, from, to}; ids/codes/dates only (E4)', async () => {
    const c = await makeCtx15(OWNER);
    const r = await okExp('createAnalyticsExport', c.ctx, { body: createBody() }, 202);
    expect(c.entries).toHaveLength(1);
    expect(c.entries[0]).toMatchObject({ action: 'data.export', entityType: 'analytics_export', entityId: r.body.id, outcome: 'allowed' });
    expect(c.entries[0].detail).toEqual({ report_code: 'income', format: 'xlsx', phase: 'request', from: PARAMS.business_date_from, to: PARAMS.business_date_to });
    expect(c.accessRows).toHaveLength(1);
  });

  it('a centre-restricted requester gets a snapshot of exactly their centres (US-15.1/15.5 input)', async () => {
    const c = await makeCtx15(OWNER_A1);
    const r = await okExp('createAnalyticsExport', c.ctx, { body: createBody() }, 202);
    expect(db15.exports.get(r.body.id)).toMatchObject({ scope_all_centres: false, scope_centre_ids: [A1] });
  });

  it('an all-centre requester who names a centre exports only that centre (snapshot = resolved scope)', async () => {
    const c = await makeCtx15(OWNER);
    const r = await okExp('createAnalyticsExport', c.ctx, { body: createBody({ params: { ...PARAMS, centre_id: [A2] } }) }, 202);
    expect(db15.exports.get(r.body.id)).toMatchObject({ scope_all_centres: false, scope_centre_ids: [A2] });
  });

  it.each([['another centre of the tenant (outside the caller scope)', A2, OWNER_A1], ['a centre of tenant B', B1, OWNER]])(
    'centre_id = %s -> 404 common.not_found (no existence oracle, US-15.2); nothing written', async (_n, centre, who) => {
      const c = await makeCtx15(who);
      await expectLims(create(c.ctx, createBody({ params: { ...PARAMS, centre_id: [centre] } })), 'common.not_found', 404);
      untouched(); expect(c.entries).toEqual([]);
    });

  it('range > 366 days -> analytics.range_too_large; nothing written (US-17.6)', async () => {
    const c = await makeCtx15(OWNER);
    const code = await codeOf(create(c.ctx, createBody({ params: { business_date_from: '2025-01-01', business_date_to: '2026-11-05' } })));
    expect(code).toBe('analytics.range_too_large');
    untouched();
  });

  it.each([
    ['unknown top-level field', { ...createBody(), extra: 1 }], ['unknown params field', createBody({ params: { ...PARAMS, extra: 1 } })], ['format docx', createBody({ format: 'docx' })],
    ['missing params', { report_code: 'income', format: 'csv' }], ['non-string report_code', createBody({ report_code: 42 })], ['body is an array', []], ['no body', undefined],
  ])('%s -> 400 common.validation_failed (X2); nothing written', async (_n, body) => {
    const c = await makeCtx15(OWNER);
    expect(await codeOf(callExp('createAnalyticsExport', c.ctx, { body }))).toBe('common.validation_failed'); // direct call: `create` would swap undefined for the default valid body
    untouched();
  });
});

// ============================================================================================================== quota (US-17.5)
describe('createAnalyticsExport — quota: 10 per user per rolling hour, 50 per tenant per business day (X16, E2)', () => {
  it('the 10th export in the hour is accepted, the 11th -> 429 common.rate_limited with Retry-After = seconds until the oldest falls out of the hour', async () => {
    const c9 = await makeCtx15(OWNER);
    seedQuota(9, OWNER, (i) => 40 - i * 3);
    await okExp('createAnalyticsExport', c9.ctx, { body: createBody() }, 202);     // the 10th
    const c11 = await makeCtx15(OWNER);
    const e: any = await expectLims(create(c11.ctx), 'common.rate_limited', 429);
    expect(e.retryAfterSeconds).toBeGreaterThanOrEqual(1199);                       // oldest = 40 min ago -> 20 min left
    expect(e.retryAfterSeconds).toBeLessThanOrEqual(1201);
    expect(db15.exports.size).toBe(10); expect(db15.jobs).toHaveLength(1); expect(c11.entries).toEqual([]);
  });

  it('exports older than one hour, other users\' exports and other tenants\' exports do not count towards the user quota', async () => {
    seedQuota(10, OWNER, (i) => 61 + i);                  // all older than 1 h
    seedQuota(10, OWNER_A1, (i) => 5 + i);                // someone else
    seedQuota(10, OWNER, (i) => 5 + i, TB);               // same membership id in another tenant
    const c = await makeCtx15(OWNER);
    await okExp('createAnalyticsExport', c.ctx, { body: createBody() }, 202);
  });

  it('a refused (quota) request writes nothing: no row, no job, no access_log', async () => {
    seedQuota(10, OWNER, (i) => 10 + i);
    const before = db15.exports.size;
    const c = await makeCtx15(OWNER);
    await expectLims(create(c.ctx), 'common.rate_limited', 429);
    expect(db15.exports.size).toBe(before); expect(db15.jobs).toEqual([]); expect(c.accessRows).toEqual([]);
  });

  it('tenant quota: 50 exports on the business day (any users) -> 429 for everyone; 49 -> the 50th is accepted', async () => {
    seedQuota(24, OWNER_A1, (i) => 120 + i); seedQuota(25, FINANCE, (i) => 150 + i);     // 49 today (local), none in the last hour
    const ok = await makeCtx15(OWNER);
    await okExp('createAnalyticsExport', ok.ctx, { body: createBody() }, 202);          // 50th
    const c = await makeCtx15(OWNER);
    const e: any = await expectLims(create(c.ctx), 'common.rate_limited', 429);        // 51st
    expect(e.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('tenant quota counts the Asia/Kathmandu business day: yesterday\'s exports do not count', async () => {
    seedQuota(25, OWNER_A1, (i) => 800 + i); seedQuota(30, FINANCE, (i) => 900 + i);    // 13:20+ h ago = yesterday local (now = 11:45 local)
    const c = await makeCtx15(OWNER);
    await okExp('createAnalyticsExport', c.ctx, { body: createBody() }, 202);
  });

  it('X16 race: two parallel requests with 9 already in the hour -> exactly one accepted, one 429; 10 rows, 1 job', async () => {
    seedQuota(9, OWNER, (i) => 30 - i);
    const [a, b] = await Promise.all([makeCtx15(OWNER), makeCtx15(OWNER)]);
    const out = await Promise.allSettled([create(a.ctx), create(b.ctx)]);
    const ok = out.filter((o) => o.status === 'fulfilled' && (o.value as any).status === 202);
    const limited = out.filter((o) => o.status === 'rejected' && isLimsError((o as PromiseRejectedResult).reason, 'common.rate_limited'));
    expect(ok).toHaveLength(1); expect(limited).toHaveLength(1);
    expect(db15.exports.size).toBe(10); expect(db15.jobs).toHaveLength(1);
    expect(a.entries.length + b.entries.length).toBe(1);
  });

  it('X16 race at the tenant limit: two parallel requests with 49 today -> exactly one accepted', async () => {
    seedQuota(24, OWNER_A1, (i) => 120 + i); seedQuota(25, FINANCE, (i) => 150 + i);
    const [a, b] = await Promise.all([makeCtx15(OWNER), makeCtx15(OWNER)]);
    const out = await Promise.allSettled([create(a.ctx), create(b.ctx)]);
    expect(out.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(db15.mine(TA).length).toBe(50);
  });
});

// ============================================================================================================== #21 / #22
describe('listAnalyticsExports / getAnalyticsExport — own exports only (US-17.8, P2, P9)', () => {
  beforeEach(() => {
    seedReady(1, OWNER); seedReady(2, OWNER, { status: 'queued', ready_at: null, expires_at: null, sha256: null });
    seedReady(3, OWNER_A1);                                     // a colleague's
    seedReady(4, OWNER, {}, TB);                                // tenant B (same membership id)
  });

  it('list returns only the caller\'s exports of the caller\'s tenant, newest first; each item is a contract-valid ExportDto', async () => {
    const c = await makeCtx15(OWNER);
    const r = await okExp('listAnalyticsExports', c.ctx);
    expect(r.body.data.map((e: any) => e.id).sort()).toEqual([exportId(1), exportId(2)].sort());
    for (const e of r.body.data) expect(contractErrors('ExportDto', e)).toEqual([]);
    const times = r.body.data.map((e: any) => Date.parse(e.requested_at));
    expect(times).toEqual([...times].sort((x: number, y: number) => y - x));
  });

  it('list honours the status filter and a limit', async () => {
    const c = await makeCtx15(OWNER);
    const q = await okExp('listAnalyticsExports', c.ctx, { query: { status: ['queued'] } });
    expect(q.body.data.map((e: any) => e.id)).toEqual([exportId(2)]);
    const l = await okExp('listAnalyticsExports', c.ctx, { query: { limit: 1 } });
    expect(l.body.data).toHaveLength(1);
  });

  it('get own export -> ExportDto with row_count / size_bytes as numbers, dates as ISO strings', async () => {
    const c = await makeCtx15(OWNER);
    const r = await okExp('getAnalyticsExport', c.ctx, { params: { export_id: exportId(1) } });
    expect(contractErrors('ExportDto', r.body)).toEqual([]);
    expect(r.body).toMatchObject({ id: exportId(1), status: 'ready', row_count: 2 });
    expect(typeof r.body.size_bytes).toBe('number');
    expect(r.body.expires_at).toBe(iso(db15.exports.get(exportId(1))!.expires_at));
  });

  it.each([['a colleague\'s export', 3], ['a tenant-B export', 4], ['an unknown id', 99]])('get %s -> 404 common.not_found', async (_n, n) => {
    const c = await makeCtx15(OWNER);
    await expectLims(callExp('getAnalyticsExport', c.ctx, { params: { export_id: exportId(n) } }), 'common.not_found', 404);
  });

  it('list / get need analytics.data.export (aal2)', async () => {
    for (const who of [NO_PERM, FINANCE]) await expectLims(callExp('listAnalyticsExports', (await makeCtx15(who)).ctx), 'auth.forbidden', 403);
    await expectLims(callExp('getAnalyticsExport', (await makeCtx15(OWNER_AAL1)).ctx, { params: { export_id: exportId(1) } }), 'auth.mfa_required', 403);
  });
});

// ============================================================================================================== #23 download
describe('downloadAnalyticsExport — streaming, limits, access log (US-17.7, TRD §10.3, E3, E4, P-2)', () => {
  const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

  it('200 with the stored bytes and the P-2 headers (attachment, nosniff, no-store, content type, filename <code>_<from>_<to>.<ext>)', async () => {
    seedReady(1, OWNER, {}, TA, Buffer.from('PK-bytes-1'));
    const c = await makeCtx15(OWNER);
    const r = await okExp('downloadAnalyticsExport', c.ctx, { params: { export_id: exportId(1) } });
    expect(Buffer.from(r.body as Uint8Array).toString()).toBe('PK-bytes-1');
    const h = Object.fromEntries(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    expect(h['content-type']).toBe(XLSX);
    expect(h['content-disposition']).toMatch(/^attachment;/);
    expect(h['content-disposition']).toMatch(/filename="income_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.xlsx"/);
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['cache-control']).toBe('no-store');
    expect(JSON.stringify(r.headers)).not.toMatch(/https?:|signed|token=/i);        // never a signed URL
  });

  it('each download counts once and writes ONE access_log row data.export {phase:download, rows, sha256_prefix8} (no content, no names)', async () => {
    seedReady(1, OWNER);
    const c = await makeCtx15(OWNER);
    await okExp('downloadAnalyticsExport', c.ctx, { params: { export_id: exportId(1) } });
    expect(db15.exports.get(exportId(1))!.downloads_used).toBe(1);
    expect(c.entries).toHaveLength(1);
    expect(c.entries[0]).toMatchObject({ action: 'data.export', entityType: 'analytics_export', entityId: exportId(1), outcome: 'allowed' });
    expect(c.entries[0].detail).toMatchObject({ phase: 'download', rows: 2, sha256_prefix8: SHA.slice(0, 8) });
    expect(JSON.stringify(c.entries[0].detail)).not.toContain(SHA);
    expect(c.accessRows).toHaveLength(1);
  });

  it('3 downloads succeed, the 4th -> 410 analytics.export_unavailable; the counter stops at 3; no 4th log row', async () => {
    seedReady(1, OWNER);
    const logs: number[] = [];
    for (let i = 0; i < 3; i++) { const c = await makeCtx15(OWNER); await okExp('downloadAnalyticsExport', c.ctx, { params: { export_id: exportId(1) } }); logs.push(c.entries.length); }
    const c4 = await makeCtx15(OWNER);
    await expectLims(download(c4.ctx, 1), 'analytics.export_unavailable', 410);
    expect(db15.exports.get(exportId(1))!.downloads_used).toBe(3);
    expect(logs).toEqual([1, 1, 1]); expect(c4.accessRows).toEqual([]);
  });

  it('X14 race: two parallel downloads with one left -> exactly one 200, one 410; counter ends at 3', async () => {
    seedReady(1, OWNER, { downloads_used: 2 });
    const [a, b] = await Promise.all([makeCtx15(OWNER), makeCtx15(OWNER)]);
    const out = await Promise.allSettled([download(a.ctx, 1), download(b.ctx, 1)]);
    const ok = out.filter((o) => o.status === 'fulfilled' && (o.value as any).status === 200);
    const gone = out.filter((o) => o.status === 'rejected' && isLimsError((o as PromiseRejectedResult).reason, 'analytics.export_unavailable'));
    expect(ok).toHaveLength(1); expect(gone).toHaveLength(1);
    expect(db15.exports.get(exportId(1))!.downloads_used).toBe(3);
    expect(a.entries.length + b.entries.length).toBe(1);
  });

  it('an expired file (status ready, expires_at in the past) -> 410; counter unchanged', async () => {
    seedReady(1, OWNER, { expires_at: new Date(Date.parse(db15.clock.now) - 1000) });
    const c = await makeCtx15(OWNER);
    await expectLims(download(c.ctx, 1), 'analytics.export_unavailable', 410);
    expect(db15.exports.get(exportId(1))!.downloads_used).toBe(0); expect(c.accessRows).toEqual([]);
  });

  it('24 h limit: a file ready at t becomes unavailable after expires_at (clock advanced)', async () => {
    seedReady(1, OWNER);
    const first = await makeCtx15(OWNER);
    await okExp('downloadAnalyticsExport', first.ctx, { params: { export_id: exportId(1) } });
    db15.advance(21 * HOUR);
    await expectLims(download((await makeCtx15(OWNER)).ctx, 1), 'analytics.export_unavailable', 410);
  });

  it.each([['queued', 'analytics.export_not_ready', 409], ['building', 'analytics.export_not_ready', 409], ['failed', 'analytics.export_unavailable', 410], ['expired', 'analytics.export_unavailable', 410]])(
    'status %s -> %s (%i); no download counted, no log row', async (status, code, http) => {
      seedReady(1, OWNER, { status, ...(status === 'failed' ? { failure_code: 'common.internal' } : {}) } as never);
      const c = await makeCtx15(OWNER);
      await expectLims(download(c.ctx, 1), code, http);
      expect(db15.exports.get(exportId(1))!.downloads_used).toBe(0); expect(c.accessRows).toEqual([]);
    });

  it.each([['a colleague\'s export (P9)', 2, OWNER_A1], ['an unknown id', 99, OWNER]])('%s -> 404 common.not_found; no bytes, no counter, no log', async (_n, n, owner) => {
    seedReady(1, OWNER); seedReady(2, owner === OWNER_A1 ? OWNER : OWNER_A1);
    const c = await makeCtx15(owner);
    await expectLims(download(c.ctx, n), 'common.not_found', 404);
    expect(db15.exports.get(exportId(2))!.downloads_used).toBe(0); expect(c.accessRows).toEqual([]);
  });

  it('a tenant-B export id from tenant A credentials -> 404', async () => {
    seedReady(5, OWNER, {}, TB);
    await expectLims(download((await makeCtx15(OWNER)).ctx, 5), 'common.not_found', 404);
    expect(db15.exports.get(exportId(5))!.downloads_used).toBe(0);
  });

  it('abuse case 5: access revoked after the file was built -> 403 auth.forbidden, no bytes, counter untouched', async () => {
    seedReady(1, OWNER_REVOKED);
    const c = await makeCtx15(OWNER_REVOKED);
    await expectLims(download(c.ctx, 1), 'auth.forbidden', 403);
    expect(db15.exports.get(exportId(1))!.downloads_used).toBe(0); expect(db15.log).toEqual([]);
  });

  it('aal1 -> 403 auth.mfa_required, nothing read', async () => {
    seedReady(1, OWNER_AAL1);
    const c = await makeCtx15(OWNER_AAL1);
    await expectLims(download(c.ctx, 1), 'auth.mfa_required', 403);
    expect(db15.log).toEqual([]);
  });

  it('if the access-log write fails the download fails and returns no body (every call is logged or nothing is served)', async () => {
    seedReady(1, OWNER); seedReady(2, OWNER);
    await okExp('downloadAnalyticsExport', (await makeCtx15(OWNER)).ctx, { params: { export_id: exportId(2) } });     // control: the same call works when logging works
    const c = await makeCtx15(OWNER, { accessFails: true });
    const out = await Promise.allSettled([download(c.ctx, 1)]);
    expect(out[0]!.status).toBe('rejected');
    expect((out[0] as PromiseRejectedResult).reason?.message).toMatch(/access_log|synthetic/);
  });
});
