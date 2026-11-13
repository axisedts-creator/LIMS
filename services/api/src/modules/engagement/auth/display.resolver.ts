// queueDisplayToken AuthResolver (CR-C16-005; 02-TRD §4.10, §6.3; 05-SCHEMA §6.3 app.engagement_resolve_display; REQ-SEC-017 device).
// The token is hashed here and only the SHA-256 (bytea, 08 R24) reaches the DEFINER, which sees no tenant yet. Every failure -> undefined -> core answers auth.unauthenticated.
import { sha256Bytes } from '../../../../../../packages/shared-ts/src/crypto/index.js';

const TOKEN = /^[A-Za-z0-9_-]{43}$/; // pairQueueDisplay display_token

export const queueDisplayToken = {
  async resolve(credential: string, tx: unknown): Promise<unknown> {
    if (typeof credential !== 'string' || !TOKEN.test(credential)) return undefined; // no DB round trip for junk
    const { rows } = await (tx as { query(t: string, v: unknown[]): Promise<{ rows: Array<Record<string, string>> }> })
      .query('SELECT * FROM app.engagement_resolve_display($1)', [sha256Bytes(credential)]);
    const r = rows[0];
    if (!r) return undefined;
    return { tenantId: r['tenant_id'], actor: { type: 'device', id: r['display_id'] }, centreId: r['centre_id'], extraClaims: { device_kind: 'queue_display' } };
  },
};
