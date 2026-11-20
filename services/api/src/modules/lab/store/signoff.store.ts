// T0B-VERLEVEL-1 (LD-316; LD-318 follow-up 4; T0C migration 20261117150000): SQL of the verification levels. lab.verification_policy (one active row per target, never deleted)
// and lab.result_signoff (APPEND ONLY: this file only SELECTs and INSERTs it). Caller's tx only; tenant = $1 of every statement (tenant_id filter next to RLS, REQ-SEC-024).
// The catalog existence checks read the published views catalog.v_pub_department / catalog.v_pub_test_directory (security_invoker, granted to lims_app), never catalog tables.
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError } from '../../../core/errors.js';
import { isUuid } from '../repository/base.repo.js';
import { rcOf, sql } from './scope.js';

type Obj = Record<string, any>;
export interface Policy { id?: string; scope: 'lab' | 'department' | 'test'; level: number; requirePathologist: boolean; allowEntererVerify: boolean }
export interface SignoffState { count: number; frozen: number | undefined; policy: Policy; signers: string[]; entererMembershipId: string | undefined }
export interface SignoffRow {
  resultId: string; resultVersion: number; action: 'verify' | 'approve'; signerUserId: string; displayName: string; roleCode: string; isPathologist: boolean;
  registrationNo?: string; signatureAssetId?: string; signedAt: string;
}

/** LD-316 default (no policy row at all): level 2 with a pathologist, the enterer may not sign. Reproduces the old verify-then-approve flow. */
export const DEFAULT_POLICY: Policy = { scope: 'lab', level: 2, requirePathologist: true, allowEntererVerify: false };

/** most specific ACTIVE policy of a result row aliased `r` (test > department > lab). Columns vp_level / vp_pathologist / vp_enterer. */
export const POLICY_LATERAL = (r: string): string => `LEFT JOIN LATERAL (SELECT p.id AS vp_id, p.scope AS vp_scope, p.required_verifiers AS vp_level, p.require_pathologist AS vp_pathologist,
      p.allow_enterer_verify AS vp_enterer FROM lab.verification_policy p
    WHERE p.tenant_id = ${r}.tenant_id AND p.active AND (p.scope = 'lab' OR (p.scope = 'department' AND p.department_id = ${r}.department_id) OR (p.scope = 'test' AND p.test_id = ${r}.test_id))
    ORDER BY CASE p.scope WHEN 'test' THEN 0 WHEN 'department' THEN 1 ELSE 2 END LIMIT 1) vp ON true`;

const policyOf = (r: Obj | undefined): Policy => (r && r['vp_level'] != null
  ? { id: r['vp_id'], scope: r['vp_scope'], level: Number(r['vp_level']), requirePathologist: Boolean(r['vp_pathologist']), allowEntererVerify: Boolean(r['vp_enterer']) }
  : DEFAULT_POLICY);

export const signoffStore = () => ({
  /** sign-off state of one (already locked) result: counter, frozen level, resolved policy, signers of the current version, enterer of the latest manual observation. */
  async state(tx: unknown, t: string, resultId: string): Promise<SignoffState | undefined> {
    const r = (await sql(tx, t, `SELECT r.signoff_count, r.signoff_required, r.current_version_no, vp.*,
          (SELECT o.entered_by_membership_id FROM lab.result_observations o WHERE o.tenant_id = r.tenant_id AND o.result_id = r.id AND o.source = 'manual'
            ORDER BY o.created_at DESC, o.id DESC LIMIT 1) AS enterer
        FROM lab.results r ${POLICY_LATERAL('r')} WHERE r.tenant_id = $1 AND r.id = $2`, [resultId]))[0];
    if (!r) return undefined;
    const signers = (await sql(tx, t, 'SELECT signer_user_id FROM lab.result_signoff WHERE tenant_id = $1 AND result_id = $2 AND result_version = $3', [resultId, r['current_version_no']]))
      .map((x) => String(x['signer_user_id']));
    return { count: Number(r['signoff_count'] ?? 0), frozen: r['signoff_required'] == null ? undefined : Number(r['signoff_required']), policy: policyOf(r), signers,
      entererMembershipId: r['enterer'] ?? undefined };
  },

  /** appends ONE chain row (seq = counter + 1) and moves the counter; the level is frozen on the first sign-off (COALESCE). Same tx as the status change, BEFORE it (the lock trigger freezes approved rows). */
  async append(tx: unknown, t: string, a: SignoffRow & { level: number }): Promise<{ seq: number; count: number; required: number }> {
    const rc = await rcOf(tx, t);
    const r = (await sql(tx, t, `UPDATE lab.results SET signoff_required = COALESCE(signoff_required, $3), signoff_count = signoff_count + 1, updated_at = now(), updated_by = $4
        WHERE tenant_id = $1 AND id = $2 AND status IN ('resulted','verified') RETURNING signoff_count, signoff_required`, [a.resultId, a.level, rc.actorId]))[0];
    if (!r) throw new LimsError('common.version_conflict');
    const seq = Number(r['signoff_count']);
    await sql(tx, t, `INSERT INTO lab.result_signoff (id, tenant_id, result_id, result_version, seq, action, signer_user_id, signer_display_name, signer_role_code, signer_is_pathologist,
        signer_registration_no, signer_signature_asset_id, signed_at) VALUES ($2, $1, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::timestamptz)`,
    [uuidv7(), a.resultId, a.resultVersion, seq, a.action, a.signerUserId, a.displayName, a.roleCode, a.isPathologist, a.registrationNo ?? null, a.signatureAssetId ?? null, a.signedAt]);
    return { seq, count: seq, required: Number(r['signoff_required']) };
  },

  /** chain of every version, ordered by version then seq (getResultSignoffs). */
  listChain: (tx: unknown, t: string, resultId: string): Promise<Obj[]> =>
    sql(tx, t, `SELECT result_version, seq, action, signer_user_id, signer_display_name, signer_role_code, signer_is_pathologist, signer_registration_no, signed_at
        FROM lab.result_signoff WHERE tenant_id = $1 AND result_id = $2 ORDER BY result_version, seq`, [resultId]),

  /** sign-off columns + the resolved policy for result rows (DTO next_step). lab.v_result_current predates the counters, so they are read from lab.results. */
  async counters(tx: unknown, t: string, ids: readonly string[]): Promise<Map<string, Obj>> {
    const ok = [...new Set(ids.filter(isUuid))];
    if (!ok.length) return new Map();
    const rows = await sql(tx, t, `SELECT r.id, r.signoff_count, r.signoff_required, vp.vp_level, vp.vp_pathologist FROM lab.results r ${POLICY_LATERAL('r')}
        WHERE r.tenant_id = $1 AND r.id = ANY($2::uuid[])`, [ok]);
    return new Map(rows.map((r) => [String(r['id']), r]));
  },

  // ---------------------------------------------------------------- policies
  listPolicies: (tx: unknown, t: string): Promise<Obj[]> =>
    sql(tx, t, `SELECT * FROM lab.verification_policy WHERE tenant_id = $1 AND active ORDER BY CASE scope WHEN 'lab' THEN 0 WHEN 'department' THEN 1 ELSE 2 END, created_at, id LIMIT 2000`),

  /** LD-316: the lab scope policy always exists; a tenant seeded without it gets the default on first read (the unique partial index makes a race harmless). */
  async ensureLabDefault(tx: unknown, t: string): Promise<void> {
    const rc = await rcOf(tx, t);
    await sql(tx, t, `INSERT INTO lab.verification_policy (id, tenant_id, scope, required_verifiers, require_pathologist, allow_enterer_verify, active, updated_by)
        SELECT $2, $1, 'lab', 2, true, false, true, $3 WHERE NOT EXISTS (SELECT 1 FROM lab.verification_policy p WHERE p.tenant_id = $1 AND p.scope = 'lab' AND p.active)
        ON CONFLICT DO NOTHING`, [uuidv7(), rc.actorId]);
  },

  async lockActivePolicy(tx: unknown, t: string, a: { scope: string; departmentId?: string; testId?: string }): Promise<Obj | undefined> {
    return (await sql(tx, t, `SELECT * FROM lab.verification_policy WHERE tenant_id = $1 AND active AND scope = $2 AND department_id IS NOT DISTINCT FROM $3::uuid AND test_id IS NOT DISTINCT FROM $4::uuid
        FOR UPDATE`, [a.scope, a.departmentId ?? null, a.testId ?? null]))[0];
  },

  /** department / test exists in THIS tenant (published catalog views, RLS applies through security_invoker). */
  async targetExists(tx: unknown, t: string, a: { departmentId?: string; testId?: string }): Promise<boolean> {
    if (a.departmentId !== undefined) return (await sql(tx, t, 'SELECT 1 AS x FROM catalog.v_pub_department WHERE tenant_id = $1 AND department_id = $2', [a.departmentId])).length > 0;
    if (a.testId !== undefined) return (await sql(tx, t, 'SELECT 1 AS x FROM catalog.v_pub_test_directory WHERE tenant_id = $1 AND test_id = $2', [a.testId])).length > 0;
    return true;
  },

  async insertPolicy(tx: unknown, t: string, a: { scope: string; departmentId?: string; testId?: string; level: number; requirePathologist: boolean; allowEntererVerify: boolean; active: boolean }): Promise<Obj> {
    const rc = await rcOf(tx, t);
    try {
      return (await sql(tx, t, `INSERT INTO lab.verification_policy (id, tenant_id, scope, department_id, test_id, required_verifiers, require_pathologist, allow_enterer_verify, active, updated_by)
          VALUES ($2, $1, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [uuidv7(), a.scope, a.departmentId ?? null, a.testId ?? null, a.level, a.requirePathologist, a.allowEntererVerify, a.active, rc.actorId]))[0]!;
    } catch (e) {
      if ((e as { code?: string })?.code === '23505') throw new LimsError('common.version_conflict');   // a parallel create of the same target won
      throw e;
    }
  },

  async updatePolicy(tx: unknown, t: string, a: { id: string; expectedVersion: number; level: number; requirePathologist: boolean; allowEntererVerify: boolean; active: boolean }): Promise<Obj> {
    const rc = await rcOf(tx, t);
    const r = (await sql(tx, t, `UPDATE lab.verification_policy SET required_verifiers = $4, require_pathologist = $5, allow_enterer_verify = $6, active = $7, version = version + 1,
        updated_at = now(), updated_by = $8 WHERE tenant_id = $1 AND id = $2 AND version = $3 RETURNING *`,
    [a.id, a.expectedVersion, a.level, a.requirePathologist, a.allowEntererVerify, a.active, rc.actorId]))[0];
    if (!r) throw new LimsError('common.version_conflict');
    return r;
  },
});
export type SignoffStore = ReturnType<typeof signoffStore>;
