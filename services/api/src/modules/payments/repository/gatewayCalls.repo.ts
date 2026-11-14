// payments.gateway_calls writer (PG-T04; 05-SCHEMA; TRD §7.6; REQ-SEC-056/098). Append-only (lims_app has INSERT only).
// Last gate before the DB: re-applies the response allowlist and the 64-char cap, whatever the caller passed.
import type { Tx } from '../../../core/db/tx.js';
import { cutChars, MAX_STATUS_RAW_CHARS, redactResponse, type GatewayCallOutcome } from '../gateways/http.js';

export interface GatewayCallInsert {
  id: string;
  tenantId: string;
  intentId?: string | null;
  refundId?: string | null;
  merchantAccountId?: string | null;
  gateway: string;
  operation: string;
  attempt?: number;
  httpStatus?: number | null;
  outcome: GatewayCallOutcome;
  gatewayStatusRaw?: string | null;
  responseRedacted?: unknown;
  durationMs: number;
  createdBy: string;
}

const SQL = `INSERT INTO payments.gateway_calls
  (id, tenant_id, intent_id, refund_id, merchant_account_id, gateway, operation, attempt, http_status, outcome,
   gateway_status_raw, response_redacted, duration_ms, created_by)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14)`;

export async function insertGatewayCall(tx: Pick<Tx, 'query'>, r: GatewayCallInsert): Promise<void> {
  const redacted = r.responseRedacted == null ? null : redactResponse(r.gateway, r.operation, r.responseRedacted);
  await tx.query(SQL, [
    r.id, r.tenantId, r.intentId ?? null, r.refundId ?? null, r.merchantAccountId ?? null, r.gateway, r.operation,
    r.attempt ?? 1, r.httpStatus ?? null, r.outcome,
    r.gatewayStatusRaw == null ? null : cutChars(r.gatewayStatusRaw, MAX_STATUS_RAW_CHARS),
    redacted === null ? null : JSON.stringify(redacted),
    r.durationMs, r.createdBy,
  ]);
}
