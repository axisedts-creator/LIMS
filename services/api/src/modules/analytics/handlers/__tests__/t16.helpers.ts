// AN-T16 test helpers (not a test file). Synthetic data only. Handlers #24-#29 (listReportSchedules, createReportSchedule, getReportSchedule, updateReportSchedule,
// deactivateReportSchedule, getReportRun) run for real through handlers/index.ts against the in-memory repo of ../../service/__tests__/schedulesFake.ts (its header pins the
// repository seams; the test files vi.mock `repository/schedules.repo.js` with `schedulesRepoMock`).
//
// SEAMS pinned here (spec leaves them open; the writer may dispute through the reviewer):
//   * ctx.actor.membershipId and IdentityPort.getActor(ctx).actor.membershipId are the caller's membership (= schedule owner on create).
//   * Permission gate = ctx.ports.IdentityPort.assertRole(ctx, {permission}) FIRST (before any repo / core read): #24-#28 analytics.schedule.manage, #29 analytics.dashboard.read.
//   * Recipients / owners are checked through ctx.core.membership(ctx,{membershipId}) -> {membershipId, displayName, status, isActive, lockedAt?, allCentres, centreIds, roleCodes}
//     (throws common.not_found for another tenant's id) and ctx.core.membershipPermissions(ctx,{membershipId}) -> string[]; display names for #29 through
//     ctx.core.memberships.list(ctx,{membershipIds, activeOnly:false}) (08 A17 D-45/P-17). The caller's centre scope is IdentityPort.getActor(ctx).centreScope (as resolveScope does).
//   * ctx.tx = {membershipId, tenantId, query} — the repo emulator reads `membershipId` to emulate the report_runs / report_run_recipients RLS policies (05-SCHEMA §3).
//   * ctx.now() = schedulesDb.clock.now (2026-11-06T06:00:00.000Z = Friday 11:45 Nepal time). The Idempotency-Key / ETag plumbing belongs to the core (not tested here).
//   * If-Match header = `"<version>"` (02-CV §4.2), key `if-match`.
import { vi } from 'vitest';
import { createFakeIdentityPort, type MembershipRow } from '../../../../../../../packages/fakes/src/IdentityPort.fake';
import { TENANTS, actorIdFor, idFor } from '../../../../../../../packages/fakes/src/base';
import { makeCtxFor } from '../../../../../../../packages/fakes/src/harness';
import { ROLE_GRANTS } from '../../../../../../../contracts/ports/generated/permissions.ts';
import { LimsError } from '../../../../core/errors.js';
import { A1, A2, A3, B1, TA, TB, contractErrors, expectLims, makeCore, rejection } from './helpers.js';
import { schedulesDb } from '../../service/__tests__/schedulesFake.js';

export { A1, A2, A3, B1, TA, TB, contractErrors, expectLims, rejection, schedulesDb };
export { schedulesRepoMock } from '../../service/__tests__/schedulesFake.js';

const SEED = 1;
export const NOW = '2026-11-06T06:00:00.000Z';
export const uid = (n: number): string => idFor(SEED, 0x1600 + n);

// ------------------------------------------------------------------ personas (tenant A unless noted)
export const OWNER = 'A:user:schowner';          // owner_viewer, all centres, aal2: every analytics permission incl. schedule.manage + referral_report.read
export const OWNER_A1 = 'A:user:schownera1';     // owner_viewer restricted to {A1}
export const OWNER2 = 'A:user:schowner2';        // a second owner_viewer: never the owner of a seeded schedule
export const ADMIN = 'A:user:schadmin';          // tenant_admin: schedule.manage + collections.read + dashboard.read, NO referral_report.read
export const LAB = 'A:user:schlab';              // lab_manager: analytics.dashboard.read only
export const LAB2 = 'A:user:schlab2';
export const LAB3 = 'A:user:schlab3';
export const LAB_A1 = 'A:user:schlaba1';         // lab_manager restricted to {A1}
export const FINANCE = 'A:user:schfinance';      // finance: collections.read, NO dashboard.read
export const NOPERM = 'A:user:schnoperm';        // no roles
export const SCHEDMGR = 'A:user:schmgr';         // lab_manager + analytics.schedule.manage (dashboard.read, no collections.read)
export const REVOKED = 'A:user:schrevoked';      // owner_viewer, membership deactivated
export const LOCKED = 'A:user:schlocked';        // lab_manager, locked
const ALLC = { all: true, centreIds: [] as string[] };
const P: [string, string, string[], MembershipRow['centreScope'], Partial<MembershipRow>][] = [
  ['schowner', 'owner', ['owner_viewer'], ALLC, {}], ['schownera1', 'ownerA1', ['owner_viewer'], { all: false, centreIds: [A1] }, {}], ['schowner2', 'owner2', ['owner_viewer'], ALLC, {}],
  ['schadmin', 'admin', ['tenant_admin'], ALLC, {}], ['schlab', 'lab', ['lab_manager'], ALLC, {}], ['schlab2', 'lab2', ['lab_manager'], ALLC, {}], ['schlab3', 'lab3', ['lab_manager'], ALLC, {}],
  ['schlaba1', 'labA1', ['lab_manager'], { all: false, centreIds: [A1] }, {}], ['schfinance', 'finance', ['finance'], ALLC, {}], ['schnoperm', 'noperm', [], ALLC, {}],
  ['schmgr', 'mgr', ['lab_manager'], ALLC, { extraPermissions: ['analytics.schedule.manage'] }], ['schrevoked', 'revoked', ['owner_viewer'], ALLC, { status: 'deactivated' }],
  ['schlocked', 'locked', ['lab_manager'], ALLC, { isLocked: true }],
];
const MEMBERS: MembershipRow[] = P.map(([persona, , roles, centreScope, extra], i) => ({
  id: idFor(SEED, 0xd00 + i + 1), tenantId: TENANTS.A, actorId: actorIdFor('A', 'user', persona), actorType: 'user', displayName: `Test User A-${persona}`, roles, extraPermissions: [],
  centreScope, branchIds: [], mfaLevel: 'aal2', isLocked: false, status: 'active', email: null, version: 1, ...extra,
}));
const FOREIGN: MembershipRow = { id: idFor(SEED, 0xdb1), tenantId: TENANTS.B, actorId: actorIdFor('B', 'user', 'schforeign'), actorType: 'user', displayName: 'Test User B-schforeign', roles: ['owner_viewer'], extraPermissions: [], centreScope: ALLC, branchIds: [], mfaLevel: 'aal2', isLocked: false, status: 'active', email: null, version: 1 };
/** membership id of every persona (keys as above), plus FOREIGN (tenant B). */
export const MEMBER: Record<string, string> = Object.fromEntries([...P.map(([persona], i) => [`A:user:${persona}`, MEMBERS[i]!.id]), ['B:user:schforeign', FOREIGN.id]]);
export const FOREIGN_MEMBER = FOREIGN.id;
const ALL_ROWS = [...MEMBERS, FOREIGN];
export const permsOf = (m: MembershipRow): string[] => (m.status === 'active' ? [...new Set([...m.roles.flatMap((r) => (ROLE_GRANTS as any)[r] ?? []), ...(m.extraPermissions ?? [])])] : []);

export function makeCore16(touched: string[] = []) {
  const base: any = makeCore(touched);
  const view = (m: MembershipRow) => ({
    membershipId: m.id, displayName: m.displayName, status: m.status, isActive: m.status === 'active', ...(m.isLocked ? { lockedAt: '2026-11-01T00:00:00.000Z' } : {}),
    allCentres: m.centreScope.all, centreIds: [...m.centreScope.centreIds], roleCodes: [...m.roles],
  });
  const own = (ctx: any, id: string) => ALL_ROWS.find((m) => m.id === id && m.tenantId === ctx.tenantId);
  base.membership = async (ctx: any, i: { membershipId: string }) => { touched.push('core.membership'); const m = own(ctx, i.membershipId); if (!m) throw new LimsError('common.not_found'); return view(m); };
  base.membershipPermissions = async (ctx: any, i: { membershipId: string }) => { touched.push('core.membershipPermissions'); const m = own(ctx, i.membershipId); if (!m) throw new LimsError('common.not_found'); return permsOf(m); };
  base.memberships = { async list(ctx: any, i: { membershipIds?: string[]; activeOnly?: boolean } = {}) {
    touched.push('core.memberships.list');
    base.memberships.calls.push(i);
    return ALL_ROWS.filter((m) => m.tenantId === ctx.tenantId && (!i.membershipIds || i.membershipIds.includes(m.id)) && (i.activeOnly !== true || m.status === 'active')).map(view);
  }, calls: [] as unknown[] };
  return base;
}

export interface Ctx16Opts { settings?: Record<string, unknown> }
/** A fresh request ctx (own tx). Spies: identity.assertRole / getTenantSettings, core touch list, log + metrics calls. */
export async function makeCtx16(actorKey: string, o: Ctx16Opts = {}) {
  const tenantKey = actorKey.split(':')[0] === 'B' ? 'B' : 'A';
  const identity = createFakeIdentityPort({ seed: SEED, fixtures: { memberships: ALL_ROWS, settings: o.settings ? { [TENANTS[tenantKey]]: o.settings } : {} } as never }) as any;
  const assertRole = vi.spyOn(identity, 'assertRole');
  const getTenantSettings = vi.spyOn(identity, 'getTenantSettings');
  const touched: string[] = [];
  const core = makeCore16(touched);
  const membershipId = MEMBER[actorKey] ?? '';
  const ctxFor = makeCtxFor();
  const ctx: any = {
    ...ctxFor(actorKey, { now: () => schedulesDb.clock.now } as any), operationId: 'createReportSchedule', clientIp: '127.0.0.1',
    ports: { IdentityPort: identity }, core, tx: { membershipId, tenantId: TENANTS[tenantKey], query: vi.fn(async () => { touched.push('tx.query'); return { rows: [] }; }) },
    metrics: { inc: vi.fn(), set: vi.fn(), observe: vi.fn() }, log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }, audit: { access: vi.fn(async () => undefined) },
    services: { analytics: {} },
  };
  ctx.actor = { ...ctx.actor, ...(membershipId ? { membershipId } : {}) };
  return { ctx, identity, assertRole, getTenantSettings, touched, core, membershipId };
}
export type Ctx16 = Awaited<ReturnType<typeof makeCtx16>>;

export type SchedOp = 'listReportSchedules' | 'createReportSchedule' | 'getReportSchedule' | 'updateReportSchedule' | 'deactivateReportSchedule' | 'getReportRun';
let keySeq = 0;
export async function callSch(op: SchedOp, ctx: any, o: { body?: unknown; params?: Record<string, unknown>; query?: Record<string, unknown>; ifMatch?: string | number | null } = {}) {
  const { handlers } = await import('../index.js');
  ctx.operationId = op;
  const headers: Record<string, string> = { 'idempotency-key': `k16-${++keySeq}` };
  if (o.ifMatch !== undefined && o.ifMatch !== null) headers['if-match'] = typeof o.ifMatch === 'number' ? `"${o.ifMatch}"` : o.ifMatch;
  return handlers[op]({ params: o.params ?? {}, query: o.query ?? {}, headers, body: o.body }, ctx);
}
export async function okSch(op: SchedOp, ctx: any, o: Parameters<typeof callSch>[2] = {}, status = 200): Promise<any> {
  const r = await callSch(op, ctx, o);
  if (r.status !== status) throw new Error(`expected ${status} from ${op}, got ${r.status}`);
  return r.body;
}

export const REPORTS = ['dashboard', 'income', 'department_income', 'pending_tests'];
export const scheduleBody = (over: Record<string, unknown> = {}) => ({
  name: 'Daily MIS', report_codes: [...REPORTS], frequency: 'daily', send_time_local: '07:00', period_rule: 'previous_business_day',
  scope: { all_centres: true }, recipient_membership_ids: [MEMBER[LAB]!, MEMBER[LAB2]!], ...over,
});
export const sid = (n: number): string => idFor(SEED, 0x1700 + n);
/** A stored schedule of `ownerKey` (tenant A unless `tenant`), active, daily 07:00, next run 2026-11-07T01:15Z, with the given ACTIVE recipients. */
export function seedSchedule(n: number, ownerKey: string, recipients: string[] = [LAB, LAB2], over: Partial<Parameters<typeof schedulesDb.seedSchedule>[0]> = {}) {
  return schedulesDb.seedSchedule({ id: sid(n), tenant_id: TA, owner_membership_id: MEMBER[ownerKey]!, next_run_at: '2026-11-07T01:15:00.000Z', ...over }, recipients.map((k) => MEMBER[k] ?? k));
}
export const ifm = (v: number) => `"${v}"`;
