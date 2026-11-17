// PG-T09 — public routes P30-P33 (TRD §5.2, §6.3, §6.3a, §7.2.2-§7.2.3) and the `paymentCallback` auth resolver (CR-C15-004, 08 CR-REGISTER §4.11).
// Callback input never changes state: only applyCheck (a gateway answer) does. Every invalid / foreign / expired token gets the same 303 to the unknown page.
import { createHash } from 'node:crypto';
import type { HandlerResult } from '../../../core/module.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js'; // [CONV] relative import, same as intent.service.ts
import { renderLaunchPage } from '../pages/launchPage.js';
import { PUBLIC_HEADERS } from '../pages/resultPage.js';
import { accountById, findById, usable } from '../repository/intents.repo.js';
import type { createEsewaAdapter } from '../gateways/esewa.adapter.js';
import type { Ctx, PaymentsDeps, Row } from '../repository/shared.js';
import { createOutcomeService } from './outcome.service.js';

export type CallbackDeps = Omit<PaymentsDeps, 'adapters'> & {
  adapters: { esewa: PaymentsDeps['adapters']['esewa'] & Pick<ReturnType<typeof createEsewaAdapter>, 'verifyCallbackSignature'>; khalti: PaymentsDeps['adapters']['khalti'] };
};
/** The request context as the pipeline leaves it: tenantId/actor are the resolver's claims and are ABSENT when nothing resolved. */
export type CbCtx = Omit<Ctx, 'tenantId' | 'actor'> & Partial<Pick<Ctx, 'tenantId' | 'actor'>> & {
  db: { tx<T>(f: (c: any) => Promise<T>): Promise<T> };
  rateLimit: { consume(tier: string, key: string): Promise<unknown> };
  log: { warn(o: object, m?: string): void };
};
type Kind = 'esewa_success' | 'esewa_failure' | 'khalti_return' | 'launch';

const TOKEN_RE = /^[A-Za-z0-9_-]{1,128}$/;              // base64url of 32 bytes is 43 chars; anything else cannot be ours
const DATA_RE = /^[A-Za-z0-9+/=_-]{1,4096}$/;           // TRD §5.2 P31 `data`
const sha256 = (s: string): Buffer => createHash('sha256').update(s).digest();
const CLOSED = ['settled', 'partially_refunded', 'refunded', 'failed', 'expired'];
const SETTLED = ['settled', 'partially_refunded', 'refunded'];
const KHALTI_KEYS: Readonly<Record<string, number>> = { pidx: 64, status: 32, transaction_id: 64, tidx: 64, txnId: 64, amount: 20, total_amount: 20, purchase_order_id: 64, purchase_order_name: 100 }; // no `mobile` (REQ-SEC-056)
const ESEWA_KEYS = ['transaction_code', 'status', 'total_amount', 'transaction_uuid', 'product_code'] as const;                                       // never `signature` / the raw payload

/** CR-C15-004: the `paymentCallback` AuthResolver. One DEFINER call with the token's SHA-256; `undefined` for every token it does not return. */
export function createCallbackResolver(o: { systemActorId: string }) {
  return {
    async resolve(token: unknown, tx: { query(text: string, values?: unknown[]): Promise<{ rows: Row[] }> }) {
      if (typeof token !== 'string' || !TOKEN_RE.test(token)) return undefined;
      const r = (await tx.query('SELECT tenant_id, intent_id FROM app.payments_resolve_callback_token($1)', [sha256(token)])).rows[0];
      return r ? { actor: { type: 'system' as const, id: o.systemActorId }, tenantId: r['tenant_id'] as string, extraClaims: { payment_intent_id: r['intent_id'] as string } } : undefined;
    },
  };
}

export function createCallbackService(deps: CallbackDeps) {
  const outcome = createOutcomeService(deps);
  const newId = (): string => deps.newId?.() ?? uuidv7();
  const redirectTo = (location: string): HandlerResult => ({ status: 303, headers: { ...PUBLIC_HEADERS, Location: location } });
  const unknown = (): HandlerResult => redirectTo(`${deps.config.publicBaseUrl.replace(/\/+$/, '')}/v1/payments/result?outcome=unknown`);

  /** §6.3 step 6: by the stored status; the existing query of the target is kept. */
  function redirect(row: Row): HandlerResult {
    const out = SETTLED.includes(row['status']) ? 'settled' : row['status'] === 'failed' || row['status'] === 'expired' ? 'failed' : 'pending';
    const u = new URL(out === 'failed' ? row['cancel_url'] : row['return_url']);
    u.searchParams.set('intent_id', row['id']);
    u.searchParams.set('outcome', out);
    return redirectTo(u.toString());
  }

  /** The intent of this path token under the claims' tenant (RLS emulation): a token of another tenant finds nothing. */
  async function load(ctx: CbCtx, token: unknown, gateway?: 'esewa' | 'khalti'): Promise<Row | undefined> {
    if (!ctx.tenantId || !ctx.actor || typeof token !== 'string' || !TOKEN_RE.test(token)) return undefined;
    const r = (await ctx.tx.query('SELECT * FROM payments.intents WHERE tenant_id = $1 AND callback_token_sha256 = $2', [ctx.tenantId, sha256(token)])).rows[0];
    return r && (!gateway || r['gateway'] === gateway) ? r : undefined;
  }

  async function throttled(ctx: CbCtx, row: Row): Promise<boolean> {
    try { await ctx.rateLimit.consume('general', `payments:cb:${row['id']}`); return false; } catch (e) {
      if ((e as { code?: string })?.code === 'common.rate_limited') return true;
      throw e;
    }
  }

  const record = (ctx: CbCtx, row: Row, kind: Kind, r: { code: string; query?: Record<string, string> | null; signatureValid?: boolean | null }) => ctx.tx.query(
    'INSERT INTO payments.callbacks (id, tenant_id, intent_id, gateway, kind, query_redacted, signature_valid, outcome_code, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
    [newId(), ctx.tenantId, row['id'], row['gateway'], kind, r.query && Object.keys(r.query).length ? JSON.stringify(r.query) : null, r.signatureValid ?? null, r.code, ctx.actor!.id]);

  const pick = (src: Record<string, unknown>, limits: Readonly<Record<string, number>>): Record<string, string> => Object.fromEntries(
    Object.entries(limits).flatMap(([k, max]) => (typeof src[k] === 'string' ? [[k, (src[k] as string).slice(0, max)]] : [])));

  /** Base64 JSON of the eSewa success redirect, for redaction and mismatch detection only (the adapter owns the signature check). */
  function decode(payload: string): Record<string, string> | undefined {
    if (!DATA_RE.test(payload)) return undefined;
    try {
      const doc = JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as unknown;
      if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return undefined;
      return Object.values(doc).every((v) => typeof v === 'string') ? doc as Record<string, string> : undefined;
    } catch { return undefined; }
  }

  async function esewaVerdict(ctx: CbCtx, row: Row, payload: string, fields: Record<string, string> | undefined): Promise<{ valid: boolean; code: string }> {
    let productCode: string | undefined, valid = false;
    try {
      const { acct, handle } = usable(deps.kek, ctx as Ctx, await accountById(ctx as Ctx, row['merchant_account_id']));
      productCode = acct['esewa_product_code'];
      valid = DATA_RE.test(payload) && (await deps.adapters.esewa.verifyCallbackSignature(payload, handle,
        { id: row['id'], gatewayTxnRef: row['gateway_txn_ref'], amountPaisa: Number(row['amount_paisa']), productCode: productCode!, callbackToken: '' })).valid;
    } catch { valid = false; } // account disabled / secret unreadable: unverifiable = invalid; the status check (and its own failure path) still runs
    if (valid) return { valid, code: 'ok' };
    const mismatch = fields !== undefined && (fields['transaction_uuid'] !== row['gateway_txn_ref'] || (productCode !== undefined && fields['product_code'] !== productCode));
    return { valid, code: mismatch ? 'payments.callback_mismatch' : 'payments.signature_invalid' };
  }

  /** P31 / P32 / P33 share steps 1-6 of TRD §6.3. */
  async function callback(ctx: CbCtx, token: unknown, kind: Exclude<Kind, 'launch'>, query: Record<string, unknown>): Promise<HandlerResult> {
    const row = await load(ctx, token, kind === 'khalti_return' ? 'khalti' : 'esewa');
    if (!row) return unknown();
    if (await throttled(ctx, row)) { await record(ctx, row, kind, { code: 'rate_limited' }); return redirect(row); }

    const closed = CLOSED.includes(row['status']);
    let code = closed ? 'payments.callback_stale' : 'ok', signatureValid: boolean | null = null, redacted: Record<string, string> | null = null;
    if (kind === 'esewa_success') {
      const payload = typeof query['data'] === 'string' ? query['data'] : '';
      const fields = decode(payload);
      redacted = fields ? pick(fields, Object.fromEntries(ESEWA_KEYS.map((k) => [k, 64]))) : null;
      if (!closed) { const v = await esewaVerdict(ctx, row, payload, fields); signatureValid = v.valid; code = v.code; }
    } else if (kind === 'khalti_return') {
      redacted = pick(query, KHALTI_KEYS);
      const differs = (k: string, stored: string): boolean => redacted![k] !== undefined && redacted![k] !== stored;
      if (!closed && (differs('pidx', row['gateway_txn_ref']) || differs('purchase_order_id', row['id']))) code = 'payments.callback_mismatch'; // the lookup uses the stored ones
    }
    await record(ctx, row, kind, { code, query: redacted, signatureValid });

    // held_for_review is finance's to resolve (a callback must not move it); created cannot have a callback.
    if (row['status'] === 'initiated' || row['status'] === 'pending') {
      try { await ctx.db.tx(() => outcome.applyCheck(ctx as Ctx, row['id'], 'reconciliation', { cause: 'callback' })); } catch (e) {
        ctx.log.warn({ intentId: row['id'], code: (e as { code?: string })?.code }, 'payments_callback_check_failed'); // ids/codes only
        await deps.jobs.enqueue(ctx, 'payments.poll_intent', { tenant_id: ctx.tenantId, intent_id: row['id'], n: 0 },
          { key: `poll:${row['id']}:cb:${Math.floor(Date.parse(ctx.now()) / 60_000)}` }); // run now; one per minute at most
      }
    }
    return redirect(await findById(ctx as Ctx, row['id']) ?? row);
  }

  /** P30, TRD §6.3a: a page for a live eSewa intent, else a redirect by state; always one `launch` row, never a gateway call or state change. */
  async function launch(ctx: CbCtx, token: unknown): Promise<HandlerResult> {
    const row = await load(ctx, token);
    if (!row) return unknown();
    if (await throttled(ctx, row)) { await record(ctx, row, 'launch', { code: 'rate_limited' }); return redirect(row); }
    const live = row['status'] === 'initiated' || row['status'] === 'pending';
    await record(ctx, row, 'launch', { code: live ? 'ok' : 'payments.callback_stale' });
    if (!live || row['gateway'] !== 'esewa') return redirect(row);
    const { acct, handle } = usable(deps.kek, ctx as Ctx, await accountById(ctx as Ctx, row['merchant_account_id']));
    return renderLaunchPage(await deps.adapters.esewa.buildAction({ id: row['id'], gatewayTxnRef: row['gateway_txn_ref'], amountPaisa: Number(row['amount_paisa']),
      productCode: acct['esewa_product_code'], callbackToken: token as string }, handle));
  }

  return {
    launch,
    esewaSuccess: (ctx: CbCtx, token: unknown, query: Record<string, unknown>) => callback(ctx, token, 'esewa_success', query),
    esewaFailure: (ctx: CbCtx, token: unknown) => callback(ctx, token, 'esewa_failure', {}),
    khaltiReturn: (ctx: CbCtx, token: unknown, query: Record<string, unknown>) => callback(ctx, token, 'khalti_return', query),
  };
}
export type CallbackService = ReturnType<typeof createCallbackService>;
