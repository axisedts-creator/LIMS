// PG-T08 SQL for payments.intents / intent_transitions / merchant_accounts / settings (05-SCHEMA §1, §6). Every statement is tenant-scoped.
// Dialect kept to the subset documented in __tests__/helpers/merchantDb.ts (no OR / sub-selects).
import { LimsError } from '../../../core/errors.js';
import { openSecret, type Kek, type SecretHandle } from '../service/credentials.js';
import type { Ctx, Row } from './shared.js';

export const findByKey = async (ctx: Ctx, key: string): Promise<Row | undefined> =>
  (await ctx.tx.query('SELECT * FROM payments.intents WHERE tenant_id = $1 AND idempotency_key = $2', [ctx.tenantId, key])).rows[0];

export const findById = async (ctx: Ctx, id: string, lock = false): Promise<Row | undefined> =>
  (await ctx.tx.query(`SELECT * FROM payments.intents WHERE tenant_id = $1 AND id = $2${lock ? ' FOR UPDATE' : ''}`, [ctx.tenantId, id])).rows[0];

/** ON CONFLICT DO NOTHING covers the idempotency key, the one-open-per-order index, the txn-ref index and the token hash. false = no row inserted. */
export async function insertIntent(ctx: Ctx, r: Row): Promise<boolean> {
  const cols = Object.keys(r);
  const res = await ctx.tx.query(
    `INSERT INTO payments.intents (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) ON CONFLICT DO NOTHING RETURNING id`,
    cols.map((c) => r[c]));
  return (res.rowCount ?? res.rows.length) > 0;
}

/** Optimistic update on the locked row: version predicate + optional from-status set; bumps version. undefined = nothing updated. */
export async function updateIntent(ctx: Ctx, row: Row, sets: Row, o: { from?: readonly string[]; inc?: readonly string[] } = {}): Promise<Row | undefined> {
  const all: Row = { ...sets, updated_at: ctx.now(), updated_by: ctx.actor.id };
  const cols = Object.keys(all);
  const assigns = [...cols.map((c, i) => `${c} = $${i + 1}`), ...(o.inc ?? []).map((c) => `${c} = ${c} + 1`), 'version = version + 1'];
  const vals: unknown[] = cols.map((c) => all[c]);
  const n = vals.length;
  vals.push(ctx.tenantId, row['id'], row['version']);
  let where = `tenant_id = $${n + 1} AND id = $${n + 2} AND version = $${n + 3}`;
  if (o.from) { vals.push([...o.from]); where += ` AND status = ANY($${n + 4})`; }
  return (await ctx.tx.query(`UPDATE payments.intents SET ${assigns.join(', ')} WHERE ${where} RETURNING *`, vals)).rows[0];
}

export async function insertTransition(ctx: Ctx, id: string, intentId: string, t: { from: string | null; to: string; cause: string; reason?: string }): Promise<void> {
  await ctx.tx.query(
    'INSERT INTO payments.intent_transitions (id, tenant_id, intent_id, from_status, to_status, cause, reason_code, actor_type, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
    [id, ctx.tenantId, intentId, t.from, t.to, t.cause, t.reason ?? null, ctx.actor.type, ctx.actor.id]);
}

export const accountBySlot = async (ctx: Ctx, gateway: string, environment: string): Promise<Row | undefined> =>
  (await ctx.tx.query('SELECT * FROM payments.merchant_accounts WHERE tenant_id = $1 AND gateway = $2 AND environment = $3', [ctx.tenantId, gateway, environment])).rows[0];
export const accountById = async (ctx: Ctx, id: string): Promise<Row | undefined> =>
  (await ctx.tx.query('SELECT * FROM payments.merchant_accounts WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, id])).rows[0];

/** Enabled and secret set, else payments.gateway_not_available (TRD §6.1 step 4, §5.3 verify). Returns the row and a handle to its secret. */
export function usable(kek: Kek, ctx: Ctx, acct: Row | undefined): { acct: Row; handle: SecretHandle } {
  if (!acct || acct['is_enabled'] !== true || acct['secret_ciphertext'] == null) throw new LimsError('payments.gateway_not_available');
  const handle = openSecret(kek, { ciphertext: acct['secret_ciphertext'], nonce: acct['secret_nonce'], authTag: acct['secret_auth_tag'], kekId: acct['secret_kek_id'] },
    { tenantId: ctx.tenantId, gateway: acct['gateway'], environment: acct['environment'], merchantAccountId: acct['id'] });
  return { acct, handle };
}

export async function purchaseOrderLabel(ctx: Ctx): Promise<string> {
  const r = (await ctx.tx.query('SELECT purchase_order_label FROM payments.settings WHERE tenant_id = $1', [ctx.tenantId])).rows[0];
  return r?.['purchase_order_label'] ?? 'Lab payment'; // 05-SCHEMA default, no seed row (08 A17 P-22)
}
