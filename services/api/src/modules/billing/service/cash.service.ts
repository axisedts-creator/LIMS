// B17 getMyCashSession / closeCashSession (02-TRD §5 B17, §6.5; 03-APP-FLOW §5 "Close: own open session only"; PRD US-BL-11.2/.3; 05-SCHEMA billing.cash_sessions open -> closed only).
// Own session only (the owner is the ctx membership; nothing in the body can name another). `expected` per method = signed sum of the session's ledger rows
// (payments, reversals, refunds); home_collection / B22 rows have no session and never enter it. billing.cash_sessions.variance_paisa = Σ (counted - expected) over CASH
// methods only (APP-FLOW §5); a method that was not counted counts as 0. The next manual payment after the close opens a new session (ledger.service).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError, type FieldError } from '../../../core/errors.js';
import { toPaisa } from '../domain/money/paisa.js';
import { billingRepo, type BillingRepo } from '../repository/index.js';
import type { BalanceCtx } from './balance.service.js';
import { cashSessionDto, names } from './ledgerDto.js';
import { isRec, UUID } from './invoiceRead.service.js';

const MAX_ROWS = 20;
const MAX_NOTE = 500;
const invalid = (...errors: FieldError[]): LimsError => new LimsError('common.validation_failed', undefined, errors);
const fieldError = (path: string): FieldError => ({ path, code: 'common.field_invalid', message: 'Field invalid' });

function authed(ctx: BalanceCtx): { tx: never; tenantId: string; actorId: string } {
  if (typeof ctx?.tenantId !== 'string' || typeof ctx.actor?.id !== 'string' || !ctx.tx) throw new LimsError('auth.unauthenticated');
  return { tx: ctx.tx as never, tenantId: ctx.tenantId, actorId: ctx.actor.id };
}

interface CloseInput { sessionId: string; expectedVersion: number | undefined; counted: Map<string, number>; note?: string }
function checkClose(raw: unknown): CloseInput {
  if (!isRec(raw)) throw invalid(fieldError('/'));
  const errors: FieldError[] = [];
  if (typeof raw['sessionId'] !== 'string' || !UUID.test(raw['sessionId'])) errors.push(fieldError('/sessionId'));
  const v = raw['expectedVersion'];
  if (v !== undefined && !(typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 2147483647)) errors.push(fieldError('/expectedVersion'));
  const counted = new Map<string, number>();
  const rows = raw['counted'];
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) errors.push(fieldError('/counted'));
  else rows.forEach((r, n) => {
    const ok = isRec(r) && typeof r['method_code'] === 'string' && r['method_code'].length >= 1 && r['method_code'].length <= 64
      && typeof r['amount_paisa'] === 'number' && Number.isSafeInteger(r['amount_paisa']) && r['amount_paisa'] >= 0 && !counted.has(r['method_code']);
    if (ok) counted.set(r['method_code'], r['amount_paisa']); else errors.push(fieldError(`/counted/${n}`));
  });
  const note = raw['note'];
  if (note !== undefined && (typeof note !== 'string' || note.length > MAX_NOTE)) errors.push(fieldError('/note'));
  if (errors.length) throw invalid(...errors);
  return { sessionId: raw['sessionId'] as string, expectedVersion: v as number | undefined, counted, ...(typeof note === 'string' ? { note } : {}) };
}

export function createCashService(deps: { repo?: Pick<BillingRepo, 'findOpenCashSession' | 'getCashSession' | 'sumLedgerBySession' | 'closeCashSession' | 'getPaymentMethod' | 'insertActivity'> } = {}) {
  const repo = deps.repo ?? billingRepo;
  const expectedOf = async (tx: never, tenantId: string, sessionId: string) =>
    new Map((await repo.sumLedgerBySession(tx, { tenantId, sessionId })).map((r) => [r.method_code, toPaisa(r.amount_paisa)] as const));

  async function getMyCashSession(ctx: BalanceCtx) {
    const { tx, tenantId } = authed(ctx);
    const membershipId = ctx.actor.membershipId;
    const s = membershipId === undefined ? undefined : await repo.findOpenCashSession(tx, { tenantId, membershipId });
    if (!s) throw new LimsError('common.not_found');
    return cashSessionDto(s, await names(ctx, [s['membership_id']]), await expectedOf(tx, tenantId, String(s['id'])));
  }

  async function closeCashSession(ctx: BalanceCtx, rawInput: unknown) {
    const { tx, tenantId, actorId } = authed(ctx);
    const i = checkClose(rawInput);
    if (i.expectedVersion === undefined) throw new LimsError('common.precondition_required');
    const s = await repo.getCashSession(tx, { tenantId, sessionId: i.sessionId });
    if (!s) throw new LimsError('common.not_found'); // unknown and another tenant's id answer the same
    if (ctx.actor.membershipId === undefined || s['membership_id'] !== ctx.actor.membershipId) throw new LimsError('auth.forbidden');
    if (s['status'] !== 'open') throw new LimsError('common.immutable_record');
    if (Number(s['version']) !== i.expectedVersion) throw new LimsError('common.version_conflict');

    const expected = await expectedOf(tx, tenantId, i.sessionId);
    const methods = [...new Set([...expected.keys(), ...i.counted.keys()])].sort();
    let variancePaisa = 0;
    for (const m of methods) {
      if ((await repo.getPaymentMethod(tx, { tenantId, code: m }))?.is_cash === true) variancePaisa += (i.counted.get(m) ?? 0) - (expected.get(m) ?? 0);
    }
    const closed = await repo.closeCashSession(tx, {
      tenantId, sessionId: i.sessionId, expectedVersion: i.expectedVersion,
      expected: methods.map((m) => ({ method_code: m, amount_paisa: expected.get(m) ?? 0 })), counted: methods.map((m) => ({ method_code: m, amount_paisa: i.counted.get(m) ?? 0 })),
      variancePaisa, ...(i.note === undefined ? {} : { note: i.note }), closedAt: ctx.now(), userId: actorId,
    });
    if (!closed) throw new LimsError('common.version_conflict'); // moved between the read and the write
    await repo.insertActivity(tx, {
      id: uuidv7(), tenant_id: tenantId, centre_id: s['centre_id'], action: 'cash_session_closed', document_kind: 'cash_session', document_id: i.sessionId,
      actor_id: actorId, actor_membership_id: ctx.actor.membershipId, actor_type: ctx.actor.type, occurred_at: ctx.now(), request_id: ctx.requestId ?? null,
      details: { variance_paisa: variancePaisa }, created_by: actorId,
    });
    return cashSessionDto(closed, await names(ctx, [closed['membership_id']]));
  }
  return { getMyCashSession, closeCashSession };
}
export type CashService = ReturnType<typeof createCashService>;
