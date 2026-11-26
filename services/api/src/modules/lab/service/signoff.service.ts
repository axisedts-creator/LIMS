// T0B-VERLEVEL-1 (LD-316; LD-318 follow-up 4; LD-319 (5)): verification levels 1, 2, 3 = the number of DIFFERENT people who must sign off a result version before it is final.
// Rules (lab.yaml verifyResult / approveResult descriptions; pinned choices in .orchestra/notes/T0B-VERLEVEL-1-tests.md):
//   * policy = the most specific ACTIVE one (test > department > lab; none at all = level 2 + pathologist + enterer may not sign); the level is FROZEN on the result
//     (signoff_required) when its first sign-off is recorded, so a later policy change never alters a result in progress;
//   * one person (user id) signs one version once (lab.verifier_not_distinct; on approve lab.self_approval_forbidden); the enterer (membership of the latest manual
//     observation) may not sign unless allow_enterer_verify (lab.enterer_cannot_verify); with require_pathologist the final sign-off is approveResult (a verify that would
//     be final is lab.pathologist_required); approveResult is ONLY the final sign-off (otherwise lab.result_invalid_transition);
//   * every refusal by these rules keeps one audit.access_log row (outcome denied; ctx.commitOnError for a single-item request);
//   * the chain row (signer snapshot) is appended in the same transaction as the status change, before it; one lab.result.signed_off.v1 per sign-off.
// No SQL here: every statement is in store/signoff.store.ts and filters tenant_id = $1 (ctx.tenantId) next to RLS.
// [CONV] audit action of a refused sign-off = 'lab_result.view' (the only lab result code of audit.g_cs_access_actions) with detail { operation, code }; a dedicated code needs a CR.
// [CONV] a legacy `verified` row with signoff_count 0 (written before the counters) counts as one sign-off (its verifier).
import { toDate } from '../../../core/clock.js'; // T0D-FIX-6 (LD-448): toDate(ctx.now()) is an ISO string in the pipeline, a Date in unit fakes
import { LimsError } from '../../../core/errors.js';
import { isUuid } from '../repository/base.repo.js';
import { createLabEvents } from '../events/publish.js';
import type { SignoffState, SignoffStore } from '../store/signoff.store.js';

type Obj = Record<string, any>;
const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const APPROVE_PERMISSION = 'lab.result.approve';
const REFUSAL_ACTION = 'lab_result.view';

export interface SignCtx {
  readonly tenantId: string; readonly tx: unknown; now(): Date;
  readonly actor: { readonly type?: string; readonly id: string; readonly membershipId?: string };
  readonly store: { readonly signoffs?: SignoffStore };
  readonly ports: { readonly IdentityPort: { getActor?(ctx: unknown): Promise<Obj> } };
  readonly audit?: { access(e: Obj): Promise<unknown> };
  readonly events: unknown;
  commitOnError?(): void;
}
export interface SignRow { resultId: string; status: string; centreId: string; currentVersionNo: number; orderId: string; testId: string; departmentId: string; verifiedByMembershipId?: string | undefined }
export interface Plan { st: SignoffState; required: number; count: number; final: boolean }

/** the sign-off seam of the production store; a store without it (unit fakes of T-16/T-17) keeps the pre-LD-316 two step flow. */
export const signoffsOf = (ctx: unknown): SignoffStore | undefined => (ctx as SignCtx).store?.signoffs;

const countOf = (status: string, n: number): number => (status === 'verified' && n === 0 ? 1 : n);

/** a refusal by the sign-off rules: audited (denied), kept on error for a single-item request, then thrown. */
async function refuse(ctx: SignCtx, row: SignRow, code: string, operation: 'verify' | 'approve', single: boolean): Promise<never> {
  if (ctx.audit) {
    await ctx.audit.access({ action: REFUSAL_ACTION, entityType: 'result', ...(UUIDV7.test(row.resultId) ? { entityId: row.resultId } : {}),
      ...(UUIDV7.test(row.centreId) ? { centreId: row.centreId } : {}), outcome: 'denied', detail: { operation, code } });
    if (single) ctx.commitOnError?.();   // only the audit row was written in this transaction
  }
  throw new LimsError(code as never);
}

async function stateOf(ctx: SignCtx, so: SignoffStore, row: SignRow): Promise<Plan> {
  const st = await so.state(ctx.tx, ctx.tenantId, row.resultId);
  if (!st) throw new LimsError('common.not_found');
  const required = st.frozen ?? st.policy.level;
  const count = countOf(row.status, st.count);
  return { st, required, count, final: count + 1 >= required };
}
async function isSoloAdmin(ctx: SignCtx): Promise<boolean> {
  const getActor = ctx.ports?.IdentityPort?.getActor;
  if (typeof getActor !== 'function') return false;
  try {
    const a = await getActor.call(ctx.ports.IdentityPort, ctx);
    return Array.isArray(a?.['roles']) && a['roles'].includes('tenant_admin');
  } catch {
    return false;
  }
}

async function isEnterer(ctx: SignCtx, st: SignoffState): Promise<boolean> {
  if (st.policy.allowEntererVerify) return false;
  if (st.entererMembershipId === undefined || st.entererMembershipId !== ctx.actor.membershipId) return false;
  return !(await isSoloAdmin(ctx));
}

/** verifyResult rules after the status / hold / flag gates: counter, distinct people, enterer, pathologist (LD-316). */
export async function planVerify(ctx: SignCtx, so: SignoffStore, row: SignRow, single: boolean): Promise<Plan> {
  const p = await stateOf(ctx, so, row);
  if (p.count >= p.required) throw new LimsError('lab.result_invalid_transition');
  const solo = await isSoloAdmin(ctx);
  if (!solo && p.st.signers.includes(ctx.actor.id)) await refuse(ctx, row, 'lab.verifier_not_distinct', 'verify', single);
  if (await isEnterer(ctx, p.st)) await refuse(ctx, row, 'lab.enterer_cannot_verify', 'verify', single);
  if (p.final && p.st.policy.requirePathologist && !solo) await refuse(ctx, row, 'lab.pathologist_required', 'verify', single);
  return p;
}

/** approveResult rules: approve is the FINAL sign-off only; self approval (in the chain, or the legacy verifier), enterer (LD-316). */
export async function planApprove(ctx: SignCtx, so: SignoffStore, row: SignRow, single: boolean): Promise<Plan> {
  const p = await stateOf(ctx, so, row);
  if (p.count + 1 !== p.required) throw new LimsError('lab.result_invalid_transition');
  const solo = await isSoloAdmin(ctx);
  const legacyUnknownVerifier = row.status === 'verified' && !row.verifiedByMembershipId && p.st.signers.length === 0;   // S-02 fail closed, as before
  if (!ctx.actor.membershipId || legacyUnknownVerifier || (!solo && (p.st.signers.includes(ctx.actor.id) || row.verifiedByMembershipId === ctx.actor.membershipId))) {
    await refuse(ctx, row, 'lab.self_approval_forbidden', 'approve', single);
  }
  if (await isEnterer(ctx, p.st)) await refuse(ctx, row, 'lab.enterer_cannot_verify', 'approve', single);
  return p;
}

/** signer snapshot at signing time (IdentityPort.getActor): name, role, held lab.result.approve, registration number; the signature asset only for a pathologist (only those print). */
async function snapshot(ctx: SignCtx): Promise<{ displayName: string; roleCode: string; isPathologist: boolean; registrationNo?: string; signatureAssetId?: string }> {
  const getActor = ctx.ports.IdentityPort.getActor;
  if (typeof getActor !== 'function') throw new LimsError('common.internal');   // fail closed: no signer identity, no sign-off
  const a = await getActor.call(ctx.ports.IdentityPort, ctx);
  const isPathologist = Array.isArray(a?.['permissions']) && a['permissions'].includes(APPROVE_PERMISSION);
  const name = typeof a?.['displayName'] === 'string' && a['displayName'].trim() ? a['displayName'].trim() : ctx.actor.id;
  const role = Array.isArray(a?.['roles']) && typeof a['roles'][0] === 'string' && a['roles'][0] ? String(a['roles'][0]) : String(ctx.actor.type ?? 'user');
  const sig = a?.['signature'] ?? {};
  const reg = typeof sig['registrationNo'] === 'string' && sig['registrationNo'] ? String(sig['registrationNo']).slice(0, 60) : undefined;
  const asset = isPathologist && isUuid(sig['signatureImageRef']) ? String(sig['signatureImageRef']) : undefined;
  return { displayName: name.slice(0, 200), roleCode: role.slice(0, 100), isPathologist, ...(reg ? { registrationNo: reg } : {}), ...(asset ? { signatureAssetId: asset } : {}) };
}

/** appends the chain row (before the status change) and returns what the event needs. A pathologist-required final approve by a non-pathologist is refused here. */
export async function recordSignoff(ctx: SignCtx, so: SignoffStore, row: SignRow, p: Plan, action: 'verify' | 'approve', single: boolean) {
  const snap = await snapshot(ctx);
  if (action === 'approve' && p.st.policy.requirePathologist && !snap.isPathologist) await refuse(ctx, row, 'lab.pathologist_required', 'approve', single);
  const signedAt = toDate(ctx.now()).toISOString();
  const r = await so.append(ctx.tx, ctx.tenantId, { resultId: row.resultId, resultVersion: row.currentVersionNo, action, signerUserId: ctx.actor.id, ...snap, signedAt, level: p.required });
  return { ...r, signedAt, isPathologist: snap.isPathologist };
}

/** one lab.result.signed_off.v1 per sign-off (ids and counters only: no value, no names, no registration number, no signature). */
export async function publishSignedOff(ctx: SignCtx, row: SignRow, s: { seq: number; count: number; required: number; signedAt: string; isPathologist: boolean }, action: 'verify' | 'approve', final: boolean, rowVersion: number) {
  await createLabEvents(ctx.events as never).resultSignedOff(ctx as never, {
    result_id: row.resultId, result_version_no: row.currentVersionNo, order_id: row.orderId, test_id: row.testId, department_id: row.departmentId,
    seq: s.seq, action, signoff_count: s.count, signoff_required: s.required, is_final: final, signer_user_id: ctx.actor.id, signer_is_pathologist: s.isPathologist, signed_at: s.signedAt,
  }, { resultRowVersion: rowVersion });
}

/** adds signoff_count / signoff_required / the resolved policy level to result rows (ResultDto next_step, result.mapper.ts). */
export async function withCounters<T extends Obj>(ctx: unknown, rows: T[]): Promise<T[]> {
  const so = signoffsOf(ctx);
  if (!so || rows.length === 0) return rows;
  const c = ctx as SignCtx;
  const m = await so.counters(c.tx, c.tenantId, rows.map((r) => String(r['id'])));
  return rows.map((r) => { const x = m.get(String(r['id'])); return x ? { ...r, signoff_count: x['signoff_count'], signoff_required: x['signoff_required'], vp_level: x['vp_level'] } : r; });
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// T0B-VERLEVEL-1 (LD-316) operations: listVerificationPolicies, upsertVerificationPolicy, getResultSignoffs. The contract x-permission is asserted by the handlers/index.ts gate
// (lab.verification_policy.manage is privileged = aal2); tenant from ctx only; only the documented body fields are read.
// ---------------------------------------------------------------------------------------------------------------------------------------------
interface OpCtx extends SignCtx { readonly ports: SignCtx['ports'] & { readonly IdentityPort: { assertRole(c: unknown, r: { permission: string; centreId?: string }): Promise<unknown> } } }
const iso = (v: unknown): string | undefined => (v === null || v === undefined ? undefined : new Date(v as string).toISOString());
const field = (path: string) => new LimsError('common.validation_failed', undefined, [{ path, code: 'common.field_invalid', message: 'Field invalid' }]);
const seam = (ctx: unknown): SignoffStore => { const so = signoffsOf(ctx); if (!so) throw new LimsError('common.internal'); return so; };   // fail closed: no store wiring

/** VerificationPolicy (lab.yaml): allowlist, no tenant id, absent ids omitted. */
export function toPolicyDto(r: Obj): Obj {
  return { id: r['id'], scope: r['scope'], ...(r['department_id'] ? { department_id: r['department_id'] } : {}), ...(r['test_id'] ? { test_id: r['test_id'] } : {}),
    required_verifiers: Number(r['required_verifiers']), require_pathologist: Boolean(r['require_pathologist']), allow_enterer_verify: Boolean(r['allow_enterer_verify']),
    active: Boolean(r['active']), version: Number(r['version']), updated_at: iso(r['updated_at']) };
}

export async function listVerificationPolicies(rawCtx: unknown): Promise<Obj[]> {
  const ctx = rawCtx as OpCtx;
  const so = seam(ctx);
  await so.ensureLabDefault(ctx.tx, ctx.tenantId);
  return (await so.listPolicies(ctx.tx, ctx.tenantId)).map(toPolicyDto);
}

export interface PolicyUpsert { scope: 'lab' | 'department' | 'test'; departmentId?: string; testId?: string; level: number; requirePathologist: boolean; allowEntererVerify: boolean; active: boolean }
const UPSERT_KEYS = new Set(['scope', 'department_id', 'test_id', 'required_verifiers', 'require_pathologist', 'allow_enterer_verify', 'active']);
/** VerificationPolicyUpsert, strictly (additionalProperties false; exactly the target id of the scope; omitted flags take the defaults). */
export function parsePolicyUpsert(body: unknown): PolicyUpsert {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw field('/body');
  const b = body as Obj;
  for (const k of Object.keys(b)) if (!UPSERT_KEYS.has(k)) throw field(`/${k}`);
  const scope = b['scope'];
  if (scope !== 'lab' && scope !== 'department' && scope !== 'test') throw field('/scope');
  const level = b['required_verifiers'];
  if (typeof level !== 'number' || !Number.isInteger(level) || level < 1 || level > 3) throw field('/required_verifiers');
  for (const k of ['require_pathologist', 'allow_enterer_verify', 'active']) if (b[k] !== undefined && typeof b[k] !== 'boolean') throw field(`/${k}`);
  for (const k of ['department_id', 'test_id']) if (b[k] !== undefined && !isUuid(b[k])) throw field(`/${k}`);
  const wantDept = scope === 'department', wantTest = scope === 'test';
  if (wantDept !== (b['department_id'] !== undefined)) throw field('/department_id');
  if (wantTest !== (b['test_id'] !== undefined)) throw field('/test_id');
  return { scope, ...(wantDept ? { departmentId: b['department_id'] as string } : {}), ...(wantTest ? { testId: b['test_id'] as string } : {}), level,
    requirePathologist: b['require_pathologist'] ?? true, allowEntererVerify: b['allow_enterer_verify'] ?? false, active: b['active'] ?? true };
}

/** create (no If-Match) or update (If-Match = the active row's version) the ONE active policy of the target. The lab scope policy is never deactivated. A change applies to
 *  results whose sign-off has not started (the level is frozen at the first sign-off). The row audit trigger of lab.verification_policy records the change. */
export async function upsertVerificationPolicy(rawCtx: unknown, i: { body: PolicyUpsert; ifMatch?: number }): Promise<Obj> {
  const ctx = rawCtx as OpCtx;
  const so = seam(ctx);
  const b = i.body;
  if (b.scope === 'lab' && !b.active) throw field('/active');
  const target = { scope: b.scope, ...(b.departmentId ? { departmentId: b.departmentId } : {}), ...(b.testId ? { testId: b.testId } : {}) };
  if (!(await so.targetExists(ctx.tx, ctx.tenantId, target))) throw new LimsError('common.not_found');   // per tenant: a foreign id is unknown here
  const cur = await so.lockActivePolicy(ctx.tx, ctx.tenantId, target);
  const values = { level: b.level, requirePathologist: b.requirePathologist, allowEntererVerify: b.allowEntererVerify, active: b.active };
  if (!cur) {
    if (i.ifMatch !== undefined) throw new LimsError('common.version_conflict');   // the version the client names is no longer an active policy
    return toPolicyDto(await so.insertPolicy(ctx.tx, ctx.tenantId, { ...target, ...values }));
  }
  if (i.ifMatch === undefined) throw new LimsError('common.precondition_required');
  if (i.ifMatch !== Number(cur['version'])) throw new LimsError('common.version_conflict');
  return toPolicyDto(await so.updatePolicy(ctx.tx, ctx.tenantId, { id: String(cur['id']), expectedVersion: i.ifMatch, ...values }));
}

/** ResultSignoff rows (contract fields only: no signature asset, no tenant id). lab.result.read at the result's centre or its processing centre (P-01 / P-02: 404). */
export async function getResultSignoffs(rawCtx: unknown, i: { resultId: unknown }): Promise<Obj[]> {
  const ctx = rawCtx as OpCtx;
  const so = seam(ctx);
  if (!isUuid(i.resultId)) throw new LimsError('common.not_found');
  const store = ctx.store as { getResults?(tx: unknown, t: string, ids: readonly string[]): Promise<Obj[]> };
  const row = (await store.getResults?.(ctx.tx, ctx.tenantId, [i.resultId]))?.[0];
  if (!row) throw new LimsError('common.not_found');
  const at = async (centreId: unknown): Promise<boolean> => {
    try { await ctx.ports.IdentityPort.assertRole(ctx, { permission: 'lab.result.read', ...(typeof centreId === 'string' ? { centreId } : {}) }); return true; }
    catch (e) { if (e instanceof LimsError && e.code === 'auth.forbidden') return false; throw e; }
  };
  if (!(await at(row['centre_id'])) && !(typeof row['processing_centre_id'] === 'string' && (await at(row['processing_centre_id'])))) throw new LimsError('common.not_found');
  return (await so.listChain(ctx.tx, ctx.tenantId, i.resultId)).map((r) => ({
    result_version: Number(r['result_version']), seq: Number(r['seq']), action: r['action'], signer_user_id: r['signer_user_id'], signer_display_name: r['signer_display_name'],
    signer_role_code: r['signer_role_code'], signer_is_pathologist: Boolean(r['signer_is_pathologist']),
    ...(r['signer_registration_no'] ? { signer_registration_no: r['signer_registration_no'] } : {}), signed_at: iso(r['signed_at']),
  }));
}
