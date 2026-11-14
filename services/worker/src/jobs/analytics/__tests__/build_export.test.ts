// C8 AN-T15 — worker task `analytics.build_export` (02-TRD §10.2 steps 1–9, §7.2 RenderPort mapping; PRD US-17.1/.2/.3/.6, US-15.4/15.5; 07-SECURITY P8, E5, E6, X13/X19 abuse cases;
// CR-C8-002 codes). Emulators + pinned seams: ./buildExportFake.ts and (API side) export/__tests__/sqlFake.ts. The report services, writers and RenderPort fake are REAL.
// Assumptions pinned here (writer may dispute via the reviewer): terminal failures resolve, retryable ones reject (see buildExportFake.ts header); an unreadable/unsupported
// state (export not found for this tenant) is a quiet no-op; a RenderPort answer whose sha256 does not match its bytes never becomes `ready`.
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { err } from '../../../../../../packages/fakes/src/base';
import { businessDateOf, resolvePeriod } from '../../../../../api/src/modules/analytics/domain/period.js';
import { income } from '../../../../../api/src/modules/analytics/service/reports.service.js';
import { csvParts, flat, readXlsx } from '../../../../../api/src/modules/analytics/export/__tests__/xlsxRead.js';
import { iso } from '../../../../../api/src/modules/analytics/export/__tests__/sqlFake.js';
import {
  A1, A2, A3, D1, D2, D3, EXPORT, NOW, R, SYS, TA, alerted, exportsDb, fileOf, makeJobCtx, resetWorld, rf, rollupDb, rollupReads, rowOf, run, seed09, seedExport, volumeWorld, world,
} from './buildExportFake.js';

vi.mock('../../../../../api/src/modules/analytics/repository/rollups.repo.js', async () => (await import('../../../../../api/src/modules/analytics/handlers/__tests__/t09.helpers.js')).rollupsMock09);
vi.mock('../../../../../api/src/modules/analytics/repository/labels.repo.js', async () => (await import('../../../../../api/src/modules/analytics/handlers/__tests__/t09.helpers.js')).labelsRepoMock09);

const NOT_STATUTORY = 'Internal MIS — not a statutory register';
const FORMULA = '=HYPERLINK("http://x","click")';
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const ENV = ['LIMS_ANALYTICS_EXPORT_MAX_ROWS', 'LIMS_ANALYTICS_EXPORT_MAX_BYTES'] as const;

beforeEach(() => { seed09(); resetWorld(); vi.clearAllMocks(); });
afterEach(() => { for (const k of ENV) delete process.env[k]; });

/** What the API would return for `income` with the stored params and the given scope (the same service function the worker must call). */
async function expectedIncome(ctx: any, scope: { all: boolean; centreIds: string[] }) {
  const period = resolvePeriod({ business_date_from: D1, business_date_to: D2 }, businessDateOf(NOW as never), 366);
  const out = await income(ctx, { period, scope, groupBy: 'day' });
  rollupDb.calls.length = 0;
  return out;
}
const ALL = { all: true, centreIds: [] as string[] };
const scopesRead = () => rollupReads().map((c) => c.args.scope as { all: boolean; centreIds: string[] });
const failed = (code: string) => { expect(rowOf()).toMatchObject({ status: 'failed', failure_code: code }); expect(fileOf()).toBeUndefined(); };

// ============================================================================================================== happy path
describe('build_export — CSV (US-17.1/17.2/17.3)', () => {
  it('loads the row FOR UPDATE, goes building -> ready with the TRD §10.2 step 8 bookkeeping, and stores the bytes', async () => {
    seedExport({ format: 'csv' });
    const ctx = makeJobCtx();
    const want = await expectedIncome(ctx, ALL);
    await run(ctx);
    expect(exportsDb.log[0]!.text).toMatch(/FOR\s+UPDATE/i);
    const events = exportsDb.events.filter((e) => e.startsWith('update:exports') || e.startsWith('insert:export_files'));
    expect(events.some((e) => e.endsWith(':building'))).toBe(true);
    expect(events.at(-1)).toMatch(/update:exports:ready/);
    const f = fileOf()!;
    expect(rowOf()).toMatchObject({ status: 'ready', sha256: f.sha256, failure_code: null });
    expect(Number(rowOf().row_count)).toBe(want.rows.length);
    expect(Number(rowOf().size_bytes)).toBe(f.content.length);
    expect(f.sha256).toBe(sha(f.content));
    expect(f.content_type).toBe('text/csv; charset=utf-8');
    expect(iso(rowOf().ready_at)).toBe(NOW);
    expect(iso(rowOf().expires_at)).toBe(new Date(Date.parse(NOW) + 24 * 3_600_000).toISOString());
  });

  it('export_files insert carries tenant, export_id, created_by = the system actor and expires_at = the export\'s new expires_at (review m#16)', async () => {
    seedExport({ format: 'csv' });
    await run(makeJobCtx());
    const f = fileOf()!;
    expect(f).toMatchObject({ tenant_id: TA, export_id: EXPORT, created_by: SYS });
    expect(iso(f.expires_at)).toBe(iso(rowOf().expires_at));
    expect(Buffer.isBuffer(f.content) || f.content instanceof Uint8Array).toBe(true);
  });

  it('header block: tenant name, title, period, scope "All centres", export id, "Exported by <name>", freshness, not-statutory line; rows equal the API service rows', async () => {
    seedExport({ format: 'csv' });
    const ctx = makeJobCtx();
    const want = await expectedIncome(ctx, ALL);
    await run(ctx);
    const { headerLines, body } = csvParts(fileOf()!.content);
    const block = headerLines.join('\n');
    for (const s of ['Test Lab Pvt Ltd', 'All centres', EXPORT, 'Exported by Test User A-refowner', NOT_STATUTORY]) expect(block).toContain(s);
    expect(want.rows.length).toBeGreaterThan(0);
    expect(body).toHaveLength(want.rows.length);
    for (const row of want.rows) {
      const rec = body.find((r) => r.includes(row.label));
      expect(rec, row.label).toBeDefined();
      for (const k of ['invoiced_paisa', 'credit_notes_paisa', 'net_sales_paisa'] as const) expect(rec).toContain(String(row[k]));
    }
  });

  it('every repository read receives the explicit scope argument (worker RLS is tenant-wide; the argument is the enforcement)', async () => {
    seedExport({ format: 'csv' });
    await run(makeJobCtx());
    expect(rollupReads().length).toBeGreaterThan(0);
    for (const s of scopesRead()) expect(typeof s?.all).toBe('boolean');
  });
});

describe('build_export — XLSX opens and matches the API rows (US-17.1/17.2)', () => {
  it('Report sheet = labels + one row per API row with numeric money; About sheet = header block', async () => {
    seedExport({ format: 'xlsx' });
    const ctx = makeJobCtx();
    const want = await expectedIncome(ctx, ALL);
    await run(ctx);
    const f = fileOf()!;
    expect(f.content_type).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const book = readXlsx(f.content);
    expect(Object.keys(book).sort()).toEqual(['About', 'Report']);
    expect(book.Report).toHaveLength(want.rows.length + 1);
    for (const row of want.rows) {
      const rec = book.Report!.find((r) => r.includes(row.label));
      expect(rec, row.label).toBeDefined();
      for (const k of ['invoiced_paisa', 'credit_notes_paisa', 'net_sales_paisa'] as const) expect(rec).toContain(row[k]);   // numbers, not strings
    }
    const about = flat(book.About!).join('\n');
    for (const s of ['Test Lab Pvt Ltd', 'Exported by Test User A-refowner', NOT_STATUTORY]) expect(about).toContain(s);
  });
});

describe('build_export — formula injection through the whole chain (E5, D-C8-07)', () => {
  beforeEach(() => {
    volumeWorld.referrers.push({ tenantId: TA, referrer_id: R.FOREIGN.replace(/..$/, '99'), display_name: FORMULA, is_active: true, canonical_referrer_id: null });
    volumeWorld.refs.push(rf(D1, A1, R.FOREIGN.replace(/..$/, '99'), { orders: 9 }));
  });

  it.each(['csv', 'xlsx'])('a doctor name starting with =HYPERLINK(...) is written as TEXT with a leading apostrophe (%s)', async (format) => {
    seedExport({ format, report_code: 'top_referrers' });
    await run(makeJobCtx());
    const cells = format === 'csv' ? csvParts(fileOf()!.content).body.flat() : flat(readXlsx(fileOf()!.content).Report!);
    expect(cells).toContain(`'${FORMULA}`);
    expect(cells).not.toContain(FORMULA);
  });
});

// ============================================================================================================== guards
describe('build_export — step 1: only queued / building rows are built', () => {
  it.each(['ready', 'failed', 'expired'])('status %s -> nothing happens (no building update, no file, no reads)', async (status) => {
    seedExport({ status, ...(status === 'ready' ? { ready_at: new Date(NOW), expires_at: new Date(NOW), sha256: 'a'.repeat(64) } : {}), ...(status === 'failed' ? { failure_code: 'common.internal' } : {}) } as never);
    await run(makeJobCtx());
    expect(exportsDb.files.size).toBe(0);
    expect(exportsDb.log.filter((s) => /^\s*(UPDATE|INSERT)/i.test(s.text))).toEqual([]);
    expect(rollupReads()).toEqual([]);
  });

  it('status building (a crashed earlier attempt) is built again', async () => {
    seedExport({ status: 'building', building_started_at: new Date(NOW) });
    await run(makeJobCtx());
    expect(rowOf().status).toBe('ready');
  });

  it('an export id of another tenant / an unknown id is a quiet no-op (the row is not visible to this tenant)', async () => {
    seedExport({ tenant_id: '01a1a98a-ac40-7000-8000-00000000b001' });
    await run(makeJobCtx());
    expect(exportsDb.files.size).toBe(0); expect(rollupReads()).toEqual([]);
    expect(exportsDb.exports.get(EXPORT)!.status).toBe('queued');
  });

  it('a payload naming another tenant than the job context is refused before any statement', async () => {
    seedExport();
    await expect(run(makeJobCtx(), { tenant_id: '01a1a98a-ac40-7000-8000-00000000b001' })).rejects.toBeTruthy();
    expect(exportsDb.log).toEqual([]);
  });
});

describe('build_export — step 2: the requester is re-validated at build time (X13, P8)', () => {
  const cases: [string, () => void][] = [
    ['membership deactivated', () => { world.member!.status = 'deactivated'; }],
    ['membership inactive', () => { world.member!.isActive = false; }],
    ['membership locked', () => { world.member!.lockedAt = NOW; }],
    ['membership gone', () => { world.member = undefined; }],
    ['analytics.data.export revoked', () => { world.perms = world.perms.filter((p) => p !== 'analytics.data.export'); }],
    ['report permission revoked (analytics.dashboard.read)', () => { world.perms = world.perms.filter((p) => p !== 'analytics.dashboard.read'); }],
  ];
  it.each(cases)('%s -> failed auth.forbidden; task resolves; no report read; no file', async (_n, mutate) => {
    seedExport({ format: 'xlsx' });
    mutate();
    await expect(run(makeJobCtx())).resolves.toBeUndefined();
    failed('auth.forbidden');
    expect(rollupReads()).toEqual([]);
  });

  it('collections export loses analytics.collections.read -> failed auth.forbidden', async () => {
    seedExport({ report_code: 'collections' });
    world.perms = world.perms.filter((p) => p !== 'analytics.collections.read');
    await run(makeJobCtx());
    failed('auth.forbidden');
  });

  it('X19: the referral flag is switched off while the export waits -> failed common.feature_disabled; no read, no file', async () => {
    seedExport({ report_code: 'referral_incentive', format: 'csv' });
    world.settings.referralIncentiveReportEnabled = false;
    await run(makeJobCtx());
    failed('common.feature_disabled');
    expect(rollupReads()).toEqual([]);
  });

  it('referral_incentive: requester lost analytics.referral_report.read -> failed auth.forbidden', async () => {
    seedExport({ report_code: 'referral_incentive' });
    world.perms = world.perms.filter((p) => p !== 'analytics.referral_report.read');
    await run(makeJobCtx());
    failed('auth.forbidden');
  });
});

describe('build_export — step 3: effective scope = snapshot ∩ current membership scope (US-15.4/15.5, P8)', () => {
  const cases: [string, { all: boolean; ids: string[] }, { all: boolean; ids: string[] }, { all: boolean; ids: string[] } | 'empty'][] = [
    ['all-centres snapshot, still all-centres', { all: true, ids: [] }, { all: true, ids: [] }, { all: true, ids: [] }],
    ['all-centres snapshot, membership shrank to {A1}', { all: true, ids: [] }, { all: false, ids: [A1] }, { all: false, ids: [A1] }],
    ['snapshot {A1,A2}, membership now {A2,A3}', { all: false, ids: [A1, A2] }, { all: false, ids: [A2, A3] }, { all: false, ids: [A2] }],
    ['snapshot {A1}, membership widened to all centres', { all: false, ids: [A1] }, { all: true, ids: [] }, { all: false, ids: [A1] }],
    ['snapshot {A1}, membership moved to {A2} only', { all: false, ids: [A1] }, { all: false, ids: [A2] }, 'empty'],
  ];
  it.each(cases)('%s', async (_n, snap, now, want) => {
    seedExport({ format: 'csv', scope_all_centres: snap.all, scope_centre_ids: snap.ids });
    world.member!.allCentres = now.all; world.member!.centreIds = now.ids;
    const ctx = makeJobCtx();
    await run(ctx);
    if (want === 'empty') { failed('auth.forbidden'); expect(rollupReads()).toEqual([]); return; }
    expect(rowOf().status).toBe('ready');
    const seen = scopesRead();
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) { expect(s.all).toBe(want.all); expect([...s.centreIds].sort()).toEqual([...want.ids].sort()); }
    const expected = await expectedIncome(ctx, { all: want.all, centreIds: want.ids });
    const body = csvParts(fileOf()!.content).body;
    expect(body).toHaveLength(expected.rows.length);
    for (const row of expected.rows) expect(body.find((r) => r.includes(row.label))).toContain(String(row.net_sales_paisa));
  });

  it('a shrunk membership gets strictly fewer money than the snapshot would have shown (tenant-wide figures never leak)', async () => {
    seedExport({ format: 'csv' });
    world.member!.allCentres = false; world.member!.centreIds = [A1];
    const ctx = makeJobCtx();
    const wide = await expectedIncome(ctx, ALL), narrow = await expectedIncome(ctx, { all: false, centreIds: [A1] });
    expect(narrow.totals.net_sales_paisa).toBeLessThan(wide.totals.net_sales_paisa);
    await run(ctx);
    expect(csvParts(fileOf()!.content).body.flat().join(' ')).not.toContain(String(wide.rows[0]!.net_sales_paisa));
  });
});

describe('build_export — steps 5/7: row and size caps -> failed analytics.export_too_large (CR-C8-002)', () => {
  it('rows above LIMS_ANALYTICS_EXPORT_MAX_ROWS', async () => {
    process.env.LIMS_ANALYTICS_EXPORT_MAX_ROWS = '1';
    seedExport({ format: 'csv', params: { business_date_from: D1, business_date_to: D3, group_by: 'day' } }); // 2 day-rows (D1, D2) > 1 (TRD:757 is strictly greater)
    await run(makeJobCtx());
    failed('analytics.export_too_large');
  });
  it('bytes above LIMS_ANALYTICS_EXPORT_MAX_BYTES', async () => {
    process.env.LIMS_ANALYTICS_EXPORT_MAX_BYTES = '100';
    seedExport({ format: 'xlsx' });
    await run(makeJobCtx());
    failed('analytics.export_too_large');
  });
});

// ============================================================================================================== PDF / RenderPort
describe('build_export — PDF through RenderPort (TRD §10.2 step 6/6a, §7.2)', () => {
  it('renderPdf({templateKey:"analytics.report", data per step 6a, idempotencyKey: export_id}); bytes are decoded, sha256 checked and stored as application/pdf', async () => {
    seedExport({ format: 'pdf' });
    await run(makeJobCtx());
    expect(world.render.renderPdf).toHaveBeenCalledTimes(1);
    const input = world.render.renderPdf.mock.calls[0][1];
    expect(input.templateKey).toBe('analytics.report');
    expect(input.idempotencyKey).toBe(EXPORT);
    expect(Object.keys(input.data).sort()).toEqual(['columns', 'exportId', 'exportedBy', 'freshnessNote', 'generatedAtLocal', 'notStatutoryNote', 'periodLabelAd', 'periodLabelBs', 'reportTitle', 'rows', 'scopeLabel', 'tenantDisplayName'].sort());
    expect(input.data.notStatutoryNote).toBe(NOT_STATUTORY);
    expect(input.data.exportId).toBe(EXPORT);
    expect(input.data.exportedBy).toContain('Test User A-refowner');
    const f = fileOf()!;
    expect(f.content_type).toBe('application/pdf');
    expect(Buffer.from(f.content).subarray(0, 4).toString()).toBe('%PDF');
    expect(f.sha256).toBe(sha(f.content));
    expect(rowOf()).toMatchObject({ status: 'ready', sha256: f.sha256 });
  });

  const port = (impl: () => unknown) => ({ renderPdf: vi.fn(async () => impl()) });
  it.each([['common.payload_too_large', 'analytics.export_too_large', false], ['reporting.template_invalid', 'common.internal', true], ['auth.forbidden', 'common.internal', true]])(
    'RenderPort error %s -> failed %s (task resolves%s)', async (code, mapped, alert) => {
      seedExport({ format: 'pdf' });
      const ctx = makeJobCtx();
      ctx.ports.RenderPort = port(() => { throw err(code as never); });
      await expect(run(ctx)).resolves.toBeUndefined();
      failed(mapped);
      if (alert) expect(alerted()).toBe(true);
    });

  it('reporting.render_unavailable -> the task REJECTS (retry), the export is not failed and goes back to queued', async () => {
    seedExport({ format: 'pdf' });
    const ctx = makeJobCtx({ attempt: 1, maxAttempts: 3 });
    ctx.ports.RenderPort = port(() => { throw err('reporting.render_unavailable'); });
    await expect(run(ctx)).rejects.toBeTruthy();
    expect(rowOf().status).toBe('queued'); expect(fileOf()).toBeUndefined();
  });

  it('a RenderPort answer whose sha256 does not match its bytes never becomes ready', async () => {
    seedExport({ format: 'pdf' });
    const ctx = makeJobCtx({ attempt: 3, maxAttempts: 3 });
    const bytes = Buffer.from('%PDF-1.7 tampered');
    ctx.ports.RenderPort = port(() => ({ contentBase64: bytes.toString('base64'), sha256: '0'.repeat(64), byteSize: bytes.length, pageCount: 1 }));
    await run(ctx).catch(() => undefined);
    expect(rowOf().status).not.toBe('ready'); expect(fileOf()).toBeUndefined();
  });
});

// ============================================================================================================== attempts
describe('build_export — retries and the final attempt (step 8a, 03-APP-FLOW E4/E6)', () => {
  it.each([[1, 3], [2, 3]])('attempt %i of %i: an unexpected error rejects and resets building -> queued (not failed)', async (attempt, max) => {
    seedExport({ format: 'csv' });
    rollupDb.fail = new Error('synthetic database outage');
    await expect(run(makeJobCtx({ attempt, maxAttempts: max }))).rejects.toThrow('synthetic database outage');
    expect(rowOf().status).toBe('queued'); expect(rowOf().failure_code).toBeNull(); expect(fileOf()).toBeUndefined();
  });

  it('final attempt: the task RESOLVES and the committed row is failed / common.internal (ctx.db.tx reuses the job tx, so a rethrow would roll the failure back)', async () => {
    seedExport({ format: 'csv' });
    rollupDb.fail = new Error('synthetic database outage');
    await expect(run(makeJobCtx({ attempt: 3, maxAttempts: 3 }))).resolves.toBeUndefined();
    failed('common.internal');
    expect(world.errors.length).toBeGreaterThan(0);
  });

  // A SQL error (e.g. statement timeout) aborts the Postgres transaction: the task must SAVEPOINT before building and ROLLBACK TO SAVEPOINT in its catch.
  const sqlTimeout = () => { exportsDb.failOn = (t) => (/^\s*INSERT\s+INTO\s+analytics\.export_files/i.test(t) ? Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }) : undefined); };
  it('final attempt after a SQL error following markBuilding (aborted tx): savepoint rollback, then failed / common.internal is committed', async () => {
    seedExport({ format: 'csv' });
    sqlTimeout();
    await expect(run(makeJobCtx({ attempt: 3, maxAttempts: 3 }))).resolves.toBeUndefined();
    failed('common.internal');
  });
  it('non-final attempt after a SQL error: rejects with the ORIGINAL error (not "transaction is aborted"), the export stays queued', async () => {
    seedExport({ format: 'csv' });
    sqlTimeout();
    await expect(run(makeJobCtx({ attempt: 1, maxAttempts: 3 }))).rejects.toThrow('statement timeout');
    expect(rowOf().status).toBe('queued'); expect(rowOf().failure_code).toBeNull(); expect(fileOf()).toBeUndefined();
  });
});

describe('build_export — wiring', () => {
  it('the manifest task analytics.build_export is the real handler (not the AN-T01 stub), max_attempts 3', async () => {
    const { manifest } = await import('../index.js');
    const { buildExportTask } = await import('../tasks/build_export.js');
    expect(manifest.tasks!['analytics.build_export']).toBe(buildExportTask);
    expect(manifest.maxAttempts!['analytics.build_export']).toBe(3);
  });
  it('the task writes only analytics.exports / analytics.export_files (no other table, no DELETE)', async () => {
    seedExport({ format: 'csv' });
    await run(makeJobCtx());
    const writes = exportsDb.log.filter((s) => /^\s*(INSERT|UPDATE|DELETE)/i.test(s.text));
    expect(writes.length).toBeGreaterThan(0);
    for (const s of writes) { expect(s.text).toMatch(/analytics\.(exports|export_files)\b/i); expect(s.text).not.toMatch(/^\s*DELETE/i); }
  });
});
