// Patient-context repo (LD-81, CR-C16 draft): the PatientWrites seams of IdentityPort over the three DEFINER functions of
// db/migrations/20261117000000_identity__patient_provision_and_session_definers.sql. Every statement binds only its own inputs;
// the functions check the tenant and the pre-auth patient claims themselves (RLS hides these tables from a patient actor).
// No phone, e-mail, token or session secret is logged or returned from here. Any DB error propagates to core (mapDbError) -> 500 common.internal.
import { LimsError } from '../../../core/errors.js';
import type { NewPatientSession, PatientWrites } from '../ports/IdentityPort.impl.js';

type Q = { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> };
type RepoCtx = { tenantId?: string; tx?: unknown };

const txOf = (ctx: RepoCtx): Q => {
  const t = ctx?.tx as Q | undefined;
  if (!ctx?.tenantId || typeof t?.query !== 'function') throw new LimsError('common.internal');
  return t;
};

const PROVISION_SQL = 'SELECT membership_id, user_id FROM app.identity_patient_create_membership($1::uuid)';
const MEMBERSHIP_SQL = 'SELECT user_id, status, locked FROM app.identity_patient_membership($1::uuid)';
const OPEN_SESSION_SQL = 'SELECT app.identity_patient_open_session($1::jsonb)';

export interface PatientMembershipFacts { userId: string; status: string; locked: boolean }
export interface PatientReads {
  /** pre-auth patient context only (the DEFINER refuses anything else); undefined = no such patient membership in this tenant */
  patientMembership(ctx: RepoCtx, i: { membershipId: string }): Promise<PatientMembershipFacts | undefined>;
}

/** The DEFINER reads token_sha256 as a bytea text literal inside the jsonb row. */
export function sessionRow(s: NewPatientSession & { accessExpiresAt: Date }, tenantId: string): Record<string, unknown> {
  return {
    id: s.id, tenant_id: tenantId, kind: 'patient', user_id: s.userId, membership_id: s.membershipId,
    token_sha256: `\\x${s.tokenSha256.toString('hex')}`, state: 'active', aal: 'aal1',
    access_expires_at: s.accessExpiresAt.toISOString(), idle_timeout_minutes: s.idleTimeoutMinutes, idle_expires_at: s.idleExpiresAt.toISOString(),
    absolute_expires_at: s.absoluteExpiresAt.toISOString(), expires_at: s.expiresAt.toISOString(),
    app_instance_id: s.appInstanceId, app_platform: s.appPlatform, created_by: s.actorId, updated_by: s.actorId,
  };
}

export function createPatientWritesRepo(): Pick<PatientWrites, 'createPatientMembership' | 'insertPatientSession'> & PatientReads {
  return {
    async createPatientMembership(ctx, i) {
      const { rows } = await txOf(ctx).query(PROVISION_SQL, [i.accountId]);
      const r = rows[0];
      if (!r?.membership_id || !r?.user_id) throw new LimsError('common.internal');
      return { membershipId: String(r.membership_id), userId: String(r.user_id) };
    },
    async insertPatientSession(ctx, s) {
      await txOf(ctx).query(OPEN_SESSION_SQL, [JSON.stringify(sessionRow(s as NewPatientSession & { accessExpiresAt: Date }, String(ctx.tenantId)))]);
    },
    async patientMembership(ctx, i) {
      const { rows } = await txOf(ctx).query(MEMBERSHIP_SQL, [i.membershipId]);
      const r = rows[0];
      return r ? { userId: String(r.user_id), status: String(r.status), locked: r.locked === true } : undefined;
    },
  };
}
