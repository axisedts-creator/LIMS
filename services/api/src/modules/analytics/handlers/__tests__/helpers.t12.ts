// AN-T12 test helpers (not a test file). Synthetic data only. Used by tat.handler.test.ts and tat.security.test.ts.
// Builds on ./helpers.t11.ts (ids, actors, core fake, ctx factory, contract-validation pattern). The ONLY thing replaced is repository/tat.repo.js:
// an in-memory emulator of analytics.tat_facts that honours tenant, segment list, [from, to) on business_date, the scope predicate, the optional
// priority / specimen-type / processing-branch filters, the anomaly split and exact percentile_cont, exactly as TRD §6.6 states.
// Handler + service + mapper + labels.service are real. The SQL itself is covered by repository/__tests__/tat.repo.test.ts.
//
// CRAFTED TIMELINES -> FACTS. Tests describe specimens / orders as timelines (the columns of lab.v_pub_specimen_timeline and
// reporting.v_pub_order_report_tat) and `deriveFacts()` applies TRD §9.2 (the same rules refresh.repo.ts's TAT_ROWS applies in SQL):
//   pre_analytical = received - collected (stop received) | transport = received - in_transit (stop received) | within_lab = first_verified - received (stop first_verified)
//   specimen segments need both endpoints, rejected_at NULL and parent_specimen_id NULL; business_date = Asia/Kathmandu (+05:45) date of the STOP event;
//   total_first_release = first_released - registered | total_final_release = final_released - registered only when total_tat_seconds is present (allFinal);
//   order facts carry NULL branch / priority / specimen type; is_anomaly = stop < start (the row stays, stats ignore it).
//
// SEAM pinned here (the spec leaves the repo signature open; the writer may dispute through the reviewer):
//   tat.repo.tatRows(tx, { tenantId, from, to, scope, segments: Segment[], priority?: 'routine'|'urgent', specimenTypeCodes?: string[], processingBranchIds?: string[],
//                          groupBy: 'none'|'centre'|'processing_branch'|'priority'|'specimen_type'|'day'|'ad_month'|'bs_month' })
//     -> [{ segment, key: string|null, n, median_seconds|null, p90_seconds|null, max_seconds|null, anomalies }]   (UNROUNDED percentiles; the mapper rounds half-up)
//   key: day 'YYYY-MM-DD'; ad_month 'YYYY-MM-01'; centre / branch uuid; priority / specimen type code as-is; null = the fact's column is NULL.
//   The emulator also accepts groupBy 'bs_month' (key 'YYYY-MM' of the B.S. month) so a service may group in SQL or per B.S.-month sub-range: medians are not additive,
//   so per-day rows can never be merged into a month.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AjvCompiler } from '@fastify/ajv-compiler';
import { parse } from 'yaml';
import { vi } from 'vitest';
import { idFor } from '../../../../../../../packages/fakes/src/base';
import { adToBs, formatBs, type IsoDate } from '../../../../../../../packages/shared-ts/src/bsdate/index.js';
import { REPO_ROOT } from '../../../../core/module.js';
import { AJV_OPTIONS } from '../../../../core/openapi.js';
import { A1, A2, B1, BR1, BR2, BRB, D0, D1, D2, D3, TA, TB, db, resetDb, SENTINEL, makeCtx11 } from './helpers.t11.js';

export * from './helpers.t11.js';

export type Segment = 'pre_analytical' | 'transport' | 'within_lab' | 'total_first_release' | 'total_final_release';
export const SEGMENTS: readonly Segment[] = ['pre_analytical', 'transport', 'within_lab', 'total_first_release', 'total_final_release'];

// ------------------------------------------------------------------ timelines
export interface SpecimenTL {
  id: string; tenantId: string; centreId: string | null; branchId: string; type: string; priority: 'routine' | 'urgent';
  collected: string | null; inTransit: string | null; received: string | null; firstVerified: string | null; rejected: boolean; parent: boolean;
}
export interface OrderTL { id: string; tenantId: string; centreId: string | null; registered: string; firstReleased: string | null; finalReleased: string | null; allFinal: boolean }
export const t12 = { specimens: [] as SpecimenTL[], orders: [] as OrderTL[] };

/** Asia/Kathmandu wall clock -> ISO UTC. */
export const npt = (day: string, hms: string): string => new Date(Date.parse(`${day}T${hms}Z`) - 345 * 60_000).toISOString();
const plus = (iso: string, secs: number): string => new Date(Date.parse(iso) + secs * 1000).toISOString();
const SEED = 2;
let nextId = 0;
const sid = () => idFor(SEED, 0x1000 + ++nextId);
const oid = () => idFor(SEED, 0x2000 + ++nextId);

/** A specimen received at `day hms` (NPT). pre / transport / lab = seconds (negative = the earlier event is AFTER the later one; undefined = endpoint missing). */
export function SP(centreId: string | null, branchId: string, type: string, priority: 'routine' | 'urgent', day: string, hms: string,
  d: { pre?: number; transport?: number; lab?: number } = {}, o: { rejected?: boolean; parent?: boolean; notReceived?: boolean; tenantId?: string } = {}): SpecimenTL {
  const received = npt(day, hms);
  return {
    id: sid(), tenantId: o.tenantId ?? TA, centreId, branchId, type, priority, rejected: o.rejected ?? false, parent: o.parent ?? false,
    received: o.notReceived ? null : received,
    collected: d.pre === undefined ? null : plus(received, -d.pre),
    inTransit: d.transport === undefined ? null : plus(received, -d.transport),
    firstVerified: d.lab === undefined ? null : plus(received, d.lab),
  };
}
/** An order registered at `day hms` (NPT); first / final = seconds after registration (undefined = not released / not final). allFinal = total_tat_seconds present. */
export function OR(centreId: string | null, day: string, hms: string, d: { first?: number; final?: number } = {}, o: { allFinal?: boolean; tenantId?: string } = {}): OrderTL {
  const registered = npt(day, hms);
  return {
    id: oid(), tenantId: o.tenantId ?? TA, centreId, registered,
    firstReleased: d.first === undefined ? null : plus(registered, d.first),
    finalReleased: d.final === undefined ? null : plus(registered, d.final),
    allFinal: o.allFinal ?? d.final !== undefined,
  };
}

// ------------------------------------------------------------------ facts (TRD §9.2)
export interface TatFact {
  tenantId: string; segment: Segment; subjectId: string; centreId: string | null; branchId: string | null; priority: 'routine' | 'urgent' | null;
  type: string | null; businessDate: string; duration: number; anomaly: boolean;
}
const secs = (a: string, b: string) => Math.floor((Date.parse(b) - Date.parse(a)) / 1000);
const businessDate = (iso: string) => new Date(Date.parse(iso) + 345 * 60_000).toISOString().slice(0, 10);

export function deriveFacts(): TatFact[] {
  const out: TatFact[] = [];
  for (const s of t12.specimens) {
    if (s.rejected || s.parent) continue;
    const add = (segment: Segment, start: string | null, stop: string | null) => {
      if (!start || !stop) return; // missing endpoint: no fact
      out.push({ tenantId: s.tenantId, segment, subjectId: s.id, centreId: s.centreId, branchId: s.branchId, priority: s.priority, type: s.type,
        businessDate: businessDate(stop), duration: secs(start, stop), anomaly: Date.parse(stop) < Date.parse(start) });
    };
    add('pre_analytical', s.collected, s.received);
    add('transport', s.inTransit, s.received);
    add('within_lab', s.received, s.firstVerified);
  }
  for (const o of t12.orders) {
    const add = (segment: Segment, stop: string | null) => {
      if (!stop) return;
      out.push({ tenantId: o.tenantId, segment, subjectId: o.id, centreId: o.centreId, branchId: null, priority: null, type: null,
        businessDate: businessDate(stop), duration: secs(o.registered, stop), anomaly: Date.parse(stop) < Date.parse(o.registered) });
    };
    add('total_first_release', o.firstReleased);
    if (o.allFinal) add('total_final_release', o.finalReleased);
  }
  return out;
}

// ------------------------------------------------------------------ the standard crafted world (window [D1, D3) = 2026-11-05 .. 2026-11-06 NPT)
export const D = { D0, D1, D2, D3 };
export function seedT12(): void {
  resetDb();
  nextId = 0;
  t12.specimens.length = 0; t12.orders.length = 0;
  t12.specimens.push(
    SP(A1, BR1, 'serum', 'routine', D1, '10:00:00', { pre: 600, transport: 1000, lab: 1200 }),    // s1
    SP(A1, BR1, 'serum', 'routine', D1, '11:00:00', { pre: 1200, lab: 1801 }),                    // s2  no transport endpoint
    SP(A2, BR2, 'serum', 'routine', D1, '12:00:00', { pre: 3600, transport: 2000, lab: 3000 }),   // s3
    SP(A1, BR2, 'edta', 'urgent', D2, '09:00:00', { pre: 300, transport: 4000, lab: 7200 }),      // s4
    SP(A1, BR1, 'edta', 'routine', D2, '10:00:00', { pre: 1800 }),                                // s5  not verified yet
    SP(A1, BR1, 'serum', 'routine', D2, '11:00:00', { pre: 2400 }),                               // s6
    SP(A1, BR1, 'serum', 'routine', D1, '13:00:00', { pre: -120, transport: -60 }),               // s7  received before collected / scanned out AFTER scan-in
    SP(A1, BR1, 'serum', 'routine', D1, '13:30:00', { lab: -30 }),                                // s8  verified before received
    SP(A1, BR1, 'serum', 'routine', D1, '14:00:00', { pre: -500, transport: 99_999, lab: 99_999 }, { rejected: true }), // s9  rejected: nothing, not even anomalies
    SP(A1, BR1, 'serum', 'routine', D1, '15:00:00', { pre: 88_888, transport: -500, lab: 88_888 }, { parent: true }),   // s10 aliquot
    SP(A1, BR1, 'serum', 'routine', D1, '16:00:00', { pre: 5000 }, { notReceived: true }),                              // s11 never received: no stop event
    SP(null, BR1, 'serum', 'routine', D2, '12:00:00', { pre: 4000 }),                                                   // s16 NULL centre: all-centre users only
    SP(A1, BR1, 'serum', 'routine', D0, '10:00:00', { pre: 77_777, transport: 77_777, lab: 40_404 }),                   // before the window
    SP(A1, BR1, 'serum', 'routine', D3, '10:00:00', { pre: 66_666, transport: 66_666, lab: 66_666 }),                   // after the window
    SP(B1, BRB, 'serum', 'routine', D1, '10:00:00', { pre: SENTINEL, transport: SENTINEL, lab: SENTINEL }, { tenantId: TB }),
  );
  t12.orders.push(
    OR(A1, D1, '08:00:00', { first: 3600, final: 7200 }),                       // o1
    OR(A1, D1, '09:00:00', { first: 1800, final: 86_400 }),                     // o2  final lands on D2
    OR(A2, D2, '08:00:00', { first: 7200 }),                                    // o3  no final report yet
    OR(A1, D2, '09:00:00', { first: -60 }),                                     // o4  first release before registration: anomaly
    OR(A1, D1, '07:00:00'),                                                     // o5  nothing released
    OR(A1, D1, '11:00:00', { first: 600, final: 3000 }, { allFinal: false }),   // o7  one family final, others not: counts for M63, NOT for M64
    OR(null, D2, '10:00:00', { first: 5000, final: 9000 }),                     // o8  NULL centre
    OR(A1, D0, '08:00:00', { first: 3600, final: 7200 }),                       // before the window
    OR(A1, D2, '22:00:00', { first: 7200, final: 7200 }),                       // first release at D3 00:00..02:00 NPT: after the window
    OR(B1, D1, '08:00:00', { first: SENTINEL, final: SENTINEL }, { tenantId: TB }),
  );
}

// ------------------------------------------------------------------ the tat.repo emulator
type Scope = { all: boolean; centreIds: readonly string[] };
type Args = {
  tenantId: string; from: string; to: string; scope: Scope; segments?: readonly Segment[]; priority?: string; specimenTypeCodes?: readonly string[];
  processingBranchIds?: readonly string[]; groupBy: string;
};
const percentile = (sorted: number[], p: number): number => {
  const pos = p * (sorted.length - 1); const lo = Math.floor(pos); const hi = Math.ceil(pos);
  return sorted[lo]! + (pos - lo) * (sorted[hi]! - sorted[lo]!);
};
const keyOf = (g: string, f: TatFact): string | null => {
  switch (g) {
    case 'none': return null;
    case 'centre': return f.centreId;
    case 'processing_branch': return f.branchId;
    case 'priority': return f.priority;
    case 'specimen_type': return f.type;
    case 'day': return f.businessDate;
    case 'ad_month': return `${f.businessDate.slice(0, 7)}-01`;
    case 'bs_month': return formatBs(adToBs(f.businessDate as IsoDate)).slice(0, 7);
    default: throw new Error(`mock: unsupported groupBy ${g}`);
  }
};
export const tatMockT12 = {
  tatRows: vi.fn(async (_tx: unknown, a: Args) => {
    db.calls.push({ fn: 'tatRows', args: a });
    if (db.fail) throw db.fail;
    const segs = a.segments?.length ? a.segments : SEGMENTS;
    const facts = deriveFacts().filter((f) => f.tenantId === a.tenantId && segs.includes(f.segment) && f.businessDate >= a.from && f.businessDate < a.to
      && (a.scope.all || (f.centreId !== null && a.scope.centreIds.includes(f.centreId)))
      && (!a.priority || f.priority === a.priority)
      && (!a.specimenTypeCodes?.length || (f.type !== null && a.specimenTypeCodes.includes(f.type)))
      && (!a.processingBranchIds?.length || (f.branchId !== null && a.processingBranchIds.includes(f.branchId))));
    const groups = new Map<string, { segment: Segment; key: string | null; facts: TatFact[] }>();
    for (const f of facts) {
      const key = keyOf(a.groupBy, f); const id = `${f.segment}|${key ?? ''}|${key === null ? 'n' : 'k'}`;
      const g = groups.get(id) ?? { segment: f.segment, key, facts: [] }; g.facts.push(f); groups.set(id, g);
    }
    return [...groups.values()]
      .sort((x, y) => SEGMENTS.indexOf(x.segment) - SEGMENTS.indexOf(y.segment) || (x.key === null ? 1 : y.key === null ? -1 : x.key < y.key ? -1 : x.key > y.key ? 1 : 0))
      .map((g) => {
        const d = g.facts.filter((f) => !f.anomaly).map((f) => f.duration).sort((p, q) => p - q);
        return { segment: g.segment, key: g.key, n: d.length, median_seconds: d.length ? percentile(d, 0.5) : null, p90_seconds: d.length ? percentile(d, 0.9) : null,
          max_seconds: d.length ? d[d.length - 1]! : null, anomalies: g.facts.filter((f) => f.anomaly).length };
      });
  }),
};

// ------------------------------------------------------------------ calls + contract
export const makeCtx12 = makeCtx11;
export async function call12(ctx: any, query: Record<string, unknown> = {}) {
  const { handlers } = await import('../index.js');
  ctx.operationId = 'getTatReport';
  return handlers.getTatReport({ params: {}, query, headers: {}, body: undefined }, ctx);
}
export async function ok12(ctx: any, query: Record<string, unknown> = {}): Promise<any> {
  const r = await call12(ctx, query);
  if (r.status !== 200) throw new Error(`expected 200 from getTatReport, got ${r.status}`);
  return r.body;
}

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
/** ajv errors of `body` against the 200 schema of getTatReport (additionalProperties:false everywhere = the response allow-list); [] = valid. */
export function contractErrors12(body: unknown): string[] {
  const schema = DOCS.analytics.paths['/v1/analytics/reports/tat'].get.responses['200'].content['application/json'].schema;
  const validate = compiler({ schema: deref(schema, 'analytics') });
  return validate(body) ? [] : (validate.errors ?? []).map((e: any) => `${e.instancePath || '/'} ${e.message}`);
}

export const WINDOW12 = { business_date_from: D1, business_date_to: D3 };
