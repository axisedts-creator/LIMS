// applicantPreAuth AuthResolver (PHLEBO-UI-FULL-1, CR-C17-017; owner decision 2026-11-26: applicants get their own credential,
// the patient pre-auth credential keeps its single permission).
// Credential `t.<tenant_code>`: a person who is not signed in applies for work at one lab. It carries no secret, so it grants
// one permission only (homecollection.application.submit, fixed_actor_permissions.job_applicant_pre_auth) and every write
// behind it is rate limited and token bound in application.service.ts.
// Actor type `patient` with patient_stage `job_applicant`. Not `device`: in the database app.is_staff_or_system() counts a
// device as staff, which would open every tenant row policy. A patient-type actor has no staff rights there, and the stage
// value keeps it apart from the patient pre-auth credential (`pre_auth`) and from a signed-in patient (no stage): IdentityPort
// maps it to its own permission set, and the SQL functions for applications accept this stage only.
// Malformed input costs no round trip; every failure -> undefined -> core answers the same auth.unauthenticated.
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';

const TENANT_ONLY = /^t\.([a-z][a-z0-9_]{2,31})$/; // = tenants__tenant_code__ck
type Tx = { query(text: string, values: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> };

export const applicantPreAuth = {
  async resolve(credential: string, tx: unknown): Promise<unknown> {
    if (typeof credential !== 'string') return undefined;
    const t = TENANT_ONLY.exec(credential);
    if (!t) return undefined;
    const r = (await (tx as Tx).query('SELECT * FROM app.core_resolve_tenant_code($1)', [t[1]])).rows[0];
    if (!r || r['status'] !== 'active' || typeof r['tenant_id'] !== 'string') return undefined;
    // fresh actor id per call: nothing links two anonymous callers
    return { tenantId: r['tenant_id'], actor: { type: 'patient', id: uuidv7() }, extraClaims: { patient_stage: 'job_applicant' } };
  },
};
