// AN-T08 test helpers (not a test file). Synthetic data only. Used by income.handler.test.ts and departmentIncome.handler.test.ts.
// The two rollup repositories are replaced by in-memory emulators of analytics.daily_income / analytics.daily_department_income:
// they honour tenant, [from, to), the scope predicate and the department filter exactly as TRD §6 states, so these tests
// exercise handler + service + mapper + labels.service for real. The SQL itself is covered by repository/__tests__/rollups.repo.test.ts.
//
// SEAMS pinned here (the spec leaves the repo signatures open; the writer may dispute through the reviewer):
//   rollups.repo.incomeRows(tx, { tenantId, from, to, scope, groupBy: 'day'|'ad_month'|'branch'|'centre' })
//       -> [{ key, invoices_issued, invoices_cancelled, gross_paisa, discount_paisa, exempt_paisa, taxable_paisa, vat_paisa,
//             other_tax_paisa, invoiced_paisa, credit_notes_paisa, net_sales_paisa }]   (numbers, ascending by key)
//       key: day 'YYYY-MM-DD'; ad_month 'YYYY-MM-01'; branch/centre uuid.  bs_month = the service asks for 'day' and groups itself.
//   rollups.repo.departmentIncomeRows(tx, { tenantId, from, to, scope, departmentIds?, grain: 'total'|'day' })
//       -> [{ business_date: 'YYYY-MM-DD'|null (null when grain 'total'), department_id: uuid|null, line_count, gross_paisa, discount_paisa, net_paisa }]
//   reports.service exports `income(ctx, { period, scope, groupBy })` and `departmentIncome(ctx, { period, scope, groupBy, departmentIds })`
//       (TRD §5.2); the handler may call them through ctx.services.analytics.reports or import them: both work with this harness.
//   R2 mismatch: ctx.metrics.inc('lims_analytics_reconciliation_mismatch_total', { rule: 'R2', ... }) and ctx.log.warn({ event: 'reconciliation_mismatch', ... }).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AjvCompiler } from '@fastify/ajv-compiler';
import { parse } from 'yaml';
import { vi } from 'vitest';
import { createFakeIdentityPort, type MembershipRow } from '../../../../../../../packages/fakes/src/IdentityPort.fake';
import { TENANTS, actorIdFor, idFor } from '../../../../../../../packages/fakes/src/base';
import { makeCtxFor } from '../../../../../../../packages/fakes/src/harness';
import { LimsError, isLimsError } from '../../../../core/errors.js';
import { REPO_ROOT } from '../../../../core/module.js';
import { AJV_OPTIONS } from '../../../../core/openapi.js';

// ------------------------------------------------------------------ ids
const SEED = 1;
export const A1 = idFor(SEED, 0xc1);   // tenant A centres (A1 + A2 in branch BR1, A3 in BR2, A3 inactive)
export const A2 = idFor(SEED, 0xc3);
export const A3 = idFor(SEED, 0xc4);
export const B1 = idFor(SEED, 0xc2);   // tenant B centre
export const BR1 = idFor(SEED, 0xbb01);
export const BR2 = idFor(SEED, 0xbb02);
export const BRB = idFor(SEED, 0xbb03);
export const DEPT = { H: idFor(SEED, 0xd1), B: idFor(SEED, 0xd2), OLD: idFor(SEED, 0xd3), FOREIGN: idFor(SEED, 0xd4), UNKNOWN: idFor(SEED, 0xd5) };
export const DEPT_NAME = { H: 'Haematology', B: 'Biochemistry', OLD: 'Legacy Serology', FOREIGN: 'Tenant B Radiology' };
const TENANT_OF: Record<string, string> = { [A1]: 'A', [A2]: 'A', [A3]: 'A', [B1]: 'B', [BR1]: 'A', [BR2]: 'A', [BRB]: 'B' };
const BRANCH_OF: Record<string, string> = { [A1]: BR1, [A2]: BR1, [A3]: BR2, [B1]: BRB };
export const BRANCH_NAME = (id: string) => `Branch ${id.slice(-4)}`;
export const CENTRE_NAME = (id: string) => `Centre ${id.slice(-4)}`;
export const TA = TENANTS.A;
export const TB = TENANTS.B;

// ------------------------------------------------------------------ in-memory rollup tables
export interface IncomeFact {
  tenantId: string; date: string; branchId: string; centreId: string | null;
  issued: number; cancelled: number; gross: number; discount: number; exempt: number; taxable: number; vat: number; other: number; net: number; credit: number;
}
export interface DeptFact { tenantId: string; date: string; branchId: string; centreId: string | null; departmentId: string | null; lines: number; gross: number; discount: number; net: number }
export const db = {
  income: [] as IncomeFact[],
  dept: [] as DeptFact[],
  departments: [] as { tenantId: string; department_id: string; name: string; is_active: boolean }[],
  calls: [] as { fn: string; args: any }[],
  fail: undefined as unknown,
};
export function resetDb(): void {
  db.income = []; db.dept = []; db.departments = []; db.calls = []; db.fail = undefined;
}

/** Invoice-side fact: net = taxable + vat (C4 invoices__totals__ck with exempt = other = 0), gross = taxable + discount. */
export function incFact(date: string, centreId: string | null, o: { issued?: number; cancelled?: number; discount?: number; taxable: number; vat?: number; credit?: number; tenantId?: string; branchId?: string }): IncomeFact {
  const vat = o.vat ?? 0; const discount = o.discount ?? 0;
  return {
    tenantId: o.tenantId ?? TA, date, branchId: o.branchId ?? (centreId ? BRANCH_OF[centreId]! : BR1), centreId,
    issued: o.issued ?? 1, cancelled: o.cancelled ?? 0, gross: o.taxable + discount, discount, exempt: 0, taxable: o.taxable, vat, other: 0,
    net: o.taxable + vat, credit: o.credit ?? 0,
  };
}
export const deptFact = (date: string, centreId: string | null, departmentId: string | null, o: { lines: number; gross: number; discount?: number; net: number; tenantId?: string }): DeptFact => ({
  tenantId: o.tenantId ?? TA, date, branchId: centreId ? BRANCH_OF[centreId]! : BR1, centreId, departmentId,
  lines: o.lines, gross: o.gross, discount: o.discount ?? 0, net: o.net,
});

export const D0 = '2026-11-04', D1 = '2026-11-05', D2 = '2026-11-06', D3 = '2026-11-07'; // report window is [D1, D3)

/**
 * Standard world (hand-computed expectations live in the tests). Window [D1, D3):
 *   income  D1 A1 invoiced 10170 | D1 A2 5650 | D2 A1 invoiced 2260 with credit notes 3000 (negative day: -740); totals invoiced 18080, credit 3000, net 15080.
 *   dept    sums to the same net per (day, centre) so R2 holds for every period and scope; NULL department = package line; OLD is deactivated.
 *   out-of-window rows on D0 and D3, and tenant B rows with huge values (must never show).
 */
export function seedStandard(): void {
  resetDb();
  db.income.push(
    incFact(D1, A1, { issued: 3, cancelled: 1, discount: 1000, taxable: 9000, vat: 1170 }),
    incFact(D1, A2, { issued: 2, taxable: 5000, vat: 650 }),
    incFact(D2, A1, { issued: 1, taxable: 2000, vat: 260, credit: 3000 }),
    incFact(D0, A1, { taxable: 111 }), incFact(D3, A1, { taxable: 222 }),
    incFact(D1, B1, { tenantId: TB, branchId: BRB, issued: 9, taxable: 999_999, vat: 0, credit: 888_888 }),
  );
  db.dept.push(
    deptFact(D1, A1, DEPT.H, { lines: 3, gross: 6000, discount: 1000, net: 5000 }),
    deptFact(D1, A1, DEPT.OLD, { lines: 1, gross: 1500, net: 1500 }),
    deptFact(D1, A1, DEPT.B, { lines: 2, gross: 3200, net: 3200 }),
    deptFact(D1, A1, null, { lines: 1, gross: 500, discount: 30, net: 470 }),
    deptFact(D1, A2, DEPT.H, { lines: 3, gross: 5650, net: 5650 }),
    deptFact(D2, A1, DEPT.H, { lines: 1, gross: 2260, net: -740 }),
    deptFact(D0, A1, DEPT.H, { lines: 1, gross: 111, net: 111 }), deptFact(D3, A1, DEPT.H, { lines: 1, gross: 222, net: 222 }),
    deptFact(D1, B1, DEPT.FOREIGN, { tenantId: TB, lines: 99, gross: 999_999, net: 999_999 }),
  );
  db.departments.push(
    { tenantId: TA, department_id: DEPT.H, name: DEPT_NAME.H, is_active: true },
    { tenantId: TA, department_id: DEPT.B, name: DEPT_NAME.B, is_active: true },
    { tenantId: TA, department_id: DEPT.OLD, name: DEPT_NAME.OLD, is_active: false },
    { tenantId: TB, department_id: DEPT.FOREIGN, name: DEPT_NAME.FOREIGN, is_active: true },
  );
}

// ------------------------------------------------------------------ repo emulators (used from vi.mock factories)
type Scope = { all: boolean; centreIds: readonly string[] };
const inScope = (s: Scope, centreId: string | null) => s.all || (centreId !== null && s.centreIds.includes(centreId));
const inWindow = (date: string, from: string, to: string) => date >= from && date < to;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export const rollupsMock = {
  incomeRows: vi.fn(async (_tx: unknown, a: { tenantId: string; from: string; to: string; scope: Scope; groupBy: string }) => {
    db.calls.push({ fn: 'incomeRows', args: a });
    if (db.fail) throw db.fail;
    const facts = db.income.filter((f) => f.tenantId === a.tenantId && inWindow(f.date, a.from, a.to) && inScope(a.scope, f.centreId));
    const keyOf = (f: IncomeFact) => a.groupBy === 'day' ? f.date : a.groupBy === 'ad_month' ? `${f.date.slice(0, 7)}-01`
      : a.groupBy === 'branch' ? f.branchId : a.groupBy === 'centre' ? String(f.centreId) : (() => { throw new Error(`mock: groupBy ${a.groupBy}`); })();
    const groups = new Map<string, IncomeFact[]>();
    for (const f of facts) groups.set(keyOf(f), [...(groups.get(keyOf(f)) ?? []), f]);
    return [...groups.keys()].sort().map((key) => {
      const g = groups.get(key)!; const invoiced = sum(g.map((f) => f.net)); const credit = sum(g.map((f) => f.credit));
      return {
        key, invoices_issued: sum(g.map((f) => f.issued)), invoices_cancelled: sum(g.map((f) => f.cancelled)), gross_paisa: sum(g.map((f) => f.gross)),
        discount_paisa: sum(g.map((f) => f.discount)), exempt_paisa: sum(g.map((f) => f.exempt)), taxable_paisa: sum(g.map((f) => f.taxable)),
        vat_paisa: sum(g.map((f) => f.vat)), other_tax_paisa: sum(g.map((f) => f.other)), invoiced_paisa: invoiced, credit_notes_paisa: credit, net_sales_paisa: invoiced - credit,
      };
    });
  }),
  departmentIncomeRows: vi.fn(async (_tx: unknown, a: { tenantId: string; from: string; to: string; scope: Scope; departmentIds?: readonly string[]; grain: 'total' | 'day' }) => {
    db.calls.push({ fn: 'departmentIncomeRows', args: a });
    if (db.fail) throw db.fail;
    const facts = db.dept.filter((f) => f.tenantId === a.tenantId && inWindow(f.date, a.from, a.to) && inScope(a.scope, f.centreId)
      && (!a.departmentIds?.length || (f.departmentId !== null && a.departmentIds.includes(f.departmentId))));
    const groups = new Map<string, DeptFact[]>();
    const keyOf = (f: DeptFact) => `${a.grain === 'day' ? f.date : ''}|${f.departmentId ?? ''}`;
    for (const f of facts) groups.set(keyOf(f), [...(groups.get(keyOf(f)) ?? []), f]);
    return [...groups.keys()].sort().map((k) => {
      const g = groups.get(k)!;
      return {
        business_date: a.grain === 'day' ? g[0]!.date : null, department_id: g[0]!.departmentId, line_count: sum(g.map((f) => f.lines)),
        gross_paisa: sum(g.map((f) => f.gross)), discount_paisa: sum(g.map((f) => f.discount)), net_paisa: sum(g.map((f) => f.net)),
      };
    });
  }),
};

export const labelsRepoMock = {
  listDepartments: vi.fn(async (_tx: unknown, a: { tenantId: string }) =>
    db.departments.filter((d) => d.tenantId === a.tenantId).map(({ department_id, name, is_active }) => ({ department_id, name, is_active }))),
  listTests: vi.fn(async () => []),
  listReferrers: vi.fn(async () => []),
  listInstruments: vi.fn(async () => []),
};

// ------------------------------------------------------------------ actors + ctx
const member = (persona: string, n: number, centreScope: MembershipRow['centreScope']): MembershipRow => ({
  id: idFor(SEED, 0x900 + n), tenantId: TENANTS.A, actorId: actorIdFor('A', 'user', persona), actorType: 'user',
  displayName: `Test User A-${persona}`, roles: ['owner_viewer'], centreScope, branchIds: [],
  mfaLevel: 'aal2', isLocked: false, status: 'active', email: null, version: 1,
});
export const ADMIN = 'A:user:admin';             // tenant_admin, all centres, holds analytics.dashboard.read
export const OWNER_ALL = 'A:user:ownerall';      // owner_viewer, all centres
export const OWNER_A1 = 'A:user:ownera1';        // owner_viewer restricted to {A1}
export const OWNER_MULTI = 'A:user:ownermulti';  // owner_viewer restricted to {A1, A2}
export const NO_PERM = 'A:user:default';         // lab_technologist: no analytics.* permission
export const PARTNER = 'A:partner:default';
const MEMBERS = [member('ownerall', 1, { all: true, centreIds: [] }), member('ownera1', 2, { all: false, centreIds: [A1] }), member('ownermulti', 3, { all: false, centreIds: [A1, A2] })];

export function makeCore(touched: string[] = []) {
  const tenant = (ctx: any) => (ctx.tenantId === TENANTS.A ? 'A' : 'B');
  const mark = (n: string) => touched.push(n);
  const branchRow = (id: string) => ({ id, branchCode: id.slice(-4), name: BRANCH_NAME(id), isProcessingLab: false, isActive: true });
  const centreRow = (id: string) => ({ id, branchId: BRANCH_OF[id]!, centreCode: id.slice(-4), name: CENTRE_NAME(id), centreKind: 'own', isActive: id !== A3 });
  return {
    async branches(ctx: any) { mark('core.branches'); return [BR1, BR2, BRB].filter((b) => TENANT_OF[b] === tenant(ctx)).map(branchRow); },
    async branch(ctx: any, i: { branchId: string }) {
      mark('core.branch');
      if (TENANT_OF[i.branchId] !== tenant(ctx) || ![BR1, BR2, BRB].includes(i.branchId)) throw new LimsError('common.not_found');
      return branchRow(i.branchId);
    },
    async centres(ctx: any, i: { branchId?: string; activeOnly?: boolean } = {}) {
      mark('core.centres');
      return [A1, A2, A3, B1].filter((c) => TENANT_OF[c] === tenant(ctx) && (i.branchId === undefined || BRANCH_OF[c] === i.branchId)
        && (i.activeOnly !== true || c !== A3)).map(centreRow);
    },
    async centre(ctx: any, i: { centreId: string }) {
      mark('core.centre');
      if (![A1, A2, A3, B1].includes(i.centreId) || TENANT_OF[i.centreId] !== tenant(ctx)) throw new LimsError('common.not_found');
      return centreRow(i.centreId);
    },
    memberships: { async list() { mark('core.memberships'); return []; } },
  };
}

let reportsPromise: Promise<any> | undefined;
async function reportsService() {
  reportsPromise ??= import('../../service/reports.service.js').then((m: any) => ({ income: m.income, departmentIncome: m.departmentIncome }));
  return reportsPromise;
}

/** A fresh ctx = a fresh request (own tx, own memo). `touched` records every core-port / tx use, in order. */
export async function makeCtx(actorKey: string, over: Record<string, unknown> = {}) {
  const identity = createFakeIdentityPort({ seed: SEED, fixtures: { memberships: MEMBERS } }) as any;
  const touched: string[] = [];
  const core = makeCore(touched);
  const reports = await reportsService();
  const ctxFor = makeCtxFor();
  const ctx: any = {
    ...ctxFor(actorKey, { now: () => '2026-11-06T06:00:00.000Z', ...over } as any),
    operationId: 'getIncomeReport', clientIp: '127.0.0.1',
    ports: { IdentityPort: identity }, core,
    tx: { query: vi.fn(async () => { touched.push('tx.query'); return { rows: [] }; }) },
    metrics: { inc: vi.fn() }, log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    services: { analytics: { reports } },
  };
  return { ctx, touched, identity };
}

export async function call(op: 'getIncomeReport' | 'getDepartmentIncomeReport', ctx: any, query: Record<string, unknown> = {}) {
  const { handlers } = await import('../index.js');
  ctx.operationId = op;
  return handlers[op]({ params: {}, query, headers: {}, body: undefined }, ctx);
}
export async function ok(op: 'getIncomeReport' | 'getDepartmentIncomeReport', ctx: any, query: Record<string, unknown> = {}): Promise<any> {
  const r = await call(op, ctx, query);
  if (r.status !== 200) throw new Error(`expected 200 from ${op}, got ${r.status}`);
  return r.body;
}

/** The thrown value of a rejected promise (fails if it resolves). */
export async function rejection(p: Promise<unknown>): Promise<unknown> {
  try { await p; } catch (e) { return e; }
  throw new Error('expected the call to reject, it resolved');
}
export async function expectLims(p: Promise<unknown>, code: string, status: number): Promise<LimsError> {
  const e = await rejection(p);
  if (!isLimsError(e, code)) throw new Error(`expected LimsError ${code}, got ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
  if (e.statusCode !== status) throw new Error(`expected HTTP ${status} for ${code}, got ${e.statusCode}`);
  return e;
}

// ------------------------------------------------------------------ contract validation (contracts/openapi/analytics.yaml)
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
/** Validates `body` against the named schema of analytics.yaml; returns the ajv error list ([] = valid). */
export function contractErrors(schemaName: string, body: unknown): string[] {
  const validate = compiler({ schema: deref(DOCS.analytics.components.schemas[schemaName], 'analytics') });
  return validate(body) ? [] : (validate.errors ?? []).map((e: any) => `${e.instancePath || '/'} ${e.message}`);
}

// ------------------------------------------------------------------ B.S. golden table (US-02.7: no hard-coded conversions)
export { GOLDEN, addDays, bsKey, golden } from '../../domain/__tests__/helpers.js';
