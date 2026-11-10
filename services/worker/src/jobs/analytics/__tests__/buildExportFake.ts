// AN-T15 test helper (not a test file): a JobContext world for `analytics.build_export` (02-TRD §10.2).
// analytics.exports / export_files are emulated by the API-side ExportsDb (SQL seams in its header); the report rollups are the AN-T08/T09 emulators
// (vi.mock'ed by the test file); core reads (tenant, membership, membershipPermissions, centres) and ports (IdentityPort settings, RenderPort) are fakes.
//
// SEAMS the task must honour (pinned here; dispute through the reviewer):
//   * export `buildExportTask: TaskHandler` in tasks/build_export.ts; payload {tenant_id, export_id}.
//   * load = `SELECT ... FROM analytics.exports ... FOR UPDATE` on ctx.tx; status transitions are UPDATEs of analytics.exports (SET status = ...).
//   * requester re-validation: ctx.core.membership(ctx,{membershipId}) (status 'active', isActive, no lockedAt) and ctx.core.membershipPermissions(ctx,{membershipId});
//     referral flag: ctx.ports.IdentityPort.getTenantSettings(ctx,{keys:[...]}); tenant name: ctx.core.tenant(ctx).displayName; requester name: membership.displayName.
//   * terminal failures (auth.forbidden, common.feature_disabled, analytics.export_too_large, common.internal) RESOLVE the task after writing status 'failed' + failure_code;
//     retryable failures (render_unavailable, unexpected errors) REJECT (the job tx rolls back, the committed row stays 'queued' = E6); on the final attempt
//     (ctx.attempt >= ctx.maxAttempts) the task must RESOLVE after writing 'failed'/common.internal, because ctx.db.tx reuses the job tx (a rethrow would roll it back).
//     A failed SQL statement aborts the tx: the task must SAVEPOINT before building and ROLLBACK TO SAVEPOINT in its catch before writing anything (review AN-T15 #1).
//   * rows are built with the API's reports.service functions and the EXPLICIT effective scope (rollups.repo receives `scope`).
import { vi } from 'vitest';
import { createFakeRenderPort } from '../../../../../../packages/fakes/src/RenderPort.fake';
import { ExportsDb, type ExportRow } from '../../../../../api/src/modules/analytics/export/__tests__/sqlFake.js';
import { A1, A2, A3, B1, D1, D2, D3, TA, makeCore } from '../../../../../api/src/modules/analytics/handlers/__tests__/helpers.js';
import { db as rollupDb, w as volumeWorld, seed09, R, rf } from '../../../../../api/src/modules/analytics/handlers/__tests__/t09.helpers.js';

export { A1, A2, A3, B1, D1, D2, D3, TA, R, rf, volumeWorld, seed09, rollupDb };
export const NOW = '2026-11-06T06:00:00.000Z';
export const SYS = '01900000-0000-7000-8000-00000000ff01';
export const MID = '01900002-0000-7000-8000-0000000000b1';       // requester membership
export const EXPORT = '01900002-0000-7000-8000-0000000000e1';
export const ALL_PERMS = ['analytics.data.export', 'analytics.dashboard.read', 'analytics.collections.read', 'analytics.referral_report.read'];
export const exportsDb = new ExportsDb();

export interface Member { membershipId: string; displayName: string; status: string; isActive: boolean; lockedAt?: string; allCentres: boolean; centreIds: string[]; roleCodes: string[] }
export const world = {
  member: undefined as Member | undefined,
  perms: [...ALL_PERMS] as string[],
  settings: { referralIncentiveReportEnabled: true } as Record<string, unknown>,
  render: undefined as any,
  touched: [] as string[], logs: [] as any[], errors: [] as any[], metrics: [] as { name: string; labels: unknown }[],
};
export function resetWorld(): void {
  exportsDb.reset(NOW);
  world.member = { membershipId: MID, displayName: 'Test User A-refowner', status: 'active', isActive: true, allCentres: true, centreIds: [], roleCodes: ['owner_viewer'] };
  world.perms = [...ALL_PERMS]; world.settings = { referralIncentiveReportEnabled: true };
  world.render = createFakeRenderPort({ seed: 1 } as never); vi.spyOn(world.render, 'renderPdf');
  world.touched.length = 0; world.logs.length = 0; world.errors.length = 0; world.metrics.length = 0;
  rollupDb.calls.length = 0; rollupDb.fail = undefined;
}

export const seedExport = (o: Partial<ExportRow> = {}): ExportRow => exportsDb.seed({
  id: EXPORT, tenant_id: TA, requested_by_membership_id: MID, report_code: 'income', format: 'csv', status: 'queued',
  params: { business_date_from: D1, business_date_to: D2, group_by: 'day' }, scope_all_centres: true, scope_centre_ids: [], ...o,
});

// The job runs in ONE transaction (core consumer.ts: `db.tx = (fn) => fn(ctx)` reuses it). Model it: a rejected task rolls the whole tx back (run()), SAVEPOINT /
// ROLLBACK TO SAVEPOINT restore a snapshot, and after a failed statement every statement but ROLLBACK TO SAVEPOINT fails (Postgres 25P02).
type Snap = { exports: Map<string, ExportRow>; files: Map<string, any> };
const snapshot = (): Snap => ({ exports: new Map([...exportsDb.exports].map(([k, v]) => [k, { ...v }])), files: new Map([...exportsDb.files].map(([k, v]) => [k, { ...v }])) });
const restore = (s: Snap): void => {
  exportsDb.exports.clear(); for (const [k, v] of s.exports) exportsDb.exports.set(k, { ...v });
  exportsDb.files.clear(); for (const [k, v] of s.files) exportsDb.files.set(k, { ...v });
};

export function makeJobCtx(o: { attempt?: number; maxAttempts?: number; tenantId?: string | undefined } = {}) {
  const savepoints = new Map<string, Snap>();
  let aborted = false;
  const txFor = (txId: string) => ({
    query: vi.fn(async (text: string, values: unknown[] = []) => {
      let m: RegExpExecArray | null;
      if ((m = /^\s*SAVEPOINT\s+(\w+)/i.exec(text))) { if (aborted) throw abortedErr(); savepoints.set(m[1]!, snapshot()); return { rows: [], rowCount: 0 }; }
      if ((m = /^\s*ROLLBACK\s+TO\s+(?:SAVEPOINT\s+)?(\w+)/i.exec(text))) {
        const s = savepoints.get(m[1]!); if (!s) throw Object.assign(new Error(`no such savepoint ${m[1]}`), { code: '3B001' });
        restore(s); aborted = false; return { rows: [], rowCount: 0 };
      }
      if (/^\s*RELEASE\s+(?:SAVEPOINT\s+)?\w+/i.test(text)) return { rows: [], rowCount: 0 };
      if (aborted) throw abortedErr();
      try { return await exportsDb.exec(text, values, { tenant: ctx.tenantId ?? TA, txId }); } catch (e) { aborted = true; throw e; }
    }),
  });
  const abortedErr = () => Object.assign(new Error('current transaction is aborted, commands ignored until end of transaction block'), { code: '25P02' });
  const core: any = makeCore(world.touched);
  core.tenant = async () => ({ id: TA, displayName: 'Test Lab Pvt Ltd', timezone: 'Asia/Kathmandu' });
  core.membership = async (_c: unknown, i: { membershipId: string }) => {
    world.touched.push('core.membership');
    if (!world.member || world.member.membershipId !== i.membershipId) throw Object.assign(new Error('not found'), { code: 'common.not_found' });
    return { ...world.member };
  };
  core.membershipPermissions = async () => { world.touched.push('core.membershipPermissions'); return [...world.perms]; };
  core.memberships = { list: async () => [] };
  const ctx: any = {
    tenantId: 'tenantId' in o ? o.tenantId : TA, actor: { type: 'system', id: SYS }, requestId: '01900000-0000-7000-8000-0000000000e1', jobId: '1',
    attempt: o.attempt ?? 1, maxAttempts: o.maxAttempts ?? 3,
    now: () => exportsDb.clock.now, isNewer: () => true,
    tx: txFor('main'),
    db: { tx: async <T>(fn: (c: any) => Promise<T>) => fn(ctx) },   // same transaction, exactly like services/worker/src/core/consumer.ts:58
    core, events: {}, storage: {}, files: {}, audit: { access: vi.fn(async () => undefined) },
    log: { info: (x: unknown) => world.logs.push(x), warn: (x: unknown) => world.logs.push(x), error: (x: unknown) => { world.logs.push(x); world.errors.push(x); }, debug() {} },
    metrics: { inc: (name: string, labels: unknown) => world.metrics.push({ name, labels }), set() {}, observe() {} },
    ports: {
      IdentityPort: { getTenantSettings: async (_c: unknown, i: { keys: readonly string[] }) => Object.fromEntries(i.keys.map((k) => [k, world.settings[k]])) },
      RenderPort: world.render,
    },
  };
  return ctx;
}

export async function run(ctx: any, over: { tenant_id?: string; export_id?: string } = {}): Promise<void> {
  const { buildExportTask } = await import('../tasks/build_export.js');
  const before = snapshot();
  try { await buildExportTask({ tenant_id: TA, export_id: EXPORT, ...over } as never, ctx); }
  catch (e) { restore(before); throw e; }                       // a rejected task rolls the job transaction back; a resolved one commits
}
export const rowOf = (): ExportRow => exportsDb.exports.get(EXPORT)!;
export const fileOf = () => exportsDb.files.get(`${TA}|${EXPORT}`);
export const rollupReads = () => rollupDb.calls.filter((c) => /Rows$/.test(c.fn));
/** The alert signal for "a C8 data bug": an error log or a metric. */
export const alerted = () => world.errors.length > 0 || world.metrics.length > 0;
