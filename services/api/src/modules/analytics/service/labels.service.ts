// Display labels for report rows (02-TRD §3 labels.service; PRD US-04.2, US-05.2, US-08.2, US-14.1; 08 A17 D-47/P-17, R12d; 07-SECURITY P1).
// Every lookup returns Map<id, entry>; an id with no row is ABSENT (caller shows short id / omits). Inactive rows keep their label + isActive flag.
// Departments/tests/referrers/instruments: published views only. Centres/branches/staff: ctx.core only (never core.* tables).
import * as repo from '../repository/labels.repo.js';

interface CoreRows<T> { (ctx: never, input?: any): Promise<readonly T[]> }
export interface LabelsContext {
  readonly tenantId: string;
  readonly tx: repo.LabelsTx;
  readonly core: {
    branches: CoreRows<{ id: string; name: string; isActive: boolean }>;
    centres: CoreRows<{ id: string; name: string; isActive: boolean; branchId: string }>;
    memberships: { list: CoreRows<{ membershipId: string; displayName: string; isActive: boolean }> };
  };
}
const uniq = (ids: readonly string[]) => [...new Set(ids)];
function toMap<R, V>(rows: readonly R[], key: (r: R) => string, val: (r: R) => V): Map<string, V> {
  return new Map(rows.map((r) => [key(r), val(r)]));
}

export async function departmentLabels(ctx: LabelsContext) {
  return toMap(await repo.listDepartments(ctx.tx, { tenantId: ctx.tenantId }), (r) => r.department_id, (r) => ({ name: r.name, isActive: r.is_active }));
}
export async function testLabels(ctx: LabelsContext, ids: readonly string[]) {
  return toMap(await repo.listTests(ctx.tx, { tenantId: ctx.tenantId, ids: uniq(ids) }), (r) => r.test_id,
    (r) => ({ code: r.code, name: r.name, departmentId: r.department_id, isActive: r.is_active }));
}
export async function referrerLabels(ctx: LabelsContext, ids: readonly string[]) {
  return toMap(await repo.listReferrers(ctx.tx, { tenantId: ctx.tenantId, ids: uniq(ids) }), (r) => r.referrer_id,
    (r) => ({ displayName: r.display_name, isActive: r.is_active, canonicalId: r.canonical_referrer_id ?? r.referrer_id })); // root = own canonical
}
export async function instrumentLabels(ctx: LabelsContext, ids: readonly string[]) {
  return toMap(await repo.listInstruments(ctx.tx, { tenantId: ctx.tenantId, ids: uniq(ids) }), (r) => r.instrument_id,
    (r) => ({ label: `${r.display_name} (${r.instrument_code})`, instrumentCode: r.instrument_code, isActive: r.is_active, centreId: r.centre_id }));
}
export async function centreLabels(ctx: LabelsContext) {
  return toMap(await ctx.core.centres(ctx as never, { activeOnly: false }), (r) => r.id, (r) => ({ name: r.name, isActive: r.isActive, branchId: r.branchId }));
}
export async function branchLabels(ctx: LabelsContext) {
  return toMap(await ctx.core.branches(ctx as never, { activeOnly: false }), (r) => r.id, (r) => ({ name: r.name, isActive: r.isActive }));
}

// Staff (P-17): core.memberships.list(activeOnly:false), <=200 ids per call (core limit), memoised per request (= per ctx), failures not memoised.
const CHUNK = 200;
type Staff = { displayName: string; isActive: boolean };
const staffMemo = new WeakMap<object, Map<string, Promise<Map<string, Staff>>>>();

export async function staffLabels(ctx: LabelsContext, membershipIds: readonly string[]): Promise<Map<string, Staff>> {
  let memo = staffMemo.get(ctx);
  if (!memo) staffMemo.set(ctx, (memo = new Map()));
  const m = memo;
  const missing = uniq(membershipIds).filter((id) => !m.has(id));
  for (let i = 0; i < missing.length; i += CHUNK) {
    const chunk = missing.slice(i, i + CHUNK);
    const p = ctx.core.memberships.list(ctx as never, { membershipIds: chunk, activeOnly: false })
      .then((rows) => toMap(rows, (r) => r.membershipId, (r) => ({ displayName: r.displayName, isActive: r.isActive })));
    for (const id of chunk) m.set(id, p);
    p.catch(() => { for (const id of chunk) if (m.get(id) === p) m.delete(id); });
  }
  const out = new Map<string, Staff>();
  for (const p of new Set(uniq(membershipIds).map((id) => m.get(id)!))) {
    for (const [id, v] of await p) if (membershipIds.includes(id)) out.set(id, v);
  }
  return out;
}
