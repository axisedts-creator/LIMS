// AN-T11 test helpers (not a test file). Synthetic data only. Used by testsDone / qualityIndicators / delivery / interfaces handler tests.
// Builds on ./helpers.ts (AN-T08: ids, actors, core fake, ctx factory). The rollup/label/source-view repositories are replaced by in-memory
// emulators that honour tenant, [from, to), the scope predicate exactly as TRD §6 states (`$all OR (centre_id IS NOT NULL AND centre_id = ANY(centres))`),
// so handler + service + mapper + labels.service are real. The SQL itself is covered by repository/__tests__/rollups.t11.repo.test.ts.
//
// SEAMS pinned here (the spec leaves repo signatures open; the writer may dispute through the reviewer). All take (tx, { tenantId, from, to, scope, ... }):
//   rollups.repo.resultsRows        { groupBy: 'department'|'test'|'processing_branch'|'day'|'ad_month', departmentIds?, processingBranchIds? }
//        -> [{ key, results_resulted, results_verified, results_approved, results_amended, auto_verified, critical_count, abnormal_count, tests_approved }]
//   rollups.repo.rejectionRows      { groupBy: 'reason'|'centre'|'specimen_type'|'day'|'ad_month' } -> [{ key|null, rejections, recollections_ordered }]
//   rollups.repo.specimenRows       { groupBy: 'total'|'centre'|'specimen_type'|'day'|'ad_month' } -> [{ key|null, received }]   (aliquots are excluded upstream)
//   rollups.repo.criticalValueRows  {} -> per business_date [{ business_date, detected, notified, median_notify_seconds|null, max_notify_seconds|null }]
//   rollups.repo.deliveryRows       { groupBy: 'channel'|'day'|'ad_month' } -> [{ key, queued, sent, delivered, read, failed, suppressed }]
//   rollups.repo.releaseRows        { groupBy: 'total'|'day'|'ad_month' } -> [{ key|null, released, final, partial, preliminary, amended, overrides }]
//   rollups.repo.interfaceMessageRows {} -> [{ instrument_id, centre_id, messages, patient_records, qc_records, unmatched, quarantined, duplicates }]
//   sourceViews.repo.listAgentStatus  (tx, { tenantId, scope }) -> [{ agent_id, centre_id, state, last_heartbeat_at, agent_version, queue_depth }]
//   bs_month = the service asks for 'day' and groups itself (as AN-T08). Anything else (group 'reason' on specimens, 'channel' on releases) is treated as 'total'.
// Conventions assumed (flagged in .orchestra/notes/AN-T11-tests.md): *_bp = ratioBp(...) ?? 0; failure_share = failed / (sent + failed + suppressed);
//   reason/specimen_type/channel keys are the codes as-is and so are their labels; NULL reason key = 'unspecified'.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AjvCompiler } from '@fastify/ajv-compiler';
import { parse } from 'yaml';
import { vi } from 'vitest';
import { idFor } from '../../../../../../../packages/fakes/src/base';
import { REPO_ROOT } from '../../../../core/module.js';
import { AJV_OPTIONS } from '../../../../core/openapi.js';
import {
  A1, A2, B1, BR1, BR2, BRB, DEPT, TA, TB, D0, D1, D2, D3, db, labelsRepoMock, makeCtx, resetDb, rollupsMock,
} from './helpers.js';

export * from './helpers.js';

const SEED = 1;
export const TEST = { CBC: idFor(SEED, 0xe1), GLU: idFor(SEED, 0xe2), OLD: idFor(SEED, 0xe3), FOREIGN: idFor(SEED, 0xe4) };
export const TEST_NAME = { CBC: 'Complete Blood Count', GLU: 'Glucose Fasting', OLD: 'Legacy Widal', FOREIGN: 'Tenant B Doppler' };
export const ANALYTE = { X: idFor(SEED, 0xa1), Y: idFor(SEED, 0xa2) };
export const INSTR = { CHEM: idFor(SEED, 0x51), HAE: idFor(SEED, 0x52), BARE: idFor(SEED, 0x53), FOREIGN: idFor(SEED, 0x54) };
export const AGENT = { ONLINE: idFor(SEED, 0x61), OFFLINE: idFor(SEED, 0x62), DEGRADED: idFor(SEED, 0x63), FOREIGN: idFor(SEED, 0x64) };
export const SENTINEL = 987_654_321; // tenant B / out-of-window values: must never appear in any response

// ------------------------------------------------------------------ facts
export interface ResultFact { tenantId: string; date: string; branchId: string; departmentId: string; testId: string; centreId: string | null;
  resulted: number; verified: number; approved: number; amended: number; auto: number; critical: number; abnormal: number; testsApproved: number }
export interface RejectionFact { tenantId: string; date: string; centreId: string; specimenType: string; reason: string | null; rejections: number; recollections: number }
export interface SpecimenFact { tenantId: string; date: string; centreId: string; specimenType: string; priority: 'routine' | 'urgent'; received: number }
export interface CriticalFact { tenantId: string; date: string; analyteId: string; centreId: string | null; detected: number; notified: number; median: number | null; max: number | null }
export interface DeliveryFact { tenantId: string; date: string; channel: string; purpose: string; recipientKind: string; centreId: string | null;
  queued: number; sent: number; delivered: number; read: number; failed: number; suppressed: number }
export interface ReleaseFact { tenantId: string; date: string; centreId: string; kind: 'final' | 'partial' | 'preliminary' | 'amended' | 'addendum'; basis: string; released: number }
export interface MessageFact { tenantId: string; date: string; instrumentId: string; centreId: string; messages: number; patient: number; qc: number; unmatched: number; quarantined: number; duplicates: number }
export interface AgentFact { tenantId: string; agentId: string; centreId: string; state: string; heartbeat: string; version: string; queue: number }
export const t11 = {
  results: [] as ResultFact[], rejections: [] as RejectionFact[], specimens: [] as SpecimenFact[], critical: [] as CriticalFact[],
  deliveries: [] as DeliveryFact[], releases: [] as ReleaseFact[], messages: [] as MessageFact[], agents: [] as AgentFact[],
  tests: [] as { tenantId: string; test_id: string; code: string; name: string; department_id: string | null; is_active: boolean }[],
  instruments: [] as { tenantId: string; instrument_id: string; centre_id: string; instrument_code: string; display_name: string; is_active: boolean }[],
};
export const R = (date: string, centreId: string | null, branchId: string, departmentId: string, testId: string,
  n: [number, number, number, number, number, number, number, number], tenantId = TA): ResultFact => ({
  tenantId, date, centreId, branchId, departmentId, testId, resulted: n[0], verified: n[1], approved: n[2], amended: n[3], auto: n[4], critical: n[5], abnormal: n[6], testsApproved: n[7],
});

export function seedT11(): void {
  resetDb();
  for (const k of Object.keys(t11) as (keyof typeof t11)[]) (t11[k] as unknown[]).length = 0;
  // results  [resulted, verified, approved, amended, auto, critical, abnormal, tests_approved]
  t11.results.push(
    R(D1, A1, BR1, DEPT.H, TEST.CBC, [10, 8, 6, 1, 2, 1, 3, 4]),
    R(D1, A2, BR2, DEPT.H, TEST.GLU, [5, 5, 5, 0, 1, 0, 2, 3]),
    R(D2, A1, BR2, DEPT.B, TEST.OLD, [7, 6, 6, 2, 0, 2, 1, 5]),
    R(D2, null, BR1, DEPT.H, TEST.CBC, [4, 4, 4, 0, 0, 0, 0, 4]),                       // NULL centre: all-centre users only
    R(D0, A1, BR1, DEPT.H, TEST.CBC, [1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000]), // out of window
    R(D3, A1, BR1, DEPT.H, TEST.CBC, [2000, 2000, 2000, 2000, 2000, 2000, 2000, 2000]),
    R(D1, B1, BRB, DEPT.FOREIGN, TEST.FOREIGN, [SENTINEL, SENTINEL, SENTINEL, SENTINEL, SENTINEL, SENTINEL, SENTINEL, SENTINEL], TB),
  );
  const rej = (date: string, centreId: string, specimenType: string, reason: string | null, rejections: number, recollections: number, tenantId = TA): RejectionFact =>
    ({ tenantId, date, centreId, specimenType, reason, rejections, recollections });
  t11.rejections.push(
    rej(D1, A1, 'serum', 'haemolysed', 2, 1), rej(D1, A2, 'serum', 'clotted', 1, 1),
    rej(D2, A1, 'edta', 'haemolysed', 3, 2), rej(D2, A1, 'edta', null, 1, 0),
    rej(D0, A1, 'serum', 'haemolysed', 500, 500), rej(D3, A1, 'serum', 'haemolysed', 600, 600), rej(D1, B1, 'serum', 'haemolysed', SENTINEL, SENTINEL, TB),
  );
  const spec = (date: string, centreId: string, specimenType: string, priority: 'routine' | 'urgent', received: number, tenantId = TA): SpecimenFact =>
    ({ tenantId, date, centreId, specimenType, priority, received });
  t11.specimens.push(
    spec(D1, A1, 'serum', 'routine', 40), spec(D1, A2, 'serum', 'routine', 20), spec(D2, A1, 'edta', 'routine', 30), spec(D2, A1, 'edta', 'urgent', 10),
    spec(D0, A1, 'serum', 'routine', 5000), spec(D3, A1, 'serum', 'routine', 6000), spec(D1, B1, 'serum', 'routine', SENTINEL, TB),
  );
  const cv = (date: string, analyteId: string, centreId: string | null, detected: number, notified: number, median: number | null, max: number | null, tenantId = TA): CriticalFact =>
    ({ tenantId, date, analyteId, centreId, detected, notified, median, max });
  t11.critical.push(
    cv(D1, ANALYTE.X, A1, 3, 2, 600, 900), cv(D1, ANALYTE.X, A2, 2, 2, 300, 400), cv(D2, ANALYTE.Y, A1, 1, 0, null, null),
    cv(D2, ANALYTE.X, null, 5, 5, 100, 200),                                              // NULL centre: all-centre users only
    cv(D0, ANALYTE.X, A1, 70, 70, 1, 99_999), cv(D3, ANALYTE.X, A1, 80, 80, 1, 88_888), cv(D1, ANALYTE.X, B1, SENTINEL, SENTINEL, 7, SENTINEL, TB),
  );
  const del = (date: string, channel: string, purpose: string, recipientKind: string, centreId: string | null, n: [number, number, number, number, number, number], tenantId = TA): DeliveryFact =>
    ({ tenantId, date, channel, purpose, recipientKind, centreId, queued: n[0], sent: n[1], delivered: n[2], read: n[3], failed: n[4], suppressed: n[5] });
  t11.deliveries.push(                                                                   // [queued, sent, delivered, read, failed, suppressed]
    del(D1, 'whatsapp', 'report', 'patient', A1, [1, 5, 4, 2, 1, 0]), del(D1, 'sms', 'report', 'patient', A2, [0, 3, 3, 0, 2, 1]),
    del(D2, 'whatsapp', 'report', 'referrer', A1, [2, 4, 3, 1, 0, 0]),
    del(D2, 'email', 'otp', 'phone_otp', null, [0, 6, 6, 0, 3, 2]),                       // non-report delivery, NULL centre: all-centre users only
    del(D0, 'whatsapp', 'report', 'patient', A1, [900, 900, 900, 900, 900, 900]), del(D3, 'whatsapp', 'report', 'patient', A1, [800, 800, 800, 800, 800, 800]),
    del(D1, 'whatsapp', 'report', 'patient', B1, [SENTINEL, SENTINEL, SENTINEL, SENTINEL, SENTINEL, SENTINEL], TB),
  );
  const rel = (date: string, centreId: string, kind: ReleaseFact['kind'], basis: string, released: number, tenantId = TA): ReleaseFact => ({ tenantId, date, centreId, kind, basis, released });
  t11.releases.push(
    rel(D1, A1, 'final', 'paid_in_full', 10), rel(D1, A1, 'partial', 'zero_balance', 2), rel(D1, A2, 'final', 'override', 3),
    rel(D2, A1, 'amended', 'paid_in_full', 1), rel(D2, A1, 'addendum', 'paid_in_full', 4), rel(D2, A1, 'preliminary', 'credit_party', 1),
    rel(D0, A1, 'final', 'paid_in_full', 700), rel(D3, A1, 'final', 'override', 710), rel(D1, B1, 'final', 'override', SENTINEL, TB),
  );
  const msg = (date: string, instrumentId: string, centreId: string, n: [number, number, number, number, number, number], tenantId = TA): MessageFact =>
    ({ tenantId, date, instrumentId, centreId, messages: n[0], patient: n[1], qc: n[2], unmatched: n[3], quarantined: n[4], duplicates: n[5] });
  t11.messages.push(                                                                     // [messages, patient, qc, unmatched, quarantined, duplicates]
    msg(D1, INSTR.CHEM, A1, [120, 100, 15, 2, 1, 2]), msg(D2, INSTR.CHEM, A1, [80, 70, 8, 1, 0, 1]), msg(D1, INSTR.HAE, A2, [50, 40, 10, 0, 0, 0]),
    msg(D2, INSTR.BARE, A1, [10, 8, 2, 0, 0, 0]),
    msg(D0, INSTR.CHEM, A1, [5000, 5000, 5000, 5000, 5000, 5000]), msg(D3, INSTR.CHEM, A1, [6000, 6000, 6000, 6000, 6000, 6000]),
    msg(D1, INSTR.FOREIGN, B1, [SENTINEL, SENTINEL, SENTINEL, SENTINEL, SENTINEL, SENTINEL], TB),
  );
  const ag = (agentId: string, centreId: string, state: string, heartbeat: string, version: string, queue: number, tenantId = TA): AgentFact => ({ tenantId, agentId, centreId, state, heartbeat, version, queue });
  t11.agents.push(
    ag(AGENT.ONLINE, A1, 'online', '2026-11-06T05:59:00.000Z', '1.4.2', 0), ag(AGENT.OFFLINE, A2, 'offline', '2026-11-05T23:10:00.000Z', '1.4.1', 12),
    ag(AGENT.DEGRADED, A1, 'degraded', '2026-11-06T05:40:00.000Z', '1.4.2', 7), ag(AGENT.FOREIGN, B1, 'online', '2026-11-06T05:59:00.000Z', '9.9.9', SENTINEL, TB),
  );
  t11.tests.push(
    { tenantId: TA, test_id: TEST.CBC, code: 'CBC', name: TEST_NAME.CBC, department_id: DEPT.H, is_active: true },
    { tenantId: TA, test_id: TEST.GLU, code: 'GLU', name: TEST_NAME.GLU, department_id: DEPT.H, is_active: true },
    { tenantId: TA, test_id: TEST.OLD, code: 'WIDAL', name: TEST_NAME.OLD, department_id: DEPT.B, is_active: false },
    { tenantId: TB, test_id: TEST.FOREIGN, code: 'DOP', name: TEST_NAME.FOREIGN, department_id: DEPT.FOREIGN, is_active: true },
  );
  t11.instruments.push(                                                                  // INSTR.BARE has NO directory row (short id only)
    { tenantId: TA, instrument_id: INSTR.CHEM, centre_id: A1, instrument_code: 'CHEM-01', display_name: 'Analyser One', is_active: true },
    { tenantId: TA, instrument_id: INSTR.HAE, centre_id: A2, instrument_code: 'HAE-02', display_name: 'Analyser Two', is_active: false },
    { tenantId: TB, instrument_id: INSTR.FOREIGN, centre_id: B1, instrument_code: 'XRAY-9', display_name: 'Tenant B Imager', is_active: true },
  );
  // departments (results labels + department_id filter); same ids/names as AN-T08's standard world
  db.departments.push(
    { tenantId: TA, department_id: DEPT.H, name: 'Haematology', is_active: true },
    { tenantId: TA, department_id: DEPT.B, name: 'Biochemistry', is_active: true },
    { tenantId: TB, department_id: DEPT.FOREIGN, name: 'Tenant B Radiology', is_active: true },
  );
}

// ------------------------------------------------------------------ emulators
type Scope = { all: boolean; centreIds: readonly string[] };
type Base = { tenantId: string; from: string; to: string; scope: Scope };
const inScope = (s: Scope, centreId: string | null) => s.all || (centreId !== null && s.centreIds.includes(centreId));
const inWin = (d: string, a: Base) => d >= a.from && d < a.to;
const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
const log = (fn: string, args: unknown) => { db.calls.push({ fn, args }); if (db.fail) throw db.fail; };
function group<T>(facts: T[], keyOf: (f: T) => string | null): Map<string | null, T[]> {
  const m = new Map<string | null, T[]>();
  for (const f of facts) { const k = keyOf(f); m.set(k, [...(m.get(k) ?? []), f]); }
  return m;
}
const sortedKeys = (m: Map<string | null, unknown>) => [...m.keys()].sort((a, b) => (a === null ? 1 : b === null ? -1 : a < b ? -1 : a > b ? 1 : 0));
const dateKey = (g: string, d: string): string | null => (g === 'day' ? d : g === 'ad_month' ? `${d.slice(0, 7)}-01` : null);

export const rollupsMockT11 = {
  ...rollupsMock,
  resultsRows: vi.fn(async (_tx: unknown, a: Base & { groupBy: string; departmentIds?: readonly string[]; processingBranchIds?: readonly string[] }) => {
    log('resultsRows', a);
    const facts = t11.results.filter((f) => f.tenantId === a.tenantId && inWin(f.date, a) && inScope(a.scope, f.centreId)
      && (!a.departmentIds?.length || a.departmentIds.includes(f.departmentId)) && (!a.processingBranchIds?.length || a.processingBranchIds.includes(f.branchId)));
    const keyOf = (f: ResultFact) => a.groupBy === 'department' ? f.departmentId : a.groupBy === 'test' ? f.testId : a.groupBy === 'processing_branch' ? f.branchId : dateKey(a.groupBy, f.date);
    const g = group(facts, keyOf);
    return sortedKeys(g).map((key) => {
      const x = g.get(key)!;
      return { key, results_resulted: sum(x.map((f) => f.resulted)), results_verified: sum(x.map((f) => f.verified)), results_approved: sum(x.map((f) => f.approved)),
        results_amended: sum(x.map((f) => f.amended)), auto_verified: sum(x.map((f) => f.auto)), critical_count: sum(x.map((f) => f.critical)),
        abnormal_count: sum(x.map((f) => f.abnormal)), tests_approved: sum(x.map((f) => f.testsApproved)) };
    });
  }),
  rejectionRows: vi.fn(async (_tx: unknown, a: Base & { groupBy: string }) => {
    log('rejectionRows', a);
    const facts = t11.rejections.filter((f) => f.tenantId === a.tenantId && inWin(f.date, a) && inScope(a.scope, f.centreId));
    const g = group(facts, (f) => a.groupBy === 'reason' ? f.reason : a.groupBy === 'centre' ? f.centreId : a.groupBy === 'specimen_type' ? f.specimenType : dateKey(a.groupBy, f.date));
    return sortedKeys(g).map((key) => ({ key, rejections: sum(g.get(key)!.map((f) => f.rejections)), recollections_ordered: sum(g.get(key)!.map((f) => f.recollections)) }));
  }),
  specimenRows: vi.fn(async (_tx: unknown, a: Base & { groupBy: string }) => {
    log('specimenRows', a);
    const facts = t11.specimens.filter((f) => f.tenantId === a.tenantId && inWin(f.date, a) && inScope(a.scope, f.centreId));
    const g = group(facts, (f) => a.groupBy === 'centre' ? f.centreId : a.groupBy === 'specimen_type' ? f.specimenType : dateKey(a.groupBy, f.date));
    return sortedKeys(g).map((key) => ({ key, received: sum(g.get(key)!.map((f) => f.received)) }));
  }),
  criticalValueRows: vi.fn(async (_tx: unknown, a: Base) => {
    log('criticalValueRows', a);
    const facts = t11.critical.filter((f) => f.tenantId === a.tenantId && inWin(f.date, a) && inScope(a.scope, f.centreId));
    const g = group(facts, (f) => f.date);
    return sortedKeys(g).map((d) => {
      const x = g.get(d)!; const maxes = x.map((f) => f.max).filter((m): m is number => m !== null);
      return { business_date: d as string, detected: sum(x.map((f) => f.detected)), notified: sum(x.map((f) => f.notified)),
        median_notify_seconds: x.length === 1 ? x[0]!.median : null, max_notify_seconds: maxes.length ? Math.max(...maxes) : null };
    });
  }),
  deliveryRows: vi.fn(async (_tx: unknown, a: Base & { groupBy: string }) => {
    log('deliveryRows', a);
    const facts = t11.deliveries.filter((f) => f.tenantId === a.tenantId && inWin(f.date, a) && inScope(a.scope, f.centreId));
    const g = group(facts, (f) => a.groupBy === 'channel' ? f.channel : dateKey(a.groupBy, f.date));
    return sortedKeys(g).map((key) => {
      const x = g.get(key)!;
      return { key, queued: sum(x.map((f) => f.queued)), sent: sum(x.map((f) => f.sent)), delivered: sum(x.map((f) => f.delivered)), read: sum(x.map((f) => f.read)),
        failed: sum(x.map((f) => f.failed)), suppressed: sum(x.map((f) => f.suppressed)) };
    });
  }),
  releaseRows: vi.fn(async (_tx: unknown, a: Base & { groupBy: string }) => {
    log('releaseRows', a);
    const facts = t11.releases.filter((f) => f.tenantId === a.tenantId && inWin(f.date, a) && inScope(a.scope, f.centreId));
    const g = group(facts, (f) => dateKey(a.groupBy, f.date));
    const of = (x: ReleaseFact[], kind: string) => sum(x.filter((f) => f.kind === kind).map((f) => f.released));
    return sortedKeys(g).map((key) => {
      const x = g.get(key)!;
      return { key, released: sum(x.map((f) => f.released)), final: of(x, 'final'), partial: of(x, 'partial'), preliminary: of(x, 'preliminary'), amended: of(x, 'amended'),
        overrides: sum(x.filter((f) => f.basis === 'override').map((f) => f.released)) };
    });
  }),
  interfaceMessageRows: vi.fn(async (_tx: unknown, a: Base) => {
    log('interfaceMessageRows', a);
    const facts = t11.messages.filter((f) => f.tenantId === a.tenantId && inWin(f.date, a) && inScope(a.scope, f.centreId));
    const g = group(facts, (f) => f.instrumentId);
    return sortedKeys(g).map((id) => {
      const x = g.get(id)!;
      return { instrument_id: id as string, centre_id: x[0]!.centreId, messages: sum(x.map((f) => f.messages)), patient_records: sum(x.map((f) => f.patient)),
        qc_records: sum(x.map((f) => f.qc)), unmatched: sum(x.map((f) => f.unmatched)), quarantined: sum(x.map((f) => f.quarantined)), duplicates: sum(x.map((f) => f.duplicates)) };
    });
  }),
  listAgentStatus: vi.fn(async (_tx: unknown, a: { tenantId: string; scope: Scope }) => agentRows(a)),
};
async function agentRows(a: { tenantId: string; scope: Scope }) {
  log('listAgentStatus', a);
  return t11.agents.filter((f) => f.tenantId === a.tenantId && inScope(a.scope, f.centreId)).sort((x, y) => (x.agentId < y.agentId ? -1 : 1))
    .map((f) => ({ agent_id: f.agentId, centre_id: f.centreId, state: f.state, last_heartbeat_at: f.heartbeat, agent_version: f.version, queue_depth: f.queue }));
}
export const sourceViewsMockT11 = { listAgentStatus: vi.fn(async (_tx: unknown, a: { tenantId: string; scope: Scope }) => agentRows(a)) };

export const labelsRepoMockT11 = {
  ...labelsRepoMock,
  listTests: vi.fn(async (_tx: unknown, a: { tenantId: string; ids?: readonly string[] }) =>
    t11.tests.filter((t) => t.tenantId === a.tenantId && (!a.ids || a.ids.includes(t.test_id))).map(({ test_id, code, name, department_id, is_active }) => ({ test_id, code, name, department_id, is_active }))),
  listInstruments: vi.fn(async (_tx: unknown, a: { tenantId: string; ids?: readonly string[] }) =>
    t11.instruments.filter((t) => t.tenantId === a.tenantId && (!a.ids || a.ids.includes(t.instrument_id)))
      .map(({ instrument_id, centre_id, instrument_code, display_name, is_active }) => ({ instrument_id, centre_id, instrument_code, display_name, is_active }))),
};

// ------------------------------------------------------------------ ctx + calls
export type Op11 = 'getTestsDoneReport' | 'getQualityIndicatorsReport' | 'getDeliveryReport' | 'getInterfacesReport';
export const OPS11: readonly Op11[] = ['getTestsDoneReport', 'getQualityIndicatorsReport', 'getDeliveryReport', 'getInterfacesReport'];

/** AN-T08 ctx with every export of reports.service reachable through ctx.services.analytics.reports (the handler may also import them). */
export async function makeCtx11(actorKey: string, over: Record<string, unknown> = {}) {
  const r = await makeCtx(actorKey, over);
  const mod: any = await import('../../service/reports.service.js');
  r.ctx.services.analytics.reports = { ...mod };
  return r;
}
export async function call11(op: Op11, ctx: any, query: Record<string, unknown> = {}) {
  const { handlers } = await import('../index.js');
  ctx.operationId = op;
  return handlers[op]({ params: {}, query, headers: {}, body: undefined }, ctx);
}
export async function ok11(op: Op11, ctx: any, query: Record<string, unknown> = {}): Promise<any> {
  const r = await call11(op, ctx, query);
  if (r.status !== 200) throw new Error(`expected 200 from ${op}, got ${r.status}`);
  return r.body;
}

// ------------------------------------------------------------------ contract validation: the 200 response schema of the operation in analytics.yaml
const readYaml = (f: string) => parse(readFileSync(join(REPO_ROOT, 'contracts', 'openapi', f), 'utf8'));
const DOCS = { analytics: readYaml('analytics.yaml'), common: readYaml('_common.yaml') };
type DocName = keyof typeof DOCS;
function deref(node: any, doc: DocName): any {
  if (Array.isArray(node)) return node.map((n) => deref(n, doc));
  if (!node || typeof node !== 'object') return node;
  if (typeof node.$ref === 'string') {
    const [file, ptr = ''] = node.$ref.split('#');
    const target: DocName = file ? 'common' : doc;
    return deref(ptr.split('/').slice(1).reduce((o: any, k: string) => o[k], DOCS[target]), target);
  }
  return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, deref(v, doc)]));
}
const compile = AjvCompiler() as unknown as (ext: object, o: { customOptions: object }) => (c: { schema: object }) => any;
const compiler = compile({}, { customOptions: { ...AJV_OPTIONS, coerceTypes: false, useDefaults: false } });
const PATH_OF: Record<Op11, string> = {
  getTestsDoneReport: '/v1/analytics/reports/tests-done', getQualityIndicatorsReport: '/v1/analytics/reports/quality-indicators',
  getDeliveryReport: '/v1/analytics/reports/delivery', getInterfacesReport: '/v1/analytics/reports/interfaces',
};
/** ajv errors of `body` against the operation's 200 schema (additionalProperties:false everywhere = the response allow-list); [] = valid. */
export function contractErrors11(op: Op11, body: unknown): string[] {
  const schema = DOCS.analytics.paths[PATH_OF[op]].get.responses['200'].content['application/json'].schema;
  const validate = compiler({ schema: deref(schema, 'analytics') });
  return validate(body) ? [] : (validate.errors ?? []).map((e: any) => `${e.instancePath || '/'} ${e.message}`);
}

export const WINDOW = { business_date_from: D1, business_date_to: D3 }; // [2026-11-05, 2026-11-07)
