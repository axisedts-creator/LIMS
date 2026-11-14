// PG-T17 — merchant accounts + payment settings, operations P20–P23 (02-TRD §5 rows P20–P23, §5.1, §6.9; 05-SCHEMA merchant_accounts / settings;
// 01-PRD US-PG-10; 07-SECURITY ST-24, REQ-SEC-058/128/136; 08 A17 P-22 lazy singleton, A19 D-112 access log).
// The secret is write-only: it is encrypted here (credentials.ts) and never read back into a DTO, a log line or the access log.
import { randomBytes, randomUUID } from 'node:crypto';
import type { AccessLogEntry } from '../../../core/audit/access.js';
import { LimsError, type FieldError } from '../../../core/errors.js';
// [CONV] uuidv7 via relative import until @lims/shared-ts is a services/api dependency (same as catalog services).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import type { PaymentsConfig } from '../config.js';
import { encryptSecret, openSecret, type Kek } from './credentials.js';

type Row = Record<string, any>;
export interface MerchantCtx {
  readonly tenantId: string;
  readonly actor: { readonly id: string };
  readonly tx: { query(text: string, values?: unknown[]): Promise<{ rows: Row[]; rowCount: number | null }> };
  readonly audit: { access(entry: AccessLogEntry): Promise<void> };
}
export interface MerchantDeps { config: PaymentsConfig; kek: Kek; fetch?: typeof fetch }
export type TestOutcome = 'reachable_key_valid' | 'reachable_key_unverifiable' | 'auth_failed' | 'unreachable';

const GATEWAYS = ['esewa', 'khalti', 'fonepay'];
const ENVIRONMENTS = ['uat', 'production'];
const ACCOUNT_KEYS = ['is_enabled', 'esewa_product_code', 'khalti_website_url', 'secret', 'api_refunds_enabled'];
const ACCOUNT_FIELDS = ['is_enabled', 'esewa_product_code', 'khalti_website_url', 'api_refunds_enabled']; // logged by name when changed ('secret' is added separately)
const SETTINGS_KEYS = ['refund_two_person_threshold_paisa', 'purchase_order_label', 'reconciliation_enabled'];
const SETTINGS_DEFAULTS: Row = { refund_two_person_threshold_paisa: 0, purchase_order_label: 'Lab payment', reconciliation_enabled: true, version: 1 };
const CODE_RE = /^[A-Za-z0-9_-]{1,64}$/;
const LABEL_RE = /^[A-Za-z0-9 .,&()-]{1,50}$/;
const SECRET_MAX = 256;

// Messages are fixed strings: a value (and above all the secret) never reaches an error.
const invalid = (path: string, message = 'invalid'): never => {
  throw new LimsError('common.validation_failed', undefined, [{ path, code: 'common.field_invalid', message } satisfies FieldError]);
};
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const iso = (d: unknown): string => new Date(d as Date).toISOString();
const slot = (gateway: unknown, environment: unknown): void => {
  if (typeof gateway !== 'string' || !GATEWAYS.includes(gateway)) invalid('gateway');
  if (typeof environment !== 'string' || !ENVIRONMENTS.includes(environment)) invalid('environment');
};
const accessLog = (ctx: MerchantCtx, entityType: string, fields: string[], entityId?: string): Promise<void> =>
  ctx.audit.access({ action: 'settings.change', entityType, ...(entityId ? { entityId } : {}), outcome: 'allowed', detail: { fields: fields.join(',') } }); // names only, never a value

function accountDto(r: Row): Row {
  const dto: Row = { gateway: r.gateway, environment: r.environment, is_enabled: r.is_enabled };
  if (r.esewa_product_code != null) dto.esewa_product_code = r.esewa_product_code;
  if (r.khalti_website_url != null) dto.khalti_website_url = r.khalti_website_url;
  dto.api_refunds_enabled = r.api_refunds_enabled;
  dto.secret = r.secret_ciphertext != null ? { is_set: true, set_at: iso(r.secret_set_at), fingerprint: r.secret_fingerprint } : { is_set: false };
  if (r.last_test_outcome != null) dto.last_test = { outcome: r.last_test_outcome, at: iso(r.last_test_at) };
  dto.version = r.version;
  return dto;
}

const settingsDto = (r: Row): Row => ({
  refund_two_person_threshold: { amount_paisa: Number(r.refund_two_person_threshold_paisa), currency: 'NPR' },
  purchase_order_label: r.purchase_order_label, reconciliation_enabled: r.reconciliation_enabled, version: r.version,
});

function validateAccountBody(gateway: string, body: unknown): Row {
  if (!isObject(body)) return invalid('body');
  for (const k of Object.keys(body)) if (!ACCOUNT_KEYS.includes(k)) invalid(k, 'unknown field');
  if (typeof body['is_enabled'] !== 'boolean') invalid('is_enabled');
  const out: Row = { is_enabled: body['is_enabled'] };
  if ('esewa_product_code' in body) {
    const v = body['esewa_product_code'];
    if (gateway !== 'esewa' || typeof v !== 'string' || !CODE_RE.test(v)) invalid('esewa_product_code');
    out['esewa_product_code'] = v;
  }
  if ('khalti_website_url' in body) {
    const v = body['khalti_website_url'];
    let ok = gateway === 'khalti' && typeof v === 'string' && v.length <= 300;
    if (ok) { try { ok = new URL(v as string).protocol === 'https:' && /^https:\/\//.test(v as string); } catch { ok = false; } }
    if (!ok) invalid('khalti_website_url');
    out['khalti_website_url'] = v;
  }
  if ('api_refunds_enabled' in body) {
    const v = body['api_refunds_enabled'];
    if (typeof v !== 'boolean' || (v && gateway !== 'khalti')) invalid('api_refunds_enabled');
    out['api_refunds_enabled'] = v;
  }
  if ('secret' in body) {
    const v = body['secret'];
    if (typeof v !== 'string' || v.length < 1 || v.length > SECRET_MAX) invalid('secret');
    out['secret'] = v;
  }
  return out;
}

function validateSettingsBody(body: unknown): Row {
  if (!isObject(body)) return invalid('body');
  for (const k of Object.keys(body)) if (!SETTINGS_KEYS.includes(k)) invalid(k, 'unknown field');
  const t = body['refund_two_person_threshold_paisa'];
  if (typeof t !== 'number' || !Number.isSafeInteger(t) || t < 0) invalid('refund_two_person_threshold_paisa');
  const l = body['purchase_order_label'];
  if (typeof l !== 'string' || !LABEL_RE.test(l)) invalid('purchase_order_label');
  if (typeof body['reconciliation_enabled'] !== 'boolean') invalid('reconciliation_enabled');
  return { refund_two_person_threshold_paisa: t, purchase_order_label: l, reconciliation_enabled: body['reconciliation_enabled'] };
}

const conflict = (): never => { throw new LimsError('common.version_conflict'); };
/** If-Match of an existing row: absent -> 428, stale -> 409. */
function checkVersion(expected: number | undefined, current: number): void {
  if (expected === undefined) throw new LimsError('common.precondition_required');
  if (expected !== current) conflict();
}

export function createMerchantService(deps: MerchantDeps) {
  const { config, kek } = deps;
  const doFetch = deps.fetch ?? globalThis.fetch;

  const findAccount = async (ctx: MerchantCtx, gateway: string, environment: string, lock: boolean): Promise<Row | undefined> =>
    (await ctx.tx.query(`SELECT * FROM payments.merchant_accounts WHERE tenant_id = $1 AND gateway = $2 AND environment = $3${lock ? ' FOR UPDATE' : ''}`,
      [ctx.tenantId, gateway, environment])).rows[0];

  async function listMerchantAccounts(ctx: MerchantCtx): Promise<{ data: Row[] }> {
    const r = await ctx.tx.query('SELECT * FROM payments.merchant_accounts WHERE tenant_id = $1 AND is_active = true ORDER BY gateway ASC, environment ASC', [ctx.tenantId]);
    return { data: r.rows.map(accountDto) };
  }

  async function putMerchantAccount(ctx: MerchantCtx, input: { gateway: string; environment: string; expectedVersion?: number; body: unknown }): Promise<Row> {
    const { gateway, environment, expectedVersion } = input;
    slot(gateway, environment);
    // Environment guard (TRD §6.9, REQ-SEC-058/136): production deployment <-> environment 'production' only.
    if ((config.gatewayEnv === 'production') !== (environment === 'production')) invalid('environment', 'not allowed in this deployment');
    const body = validateAccountBody(gateway, input.body);
    if (gateway === 'fonepay' && body['is_enabled']) throw new LimsError('payments.gateway_not_available'); // B8: stored disabled only

    const existing = await findAccount(ctx, gateway, environment, true);
    if (existing) checkVersion(expectedVersion, existing['version']);
    const merged: Row = { esewa_product_code: null, khalti_website_url: null, api_refunds_enabled: false, ...(existing ?? {}), ...body };
    if (config.gatewayEnv === 'production' && merged['esewa_product_code'] === 'EPAYTEST') invalid('esewa_product_code', 'not allowed in this deployment');
    const hasSecret = body['secret'] !== undefined || existing?.['secret_ciphertext'] != null;
    if (merged['is_enabled'] && !(hasSecret && ((gateway === 'esewa' && merged['esewa_product_code']) || (gateway === 'khalti' && merged['khalti_website_url'])))) invalid('is_enabled', 'account is incomplete');

    const before: Row = existing ?? { is_enabled: false, esewa_product_code: null, khalti_website_url: null, api_refunds_enabled: false };
    const fields = ACCOUNT_FIELDS.filter((f) => f in body && body[f] !== before[f]);
    if (body['secret'] !== undefined) fields.push('secret');

    const id: string = existing?.['id'] ?? uuidv7();
    const enc = body['secret'] !== undefined ? encryptSecret(kek, body['secret'], { tenantId: ctx.tenantId, gateway, environment, merchantAccountId: id }) : undefined;
    let row: Row;
    try {
      if (!existing) {
        const cols: Row = { id, tenant_id: ctx.tenantId, gateway, environment, is_enabled: merged['is_enabled'], esewa_product_code: merged['esewa_product_code'], khalti_website_url: merged['khalti_website_url'],
          api_refunds_enabled: merged['api_refunds_enabled'], created_by: ctx.actor.id, updated_by: ctx.actor.id };
        if (enc) Object.assign(cols, { secret_ciphertext: enc.ciphertext, secret_nonce: enc.nonce, secret_auth_tag: enc.authTag, secret_kek_id: enc.kekId, secret_fingerprint: enc.fingerprint, secret_set_by: ctx.actor.id });
        const names = Object.keys(cols);
        const exprs = names.map((_, i) => `$${i + 1}`);
        if (enc) { names.push('secret_set_at'); exprs.push('now()'); }
        row = (await ctx.tx.query(`INSERT INTO payments.merchant_accounts (${names.join(', ')}) VALUES (${exprs.join(', ')}) RETURNING *`, Object.values(cols))).rows[0]!;
      } else {
        const sets: Row = { is_enabled: merged['is_enabled'], esewa_product_code: merged['esewa_product_code'], khalti_website_url: merged['khalti_website_url'], api_refunds_enabled: merged['api_refunds_enabled'], updated_by: ctx.actor.id };
        if (enc) Object.assign(sets, { secret_ciphertext: enc.ciphertext, secret_nonce: enc.nonce, secret_auth_tag: enc.authTag, secret_kek_id: enc.kekId, secret_fingerprint: enc.fingerprint, secret_set_by: ctx.actor.id });
        const names = Object.keys(sets);
        const assigns = names.map((n, i) => `${n} = $${i + 1}`);
        assigns.push('version = version + 1', 'updated_at = now()');
        if (enc) assigns.push('secret_set_at = now()');
        const n = names.length;
        const r = await ctx.tx.query(`UPDATE payments.merchant_accounts SET ${assigns.join(', ')} WHERE id = $${n + 1} AND tenant_id = $${n + 2} AND version = $${n + 3} RETURNING *`,
          [...Object.values(sets), id, ctx.tenantId, existing['version']]);
        if (!r.rows[0]) return conflict();
        row = r.rows[0];
      }
    } catch (e) {
      if ((e as { code?: string })?.code === '23505') return conflict();   // concurrent first save of the same slot
      throw e;
    }
    await accessLog(ctx, 'payment_merchant_account', fields, id);
    return accountDto(row);
  }

  /** One bounded probe; every failure to get a documented answer is `unreachable`. Redirects are never followed (the Khalti key travels in a header). */
  async function probe(gateway: string, row: Row, secret: string | undefined): Promise<TestOutcome> {
    const signal = AbortSignal.timeout(config.httpTimeoutInrequestMs);
    try {
      if (gateway === 'esewa') {
        const q = new URLSearchParams({ product_code: row['esewa_product_code'] ?? '', total_amount: '100', transaction_uuid: randomUUID() });
        const res = await doFetch(`${config.esewaStatusUrl}?${q}`, { method: 'GET', signal, redirect: 'manual' });
        const j = await res.json() as Record<string, unknown> | null;
        return isObject(j) && (j['status'] !== undefined || j['code'] !== undefined) ? 'reachable_key_unverifiable' : 'unreachable';
      }
      const pidx = randomBytes(16).toString('base64url');
      const res = await doFetch(`${config.khaltiBaseUrl}epayment/lookup/`, { method: 'POST', signal, redirect: 'manual',
        headers: { Authorization: `key ${secret}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ pidx }) });
      const j = await res.json().catch(() => null) as Record<string, unknown> | null;
      const detail = isObject(j) && typeof j['detail'] === 'string' ? j['detail'] : '';
      if (res.status === 401 || /invalid token/i.test(detail)) return 'auth_failed';
      if (res.status === 404 && /not found/i.test(detail)) return 'reachable_key_valid';
      return 'unreachable';
    } catch { return 'unreachable'; }
  }

  async function testMerchantAccount(ctx: MerchantCtx, input: { gateway: string; environment: string }): Promise<{ outcome: TestOutcome; checked_at: string }> {
    const { gateway, environment } = input;
    slot(gateway, environment);
    const row = await findAccount(ctx, gateway, environment, false);
    if (!row) throw new LimsError('common.not_found');
    if (gateway === 'fonepay') throw new LimsError('payments.gateway_not_available');
    let outcome: TestOutcome;
    if (gateway === 'khalti' && row['secret_ciphertext'] == null) outcome = 'auth_failed';   // no key to present
    else if (gateway === 'khalti') {
      const handle = openSecret(kek, { ciphertext: row['secret_ciphertext'], nonce: row['secret_nonce'], authTag: row['secret_auth_tag'], kekId: row['secret_kek_id'] },
        { tenantId: ctx.tenantId, gateway, environment, merchantAccountId: row['id'] });
      outcome = await handle.use((s) => probe(gateway, row, s));
    } else outcome = await probe(gateway, row, undefined);
    const r = await ctx.tx.query('UPDATE payments.merchant_accounts SET last_test_outcome = $1, last_test_at = now() WHERE id = $2 AND tenant_id = $3 RETURNING last_test_at', [outcome, row['id'], ctx.tenantId]);
    return { outcome, checked_at: iso(r.rows[0]!['last_test_at']) };
  }

  const readSettings = async (ctx: MerchantCtx, lock: boolean): Promise<Row | undefined> =>
    (await ctx.tx.query(`SELECT * FROM payments.settings WHERE tenant_id = $1${lock ? ' FOR UPDATE' : ''}`, [ctx.tenantId])).rows[0];

  async function getPaymentSettings(ctx: MerchantCtx): Promise<Row> {
    return settingsDto(await readSettings(ctx, false) ?? SETTINGS_DEFAULTS);   // P-22: no seed row; defaults until the first PUT
  }

  async function updatePaymentSettings(ctx: MerchantCtx, input: { expectedVersion?: number; body: unknown }): Promise<Row> {
    const body = validateSettingsBody(input.body);
    let cur = await readSettings(ctx, true);
    const before: Row = cur ?? SETTINGS_DEFAULTS;
    // int8 threshold arrives from node-pg as a string; compare numerically so unchanged values are not logged
    const fields = SETTINGS_KEYS.filter((k) => (k === 'refund_two_person_threshold_paisa' ? Number(before[k]) !== body[k] : body[k] !== before[k]));
    let row: Row | undefined;
    if (!cur) {                                                           // P-22: lazy first row; a first save may carry If-Match of the default version or none
      if (input.expectedVersion !== undefined && input.expectedVersion !== 1) conflict();
      const ins = await ctx.tx.query('INSERT INTO payments.settings (tenant_id, refund_two_person_threshold_paisa, purchase_order_label, reconciliation_enabled, created_by, updated_by) VALUES ($1, $2, $3, $4, $5, $5) ON CONFLICT (tenant_id) DO NOTHING RETURNING *',
        [ctx.tenantId, body['refund_two_person_threshold_paisa'], body['purchase_order_label'], body['reconciliation_enabled'], ctx.actor.id]);
      if (ins.rowCount) row = ins.rows[0];
      else if (!(cur = await readSettings(ctx, true))) return conflict();    // lost the race: the winner's row now needs If-Match
    }
    if (!row) {
      checkVersion(input.expectedVersion, cur!['version']);
      const r = await ctx.tx.query('UPDATE payments.settings SET refund_two_person_threshold_paisa = $1, purchase_order_label = $2, reconciliation_enabled = $3, version = version + 1, updated_at = now(), updated_by = $4 WHERE tenant_id = $5 AND version = $6 RETURNING *',
        [body['refund_two_person_threshold_paisa'], body['purchase_order_label'], body['reconciliation_enabled'], ctx.actor.id, ctx.tenantId, cur!['version']]);
      if (!r.rows[0]) return conflict();
      row = r.rows[0];
    }
    await accessLog(ctx, 'payment_settings', fields);
    return settingsDto(row!);
  }

  return { listMerchantAccounts, putMerchantAccount, testMerchantAccount, getPaymentSettings, updatePaymentSettings };
}
