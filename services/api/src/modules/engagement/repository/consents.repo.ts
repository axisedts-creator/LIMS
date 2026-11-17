// engagement.link_consents (append-only: S I, 05-SCHEMA §2; T-L1 writes the desk consent of L1, 02-TRD §4.3.1 step 4). Every statement binds tenant_id (REQ-SEC-024).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import type { Tx } from '../../../core/db/tx.js';

type Q = Pick<Tx, 'query'>;

export async function insertDeskConsent(tx: Q, a: { tenantId: string; userId: string; patientId: string; relationship: string; consentedBy: string; identityCheck: string; consentTextVersion: string; now: string }): Promise<string> {
  const id = uuidv7();
  await tx.query(
    `INSERT INTO engagement.link_consents (id, tenant_id, patient_id, source, relationship, consented_by, consent_text_version, identity_check_method, recorded_by_membership_id, recorded_at, created_by)
     VALUES ($1, $2, $3, 'desk', $4, $5, $6, $7, $8, $9, $8)`,
    [id, a.tenantId, a.patientId, a.relationship, a.consentedBy, a.consentTextVersion, a.identityCheck, a.userId, a.now]);
  return id;
}
