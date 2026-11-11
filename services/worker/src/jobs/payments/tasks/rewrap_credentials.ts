// PG-T17 — payments.rewrap_credentials (02-TRD §6.9 rotation, §8.3 cron `10 21 * * *` per_tenant, RB-7).
// Re-encrypts every merchant secret whose secret_kek_id differs from the ACTIVE kek id. Idempotent: rows on the active key are not touched.
// Fail closed: a row that cannot be opened (retired key id, failed authentication) is skipped unchanged; nothing about key/secret material is logged.
import { encryptSecret, openSecret, type Kek } from '../../../../../api/src/modules/payments/service/credentials.js';
import type { TaskHandler } from '../../../core/manifest.js';

export const REWRAP_CREDENTIALS = 'payments.rewrap_credentials';

export function createRewrapCredentials(deps: { kek: Kek }): TaskHandler {
  return async (payload, ctx) => {
    const tenantId = payload.tenant_id ?? ctx.tenantId;
    if (!tenantId) throw new Error('payments.rewrap_credentials: tenant_id required');
    const { rows } = await ctx.tx.query(
      'SELECT * FROM payments.merchant_accounts WHERE tenant_id = $1 AND secret_ciphertext IS NOT NULL AND secret_kek_id <> $2 FOR UPDATE', [tenantId, deps.kek.activeId]);
    for (const r of rows) {
      const aad = { tenantId, gateway: r.gateway, environment: r.environment, merchantAccountId: r.id };
      let next: ReturnType<typeof encryptSecret>;
      try {
        next = await openSecret(deps.kek, { ciphertext: r.secret_ciphertext, nonce: r.secret_nonce, authTag: r.secret_auth_tag, kekId: r.secret_kek_id }, aad)
          .use((secret) => encryptSecret(deps.kek, secret, aad));
      } catch { continue; }                                               // unreadable under this KEK file: left as is (fingerprint/version untouched)
      await ctx.tx.query(
        'UPDATE payments.merchant_accounts SET secret_ciphertext = $1, secret_nonce = $2, secret_auth_tag = $3, secret_kek_id = $4 WHERE id = $5 AND tenant_id = $6 AND secret_kek_id = $7',
        [next.ciphertext, next.nonce, next.authTag, next.kekId, r.id, tenantId, r.secret_kek_id]);
    }
  };
}
