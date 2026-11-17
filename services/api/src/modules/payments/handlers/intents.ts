// PG-T12 — staff intent operations P1 listPaymentIntents, P2 getPaymentIntent, P3 recheckPaymentIntent, P4 resolvePaymentIntent, P5 cancelPaymentIntent,
// P24 listPaymentCodes, P24b listPaymentCancelReasons (TRD §5.1, §5.4, §6.4, §6.5; REQ-SEC-040/044/080/081; 08 A13 P-3, A19 P-43 / D-112).
// Order in every handler: (1) assertRole WITHOUT a centre, before any payments.* read; (2) shape validation; (3) load the row (tenant-scoped, so another tenant's id is
// not_found); (4) assertRole WITH the row's centre — auth.forbidden there is answered as 404 (no existence oracle, ST-18); (5) state rules and the work.
// The core pipeline owns Idempotency-Key, the x-permission / aal gate and the response schema; the DTO allowlist is mappers/intent.mapper.ts.
import { LimsError } from '../../../core/errors.js';
// [CONV] relative import until @lims/shared-ts is a services/api dependency (same as the PG-T08 services).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import type { Handler } from '../../../core/module.js';
import { toIntentDetail, toIntentSummary } from '../mappers/intent.mapper.js';
import { findById, insertTransition, updateIntent } from '../repository/intents.repo.js';
import { CODE, invalid, notFound, uuid, type Ctx, type PaymentsDeps, type Row } from '../repository/shared.js';
import { createIntentService } from '../service/intent.service.js';
import { createOutcomeService } from '../service/outcome.service.js';

type Port = { assertRole(c: unknown, r: { permission: string; centreId?: string }): Promise<unknown> };
type SCtx = Omit<Ctx, 'ports' | 'actor'> & {
  actor: Ctx['actor'] & { membershipId?: string };
  ports: Ctx['ports'] & { IdentityPort: Port };
  audit: { access(e: Record<string, unknown>): Promise<void> };
};
interface Req { params?: unknown; query?: unknown; headers?: unknown; body?: unknown }

const READ = 'payments.reconciliation.read', RESOLVE = 'payments.intent.resolve', CREATE = 'payments.intent.create';
const STATES = ['created', 'initiated', 'pending', 'settled', 'failed', 'expired', 'held_for_review', 'refunded', 'partially_refunded'];
const GATEWAYS = ['esewa', 'khalti', 'fonepay'];
const SETS = ['hold_reasons', 'failure_reasons', 'cancel_reasons', 'resolution_reasons', 'refund_reasons', 'refund_reject_reasons', 'refund_fail_reasons', 'refund_hold_reasons',
  'finding_kinds', 'finding_resolutions'];
const RESOLUTIONS = ['settle', 'fail', 'record_exceeding_due'];
const RECHECKABLE = ['initiated', 'pending', 'held_for_review'];
const SUCCESS_RAW: Record<string, string> = { esewa: 'COMPLETE', khalti: 'Completed' };    // the exact success strings of TRD §7.2.4 / §7.3.4
const LIST_KEYS = ['status', 'gateway', 'hold_reason', 'order_id', 'centre_id', 'created_at_from', 'created_at_to', 'sort', 'cursor', 'limit'];
const BATCH = 200, MAX_VERSION = 2147483647;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;
const SUMMARY_COLS = 'id, order_id, centre_id, gateway, environment, status, amount_paisa, hold_reason, failure_reason, created_at, expires_at, settled_at, last_checked_at, version';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const only = (v: unknown, keys: readonly string[], path: string): Record<string, unknown> => {
  if (v === undefined) return {};
  if (!isObj(v)) return invalid(path);
  for (const k of Object.keys(v)) if (!keys.includes(k)) invalid(k);
  return v;
};
const intentId = (req: Req): string => uuid(isObj(req.params) ? req.params['intent_id'] : undefined, 'intent_id');

/** TRD §5.4 / 02-CV §10.1: the permission without a centre, before any payments read. auth.forbidden / auth.mfa_required pass through unchanged. */
const role = (ctx: SCtx, permission: string): Promise<unknown> => ctx.ports.IdentityPort.assertRole(ctx, { permission });
async function centreAllowed(ctx: SCtx, permission: string, centreId: string): Promise<boolean> {
  try { await ctx.ports.IdentityPort.assertRole(ctx, { permission, centreId }); return true; } catch (e) {
    if (e instanceof LimsError && e.code === 'auth.forbidden') return false;
    throw e;
  }
}
/** an intent of a centre the caller lacks is "not found", never 403 (ST-18) */
const roleAt = async (ctx: SCtx, permission: string, centreId: string): Promise<void> => { if (!(await centreAllowed(ctx, permission, centreId))) notFound(); };

/** [CONV] If-Match "<n>" exactly as lab / specimen: missing -> 428, malformed -> 400. */
function ifMatch(headers: unknown): number {
  const h = isObj(headers) ? headers['if-match'] : undefined;
  if (h === undefined) throw new LimsError('common.precondition_required');
  const m = typeof h === 'string' ? /^"([1-9][0-9]{0,9})"$/.exec(h) : null;
  if (!m || Number(m[1]) > MAX_VERSION) return invalid('if-match');
  return Number(m[1]);
}

interface CodeItem { code: string; display: string; requires_text: boolean; is_active: boolean }
/** Global set + the tenant's override shadowing by code (05-SCHEMA cs_reasons: relabel / deactivate only). Sort order = the global set's. */
async function codeSet(ctx: SCtx, set: string): Promise<CodeItem[]> {
  const g = (await ctx.tx.query('SELECT code, display, requires_text, is_active FROM payments.g_cs_reasons WHERE set_name = $1 ORDER BY sort_order ASC', [set])).rows;
  const o = new Map((await ctx.tx.query('SELECT code, display, is_active FROM payments.cs_reasons WHERE tenant_id = $1 AND set_name = $2', [ctx.tenantId, set])).rows.map((r) => [r['code'], r]));
  return g.map((r) => { const t = o.get(r['code']); return { code: r['code'], display: t?.['display'] ?? r['display'], requires_text: r['requires_text'] === true, is_active: (t ? t['is_active'] : r['is_active']) === true }; });
}
/** a code the caller sent must be an ACTIVE code of the set (the format check runs first, so only a well-formed code reaches SQL) */
async function activeCode(ctx: SCtx, set: string, v: unknown): Promise<CodeItem> {
  const code = typeof v === 'string' && CODE.test(v) ? v : invalid('reason_code');
  const hit = (await codeSet(ctx, set)).find((c) => c.code === code);
  return hit?.is_active ? hit : invalid('reason_code');
}

export function createIntentHandlers(deps: PaymentsDeps) {
  const newId = (): string => deps.newId?.() ?? uuidv7();
  const intents = createIntentService(deps);

  /** the outcome service over spied adapters: lets P3/P4 tell "the gateway did not answer" (-> gateway_not_available, nothing changes) from "answered, not success" */
  const checked = () => {
    const kinds: string[] = [];
    const wrap = <A extends unknown[], R extends { kind: string }>(f: (...a: A) => Promise<R>) => async (...a: A): Promise<R> => {
      try { const r = await f(...a); kinds.push(r.kind); return r; } catch (e) { kinds.push('threw'); throw e; }
    };
    const { esewa, khalti } = deps.adapters;
    const svc = createOutcomeService({ ...deps, adapters: { esewa: { ...esewa, check: wrap(esewa.check) }, khalti: { ...khalti, check: wrap(khalti.check) } } as PaymentsDeps['adapters'] });
    return { applyCheck: svc.applyCheck, unanswered: () => kinds.some((k) => k !== 'answer') };
  };

  async function detailOf(ctx: SCtx, id: string): Promise<Record<string, unknown>> {
    const row = await findById(ctx, id) ?? notFound();
    const q = async (sql: string): Promise<Row[]> => (await ctx.tx.query(sql, [ctx.tenantId, id])).rows;
    const transitions = await q('SELECT from_status, to_status, cause, reason_code, actor_type, created_at FROM payments.intent_transitions WHERE tenant_id = $1 AND intent_id = $2 ORDER BY created_at ASC, id ASC');
    const gatewayCalls = await q('SELECT operation, outcome, gateway_status_raw, http_status, created_at FROM payments.gateway_calls WHERE tenant_id = $1 AND intent_id = $2 ORDER BY created_at DESC, id DESC LIMIT 20');
    const callbacks = await q('SELECT kind, outcome_code, signature_valid, created_at FROM payments.callbacks WHERE tenant_id = $1 AND intent_id = $2 ORDER BY created_at DESC, id DESC LIMIT 20');
    const refunds = await q('SELECT * FROM payments.refunds WHERE tenant_id = $1 AND intent_id = $2 ORDER BY created_at ASC, id ASC');
    return toIntentDetail(row, { transitions, gatewayCalls, callbacks, refunds });
  }

  // ------------------------------------------------------------------------------------------------ P1
  const csv = (v: unknown, allowed: readonly string[] | RegExp, path: string): string[] => {
    if (typeof v !== 'string') return invalid(path);
    const items = [...new Set(v.split(','))];
    if (items.length > 20 || !items.every((x) => (Array.isArray(allowed) ? allowed.includes(x) : (allowed as RegExp).test(x)))) return invalid(path);
    return items;
  };
  const when = (v: unknown, path: string): Date => (typeof v === 'string' && ISO.test(v) && !Number.isNaN(Date.parse(v)) ? new Date(v) : invalid(path));

  async function listPaymentIntents(req: Req, ctx: SCtx) {
    await role(ctx, READ);
    const q = only(req.query, LIST_KEYS, 'query');
    const sort = q['sort'] === undefined ? '-created_at' : q['sort'] === '-created_at' || q['sort'] === 'created_at' ? q['sort'] : invalid('sort');
    const desc = sort === '-created_at';
    const limit = q['limit'] === undefined ? 50 : typeof q['limit'] === 'number' ? q['limit'] : typeof q['limit'] === 'string' && /^[0-9]{1,4}$/.test(q['limit']) ? Number(q['limit']) : NaN;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) invalid('limit');

    const conds = ['tenant_id = $1'], vals: unknown[] = [ctx.tenantId];
    const add = (cond: string, v: unknown): void => { vals.push(v); conds.push(cond.replace('?', `$${vals.length}`)); };
    if (q['status'] !== undefined) add('status = ANY(?)', csv(q['status'], STATES, 'status'));
    if (q['gateway'] !== undefined) add('gateway = ANY(?)', csv(q['gateway'], GATEWAYS, 'gateway'));
    if (q['hold_reason'] !== undefined) add('hold_reason = ANY(?)', csv(q['hold_reason'], CODE, 'hold_reason'));
    if (q['order_id'] !== undefined) add('order_id = ?', uuid(q['order_id'], 'order_id'));
    const centre = q['centre_id'] === undefined ? undefined : uuid(q['centre_id'], 'centre_id');
    if (q['created_at_from'] !== undefined) add('created_at >= ?', when(q['created_at_from'], 'created_at_from'));
    if (q['created_at_to'] !== undefined) add('created_at <= ?', when(q['created_at_to'], 'created_at_to'));
    // [CONV] keyset on id: UUIDv7 ids are created-time ordered, the PK serves it, and it never ties (a timestamp key would at the ms / µs boundary).
    // cursor = base64url {i: last id, d: direction}; it carries no authority — tenant, filters and centre scope are re-applied on every page.
    let after: string | undefined;
    if (q['cursor'] !== undefined) {
      try {
        const c = JSON.parse(Buffer.from(String(q['cursor']), 'base64url').toString('utf8')) as { i?: unknown; d?: unknown };
        if (typeof q['cursor'] === 'string' && q['cursor'].length <= 200 && isObj(c) && c['d'] === (desc ? '-' : '+')) after = uuid(c['i'], 'cursor');
      } catch { /* falls through to the 400 below */ }
      if (after === undefined) invalid('cursor');
    }
    const page = (data: unknown[], next?: string) => ({ status: 200, body: { data, page: { limit, ...(next ? { next_cursor: next } : {}) } } });

    if (centre !== undefined) {
      if (!(await centreAllowed(ctx, READ, centre))) return page([]);      // a centre the caller lacks: nothing visible (200 empty, no oracle)
      add('centre_id = ?', centre);
    }
    // Centre scope: the IdentityPort answers per centre, so rows are probed by their (cached) centre and the scan continues until the page is full.
    // ponytail: scans whole batches for a narrowly scoped caller; swap for a SQL centre predicate once IdentityPort exposes the caller's centre set.
    const seen = new Map<string, boolean>(), out: Row[] = [];
    while (out.length <= limit) {
      const w = [...conds], v = [...vals];
      if (after) { v.push(after); w.push(`id ${desc ? '<' : '>'} $${v.length}`); }
      const rows = (await ctx.tx.query(`SELECT ${SUMMARY_COLS} FROM payments.intents WHERE ${w.join(' AND ')} ORDER BY id ${desc ? 'DESC' : 'ASC'} LIMIT ${BATCH}`, v)).rows;
      for (const r of rows) {
        let ok = seen.get(r['centre_id']);
        if (ok === undefined) seen.set(r['centre_id'], ok = await centreAllowed(ctx, READ, r['centre_id']));
        if (ok) out.push(r);
        if (out.length > limit) break;
      }
      if (rows.length < BATCH) break;
      after = rows[rows.length - 1]!['id'];
    }
    const items = out.slice(0, limit);
    const next = out.length > limit ? Buffer.from(JSON.stringify({ i: items[items.length - 1]!['id'], d: desc ? '-' : '+' })).toString('base64url') : undefined;
    return page(items.map(toIntentSummary), next);
  }

  // ------------------------------------------------------------------------------------------------ P2
  async function getPaymentIntent(req: Req, ctx: SCtx) {
    await role(ctx, READ);
    const id = intentId(req);
    await roleAt(ctx, READ, (await findById(ctx, id) ?? notFound())['centre_id']);
    return { status: 200, body: await detailOf(ctx, id) };
  }

  // ------------------------------------------------------------------------------------------------ P3
  async function recheckPaymentIntent(req: Req, ctx: SCtx) {
    await role(ctx, RESOLVE);
    const id = intentId(req);
    const row = await findById(ctx, id) ?? notFound();
    await roleAt(ctx, RESOLVE, row['centre_id']);
    if (!RECHECKABLE.includes(row['status'])) throw new LimsError('payments.intent_invalid_transition');
    // 429 + Retry-After while the last gateway check is younger than VERIFY_MIN_INTERVAL_SECONDS (AC-PG-07.7); the gateway is not called, nothing is written
    const min = deps.config.verifyMinIntervalSeconds;
    if (row['last_checked_at']) {
      const age = (Date.parse(ctx.now()) - new Date(row['last_checked_at']).getTime()) / 1000;
      if (age < min) throw Object.assign(new LimsError('common.rate_limited', 'recheck'), { retryAfterSeconds: Math.min(min, Math.max(1, Math.ceil(min - age))) });
    }
    const c = checked();
    await c.applyCheck(ctx as unknown as Ctx, id, 'reconciliation', { cause: 'recheck' });
    if (c.unanswered()) throw new LimsError('payments.gateway_not_available');   // the unit of work rolls back: no state change on a guess
    return { status: 200, body: await detailOf(ctx, id) };
  }

  // ------------------------------------------------------------------------------------------------ P4
  async function resolvePaymentIntent(req: Req, ctx: SCtx) {
    await role(ctx, RESOLVE);
    const id = intentId(req);
    const expected = ifMatch(req.headers);
    const b = isObj(req.body) ? only(req.body, ['resolution', 'reason_code', 'note'], 'body') : invalid('body');
    const resolution = typeof b['resolution'] === 'string' && RESOLUTIONS.includes(b['resolution']) ? b['resolution'] : invalid('resolution');
    const note = b['note'] === undefined ? undefined : typeof b['note'] === 'string' && b['note'].length <= 500 && !b['note'].includes('\u0000') ? b['note'] : invalid('note');
    if (typeof b['reason_code'] !== 'string') invalid('reason_code');

    const row = await findById(ctx, id, true) ?? notFound();            // locked for the whole unit: concurrent resolvers queue, then fail the version check
    await roleAt(ctx, RESOLVE, row['centre_id']);
    const code = await activeCode(ctx, 'resolution_reasons', b['reason_code']);
    if (code.requires_text && (note ?? '').trim() === '') invalid('note');
    if (Number(row['version']) !== expected) throw new LimsError('common.version_conflict');
    if (row['status'] !== 'held_for_review') throw new LimsError('payments.intent_invalid_transition');
    if (resolution === 'record_exceeding_due' && row['hold_reason'] !== 'exceeds_due') throw new LimsError('payments.intent_invalid_transition');

    const now = ctx.now();
    const resolved = { resolution_reason_code: code.code, ...(note !== undefined ? { resolution_note: note } : {}), resolved_by: ctx.actor.membershipId ?? ctx.actor.id, resolved_at: now };
    if (resolution === 'fail') {
      // TRD §6.5: never fail an intent whose latest gateway check is a success — that is a payment, settle it instead.
      if (row['last_gateway_status_raw'] === SUCCESS_RAW[row['gateway']]) throw new LimsError('payments.intent_not_verifiable');
      const upd = await updateIntent(ctx as unknown as Ctx, row, { status: 'failed', failure_reason: 'resolved_failed', closed_at: now, ...resolved }, { from: ['held_for_review'] });
      if (!upd) throw new LimsError('payments.intent_invalid_transition');
      await insertTransition(ctx as unknown as Ctx, newId(), id, { from: 'held_for_review', to: 'failed', cause: 'resolve', reason: code.code });
    } else {
      // forced fresh gateway call (never rate-limited); only a gateway success with the exact amount settles, anything else refuses and rolls the unit back
      const c = checked();
      const res = await c.applyCheck(ctx as unknown as Ctx, id, 'reconciliation',
        { cause: 'resolve', reason: code.code, settleSets: resolved, ...(resolution === 'record_exceeding_due' ? { allowExceedsDue: true } : {}) });
      // TRD §6.5: no gateway answer is also "not settle" — P4's error list has no gateway_not_available
      if (c.unanswered() || res.status !== 'settled') throw new LimsError('payments.intent_not_verifiable');
    }
    // 08 A13 P-3: one access_log row, the note is never in it; written on success only, so a refused resolve leaves none
    await ctx.audit.access({ action: 'payment_intent.resolve', entityType: 'payment_intent', entityId: id, centreId: row['centre_id'], outcome: 'allowed', detail: { resolution, reason_code: code.code } });
    return { status: 200, body: await detailOf(ctx, id) };
  }

  // ------------------------------------------------------------------------------------------------ P5
  async function cancelPaymentIntent(req: Req, ctx: SCtx) {
    await role(ctx, CREATE);
    const id = intentId(req);
    const b = isObj(req.body) ? only(req.body, ['reason_code'], 'body') : invalid('body');
    const reason = typeof b['reason_code'] === 'string' && CODE.test(b['reason_code']) ? b['reason_code'] : invalid('reason_code');
    await roleAt(ctx, CREATE, (await findById(ctx, id) ?? notFound())['centre_id']);
    await activeCode(ctx, 'cancel_reasons', reason);
    const r = await intents.cancelIntent(ctx as unknown as Ctx, { intentId: id, reasonCode: reason });    // lookup-first (TRD §6.4): a gateway "paid" settles instead
    return { status: 200, body: { intent_id: r.intentId, status: r.status } };
  }

  // ------------------------------------------------------------------------------------------------ P24 / P24b
  async function listPaymentCodes(req: Req, ctx: SCtx) {
    await role(ctx, READ);
    const set = isObj(req.params) && typeof req.params['set_name'] === 'string' && SETS.includes(req.params['set_name']) ? req.params['set_name'] : invalid('set_name');
    return { status: 200, body: { data: await codeSet(ctx, set) } };
  }
  async function listPaymentCancelReasons(_req: Req, ctx: SCtx) {
    await role(ctx, CREATE);
    return { status: 200, body: { data: await codeSet(ctx, 'cancel_reasons') } };
  }

  const as = (f: (req: Req, ctx: SCtx) => Promise<{ status: number; body: unknown }>): Handler => (req, ctx) => f(req, ctx as unknown as SCtx);
  return {
    listPaymentIntents: as(listPaymentIntents), getPaymentIntent: as(getPaymentIntent), recheckPaymentIntent: as(recheckPaymentIntent), resolvePaymentIntent: as(resolvePaymentIntent),
    cancelPaymentIntent: as(cancelPaymentIntent), listPaymentCodes: as(listPaymentCodes), listPaymentCancelReasons: as(listPaymentCancelReasons),
  };
}
