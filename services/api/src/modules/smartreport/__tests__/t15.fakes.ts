// C14 T15 emulators + ctx (not a test file). Loaded by vi.mock factories, so it must NOT import summary.service or the handlers. Synthetic data only.
//
// SEAMS pinned for T15 (the spec fixes behaviour + names, not TypeScript shapes):
//   Handlers #27-#32 run for real through the handlers map. Handler ctx: ctx.tenantId, ctx.actor.id + ctx.actor.membershipId, ctx.tx (only pg_advisory_xact_lock via tx.query),
//     ctx.ports.{IdentityPort,FrontdeskPort,LabPort,CatalogPort}, ctx.core.memberships.list (P-17, batched), ctx.audit.access(entry), ctx.commitOnError().
//   Repositories are vi.mock'd (stateful emulators below): summaries.repo (the T12 emulator + listReviewQueue), reviews.repo (insertSummaryReview / listSummaryReviews),
//     codedSets.repo (listRejectReasons), plus the library repos for #30 (T12 emulators).
//   #27 pages in memory over summariesRepo.listReviewQueue(rc, { status, centreId?, limit, ... }): the emulator honours status (string | comma list | array), centreId and limit; any
//     key matching /critical/i, /from/i, /to/i (hasCritical, builtAtFrom, ...) is applied when present, so filtering in SQL or in memory both pass. RLS is NOT emulated: the handler
//     must itself keep a centre-scoped actor to their centres (pass centreId or filter) and refuse #28/#29 for another centre (auth.forbidden or common.not_found, never a body).
//   #31/#32: caller membership = ctx.actor.membershipId. The state change is summariesRepo.updateSummary(rc, id, expectedVersion = If-Match, lifecycle patch) and the history row is
//     reviewsRepo.insertSummaryReview(rc, { id, centre_id, summary_id, action, reason_code?, comment?, actor_membership_id }).
//   #31 stale hash: updateSummary(status 'superseded', superseded_at, superseded_reason 'results_changed'), ctx.commitOnError() BEFORE throwing LimsError smartreport.summary_superseded
//     (03-APP-FLOW S3); the test transaction emulation keeps the writes when commitOnError was called and rolls everything back otherwise.
//   ctx.audit.access: core validation accepts outcome 'allowed' | 'denied' only (services/api/src/core/audit/access.ts), so 'success' of 03-APP-FLOW §2.2 is 'allowed' here.
import { vi } from 'vitest';
import { idFor } from '../../../../../../packages/fakes/src/base';
import { MID, SEED, makeCtx as makeBaseCtx, type Persona } from './t11.fakes.js';
import {
  CENTRE, CatalogPort, FrontdeskPort, LabPort, ORDER, REG_NO, TA, ac081, approveLibrary, codedSetsRepoFake as codedSetsT12, result, seed as seedT12, setResults,
  summariesRepoFake as summariesT12, uid, w,
} from './t12.fakes.js';

export * from './t12.fakes.js';
export { MID, SEED, type Persona };
type Row = Record<string, any>;

export const FD_CENTRE = idFor(SEED, 0xc1);                  // the centre of the persona 'front_desk' (t11.fakes PERSONAS)
export const ORDER3 = uid(0xa003);
export const ALL_ORDERS = [ORDER.a, ORDER.a2, ORDER3];
const clone = <T>(x: T): T => structuredClone(x);
const pgErr = (code: string, message: string): Error => Object.assign(new Error(message), { code });

// ---------------------------------------------------------------- repositories
export const rv = { rows: [] as Row[], seq: 0 };
const REVIEW_INS = ['id', 'centre_id', 'summary_id', 'action', 'reason_code', 'comment', 'actor_membership_id'];
const REVIEW_ACTIONS = ['approved', 'rejected', 'superseded', 'llm_rephrase_requested'];

export const reviewsRepoFake = {
  insertSummaryReview: vi.fn(async (rc: any, row: Row) => {
    w.calls.push({ fn: 'insertSummaryReview', tenantId: rc.tenantId, args: [clone(row)] }); w.writes.push('insertSummaryReview'); await new Promise((r) => setImmediate(r));
    const bad = Object.keys(row).filter((k) => !REVIEW_INS.includes(k));
    if (bad.length) throw new Error(`insertSummaryReview: column(s) not allowed: ${bad.join(', ')}`);
    if (!REVIEW_ACTIONS.includes(row.action)) throw pgErr('23514', 'summary_reviews__action__ck');
    if (!w.summaries.some((s) => s.tenant_id === rc.tenantId && s.id === row.summary_id)) throw pgErr('23503', 'summary_reviews__summary__fk');
    const r: Row = { reason_code: null, comment: null, actor_membership_id: null, ...Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined)),
      tenant_id: rc.tenantId, created_by: rc.actorId, created_at: new Date(Date.UTC(2026, 10, 12, 1, 0, ++rv.seq)).toISOString() };
    rv.rows.push(r); return clone(r);
  }),
  listSummaryReviews: vi.fn(async (rc: any, summaryId: string) => {
    w.calls.push({ fn: 'listSummaryReviews', tenantId: rc.tenantId, args: [summaryId] });
    return clone(rv.rows.filter((r) => r.tenant_id === rc.tenantId && r.summary_id === summaryId).sort((a, b) => a.created_at.localeCompare(b.created_at)));
  }),
  insertLibraryReview: vi.fn(async () => { throw new Error('T15 must not touch library_reviews'); }),
  listLibraryReviews: vi.fn(async () => { throw new Error('T15 must not touch library_reviews'); }),
};

const REASONS = [['wording_problem', 10], ['library_error', 20], ['not_appropriate_for_patient', 30], ['results_under_review', 40], ['other', 90]] as const;
export const codedSetsRepoFake = {
  ...codedSetsT12,
  listRejectReasons: vi.fn(async (rc: any) => { w.calls.push({ fn: 'listRejectReasons', tenantId: rc.tenantId, args: [] }); return REASONS.map(([code, sort_order]) => ({ code, display: code, sort_order, is_active: true })); }),
};

const statusesOf = (s: unknown): string[] => (Array.isArray(s) ? s : String(s).split(',')).map(String);
export const summariesRepoFake = {
  ...summariesT12,
  listReviewQueue: vi.fn(async (rc: any, q: Row) => {
    w.calls.push({ fn: 'listReviewQueue', tenantId: rc.tenantId, args: [clone(q)] });
    const st = statusesOf(q.status);
    let rows = w.summaries.filter((s) => s.tenant_id === rc.tenantId && st.includes(s.status) && (q.centreId === undefined || s.centre_id === q.centreId));
    for (const [k, v] of Object.entries(q)) {
      if (v === undefined || v === null) continue;
      if (/critical/i.test(k) && v === true) rows = rows.filter((s) => s.critical_count > 0);
      else if (/critical/i.test(k) && v === false) rows = rows.filter((s) => s.critical_count === 0);
      else if (/from/i.test(k) && k !== 'centreId') rows = rows.filter((s) => Date.parse(s.built_at) >= Date.parse(String(v)));
      else if (/(^to$|To$|_to$)/.test(k)) rows = rows.filter((s) => Date.parse(s.built_at) <= Date.parse(String(v)));
    }
    rows = [...rows].sort((a, b) => Date.parse(a.built_at) - Date.parse(b.built_at) || a.id.localeCompare(b.id));
    return clone(rows.slice(0, typeof q.limit === 'number' ? q.limit : 200));
  }),
};

// ---------------------------------------------------------------- ctx
export interface T15Ctx { ctx: any; asserted: { permission: string; centreId?: string }[]; access: Row[] }
/** Handler ctx: T11's real IdentityPort/CatalogPort + memberships.list, T12's Frontdesk/Lab fakes, an advisory-lock tx, audit.access spy. `flag` = tenant feature flag smart_report. */
export function makeCtx(persona: Persona, operationId: string, tenant: 'A' | 'B' = 'A', o: { flag?: boolean } = {}): T15Ctx {
  const { ctx, asserted } = makeBaseCtx(persona, operationId, tenant);
  const access: Row[] = [];
  const identity = ctx.ports.IdentityPort;
  const settings = async (_c: unknown, input?: { keys?: string[] }) => { const all: Row = { featureFlags: { smart_report: o.flag !== false } }; return input?.keys ? Object.fromEntries(input.keys.map((k) => [k, all[k]])) : all; };
  identity.getTenantSettings = vi.fn(settings);
  ctx.ports = { ...ctx.ports, IdentityPort: identity, FrontdeskPort, LabPort, CatalogPort };
  ctx.tx = {
    query: vi.fn(async (text: string, values?: unknown[]) => {
      if (!/pg_advisory_xact_lock/i.test(String(text))) throw new Error('handlers must reach the database only through the repositories (and the advisory lock)');
      w.calls.push({ fn: 'lock', tenantId: ctx.tenantId, args: [String(text), values ?? []] }); return { rows: [] };
    }),
    async savepoint(fn: (t: unknown) => Promise<unknown>) { return fn(ctx.tx); },
  };
  ctx.audit = { access: vi.fn(async (e: Row) => { access.push(clone(e)); }) };
  ctx.now = () => new Date().toISOString();
  return { ctx, asserted, access };
}

// ---------------------------------------------------------------- transaction emulation (what the core does around a handler)
const snap = (): Row => clone({ s: w.summaries, r: rv.rows, b: w.bindings, seq: rv.seq });
const back = (s: Row): void => { w.summaries = clone(s.s); rv.rows = clone(s.r); w.bindings = clone(s.b); rv.seq = s.seq; };
/** One request transaction: a thrown error rolls everything back unless the handler called ctx.commitOnError() first. */
export async function inTx<T>(ctx: any, fn: () => Promise<T>, o: { shared?: boolean } = {}): Promise<T> {
  const before = o.shared ? null : snap();
  try { return await fn(); } catch (e) { if (before && ctx.commitOnError.mock.calls.length === 0) back(before); throw e; }
}

// ---------------------------------------------------------------- fixtures
const order = (base: number): Row[] => [result(base + 1, 'HGB', 'L'), result(base + 2, 'WBC'), result(base + 3, 'PLT'), result(base + 4, 'ALT'), result(base + 5, 'AST'), result(base + 6, 'CREAT')];
export const HGB_RESULT = { a: ac081()[0]!.resultId, a2: order(20)[0]!.resultId };
/** Fresh T12 world + an approved library v1 + three orders (a: CENTRE.a, a2: the front_desk centre, 3: CENTRE.a). No summaries yet. */
export function seedWorld(): void {
  seedT12(); approveLibrary(1); rv.rows = []; rv.seq = 0;
  w.orders.push({ tenantId: TA, orderId: ORDER3, patientId: uid(0xa103), centreId: CENTRE.a });
  const a2 = w.orders.find((o) => o.orderId === ORDER.a2)!; a2.centreId = FD_CENTRE;
  setResults(ORDER.a, units(ac081())); setResults(ORDER.a2, units(order(20))); setResults(ORDER3, units(order(30)));
}
/** The contract's unit_code is a Code (^[A-Za-z0-9][A-Za-z0-9_.:-]*$): 'g/dL' of the T12 fixture cannot be served, so T15 orders use 'g_dL'. */
const units = (rs: Row[]): Row[] => rs.map((r) => (r.unitCode ? { ...r, unitCode: 'g_dL' } : r));
/** Re-applies the T15 units after a test replaced an order's results with ac081()-style rows. */
export const t15Results = units;
export const REGISTRATION = REG_NO;
