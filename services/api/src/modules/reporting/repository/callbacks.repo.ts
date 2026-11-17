// CB1 / CB2 provider callbacks (06-PLAN C6-T29; LD-49 (b)). The token is resolved pre-tenant, so the ONLY access is the DEFINER (05-SCHEMA §6.2):
// it validates the callback token hash, records the events (dedupe on provider_events__dedupe__uq) and returns the resolved tenant id, NULL = rejected. It never enqueues.
import type { Tx } from './settings.repo.js';

export interface IngestEvent { id: string; provider_message_id: string; status_raw: string; mapped_status: string; occurred_at?: string }

export async function ingestProviderCallback(tx: Tx, providerKind: string, tokenSha256: Uint8Array, events: readonly IngestEvent[]): Promise<string | null> {
  const { rows } = await tx.query('SELECT app.reporting_ingest_provider_callback($1, $2, $3::jsonb) AS tenant_id', [providerKind, Buffer.from(tokenSha256), JSON.stringify(events)]);
  const t = rows[0]?.['tenant_id'];
  return typeof t === 'string' ? t : null;
}
