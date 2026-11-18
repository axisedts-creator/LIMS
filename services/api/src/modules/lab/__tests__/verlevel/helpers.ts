// T0B-VERLEVEL-1 test helpers (not a test file). Verification levels 1, 2, 3 (LD-316; founder 2026-11-17 08:39 NPT; LD-318 follow-up 4; LD-319 (3)/(5)).
// Everything here drives the REAL handlers over a real PG17 tx under RLS through the T-32 probe kit (probes/kit.ts `fire`); nothing is faked except the IdentityPort and CatalogPort the kit supplies.
// DB: tests/lab/T0B-VERLEVEL-1.pg.sh (LIMS_TEST_DATABASE_URL = lims_api, LIMS_TEST_ADMIN_DATABASE_URL = superuser; LIMS_T03_REQUIRE_DB=1 makes a missing database a failure).
// PINNED CHOICES (the brief and the T0C contract are silent; a change needs a ruling, see .orchestra/notes/T0B-VERLEVEL-1-tests.md):
//   * a person = one user id (ctx.actor.id = claims sub = result_signoff.signer_user_id) with one membership id (lab.result_observations.entered_by_membership_id, lab.results.verified_by_membership_id);
//   * the enterer of a result is the membership in the (latest) manual lab.result_observations row; the tests also set lab.results.updated_by to the enterer user id;
//   * policies of CASES are TEST scope policies on the case's own test id (isolated from parallel files); lab scope policy mutation is done in tenant B only (policy.live.test.ts);
//   * next_step = 'approve' when the next sign-off is the final one (count + 1 = signoff_required), 'verify' when a further non final sign-off is due, 'none' otherwise (lab.yaml ResultDto.next_step);
//     the brief says "next_step says pathologist": the contract enum has no such value, the pathologist step IS 'approve' (approveResult is the pathologist sign-off).
import { LimsError } from '../../../../core/errors.js';
import { CENTRE, CENTRE_A2, SYS, asOwner, fire, grantsOfRole, ins, mk, objs, owner, req, uid, type Objs, type Outcome, type Who } from '../probes/kit.js';

/** CatalogPort fake: no reference range, no critical limits (the result is never flagged), getTest knows the ids given to knownTests(). */
const known = new Set<string>();
export const knownTests = (...ids: string[]): void => { ids.forEach((i) => known.add(i)); };
export const catalog = {
  async referenceRangeFor() { return undefined; },
  async criticalLimitsFor() { return undefined; },
  async getTest(_c: unknown, a: { testId: string }) { if (!known.has(a.testId)) throw new LimsError('common.not_found'); return { id: a.testId, testId: a.testId, isActive: true }; },
};
export const PORTS = { CatalogPort: catalog };

// ---------------------------------------------------------------- people
export type Kind = 'tech' | 'patho' | 'manager';
const ROLE: Record<Kind, string> = { tech: 'lab_technologist', patho: 'pathologist', manager: 'lab_manager' };
let counter = 0;
/** A real person: own user id + membership id; a pathologist holds lab.result.approve (grants of the pathologist role) and has a registration number + signature asset. Tenant A or B. */
export function person(kind: Kind, side: 'a' | 'b' = 'a', extra: Partial<Who> = {}): Who {
  const n = ++counter;
  return mk(side, { userId: uid(), membershipId: uid(), grants: grantsOfRole(ROLE[kind]), roleCode: ROLE[kind], displayName: `${kind} ${n} (SYNTHETIC)`, allCentres: true,
    centreIds: side === 'a' ? [CENTRE.a, CENTRE_A2] : [CENTRE.b],
    ...(kind === 'patho' ? { registrationNo: `NMC-${uid().slice(-8)}`, signatureAssetId: uid() } : {}), ...extra });
}
export const holdsApprove = (w: Who): boolean => w.grants.includes('lab.result.approve');

// ---------------------------------------------------------------- cases (one result per case, own test + department, so policies of parallel files never meet)
export interface Case { S: Objs; id: string; testId: string; departmentId: string; enterer: Who }
/** A `resulted` manual result entered by `enterer` (default: a fresh technologist). Own order/test graph (objs), a NEW result (no open critical event). Tenant A unless side b. */
export async function newCase(o: { enterer?: Who; side?: 'a' | 'b' } = {}): Promise<Case> {
  const side = o.side ?? 'a';
  const S = await objs(side);
  const enterer = o.enterer ?? person('tech', side);
  const departmentId = uid();
  return addResult({ S, id: '', testId: S.testId, departmentId, enterer }, enterer);
}
/** One more `resulted` result of the same order test (same test id, same department), entered by `enterer`. */
export async function addResult(k: Case, enterer: Who = k.enterer): Promise<Case> {
  const { S, departmentId } = k; const id = uid(); const tenant = S.tenant;
  await asOwner(tenant, async (c) => {
    await ins(c, 'lab.results', { id, tenant_id: tenant, centre_id: S.centre, processing_centre_id: S.centre, order_id: S.orderId, order_item_id: S.itemId, order_test_id: S.orderTestId, specimen_id: S.specimenId,
      patient_id: S.patientId, test_id: S.testId, analyte_id: uid(), analyte_code: 'T0BV', department_id: departmentId, is_reportable: true, result_type: 'numeric', status: 'resulted', origin: 'manual',
      value_numeric: 5, unit_code: 'g/L', resulted_at: '2026-06-15T04:40:00.000Z', first_resulted_at: '2026-06-15T04:40:00.000Z', created_by: enterer.userId, updated_by: enterer.userId });
    await ins(c, 'lab.result_observations', { id: uid(), tenant_id: tenant, centre_id: S.centre, processing_centre_id: S.centre, result_id: id, source: 'manual', value_numeric: 5, unit_code: 'g/L',
      received_at: '2026-06-15T04:40:00.000Z', entered_by_membership_id: enterer.membershipId, created_by: enterer.userId });
  });
  return { ...k, id, enterer };
}
/** catalog department + test rows of a tenant (existence checks of upsertVerificationPolicy) and the CatalogPort fake that knows the test. */
export async function seedCatalog(tenant: string, o: { departmentId: string; testId: string }): Promise<void> {
  const code = `V${uid().slice(-10).toUpperCase().replace(/-/g, '')}`;
  await asOwner(tenant, async (c) => {
    await ins(c, 'catalog.departments', { id: o.departmentId, tenant_id: tenant, code, name: `Dept ${code} (SYNTHETIC)` });
    await ins(c, 'catalog.orderables', { id: o.testId, tenant_id: tenant, kind: 'test', code: `T${code}`, name: `Test ${code} (SYNTHETIC)`, department_id: o.departmentId });
    await ins(c, 'catalog.tests', { id: o.testId, tenant_id: tenant, kind: 'test', workflow_type: 'standard' });
  });
  knownTests(o.testId);
}

/** Owner side policy row (the policy API is tested in policy.live.test.ts; the matrix must not depend on it). */
export async function setPolicy(tenant: string, o: { scope: 'test' | 'department' | 'lab'; testId?: string; departmentId?: string; level: 1 | 2 | 3; pathologist?: boolean; enterer?: boolean; active?: boolean }): Promise<string> {
  const id = uid();
  await asOwner(tenant, (c) => ins(c, 'lab.verification_policy', { id, tenant_id: tenant, scope: o.scope, ...(o.testId ? { test_id: o.testId } : {}), ...(o.departmentId ? { department_id: o.departmentId } : {}),
    required_verifiers: o.level, require_pathologist: o.pathologist ?? true, allow_enterer_verify: o.enterer ?? false, active: o.active ?? true, updated_by: SYS }));
  return id;
}
/** Test scope policy for a case (its own tenant). */
export const policyFor = (k: Case, level: 1 | 2 | 3, o: { pathologist?: boolean; enterer?: boolean } = {}): Promise<string> =>
  setPolicy(k.S.tenant, { scope: 'test', testId: k.testId, level, ...(o.pathologist === undefined ? {} : { pathologist: o.pathologist }), ...(o.enterer === undefined ? {} : { enterer: o.enterer }) });

// ---------------------------------------------------------------- owner side truth
export const rowOf = async (id: string): Promise<{ status: string; version: number; signoff_required: number | null; signoff_count: number; current_version_no: number }> =>
  (await owner('SELECT status, version, signoff_required, signoff_count, current_version_no FROM lab.results WHERE id = $1', [id]))[0];
export const chainOf = async (id: string): Promise<any[]> => owner(`SELECT result_version, seq, action, signer_user_id, signer_display_name, signer_role_code, signer_is_pathologist, signer_registration_no,
  signer_signature_asset_id, signed_at FROM lab.result_signoff WHERE result_id = $1 ORDER BY result_version, seq`, [id]);
export const deniedAudit = async (resultId: string, userId: string): Promise<any[]> =>
  owner(`SELECT action, entity_type, outcome FROM audit.access_log WHERE entity_id = $1 AND actor_id = $2 AND outcome = 'denied'`, [resultId, userId]);

// ---------------------------------------------------------------- the operations (If-Match = the current row version, so a test never fails on a stale number by accident)
const ifm = async (id: string) => ({ 'if-match': `"${(await rowOf(id)).version}"` });
export const verify = async (who: Who, id: string, flags?: string[]): Promise<Outcome> =>
  fire('verifyResult', req({ params: { result_id: id }, headers: await ifm(id), body: flags ? { acknowledged_flags: flags } : {} }), who, { ports: PORTS });
export const approve = async (who: Who, id: string): Promise<Outcome> =>
  fire('approveResult', req({ params: { result_id: id }, headers: await ifm(id), body: {} }), who, { ports: PORTS });
export const bulk = async (op: 'bulkVerifyResults' | 'bulkApproveResults', who: Who, ids: string[], versions: Record<string, number> = {}): Promise<Outcome> => {
  const items = await Promise.all(ids.map(async (id) => ({ id, version: versions[id] ?? (await rowOf(id)).version })));
  return fire(op, req({ headers: { 'idempotency-key': uid() }, body: { items } }), who, { ports: PORTS });
};
export const getResult = (who: Who, id: string): Promise<Outcome> => fire('getResult', req({ params: { result_id: id } }), who, { ports: PORTS });
export const signoffs = (who: Who, id: string): Promise<Outcome> => fire('getResultSignoffs', req({ params: { result_id: id } }), who, { ports: PORTS });
export const queue = (who: Who, stage: 'verify' | 'approve'): Promise<Outcome> => fire('listVerificationQueue', req({ query: { stage } }), who, { ports: PORTS });
export const amend = (who: Who, id: string, value = '6'): Promise<Outcome> =>
  rowOf(id).then((r) => fire('amendResult', req({ params: { result_id: id }, headers: { 'idempotency-key': uid(), 'if-match': `"${r.version}"` }, body: { amendment_reason_code: 'transcription_error', value_numeric: value } }), who, { ports: PORTS }));

/** the code of a failed outcome, or undefined for a reply */
export const code = (o: Outcome): string | undefined => (o.error as { code?: string } | undefined)?.code;
export const http = (o: Outcome): number | undefined => o.reply?.status ?? (o.error as { statusCode?: number } | undefined)?.statusCode;
export const dto = (o: Outcome): any => o.reply?.body;
export const why = (o: Outcome): string => `${o.reply ? `reply ${o.reply.status}` : `error ${(o.error as any)?.code} ${(o.error as any)?.message}`}`;
/** lab.result.signed_off.v1 events of one outcome */
export const SIGNED_OFF = 'lab.result.signed_off.v1';
export const eventsOf = (o: Outcome, type: string): Array<{ type: string; input: any }> => o.probe.events.filter((e) => e.type === type);

/** Put a case into a state through the real operations: `signers` sign in order (verify unless the person holds approve AND `last` is set). Fails loudly when a step is refused. */
export async function signAll(k: Case, steps: Array<{ who: Who; op: 'verify' | 'approve' }>): Promise<void> {
  for (const s of steps) {
    const o = s.op === 'verify' ? await verify(s.who, k.id) : await approve(s.who, k.id);
    if (!o.reply) throw new Error(`setup step ${s.op} refused: ${why(o)}`);
  }
}
