// C6-T14 test helpers (not a test file). Synthetic data only. Reuses the T13 release world (worker release.helpers.ts) but seeds N reports (one rendered version each).
// ASSUMED (spec gives no signatures; repeated in .orchestra/notes/C6-T14-tests.md):
//   - R7 handler `bulkReleaseReportVersions` has the R6 context shape: { tenantId, actor, tx, ports:{ billing, frontdesk, IdentityPort }, events, audit, now }
//   - per-id isolation = a savepoint on ctx.tx: either `ctx.tx.savepoint(fn)` or raw `SAVEPOINT x` / `ROLLBACK TO SAVEPOINT x` statements; both are rolled back for real
//     here (rows, enqueued jobs, published events and access-log entries made after the savepoint disappear on ROLLBACK TO)
//   - aal2 / role gate: IdentityPort.assertRole(ctx, { permission: 'reporting.report.bulk_release', ... }) (same defence-in-depth as N4/N5; the pipeline gate is not run in unit tests)
//   - tenant limit: reporting.settings.bulk_release_max (row absent => 200)
//   - centre RLS is emulated: SELECTs on reporting.* only return rows whose centre_id is in `centres` (the real policy is a DB test of C0/C6-T02)
import { world, makeBilling, makeFrontdesk, ddlChecked, makeAudit, makeLog, rendered, USER, MEMBERSHIP, ELIGIBLE, DUE_500, TENANT_A, TENANT_B, NOW, idN, SYSTEM_ACTOR, I, type Row, type Eligibility, type ConsentOpts } from '../../../../../worker/src/jobs/reporting/__tests__/release.helpers.js';

export { USER, TENANT_A, TENANT_B, NOW, idN, ELIGIBLE, DUE_500, rendered, type Row };
export const CENTRE_A = I.centre;
export const CENTRE_B = idN(0xc2);
export const OP = 'bulkReleaseReportVersions';
export const EVENT = 'reporting.report.released.v1';
export const DISPATCH_TASK = 'reporting.dispatch_release_deliveries';
export const PERMISSION = 'reporting.report.bulk_release';
export const VID = (i: number) => idN(0x40000 + i);     // version id of report i
export const RID = (i: number) => idN(0x41000 + i);     // report id
export const OID = (i: number) => idN(0x42000 + i);     // order id
export const PID = (i: number) => idN(0x43000 + i);     // patient id
/** Precise ms delay (setTimeout alone is clamped to ~16-20 ms on Windows): coarse setTimeout only for the part above SLACK_MS, then spin on performance.now(). */
const SLACK_MS = 20;
export const sleep = async (ms: number): Promise<void> => {
  const end = performance.now() + ms;
  if (ms > SLACK_MS) await new Promise<void>((r) => setTimeout(r, ms - SLACK_MS));
  while (performance.now() < end) { /* spin: accurate to sub-ms */ }
};

export interface Item { reportOver?: Row; versions?: Row[]; tenant?: string; centre?: string }
export interface BulkOpts {
  items: Item[]; dues?: readonly number[]; maxSetting?: number | null; autoRelease?: 'when_eligible' | 'manual'; centres?: readonly string[] | null; rls?: boolean;
  billing?: (orderId: string, n: number) => Eligibility | Error; failOn?: Array<{ match: RegExp; error: () => Error; times?: number }>;
  publishFails?: (reportId: string) => Error | undefined; deniedWith?: string; fastSavepoints?: boolean; billingMs?: number; queryMs?: number; consent?: ConsentOpts;
}

export const V2 = (i: number) => idN(0x45000 + i);      // id of version 2 of report i (version 1 is VID(i))
/** `over` is a PARTIAL row (status, version_no, release fields ...); ids/tenant/centre/report/order/patient are forced. */
const ver = (i: number, tenant: string, centre: string, over: Row = {}): Row => {
  const vn = (over['version_no'] as number | undefined) ?? 1;
  return rendered(vn, { pdf_object_path: `${tenant}/2026/11/${RID(i)}-v${vn}.pdf`, ...over, tenant_id: tenant, centre_id: centre, id: over['id'] ?? (vn === 1 ? VID(i) : V2(i)),
    report_id: RID(i), order_id: OID(i), patient_id: PID(i), partner_id: null });
};
export const REL = { status: 'released', released_at: '2026-11-06T09:00:00.000Z', released_by: USER, release_mode: 'manual', release_basis: 'paid_in_full', audiences: ['patient', 'centre'], version: 4 } as const;

/** `n` plain rendered reports of tenant A / centre A (report i, version id VID(i), order OID(i), row version 3). */
export const many = (n: number, from = 1): Item[] => Array.from({ length: n }, (_, k) => ({ reportOver: { _i: from + k } }));

export function bulkSetup(o: BulkOpts) {
  const reports: Row[] = []; const versions: Row[] = [];
  o.items.forEach((it, k) => {
    const i = (it.reportOver?.['_i'] as number | undefined) ?? k + 1; const tenant = it.tenant ?? TENANT_A; const centre = it.centre ?? CENTRE_A;
    const { _i, ...ro } = it.reportOver ?? {};
    reports.push({ tenant_id: tenant, centre_id: centre, created_by: SYSTEM_ACTOR, updated_by: SYSTEM_ACTOR, id: RID(i), branch_id: idN(5), order_id: OID(i), patient_id: PID(i),
      referrer_id: null, partner_id: null, family: 'laboratory', order_source: 'front_desk', registered_at: '2026-11-05T02:17:00.000Z', registration_no: `0001SY${String(i).padStart(6, '0')}`,
      centre_code: 'C000000099', latest_version_no: 1, released_version_no: null, first_released_at: null, final_released_at: null, version: 5, ...ro });
    for (const v of it.versions ?? [{}]) versions.push(ver(i, tenant, centre, v));
  });
  const settings = o.maxSetting === null ? [] : [{ tenant_id: TENANT_A, centre_id: CENTRE_A, id: idN(0x5e7), created_by: SYSTEM_ACTOR, updated_by: SYSTEM_ACTOR,
    narrative_report_mode: 'separate', auto_release: o.autoRelease ?? 'when_eligible', ...(o.maxSetting === undefined ? {} : { bulk_release_max: o.maxSetting }) }];
  const w = world({ versions: [], ...(o.rls === undefined ? {} : { rls: o.rls }), ...(o.failOn ? { dbOpts: { failOn: o.failOn } } : {}),
    extraSeed: { 'reporting.reports': reports, 'reporting.report_versions': versions, 'reporting.settings': settings, 'reporting.portal_links': [], 'reporting.qr_tokens': [] } });

  const dues = new Set((o.dues ?? []).map(OID));
  const billing = makeBilling(o.billing ?? ((orderId) => (dues.has(orderId) ? DUE_500 : ELIGIBLE)));
  if (o.billingMs) { const g = billing.port.getReleaseEligibility; billing.port.getReleaseEligibility = async (c: any, i: any) => { await sleep(o.billingMs!); return g(c, i); }; }
  const frontdesk = makeFrontdesk(o.consent ?? {});
  const published: Array<{ type: string; input: any; ctxTxIsOurTx: boolean; ctxActor: any }> = []; const access: any[] = []; const au = makeAudit();
  const base = o.fastSavepoints ? w.db.tx : ddlChecked(w.db);   // load tests: skip the DDL re-check, it re-reads ALL versions after every write (O(N^2) host cost; correctness tests keep it)
  const marks = new Map<string, { p: number; a: number }>(); let seq = 0; const centres = o.centres ? new Set(o.centres) : null;
  const tx: any = {
    startedAt: base.startedAt, savepoints: 0, rollbacks: 0,
    async query(text: string, values: unknown[] = []) {
      const sp = /^\s*savepoint\s+(\w+)/i.exec(text); if (sp) { tx.savepoints++; marks.set(sp[1]!.toLowerCase(), { p: published.length, a: access.length }); }
      const rb = /^\s*rollback\s+to\s+savepoint\s+(\w+)/i.exec(text);
      if (rb) { tx.rollbacks++; const m = marks.get(rb[1]!.toLowerCase()); if (m) { published.length = m.p; access.length = m.a; } }
      if (o.queryMs && /^\s*(update|insert)|enqueue_job/i.test(text)) await sleep(o.queryMs);   // write latency only (~5 writes per release)
      if (o.fastSavepoints && (sp || rb)) return { rows: [] };   // load tests only: the fake's SAVEPOINT deep-clones the whole store (O(N) per id => O(N^2) host cost the spec's cost model lacks)
      const res = await base.query(text, values);
      if (centres && /^\s*select/i.test(text) && /\breporting\./i.test(text)) return { rows: res.rows.filter((r: Row) => r['centre_id'] === undefined || centres.has(r['centre_id'])) };
      return res;
    },
    async savepoint<T>(fn: (t: unknown) => Promise<T>): Promise<T> {
      const name = `sp_${++seq}`; await tx.query(`SAVEPOINT ${name}`, []);
      try { return await fn(tx); } catch (e) { await tx.query(`ROLLBACK TO SAVEPOINT ${name}`, []); throw e; }
    },
  };
  const events = { async publish(c: any, type: string, input: any) {
    const bad = o.publishFails?.(input?.aggregate?.id); if (bad) throw bad;
    published.push({ type, input: structuredClone(input), ctxTxIsOurTx: c?.tx === tx, ctxActor: c?.actor }); return { eventId: idN(0xe000 + published.length), duplicate: false }; } };
  const audit = { async access(entry: any) { access.push(structuredClone(entry)); await au.audit.access(entry); } };
  const roleCalls: any[] = []; const logs = makeLog();
  const IdentityPort = { assertRole: async (_c: unknown, req: any) => { roleCalls.push(req); if (o.deniedWith) throw Object.assign(new Error(o.deniedWith), { code: o.deniedWith }); } };
  const ports = { billing: billing.port, frontdesk: frontdesk.port, IdentityPort } as any;
  const ctx = (over: Row = {}): any => ({ tenantId: TENANT_A, actor: { type: 'user', id: USER, membershipId: MEMBERSHIP }, requestId: idN(0xf1), operationId: OP, clientIp: '203.0.113.9',
    tx, ports, events, audit, now: () => NOW, log: logs.log, ...over });
  const version = (i: number) => w.db.all('reporting.report_versions').find((v) => v['id'] === VID(i))!;
  const report = (i: number) => w.db.all('reporting.reports').find((r) => r['id'] === RID(i))!;
  const jobs = () => w.db.jobs.filter((j) => j.identifier === DISPATCH_TASK);
  return { ...w, tx, billing, frontdesk, published, access, roleCalls, logs, ports, ctx, version, report, jobs,
    allText: () => JSON.stringify({ p: published, j: w.db.jobs, a: access, l: logs.text() }) };
}
export type BulkSetup = ReturnType<typeof bulkSetup>;

/** Calls R7 like the pipeline: a rejection rolls back everything the handler wrote on the tx. */
export async function callBulk(manifest: any, s: BulkSetup, body: unknown, ctx: Row = s.ctx()): Promise<{ status: number; body: any }> {
  await s.tx.query('SAVEPOINT pipeline_tx', []);
  try { return await manifest.handlers[OP]({ params: {}, query: {}, headers: {}, body }, ctx); } catch (e) { await s.tx.query('ROLLBACK TO SAVEPOINT pipeline_tx', []); throw e; }
}
export const idsOf = (n: number, from = 1) => Array.from({ length: n }, (_, k) => VID(from + k));
export const outcomes = (r: { body: any }): Record<string, string> => Object.fromEntries(r.body.results.map((x: any) => [x.id, x.outcome]));
export const countBy = (r: { body: any }, outcome: string): number => r.body.results.filter((x: any) => x.outcome === outcome).length;
