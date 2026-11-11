// C14 T12 emulators + fixtures + ctx builder (not a test file). Loaded by vi.mock factories, so it must NOT import summary.service.
// Synthetic data only.
//
// SEAMS pinned for T12 (the spec fixes the algorithm 02-TRD §7.1 steps 3-8 and §4.10, not the TypeScript shapes):
//   summary.service.ts   buildOrGet(ctx, input: { orderId: string; mode?: 'current' | 'prebuild' | 'rebuild_with_active_library'; reportVersionNo?: number })
//                          : Promise<{ summary: Row /* the smartreport.summaries row, snake_case, as stored */; created: boolean /* true = inserted by this call */ }>
//     mode defaults to 'current'. A binding row (report_version_no = reportVersionNo) is written iff reportVersionNo is given (port path); staff/prebuild omit it.
//     reportVersionNo given but not an integer >= 1 -> LimsError common.validation_failed, nothing written. Non-uuid orderId -> a LimsError, nothing written.
//     Does steps 3-8 itself: FrontdeskPort.getOrderSummary, LabPort.getOrderResults({scope:'approved'}), advisory lock, live lookup, supersede, library, engine, insert, S6, binding.
//     NOT in it: the feature flag + version validation (steps 1-2, T13 / handlers). No authorisation (callers authorise).
//     ctx = { tenantId, actor: { id, type }, tx (query: only the advisory lock; savepoint(fn(tx))), ports: { FrontdeskPort, LabPort, CatalogPort }, log, now() }.
//     Reads/writes ONLY through the repositories (summaries.repo, bindings.repo, library.repo, blocks.repo, rules.repo, mappings.repo, groups.repo) + ports.
//   Lock: ONE ctx.tx.query whose text matches /pg_advisory_xact_lock\(hashtextextended\(/ and whose text+values mention the tenant id and the order id (TRD §4.10),
//         issued before any smartreport.summaries read/write of that order. It is held until the transaction ends (the emulator releases it in run()).
//   Supersede (7b): updateSummary(rc, id, version, { status:'superseded', superseded_at, superseded_reason }) (no successor id), then after the successor insert
//         ONE updateSummary(rc, oldId, <version returned by the supersede update>, { superseded_by_summary_id: newId }) (08 A19 D-107).
//   P-44: CatalogPort.getTest(follow-up, requireActive) and LabPort.getAnalyteHistory are called inside ctx.tx.savepoint(...); the savepoint emulator rolls back
//         marker rows a failing port call wrote. getAnalyteHistory(…, { includeLegacy: false }) errors -> trends empty; catalog.test_inactive -> follow-up skipped.
//   Other port errors (FrontdeskPort not_found, CatalogPort analyte read) propagate as the original LimsError code (P-23).
import { createHash } from 'node:crypto';
import { vi } from 'vitest';
import { actorIdFor } from '../../../../../../packages/fakes/src/base';
import { LimsError } from '../../../core/errors.js';
import { contentSha256 } from '../domain/engine.js';
import { starterLibrary, type LibInput } from './t10.fixtures.js';
import {
  ANALYTE, PARAMS, TA, TB, VER, blocksRepoFake, codedSetsRepoFake, groupsRepoFake, libraryRepoFake, loadLibrary, mappingsRepoFake, reid, rulesRepoFake, seed as seedLibraries,
  uid, world as lib,
} from './t11.fakes.js';

export { TA, TB, VER, lib, uid, LimsError, blocksRepoFake, codedSetsRepoFake, groupsRepoFake, libraryRepoFake, mappingsRepoFake, rulesRepoFake };
type Row = Record<string, any>;

export const ORDER = { a: uid(0xa001), a2: uid(0xa002), b: uid(0xb001) };       // a/a2 tenant A, b tenant B
export const PATIENT = { a: uid(0xa101), a2: uid(0xa102), b: uid(0xb101) };
export const CENTRE = { a: uid(0xa201), b: uid(0xb201) };
export const REG_NO = 'SYN-REG-PRIVATE-0001';                                   // display only; must never reach a stored row
export const TEST_ID = { cbc: uid(0xc001), lft: uid(0xc002), kft: uid(0xc003), misc: uid(0xc004), fu: uid(0xc010), fuInactive: uid(0xc011) };
export const AN = {                                                              // catalog analytes (ids shared with the library mappings)
  HGB: ANALYTE.a1, WBC: uid(0x911), PLT: uid(0x912), ALT: uid(0x913), AST: uid(0x914), CREAT: uid(0x915), TXT: uid(0x916),
};
const NAME: Record<string, string> = { HGB: 'Hemoglobin', WBC: 'WBC count', PLT: 'Platelets', ALT: 'ALT', AST: 'AST', CREAT: 'Creatinine', TXT: 'Free text' };
const GROUP: Record<string, string> = { HGB: 'blood_counts', WBC: 'blood_counts', PLT: 'blood_counts', ALT: 'liver', AST: 'liver', CREAT: 'kidney' };
const TEST_OF: Record<string, string> = { HGB: TEST_ID.cbc, WBC: TEST_ID.cbc, PLT: TEST_ID.cbc, ALT: TEST_ID.lft, AST: TEST_ID.lft, CREAT: TEST_ID.kft, TXT: TEST_ID.misc };
export type AnalyteKey = keyof typeof AN;

export const w = {
  summaries: [] as Row[], bindings: [] as Row[],
  calls: [] as { fn: string; tenantId?: string; args: unknown[] }[],           // every repo + port call, in order ('lock' too)
  writes: [] as string[],                                                       // repo write names
  updates: [] as { id: string; expected: number; patch: Row }[],
  markers: [] as string[], spDepth: 0, locks: new Map<string, Promise<void>>(),
  lockCalls: [] as { tenantId: string; text: string; values: unknown[] }[],
  portCalls: [] as { port: string; fn: string; input: any; tenantId: string; inSavepoint: boolean }[],
  orders: [] as Row[], results: new Map<string, Row[]>(), tests: new Map<string, Row>(),
  opts: { history: 'ok' as 'ok' | 'internal' | 'down', analyteReadError: null as string | null, historyPoints: [] as Row[] },
  seq: 0, yieldMs: 0,
};
export const callsOf = (...fns: string[]) => w.calls.filter((c) => fns.includes(c.fn));
export const portCallsOf = (fn: string) => w.portCalls.filter((c) => c.fn === fn);
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
const pgErr = (code: string, message: string): Error => Object.assign(new Error(message), { code });
const note = (fn: string, rc: { tenantId: string } | undefined, ...args: unknown[]) => w.calls.push({ fn, ...(rc ? { tenantId: rc.tenantId } : {}), args });
const mine = (rows: Row[], rc: { tenantId: string }) => rows.filter((r) => r.tenant_id === rc.tenantId);
const clone = <T>(x: T): T => structuredClone(x);
const LIVE = ['draft', 'approved', 'rejected'];

// ---------------------------------------------------------------- repositories (05-SCHEMA §2.8/§2.9, §4, §5 emulated)
const cols = (s: string): string[] => s.split(/\s+/);
const SUM_INS = cols(`id centre_id order_id patient_id library_version_id template_library_version formula_version language approved_set_hash
  input_result_versions content content_sha256 health_score_value health_score_band panels_scored deranged_count critical_count unmapped_result_count
  ignored_duplicate_count built_at use_llm_text llm_overlay`);
const SUM_UPD = cols(`status approved_at approved_by_membership_id use_llm_text llm_overlay rejected_at rejected_by_membership_id reject_reason_code
  reject_comment superseded_at superseded_reason superseded_by_summary_id`);
const BND_INS = cols('id centre_id summary_id order_id report_version_no bound_at');
const NEXT: Record<string, string[]> = { draft: ['approved', 'rejected', 'superseded'], approved: ['superseded'], rejected: ['superseded'], superseded: [] };
const HEX64 = /^[0-9a-f]{64}$/;

export const summariesRepoFake = {
  insertSummary: vi.fn(async (rc: any, row: Row) => {
    note('insertSummary', rc, row); w.writes.push('insertSummary'); await tick();
    const bad = Object.keys(row).filter((k) => !SUM_INS.includes(k));
    if (bad.length) throw new Error(`insertSummary: column(s) not allowed: ${bad.join(', ')}`);
    const r: Row = { use_llm_text: false, llm_overlay: null, health_score_value: null, health_score_band: null, ...Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined)),
      tenant_id: rc.tenantId, status: 'draft', version: 1, created_by: rc.actorId, updated_by: rc.actorId,
      approved_at: null, approved_by_membership_id: null, rejected_at: null, rejected_by_membership_id: null, reject_reason_code: null, reject_comment: null,
      superseded_at: null, superseded_reason: null, superseded_by_summary_id: null };
    if (!HEX64.test(r.approved_set_hash) || !HEX64.test(r.content_sha256)) throw pgErr('23514', 'summaries__hashes__ck');
    if (!Array.isArray(r.input_result_versions) || r.input_result_versions.length < 1 || r.input_result_versions.length > 2000) throw pgErr('23514', 'summaries__inputs__ck');
    if (!/^[0-9]{1,6}$/.test(String(r.template_library_version))) throw pgErr('23514', 'summaries__lib_version_text__ck');
    if (!lib.versions.some((v) => v.tenant_id === rc.tenantId && v.id === r.library_version_id)) throw pgErr('23503', 'summaries__library__fk');
    if (w.summaries.some((s) => s.tenant_id === rc.tenantId && s.order_id === r.order_id && s.approved_set_hash === r.approved_set_hash && s.library_version_id === r.library_version_id))
      throw pgErr('23505', 'summaries__tenant_id_order_id_hash_library__uq');
    if (w.summaries.some((s) => s.tenant_id === rc.tenantId && s.order_id === r.order_id && LIVE.includes(s.status))) throw pgErr('23505', 'summaries__tenant_id_order_id__live__p_uq');
    w.summaries.push(r); return clone(r);
  }),
  getSummary: vi.fn(async (rc: any, id: string) => { note('getSummary', rc, id); await tick(); const r = mine(w.summaries, rc).find((s) => s.id === id); return r ? clone(r) : null; }),
  updateSummary: vi.fn(async (rc: any, id: string, expected: number, patch: Row) => {
    note('updateSummary', rc, id, expected, patch); w.writes.push('updateSummary'); w.updates.push({ id, expected, patch: clone(patch) }); await tick();
    const keys = Object.keys(patch).filter((k) => patch[k] !== undefined);
    const bad = keys.filter((k) => !SUM_UPD.includes(k));
    if (bad.length) throw new Error(`updateSummary: column(s) not allowed: ${bad.join(', ')}`);
    if (keys.length === 0) throw new Error('updateSummary: empty patch');
    const r = mine(w.summaries, rc).find((s) => s.id === id);
    if (!r) throw new LimsError('common.not_found');
    if (r.version !== expected) throw new LimsError('common.version_conflict');
    const next: Row = { ...r, ...Object.fromEntries(keys.map((k) => [k, patch[k]])) };
    if (r.status === 'superseded') {                                              // guarded S6 (08 A19 D-107): only superseded_by_summary_id, once, NULL -> id
      const only = keys.length === 1 && keys[0] === 'superseded_by_summary_id';
      if (!only || r.superseded_by_summary_id !== null || typeof patch.superseded_by_summary_id !== 'string') throw pgErr('P0001', 'invalid_transition');
      const succ = w.summaries.find((s) => s.tenant_id === rc.tenantId && s.id === patch.superseded_by_summary_id);
      if (!succ || succ.order_id !== r.order_id) throw pgErr('23503', 'summaries__superseded_by__fk');
    } else {
      if (next.status !== r.status && !NEXT[r.status]!.includes(next.status)) throw pgErr('P0001', 'invalid_transition');
      if (patch.superseded_by_summary_id != null) throw pgErr('P0001', 'invalid_transition');   // the successor does not exist yet at S5
      if (next.status === 'superseded' && (next.superseded_at == null || !['results_changed', 'library_rebuild'].includes(next.superseded_reason))) throw pgErr('23514', 'summaries__superseded_fields__ck');
    }
    Object.assign(r, next, { version: r.version + 1, updated_by: rc.actorId }); return clone(r);
  }),
  getLiveSummaryByOrder: vi.fn(async (rc: any, orderId: string) => {
    note('getLiveSummaryByOrder', rc, orderId); await tick();
    const r = mine(w.summaries, rc).find((s) => s.order_id === orderId && LIVE.includes(s.status)); return r ? clone(r) : null;
  }),
  findSummaryByDeterminismKey: vi.fn(async (rc: any, k: { orderId: string; approvedSetHash: string; libraryVersionId: string }) => {
    note('findSummaryByDeterminismKey', rc, k); await tick();
    const r = mine(w.summaries, rc).find((s) => s.order_id === k.orderId && s.approved_set_hash === k.approvedSetHash && s.library_version_id === k.libraryVersionId); return r ? clone(r) : null;
  }),
  listSummariesByOrder: vi.fn(async (rc: any, orderId: string) => { note('listSummariesByOrder', rc, orderId); await tick(); return clone(mine(w.summaries, rc).filter((s) => s.order_id === orderId)); }),
  listReviewQueue: vi.fn(async () => { throw new Error('buildOrGet must not list the review queue'); }),
};

export const bindingsRepoFake = {
  insertBinding: vi.fn(async (rc: any, row: Row) => {
    note('insertBinding', rc, row); w.writes.push('insertBinding'); await tick();
    const bad = Object.keys(row).filter((k) => !BND_INS.includes(k));
    if (bad.length) throw new Error(`insertBinding: column(s) not allowed: ${bad.join(', ')}`);
    if (!w.summaries.some((s) => s.tenant_id === rc.tenantId && s.id === row.summary_id)) throw pgErr('23503', 'summary_report_bindings__summary__fk');
    if (!Number.isInteger(row.report_version_no) || row.report_version_no < 1) throw pgErr('23514', 'summary_report_bindings__version__ck');
    if (w.bindings.some((b) => b.tenant_id === rc.tenantId && b.summary_id === row.summary_id && b.report_version_no === row.report_version_no)) return null;   // ON CONFLICT DO NOTHING
    const r = { ...row, tenant_id: rc.tenantId, created_by: rc.actorId }; w.bindings.push(r); return clone(r);
  }),
  listBindingsBySummary: vi.fn(async (rc: any, summaryId: string) => { note('listBindingsBySummary', rc, summaryId); await tick(); return clone(mine(w.bindings, rc).filter((b) => b.summary_id === summaryId)); }),
};

// ---------------------------------------------------------------- ports
const sha = (rs: Row[]): string => createHash('sha256').update(rs.map((r) => `${r.resultId}:${r.versionNo}`).sort().join('\n')).digest('hex');
const portNote = (port: string, fn: string, ctx: any, input: unknown) => w.portCalls.push({ port, fn, input: clone(input), tenantId: ctx.tenantId, inSavepoint: w.spDepth > 0 });

export const FrontdeskPort = {
  async getOrderSummary(ctx: any, input: { orderId: string }) {
    portNote('FrontdeskPort', 'getOrderSummary', ctx, input); note('getOrderSummary', ctx, input.orderId); await tick();
    const o = w.orders.find((x) => x.tenantId === ctx.tenantId && x.orderId === input.orderId);
    if (!o) throw new LimsError('common.not_found');
    return { orderId: o.orderId, patientId: o.patientId, centreId: o.centreId, registrationNo: REG_NO, status: 'in_progress' };
  },
};
export const LabPort = {
  async getOrderResults(ctx: any, input: { orderId: string; scope: string }) {
    portNote('LabPort', 'getOrderResults', ctx, input); note('getOrderResults', ctx, input.orderId, input.scope); await tick();
    const o = w.orders.find((x) => x.tenantId === ctx.tenantId && x.orderId === input.orderId);
    if (!o) throw new LimsError('common.not_found');
    const rs = (w.results.get(input.orderId) ?? []).filter((r) => input.scope !== 'approved' || r.status === 'approved');
    const byItem = new Map<string, Row[]>();
    for (const r of rs) byItem.set(r.orderItemId, [...(byItem.get(r.orderItemId) ?? []), clone(r)]);
    return { orderId: input.orderId, specimens: [], items: [...byItem].map(([orderItemId, results]) => ({ orderItemId, testId: results[0]!.testId, departmentId: uid(0xd001), results })),
      approvedSetHash: sha((w.results.get(input.orderId) ?? []).filter((r) => r.status === 'approved')) };
  },
  async getAnalyteHistory(ctx: any, input: any) {
    portNote('LabPort', 'getAnalyteHistory', ctx, input); note('getAnalyteHistory', ctx, input); await tick();
    w.markers.push(`history:${input.patientId}`);                                // a write made by the port: must be rolled back when the call fails
    if (w.opts.history === 'internal') throw new LimsError('common.internal');
    if (w.opts.history === 'down') throw new LimsError('common.not_found');
    return { series: w.opts.historyPoints.length ? [{ analyteId: AN.HGB, points: clone(w.opts.historyPoints) }] : [] };
  },
};
export const CatalogPort = {
  async getTest(ctx: any, input: { testId: string; asOf?: string; requireActive?: boolean }) {
    portNote('CatalogPort', 'getTest', ctx, input); note('getTest', ctx, input); await tick();
    w.markers.push(`catalog:${input.testId}`);
    if (!input.requireActive && w.opts.analyteReadError) throw new LimsError(w.opts.analyteReadError);
    const t = w.tests.get(`${ctx.tenantId}:${input.testId}`);
    if (!t) throw new LimsError('common.not_found');
    if (input.requireActive && !t.isActive) throw new LimsError('catalog.test_inactive');
    return clone(t);
  },
};

// ---------------------------------------------------------------- ctx + transaction emulation
export function makeCtx(tenant: 'A' | 'B' = 'A', type: 'system' | 'user' = 'system') {
  const tenantId = tenant === 'A' ? TA : TB;
  const held = new Set<string>();
  const tx: any = {
    query: vi.fn(async (text: string, values?: unknown[]) => {
      if (!/pg_advisory_xact_lock/i.test(String(text))) throw new Error('buildOrGet must reach the database only through the repositories (and the advisory lock)');
      w.lockCalls.push({ tenantId, text: String(text), values: values ?? [] }); note('lock', { tenantId });
      const key = JSON.stringify([String(text).replace(/\s+/g, ' '), values ?? []]);
      while (w.locks.has(key) && !held.has(key)) await w.locks.get(key);
      if (!held.has(key)) { let rel!: () => void; w.locks.set(key, new Promise<void>((r) => { rel = r; })); held.add(key); (tx as any)[`rel:${key}`] = rel; }
      return { rows: [] };
    }),
    async savepoint(fn: (t: unknown) => Promise<unknown>) {
      const snap = [...w.markers]; w.spDepth++;
      try { return await fn(tx); } catch (e) { w.markers = snap; throw e; } finally { w.spDepth--; }
    },
  };
  const ctx: any = {
    tenantId, actor: { id: actorIdFor(tenant, type, 'builder'), type }, tx, now: () => '2026-11-12T00:00:00.000Z',
    ports: { FrontdeskPort, LabPort, CatalogPort }, log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, metrics: { inc: vi.fn() }, commitOnError: vi.fn(),
    release: () => { for (const k of held) { (tx as any)[`rel:${k}`](); w.locks.delete(k); } held.clear(); },
  };
  return ctx;
}
/** Runs fn as one transaction: the advisory lock is held until fn settles (commit or rollback). */
export async function run<T>(ctx: any, fn: () => Promise<T>): Promise<T> { try { return await fn(); } finally { ctx.release(); } }
export const logText = (ctx: any): string => JSON.stringify([ctx.log.info.mock.calls, ctx.log.warn.mock.calls, ctx.log.error.mock.calls, ctx.metrics.inc.mock.calls]);

// ---------------------------------------------------------------- fixtures
const R = (n: number): string => uid(0x3000 + n);
export const T_APPROVED = '2026-11-05T04:00:00.000Z';
/** One approved ResultView. flag N unless given. numeric analytes only unless text. */
export function result(n: number, a: AnalyteKey, flag: string | null = 'N', o: Row = {}): Row {
  const text = a === 'TXT';
  return { resultId: R(n), orderItemId: uid(0x4000 + Object.keys(AN).indexOf(a)), testId: TEST_OF[a], analyteId: AN[a], versionNo: 1, status: 'approved', origin: 'manual', commentCodes: [], attachments: [],
    onHold: false, qcReviewRequired: false, approvedAt: T_APPROVED, ...(text ? { valueText: 'see comment' } : { valueNumeric: '13.40', unitCode: 'g/dL' }), ...(flag != null ? { flag } : {}), ...o };
}
/** AC-08.1 order: HGB L, WBC/PLT/ALT/AST/CREAT N. */
export const ac081 = (): Row[] => [result(1, 'HGB', 'L'), result(2, 'WBC'), result(3, 'PLT'), result(4, 'ALT'), result(5, 'AST'), result(6, 'CREAT')];
export const setResults = (orderId: string, rs: Row[]): void => { w.results.set(orderId, rs); };
/** Bumps one result to the next version (an amendment): changes approvedSetHash. */
export const amend = (orderId: string, resultId: string): void => { for (const r of w.results.get(orderId)!) if (r.resultId === resultId) r.versionNo += 1; };

const mkTest = (id: string, code: string, name: string, keys: AnalyteKey[], isActive = true): Row => ({ id, code, name, isActive, departmentId: uid(0xd001), departmentCode: 'LAB', specimenTypeCodes: ['BLOOD'], workflowType: 'standard', revision: 1,
  analytes: keys.map((k, i) => ({ id: AN[k], code: k, name: NAME[k], resultType: k === 'TXT' ? 'text' : 'numeric', reportable: true, sortOrder: (i + 1) * 10 })) });

export const libOf = (): LibInput => ({ ...starterLibrary(), mappings: (['HGB', 'WBC', 'PLT', 'ALT', 'AST', 'CREAT'] as AnalyteKey[]).map((k, i) => ({ id: uid(0x5000 + i), analyteId: AN[k], groupCode: GROUP[k]! })) });
export const FU = { blockId: uid(0x5100), ruleId: uid(0x5101) };
/** Library + one follow-up rule (any trigger, direction low, min out_of_range) suggesting `testId` after 30 days. */
export const libWithFollowup = (testId: string): LibInput => {
  const l = libOf();
  l.blocks.push({ id: FU.blockId, blockKey: 'followup.repeat', kind: 'followup', textEn: 'Repeat {test_name} after {interval_days} days.' });
  l.rules.push({ id: FU.ruleId, ruleKind: 'followup', triggerKind: 'any', direction: 'low', minSeverity: 'out_of_range', priority: 100, blockId: FU.blockId, blockKind: 'followup', suggestedTestId: testId, intervalDays: 30 });
  return l;
};
/** Approved library `no` (status approved, hash set). `lib` defaults to the plain mapped starter library. */
export function approveLibrary(no: number, l: LibInput = libOf()): string {
  const id = VER(no);
  loadLibrary(TA, id, reid(l, no), { groups: true, status: 'approved', version_no: no, content_sha256: createHash('sha256').update(`v${no}`).digest('hex'),
    approved_at: new Date('2026-11-01T00:00:00.000Z'), approved_by_membership_id: uid(0x7500) });
  return id;
}
export function retireLibrary(no: number): void { const v = lib.versions.find((x) => x.id === VER(no))!; v.status = 'retired'; v.retired_at = new Date('2026-11-02T00:00:00.000Z'); }
export function enableTrend(analyte: AnalyteKey = 'HGB'): void { for (const m of lib.mappings) if (m.analyte_id === AN[analyte]) m.trend_enabled = true; }
export const withRange = (r: Row): Row => ({ ...r, referenceRangeSnapshot: { referenceRangeId: uid(0x6001), version: 1, low: '13.0', high: '17.0' } });

/** Fresh world: tenant A order ORDER.a (+ a2), tenant B order ORDER.b, catalog tests, NO library (call approveLibrary). */
export function seed(): void {
  seedLibraries();
  Object.assign(w, { summaries: [], bindings: [], calls: [], writes: [], updates: [], markers: [], spDepth: 0, locks: new Map(), lockCalls: [], portCalls: [], seq: 0 });
  w.results = new Map(); w.opts = { history: 'ok', analyteReadError: null, historyPoints: [] };
  w.orders = [
    { tenantId: TA, orderId: ORDER.a, patientId: PATIENT.a, centreId: CENTRE.a }, { tenantId: TA, orderId: ORDER.a2, patientId: PATIENT.a2, centreId: CENTRE.a },
    { tenantId: TB, orderId: ORDER.b, patientId: PATIENT.b, centreId: CENTRE.b },
  ];
  w.tests = new Map();
  for (const t of [TA, TB]) {
    for (const x of [mkTest(TEST_ID.cbc, 'CBC', 'Complete blood count', ['HGB', 'WBC', 'PLT']), mkTest(TEST_ID.lft, 'LFT', 'Liver panel', ['ALT', 'AST']), mkTest(TEST_ID.kft, 'KFT', 'Kidney panel', ['CREAT']),
      mkTest(TEST_ID.misc, 'MISC', 'Misc', ['TXT']), mkTest(TEST_ID.fu, 'HGB2', 'Repeat hemoglobin', ['HGB']), mkTest(TEST_ID.fuInactive, 'OLD', 'Retired test', ['HGB'], false)]) w.tests.set(`${t}:${x.id}`, x);
  }
  setResults(ORDER.a, ac081());
}
export const sorted = (xs: string[]): string[] => [...xs].sort();
export { contentSha256 };
