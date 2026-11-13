// patientPreAuth AuthResolver (CR-C16-005; 02-TRD §4.2, §6.3; 05-SCHEMA §6.2 app.core_resolve_tenant_code, §6.3 app.engagement_resolve_preauth; REQ-SEC-017).
// Credential `t.<tenant_code>` (E1/E2) or `c.<tenant_code>.<challenge_token>` (E3). No tenant exists yet, so the only SQL is a SELECT of a DEFINER function;
// the token is hashed here and only its SHA-256 (32-byte bytea, 08 R24) reaches the database. Malformed input never costs a round trip; every failure
// (unknown, suspended, wrong tenant, expired, junk) -> undefined -> core answers the same auth.unauthenticated.
import { sha256Bytes } from '../../../../../../packages/shared-ts/src/crypto/index.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';

const TENANT_ONLY = /^t\.([a-z][a-z0-9_]{2,31})$/; // = tenants__tenant_code__ck
const CHALLENGE = /^c\.([a-z][a-z0-9_]{2,31})\.([A-Za-z0-9_-]{43})$/; // 32 random bytes, base64url
type Tx = { query(text: string, values: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> };

export const patientPreAuth = {
  async resolve(credential: string, tx: unknown): Promise<unknown> {
    if (typeof credential !== 'string') return undefined;
    const q = (tx as Tx).query.bind(tx);
    const t = TENANT_ONLY.exec(credential);
    if (t) {
      const r = (await q('SELECT * FROM app.core_resolve_tenant_code($1)', [t[1]])).rows[0];
      if (!r || r['status'] !== 'active' || typeof r['tenant_id'] !== 'string') return undefined;
      // fresh actor id per call: nothing links two anonymous callers
      return { tenantId: r['tenant_id'], actor: { type: 'patient', id: uuidv7() }, extraClaims: { patient_stage: 'pre_auth' } };
    }
    const c = CHALLENGE.exec(credential);
    if (!c) return undefined;
    const hash = sha256Bytes(c[2]!);
    const r = (await q('SELECT * FROM app.engagement_resolve_preauth($1, $2)', [c[1], hash])).rows[0];
    if (!r || typeof r['tenant_id'] !== 'string' || typeof r['challenge_id'] !== 'string') return undefined;
    return {
      tenantId: r['tenant_id'], actor: { type: 'patient', id: r['challenge_id'] },
      extraClaims: { patient_stage: 'pre_auth', otp_token_sha256: Buffer.from(hash).toString('hex') },
    };
  },
};
