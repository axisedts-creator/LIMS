// PG-T13 — reconciliation: operations P12-P16 (02-TRD §5 rows P12-P16, §5.1 access log) and the run logic of payments.reconcile_tenant / payments.reconcile_batch (TRD §6.7, §8.3).
// The worker tasks are thin: they only validate the job scope and call startCronRun / runBatch here, so the manual run (P14) and the nightly run share one code path.
// Findings are review records: reconciliation never edits the ledger on its own except the idempotent recordGatewayPayment re-call (AC-PG-08.5), and every candidate runs
// in its own savepoint (ctx.db.tx, 08 A19 P-44) so one failing candidate is rolled back and counted without losing the batch.
import type { AccessLogEntry } from '../../../core/audit/access.js';
import { LimsError, isLimsError } from '../../../core/errors.js';
// [CONV] relative import until @lims/shared-ts is a services/api dependency (same as outcome.service.ts).
import { isUuidv7, uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { findById } from '../repository/intents.repo.js';
import { guardActor, invalid, iso, money, strict, uuid, type Ctx, type PaymentsDeps, type Row } from '../repository/shared.js';
import { createOutcomeService, type CheckDecision } from './outcome.service.js';

export const RECONCILE_BATCH_TASK = 'payments.reconcile_batch';
export const FINDINGS_METRIC = 'lims_payments_reconciliation_findings_total';
export const LAST_SUCCESS_METRIC = 'lims_payments_reconciliation_last_success_timestamp_seconds';

export interface ReconCtx extends Ctx {
  readonly actor: { readonly type: string; readonly id: string; readonly membershipId?: string };
  readonly audit?: { access(entry: AccessLogEntry): Promise<void> };
  readonly db?: { tx<T>(fn: (c: any) => Promise<T>): Promise<T> };
  readonly metrics?: { set?(name: string, value: number, labels?: Record<string, string>): void; inc?(name: string, labels?: Record<string, string>): void };
}

const BATCH = 50;                                   // TRD §6.7 [CONV]
const MAX_ATTEMPTS = 3;                             // in-run gateway attempts per item before gateway_unreachable
const DAY = 86_400_000;
const STALL_MS = 2 * 3_600_000;                     // TRD §6.7 stalled-run rule [CONV]
const KATHMANDU_OFFSET_MS = (5 * 60 + 45) * 60_000; // Asia/Kathmandu is UTC+05:45 without DST (08 A13 P-15)
const DEFAULT_LIMIT = 50, MAX_LIMIT = 200;

const RUN_STATUSES = ['running', 'completed', 'failed'];
const FINDING_STATUSES = ['open', 'resolved'];
const SEVERITIES = ['info', 'warning', 'critical'];
const KINDS = ['missed_settlement', 'still_held', 'late_payment_found', 'status_divergence', 'gateway_refund_unrecorded', 'amount_mismatch', 'ledger_entry_missing', 'refund_unconfirmed', 'gateway_unreachable'];
const RESOLUTIONS = ['confirmed_ok', 'refunded_outside_system_recorded', 'escalated_to_provider', 'ledger_corrected_in_billing', 'false_positive', 'other'];
const SORT_FINDINGS = ['-created_at', 'severity'];
const SETTLED_FAMILY = ['settled', 'partially_refunded', 'refunded'];
const OPEN_AND_HELD = ['created', 'initiated', 'pending', 'held_for_review'];
const REFUND_CANDIDATES = ['requested', 'held_for_review'];
const GATEWAY_REFUND_STATUSES = ['FULL_REFUND', 'PARTIAL_REFUND', 'Refunded', 'Partially Refunded'];
const PARTIAL_REFUND_STATUSES = ['PARTIAL_REFUND', 'Partially Refunded'];
const COMPLETE_STATUSES = ['COMPLETE', 'Completed'];
const SEVERITY_RANK: Record<string, number> = { critical: 0, warning: 1, info: 2 };

interface FindingSpec { kind: string; severity: 'info' | 'warning' | 'critical'; auto: 'none' | 'settled' | 'held' | 'ledger_repaired'; intentId?: string; refundId?: string;
  ourStatus?: string | null; ourAmount?: number; gatewayStatusRaw?: string | null; gatewayAmount?: number | null }
interface Tally { checked: number; ok: number; findings: number; critical: number }

/** Tenant business date (Asia/Kathmandu) of an instant, optionally minus whole days. */
export const businessDate = (nowIso: string, minusDays = 0): string => new Date(Date.parse(nowIso) + KATHMANDU_OFFSET_MS - minusDays * DAY).toISOString().slice(0, 10);
export const dateText =(v: unknown): string => (v instanceof Date ? v.toISOString() : String(v)).slice(0, 10);
export const isDate =(v: unknown): v is string => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const t = Date.parse(`${v}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().startsWith(v);
};
export const moneyDto =(paisa: unknown) => ({ amount_paisa: Number(paisa), currency: 'NPR' as const });
const pick = <T extends string>(v: unknown, allowed: readonly T[], path: string): T => (typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : invalid(path));

export function pageLimit(v: unknown): number {
  if (v === undefined) return DEFAULT_LIMIT;
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,4}$/.test(v) ? Number(v) : Number.NaN;
  return Number.isInteger(n) && n >= 1 && n <= MAX_LIMIT ? n : invalid('limit');
}

// Keyset cursor: base64url JSON { k: list kind, s: sort, v: sort key of the last row }. A cursor of another list (or sort) is "foreign" -> common.invalid_cursor.
export type Key =(string | number)[];
const encodeCursor = (k: string, s: string, v: Key): string => Buffer.from(JSON.stringify({ k, s, v }), 'utf8').toString('base64url');
export function decodeCursor(c: unknown, k: string, s: string, shape: ('string' | 'number')[]): Key {
  const bad = (): never => { throw new LimsError('common.invalid_cursor'); };
  if (typeof c !== 'string' || c.length < 1 || c.length > 512) return bad();
  let o: any;
  try { o = JSON.parse(Buffer.from(c, 'base64url').toString('utf8')); } catch { return bad(); }
  if (!o || o.k !== k || o.s !== s || !Array.isArray(o.v) || o.v.length !== shape.length || !shape.every((t, i) => typeof o.v[i] === t)) return bad();
  return o.v as Key;
}
/** rows sorted by `key` with per-element direction; returns the page after `after` and the cursor for the next one */
export function page<T>(rows: T[], key: (r: T) => Key, dirs: (1 | -1)[], after: Key | undefined, limit: number, kind: string, sort: string): { items: T[]; next?: string } {
  const cmp = (a: Key, b: Key): number => { for (let i = 0; i < a.length; i++) if (a[i]! !== b[i]!) return (a[i]! < b[i]! ? -1 : 1) * dirs[i]!; return 0; };
  const sorted = [...rows].sort((x, y) => cmp(key(x), key(y)));
  const rest = after ? sorted.filter((r) => cmp(key(r), after) > 0) : sorted;
  const items = rest.slice(0, limit);
  return { items, ...(rest.length > limit ? { next: encodeCursor(kind, sort, key(items[items.length - 1]!)) } : {}) };
}

export const runDto = (r: Row) => ({
  id: r['id'], business_date: dateText(r['business_date']), trigger: r['trigger'], status: r['status'], started_at: iso(r['started_at']),
  ...(r['finished_at'] != null ? { finished_at: iso(r['finished_at']) } : {}),
  counts: { checked: Number(r['checked_count']), ok: Number(r['ok_count']), findings: Number(r['findings_count']), critical: Number(r['critical_count']) },
  version: Number(r['version']),
});
// [CONV] MemberRef.display_name needs an identity lookup the payments module does not have; the membership id is the reference, the name stays empty.
export const findingDto = (r: Row) => ({
  id: r['id'], run_id: r['run_id'], kind: r['kind'], severity: r['severity'],
  ...(r['intent_id'] != null ? { intent_id: r['intent_id'] } : {}), ...(r['refund_id'] != null ? { refund_id: r['refund_id'] } : {}),
  ...(r['our_status'] != null ? { our_status: r['our_status'] } : {}), ...(r['gateway_status_raw'] != null ? { gateway_status_raw: r['gateway_status_raw'] } : {}),
  ...(r['our_amount_paisa'] != null ? { our_amount: moneyDto(r['our_amount_paisa']) } : {}), ...(r['gateway_amount_paisa'] != null ? { gateway_amount: moneyDto(r['gateway_amount_paisa']) } : {}),
  auto_action: r['auto_action'], status: r['status'],
  ...(r['resolution_code'] != null ? { resolution_code: r['resolution_code'] } : {}), ...(r['note'] != null ? { note: r['note'] } : {}),
  ...(r['resolved_by'] != null ? { resolved_by: { membership_id: r['resolved_by'], display_name: '' } } : {}), ...(r['resolved_at'] != null ? { resolved_at: iso(r['resolved_at']) } : {}),
  created_at: iso(r['created_at']), version: Number(r['version']),
});

export function createReconciliationService(deps: PaymentsDeps) {
  const newId = (): string => deps.newId?.() ?? uuidv7();
  const outcome = createOutcomeService(deps);

  // ------------------------------------------------------------------ run rows
  const settingsEnabled = async (ctx: ReconCtx): Promise<boolean> =>
    (await ctx.tx.query('SELECT * FROM payments.settings WHERE tenant_id = $1', [ctx.tenantId])).rows[0]?.['reconciliation_enabled'] !== false;   // no row = enabled (05-SCHEMA default)

  /** The partial unique index (one running run per tenant) decides: ON CONFLICT DO NOTHING -> undefined = a run is already running. */
  async function insertRun(ctx: ReconCtx, trigger: 'cron' | 'manual'): Promise<Row | undefined> {
    const now = ctx.now();
    const res = await ctx.tx.query(
      `INSERT INTO payments.reconciliation_runs (id, tenant_id, business_date, trigger, status, started_at, checked_count, ok_count, findings_count, critical_count, created_by, updated_by)
       VALUES ($1, $2, $3, $4, 'running', $5, 0, 0, 0, 0, $6, $6) ON CONFLICT DO NOTHING RETURNING *`,
      [newId(), ctx.tenantId, businessDate(now, trigger === 'cron' ? 1 : 0), trigger, now, ctx.actor.id]);
    const run = res.rows[0];
    if (!run) return undefined;
    await deps.jobs.enqueue(ctx, RECONCILE_BATCH_TASK, { tenant_id: ctx.tenantId, run_id: run['id'], phase: 'intents' }, { key: `recon:${run['id']}:intents:start` });
    return run;
  }

  /** A running run whose updated_at is strictly older than 2 h is dead: mark it failed (stalled) so the new run can start. */
  async function failStalled(ctx: ReconCtx): Promise<void> {
    const now = Date.parse(ctx.now());
    const running = (await ctx.tx.query("SELECT * FROM payments.reconciliation_runs WHERE tenant_id = $1 AND status = 'running'", [ctx.tenantId])).rows;
    for (const r of running) {
      if (Date.parse(iso(r['updated_at'] ?? r['started_at'])) >= now - STALL_MS) continue;
      await ctx.tx.query(
        "UPDATE payments.reconciliation_runs SET status = 'failed', error_code = 'stalled', finished_at = $1, updated_at = $1, updated_by = $2, version = version + 1 WHERE tenant_id = $3 AND id = $4 AND status = 'running' AND version = $5",
        [ctx.now(), ctx.actor.id, ctx.tenantId, r['id'], r['version']]);
    }
  }

  /** payments.reconcile_tenant (TRD §8.3 row 4): stalled-run check, run row, first batch. A still-healthy running run (manual or cron) means: start nothing. */
  async function startCronRun(ctx: ReconCtx): Promise<void> {
    if (!(await settingsEnabled(ctx))) return;
    await failStalled(ctx);
    await insertRun(ctx, 'cron');
  }

  // ------------------------------------------------------------------ P14
  async function startReconciliationRun(ctx: ReconCtx, input?: unknown) {
    guardActor(ctx);
    strict(input === undefined ? {} : input, []);                       // the caller cannot choose trigger, date, tenant or counts
    const run = await insertRun(ctx, 'manual');
    if (!run) throw new LimsError('payments.reconciliation_in_progress');
    return runDto(run);
  }

  // ------------------------------------------------------------------ P12 / P13
  async function listReconciliationRuns(ctx: ReconCtx, query?: unknown) {
    const q = strict(query === undefined ? {} : query, ['business_date_from', 'business_date_to', 'status', 'sort', 'cursor', 'limit']);
    const where = ['tenant_id = $1']; const vals: unknown[] = [ctx.tenantId];
    const add = (cond: string, v: unknown): void => { vals.push(v); where.push(cond.replace('?', `$${vals.length}`)); };
    if (q['status'] !== undefined) add('status = ?', pick(q['status'], RUN_STATUSES, 'status'));
    if (q['business_date_from'] !== undefined) add('business_date >= ?', isDate(q['business_date_from']) ? q['business_date_from'] : invalid('business_date_from'));
    if (q['business_date_to'] !== undefined) add('business_date <= ?', isDate(q['business_date_to']) ? q['business_date_to'] : invalid('business_date_to'));
    if (q['sort'] !== undefined && q['sort'] !== '-business_date') invalid('sort');
    const limit = pageLimit(q['limit']);
    const after = q['cursor'] !== undefined ? decodeCursor(q['cursor'], 'runs', '-business_date', ['string', 'string']) : undefined;
    const rows = (await ctx.tx.query(`SELECT * FROM payments.reconciliation_runs WHERE ${where.join(' AND ')} ORDER BY business_date DESC, id DESC`, vals)).rows;
    const p = page(rows, (r) => [dateText(r['business_date']), r['id']], [-1, -1], after, limit, 'runs', '-business_date');
    return { data: p.items.map(runDto), page: { limit, ...(p.next ? { next_cursor: p.next } : {}) } };
  }

  async function getReconciliationRun(ctx: ReconCtx, input: unknown) {
    const id = uuid(strict(input, ['runId'])['runId'], 'runId');
    const r = (await ctx.tx.query('SELECT * FROM payments.reconciliation_runs WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, id])).rows[0];
    if (!r) throw new LimsError('common.not_found');
    return runDto(r);
  }

  // ------------------------------------------------------------------ P15
  async function listReconciliationFindings(ctx: ReconCtx, query?: unknown) {
    const q = strict(query === undefined ? {} : query, ['status', 'kind', 'severity', 'run_id', 'sort', 'cursor', 'limit']);
    const where = ['tenant_id = $1']; const vals: unknown[] = [ctx.tenantId];
    const add = (col: string, v: unknown): void => { vals.push(v); where.push(`${col} = $${vals.length}`); };
    if (q['status'] !== undefined) add('status', pick(q['status'], FINDING_STATUSES, 'status'));
    if (q['severity'] !== undefined) add('severity', pick(q['severity'], SEVERITIES, 'severity'));
    if (q['run_id'] !== undefined) add('run_id', uuid(q['run_id'], 'run_id'));
    let kinds: string[] | undefined;
    if (q['kind'] !== undefined) {
      if (typeof q['kind'] !== 'string') invalid('kind');
      kinds = (q['kind'] as string).split(',');
      for (const k of kinds) pick(k, KINDS, 'kind');
    }
    const sort = q['sort'] === undefined ? '-created_at' : pick(q['sort'], SORT_FINDINGS, 'sort');
    const limit = pageLimit(q['limit']);
    const bySeverity = sort === 'severity';
    const after = q['cursor'] !== undefined ? decodeCursor(q['cursor'], 'findings', sort, bySeverity ? ['number', 'number', 'string'] : ['number', 'string']) : undefined;
    let rows = (await ctx.tx.query(`SELECT * FROM payments.reconciliation_findings WHERE ${where.join(' AND ')}`, vals)).rows;
    if (kinds) rows = rows.filter((r) => kinds!.includes(r['kind']));
    const ts = (r: Row): number => Date.parse(iso(r['created_at']));
    const p = bySeverity
      ? page(rows, (r) => [SEVERITY_RANK[r['severity']] ?? 9, ts(r), r['id']], [1, -1, -1], after, limit, 'findings', sort)
      : page(rows, (r) => [ts(r), r['id']], [-1, -1], after, limit, 'findings', sort);
    return { data: p.items.map(findingDto), page: { limit, ...(p.next ? { next_cursor: p.next } : {}) } };
  }

  // ------------------------------------------------------------------ P16
  async function resolveReconciliationFinding(ctx: ReconCtx, input: unknown) {
    guardActor(ctx);
    const i = strict(input, ['findingId', 'expectedVersion', 'body']);
    const id = uuid(i['findingId'], 'findingId');
    const body = strict(i['body'], ['resolution_code', 'note']);
    const code = pick(body['resolution_code'], RESOLUTIONS, 'resolution_code');
    let note: string | null = null;
    if (body['note'] !== undefined) {
      if (typeof body['note'] !== 'string' || body['note'].length > 1000) invalid('note');
      note = body['note'] as string;
    }
    if (code === 'other' && !note) invalid('note');                      // AC-PG-08.7: resolving with "other" needs a reason
    if (note === '') note = null;
    const expected = i['expectedVersion'];
    if (expected !== undefined && !(typeof expected === 'number' && Number.isSafeInteger(expected) && expected >= 1)) invalid('expectedVersion');

    const cur = (await ctx.tx.query('SELECT * FROM payments.reconciliation_findings WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [ctx.tenantId, id])).rows[0];
    if (!cur) throw new LimsError('common.not_found');
    if (expected === undefined) throw new LimsError('common.precondition_required');
    if (cur['status'] !== 'open') throw new LimsError('common.immutable_record');   // a resolution is never overwritten
    if (Number(cur['version']) !== expected) throw new LimsError('common.version_conflict');

    const upd = (await ctx.tx.query(
      `UPDATE payments.reconciliation_findings SET status = 'resolved', resolution_code = $1, note = $2, resolved_by = $3, resolved_at = $4, updated_at = $4, updated_by = $5, version = version + 1
       WHERE tenant_id = $6 AND id = $7 AND version = $8 AND status = 'open' RETURNING *`,
      [code, note, ctx.actor.membershipId ?? ctx.actor.id, ctx.now(), ctx.actor.id, ctx.tenantId, id, expected])).rows[0];
    if (!upd) throw new LimsError('common.version_conflict');
    // P16 access row (TRD §5.1, D-112): same transaction, the resolution code only — never the note.
    await ctx.audit!.access({ action: 'payment_intent.resolve', entityType: 'reconciliation_finding', entityId: id, outcome: 'allowed', detail: { resolution_code: code } });
    return findingDto(upd);
  }

  // ------------------------------------------------------------------ batches (TRD §6.7 "Transaction boundaries")
  const insertFinding = async (ctx: ReconCtx, runId: string, f: FindingSpec): Promise<void> => {
    await ctx.tx.query(
      `INSERT INTO payments.reconciliation_findings (id, tenant_id, run_id, intent_id, refund_id, kind, severity, our_status, gateway_status_raw, our_amount_paisa, gateway_amount_paisa, auto_action, status, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'open', $13, $13)`,
      [newId(), ctx.tenantId, runId, f.intentId ?? null, f.refundId ?? null, f.kind, f.severity, f.ourStatus ?? null, f.gatewayStatusRaw ?? null, f.ourAmount ?? null, f.gatewayAmount ?? null, f.auto, ctx.actor.id]);
  };

  /** C15 refunds that explain a gateway-side refund of the intent: completed ones (refunded_paisa) plus those in flight (requested / held_for_review). */
  async function refundCovered(ctx: ReconCtx, row: Row, raw: string | undefined): Promise<boolean> {
    const inflight = (await ctx.tx.query('SELECT * FROM payments.refunds WHERE tenant_id = $1 AND intent_id = $2 AND status = ANY($3)', [ctx.tenantId, row['id'], REFUND_CANDIDATES])).rows;
    const covered = Number(row['refunded_paisa']) + inflight.reduce((s, r) => s + Number(r['amount_paisa']), 0);
    return raw !== undefined && PARTIAL_REFUND_STATUSES.includes(raw.trim()) ? covered > 0 : covered >= Number(row['amount_paisa']);
  }

  /** AC-PG-08.5: the idempotent ledger call. duplicate:true is the healthy answer; duplicate:false means the entry was missing and is now recorded. */
  async function ledgerCheck(ctx: ReconCtx, row: Row): Promise<'ok' | 'repaired' | 'refused'> {
    try {
      const led = await ctx.db!.tx(() => ctx.ports.BillingPort.recordGatewayPayment(ctx, { intentId: row['id'], orderId: row['order_id'], gateway: row['gateway'],
        gatewayTxnRef: row['gateway_txn_ref'], amount: money(Number(row['amount_paisa'])), verifiedAt: iso(row['settled_at'] ?? ctx.now()) }));
      return led.duplicate ? 'ok' : 'repaired';
    } catch (e) {
      if (isLimsError(e, 'billing.payment_exceeds_due')) return 'refused';   // the order's due dropped meanwhile: no retry, finance resolves with C4 (review m#31)
      throw e;
    }
  }

  /** One intent candidate: applyCheck in reconciliation mode (<= 3 attempts while the gateway gives no answer), then the finding derivation. Runs inside the candidate's savepoint. */
  async function reconcileIntent(ctx: ReconCtx, runId: string, intentId: string): Promise<FindingSpec[]> {
    let seen: CheckDecision | undefined;
    const latest = (): CheckDecision | undefined => seen;               // (a call, so the closure assignment below is not narrowed away)
    let unreachable = false;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      seen = undefined;
      await outcome.applyCheck(ctx, intentId, 'reconciliation', { onDecision: (x) => { seen = x; } });
      if (latest()?.outcome.kind !== 'retry') break;
      if (attempt === MAX_ATTEMPTS) unreachable = true;
    }
    const d = latest()!;
    const row = await findById(ctx, intentId) ?? (() => { throw new LimsError('common.not_found'); })();
    const base: FindingSpec = { kind: '', severity: 'info', auto: 'none', intentId, ourStatus: d.beforeStatus, ourAmount: Number(row['amount_paisa']),
      gatewayStatusRaw: d.answer?.statusRaw.slice(0, 64) ?? null, gatewayAmount: d.answer?.amountPaisa ?? null };
    const out: FindingSpec[] = [];
    const add = (kind: string, severity: FindingSpec['severity'], auto: FindingSpec['auto']): void => { out.push({ ...base, kind, severity, auto }); };
    const o = d.outcome;
    if (unreachable) add('gateway_unreachable', 'warning', 'none');
    else if (o.kind === 'settle') add('missed_settlement', 'warning', 'settled');
    else if (o.kind === 'hold' && o.reason === 'late_payment_found') add('late_payment_found', 'critical', 'held');       // I13
    else if (o.kind === 'hold' && o.reason === 'amount_mismatch') add('amount_mismatch', 'critical', 'held');
    else if (o.kind === 'finding' && o.finding === 'status_divergence') add('status_divergence', 'critical', 'none');
    else if (o.kind === 'finding' && o.finding === 'amount_mismatch') add('amount_mismatch', 'critical', 'none');
    else if (o.kind === 'finding' && o.finding === 'gateway_refund_unrecorded') { if (!(await refundCovered(ctx, row, d.answer?.statusRaw))) add('gateway_refund_unrecorded', 'critical', 'none'); }
    else if (d.beforeStatus === 'held_for_review' && o.kind === 'stay') {
      const raw = d.answer?.statusRaw.trim();
      if (raw !== undefined && COMPLETE_STATUSES.includes(raw) && d.answer?.amountPaisa !== Number(row['amount_paisa'])) add('amount_mismatch', 'critical', 'none');   // held and the gateway amount still differs
      else add('still_held', 'info', 'none');
    }
    if (SETTLED_FAMILY.includes(d.beforeStatus)) {      // an intent settled by this very check already went through the ledger call of applyCheck
      const led = await ledgerCheck(ctx, row);
      if (led === 'repaired') add('ledger_entry_missing', 'critical', 'ledger_repaired');
      else if (led === 'refused') add('ledger_entry_missing', 'critical', 'none');
    }
    for (const f of out) await insertFinding(ctx, runId, f);
    return out;
  }

  /** One refund candidate (requested / held_for_review): is the refund visible at the gateway? Completion itself belongs to check_refund (PG-T15). */
  async function reconcileRefund(ctx: ReconCtx, runId: string, refund: Row): Promise<FindingSpec[]> {
    const base: FindingSpec = { kind: '', severity: 'warning', auto: 'none', intentId: refund['intent_id'], refundId: refund['id'], ourStatus: refund['status'], ourAmount: Number(refund['amount_paisa']) };
    let answer: { statusRaw: string } | undefined;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !answer; attempt++) {
      const res = await outcome.probe(ctx, refund['intent_id']);
      if (res.kind === 'answer') answer = res;
    }
    if (!answer) { const f = { ...base, kind: 'gateway_unreachable' }; await insertFinding(ctx, runId, f); return [f]; }   // a transient answer never counts as "not visible"
    if (GATEWAY_REFUND_STATUSES.includes(answer.statusRaw.trim())) return [];
    const next = Number(refund['unconfirmed_run_count']) + 1;
    const upd = await ctx.tx.query(
      'UPDATE payments.refunds SET unconfirmed_run_count = unconfirmed_run_count + 1, last_checked_at = $1, updated_at = $1, updated_by = $2, version = version + 1 WHERE tenant_id = $3 AND id = $4 AND version = $5',
      [ctx.now(), ctx.actor.id, ctx.tenantId, refund['id'], refund['version']]);
    if (!upd.rowCount) throw new LimsError('common.internal');
    if (next !== 2) return [];                                          // the finding is created when the count reaches 2 (review m#20)
    const f = { ...base, kind: 'refund_unconfirmed', gatewayStatusRaw: answer.statusRaw.slice(0, 64) };
    await insertFinding(ctx, runId, f);
    return [f];
  }

  /** Candidate ids of the intents phase, evaluated relative to the run's started_at (TRD §6.7): <= BATCH + 1 rows in id order after `after`. */
  async function intentCandidates(ctx: ReconCtx, startedAt: Date, after: string | undefined): Promise<Row[]> {
    const q = async (cond: string, extra: unknown[]): Promise<Row[]> => {
      const vals: unknown[] = [ctx.tenantId, ...extra]; let w = `tenant_id = $1 AND ${cond}`;
      if (after) { vals.push(after); w += ` AND id > $${vals.length}`; }
      return (await ctx.tx.query(`SELECT * FROM payments.intents WHERE ${w} ORDER BY id ASC LIMIT ${BATCH + 1}`, vals)).rows;
    };
    const t = startedAt.getTime();
    const rows = [
      ...await q('status = ANY($2)', [OPEN_AND_HELD]),
      ...await q('status = ANY($2) AND settled_at >= $3', [SETTLED_FAMILY, new Date(t - 2 * DAY)]),
      ...await q('status = ANY($2) AND closed_at >= $3', [['failed', 'expired'], new Date(t - 7 * DAY)]),
    ];
    return rows.sort((a, b) => (a['id'] < b['id'] ? -1 : a['id'] > b['id'] ? 1 : 0));
  }
  async function refundCandidates(ctx: ReconCtx, after: string | undefined): Promise<Row[]> {
    const vals: unknown[] = [ctx.tenantId, REFUND_CANDIDATES]; let w = 'tenant_id = $1 AND status = ANY($2)';
    if (after) { vals.push(after); w += ' AND id > $3'; }
    return (await ctx.tx.query(`SELECT * FROM payments.refunds WHERE ${w} ORDER BY id ASC LIMIT ${BATCH + 1}`, vals)).rows;
  }

  /** payments.reconcile_batch (TRD §8.3 row 5): <= 50 candidates of one phase in id order, counts onto the run row, next batch (then the refunds phase), the last batch completes the run. */
  async function runBatch(ctx: ReconCtx, payload: Record<string, unknown> | undefined): Promise<void> {
    const tenantId = ctx.tenantId;
    const runId = payload?.['run_id'], phase = payload?.['phase'], after = payload?.['after_id'];
    if (!tenantId || payload?.['tenant_id'] !== tenantId) return;       // the payload is untrusted: the job's own tenant scope decides
    if (typeof runId !== 'string' || !isUuidv7(runId) || (phase !== 'intents' && phase !== 'refunds')) return;
    if (after !== undefined && (typeof after !== 'string' || !isUuidv7(after))) return;
    if (!ctx.db) throw new Error('payments.reconcile_batch: ctx.db.tx required (savepoint per candidate)');

    const run = (await ctx.tx.query('SELECT * FROM payments.reconciliation_runs WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [tenantId, runId])).rows[0];
    if (!run || run['status'] !== 'running') return;                    // a late batch of a failed / completed run does nothing

    const all = phase === 'intents' ? await intentCandidates(ctx, new Date(run['started_at']), after) : await refundCandidates(ctx, after);
    const batch = all.slice(0, BATCH);
    const tally: Tally = { checked: 0, ok: 0, findings: 0, critical: 0 };
    for (const cand of batch) {
      tally.checked++;
      try {
        const found = await ctx.db.tx(() => (phase === 'intents' ? reconcileIntent(ctx, runId, cand['id']) : reconcileRefund(ctx, runId, cand)));
        tally.findings += found.length; tally.critical += found.filter((f) => f.severity === 'critical').length;
        if (found.length === 0) tally.ok++;
        for (const f of found) ctx.metrics?.inc?.(FINDINGS_METRIC, { kind: f.kind, severity: f.severity });
      } catch {
        // P-44: only this candidate was rolled back (savepoint). It stays counted as checked, not ok; an unexpected error is never turned into a finding about money.
        deps.log?.error('payments_reconcile_item_failed', { tenantId, ...(phase === 'intents' ? { intentId: cand['id'] } : { refundId: cand['id'] }) });
      }
    }

    const last = batch[batch.length - 1];
    let done = false;
    if (all.length > BATCH && last) await deps.jobs.enqueue(ctx, RECONCILE_BATCH_TASK, { tenant_id: tenantId, run_id: runId, phase, after_id: last['id'] }, { key: `recon:${runId}:${phase}:${last['id']}` });
    else if (phase === 'intents') await deps.jobs.enqueue(ctx, RECONCILE_BATCH_TASK, { tenant_id: tenantId, run_id: runId, phase: 'refunds' }, { key: `recon:${runId}:refunds:start` });
    else done = true;

    const now = ctx.now();
    await ctx.tx.query(
      `UPDATE payments.reconciliation_runs SET checked_count = checked_count + $1, ok_count = ok_count + $2, findings_count = findings_count + $3, critical_count = critical_count + $4,
       ${done ? "status = 'completed', finished_at = $5, " : ''}updated_at = $5, updated_by = $6, version = version + 1 WHERE tenant_id = $7 AND id = $8 AND status = 'running'`,
      [tally.checked, tally.ok, tally.findings, tally.critical, now, ctx.actor.id, tenantId, runId]);
    if (done) ctx.metrics?.set?.(LAST_SUCCESS_METRIC, Math.floor(Date.parse(now) / 1000), { tenant_id: tenantId });
  }

  return { listReconciliationRuns, getReconciliationRun, startReconciliationRun, listReconciliationFindings, resolveReconciliationFinding, startCronRun, runBatch };
}
