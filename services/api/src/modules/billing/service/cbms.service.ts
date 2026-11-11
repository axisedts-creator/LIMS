// CBMS sync (BL-T14; PRD US-BL-13.1-13.4; 02-TRD §5.2 B30/B31, §9). One caller transaction (ctx.tx):
//   submit  = body of job billing.cbms_sync: lock the document -> ONE client call -> append cbms_submissions -> state/attempt counters. Never throws for a client outcome (a throw would
//             roll the attempt record back with the job transaction, and the retry cadence is the sweep's, not graphile's). A client that throws counts as retryable_error; its message is stored nowhere.
//   retry   = B31: failed_permanent -> pending, attempts kept, ONE sync job queued.
//   listDocuments = B30.
// The stub client answers stub_recorded, which keeps the document pending: nothing here (or anywhere in C4) marks a document synced except an `accepted` outcome of a live client.
// ponytail: the client call runs inside the transaction while the document row is locked; fine for a stub / short live call, move the call outside the lock if the live client gets slow.
import { LimsError } from '../../../core/errors.js';
import { canTransition, nextCbmsState, type CbmsOutcome, type CbmsState } from '../domain/cbms.state.js';
import { toPaisa } from '../domain/money/paisa.js';
import type { CbmsClient, CbmsDocument, CbmsDocumentKind } from '../cbms/CbmsClient.js';
import { cbmsKindIdx } from '../repository/cbms.repo.js';
import { billingRepo, type BillingRepo } from '../repository/index.js';
import { decodeCursor, encodeCursor, iso, present } from './invoiceRead.service.js';

export interface CbmsCtx {
  readonly tenantId: string;
  readonly actor: { readonly type: string; readonly id: string };
  readonly tx: unknown;
  readonly now: () => string;
  readonly ports?: { readonly IdentityPort?: { getTenantSettings(ctx: any, input: { keys: readonly string[] }): Promise<any> } };
}

const KINDS: readonly CbmsDocumentKind[] = ['invoice', 'invoice_cancellation', 'credit_note'];
const STATES: readonly string[] = ['not_required', 'pending', 'synced', 'failed_permanent'];
const OUTCOMES: readonly string[] = ['accepted', 'rejected_permanent', 'retryable_error', 'stub_recorded'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIN_MS = 60_000, CAP_MS = 6 * 3_600_000, DEFAULT_LIMIT = 50, MAX_LIMIT = 200, MAX_TEXT = 200;

/** TRD §9 [CONV]: a pending document is due again once its last attempt is older than min(2^attempts minutes, 6 h). */
export function cbmsBackoffMs(attempts: number): number {
  const n = Number.isInteger(attempts) && attempts >= 0 ? attempts : 0;
  return Math.min(2 ** Math.min(n, 30) * MIN_MS, CAP_MS);
}

const bad = (): LimsError => new LimsError('common.validation_failed');
function scope(ctx: CbmsCtx): void {
  if (typeof ctx?.tenantId !== 'string' || typeof ctx.actor?.id !== 'string' || !ctx.tx) throw new LimsError('auth.unauthenticated');
}
function checkDoc(raw: unknown): { documentKind: CbmsDocumentKind; documentId: string } {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  if (typeof o['documentKind'] !== 'string' || !KINDS.includes(o['documentKind'] as CbmsDocumentKind)) throw bad();
  if (typeof o['documentId'] !== 'string' || !UUID.test(o['documentId'])) throw bad();
  return { documentKind: o['documentKind'] as CbmsDocumentKind, documentId: o['documentId'] };
}
const clip = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v.slice(0, MAX_TEXT) : undefined);

function documentOf(kind: CbmsDocumentKind, r: Record<string, any>): CbmsDocument {
  const opt = (k: string, v: unknown) => (typeof v === 'string' && v !== '' ? { [k]: v } : {});
  return {
    kind, documentId: String(r['document_id']), documentNo: String(r['document_no']), fiscalYearBs: String(r['fiscal_year_bs']), issuedAtUtc: iso(r['issued_at']), dateBs: String(r['date_bs']),
    ...opt('sellerPan', r['seller_pan']), buyerName: String(r['buyer_name']), ...opt('buyerPan', r['buyer_pan']), ...(kind === 'invoice' ? {} : opt('refInvoiceNo', r['ref_invoice_no'])),
    totals: {
      gross: toPaisa(r['gross_paisa']), discount: toPaisa(r['discount_paisa']), exempt: toPaisa(r['exempt_paisa']), taxable: toPaisa(r['taxable_paisa']),
      vat: toPaisa(r['vat_paisa']), otherTax: toPaisa(r['other_tax_paisa']), net: toPaisa(r['net_paisa']),
    },
  };
}

export function createCbmsService(deps: { repo?: BillingRepo; client: CbmsClient }) {
  const repo = deps.repo ?? billingRepo;

  async function submit(ctx: CbmsCtx, raw: unknown) {
    scope(ctx);
    const { documentKind, documentId } = checkDoc(raw);
    const tx = ctx.tx as never, tenantId = ctx.tenantId;
    const row = (await repo.getCbmsDocumentForUpdate(tx, { tenantId, documentKind, documentId })) as Record<string, any> | undefined;
    if (!row) return { submitted: false as const, reason: 'not_found' as const };
    if (row['cbms_state'] !== 'pending') return { submitted: false as const, reason: 'not_pending' as const };

    let outcome: CbmsOutcome = 'retryable_error';
    let externalRef: string | undefined;
    let rawStatus: string | undefined;
    try {
      const r = await deps.client.submit({ tenantId, document: documentOf(documentKind, row), idempotencyKey: `${documentKind}:${documentId}` });
      if (OUTCOMES.includes(r?.outcome)) { // an unknown answer is a transient error, never a state change
        outcome = r.outcome;
        rawStatus = clip(r.rawStatusRedacted);
        if (outcome === 'accepted') externalRef = clip(r.externalRef);
      }
    } catch { /* retryable_error; the message may hold a credential and is deliberately dropped */ }

    const state = nextCbmsState('pending', outcome);
    const attemptNo = Number(row['cbms_attempts']) + 1;
    const at = ctx.now();
    await repo.insertCbmsSubmission(tx, {
      tenantId, documentKind, documentId, attemptNo, clientMode: deps.client.mode, outcome,
      ...(externalRef === undefined ? {} : { externalRef }), ...(rawStatus === undefined ? {} : { rawStatusRedacted: rawStatus }), submittedAt: at, userId: ctx.actor.id,
    });
    await repo.recordCbmsAttempt(tx, {
      tenantId, documentKind, documentId, state, attempts: attemptNo, lastAttemptAt: at, ...(externalRef === undefined ? {} : { externalRef }), userId: ctx.actor.id,
    });
    return { submitted: true as const, outcome, cbmsState: state, attemptNo };
  }

  /** B31. LD-26: a training tenant has no CBMS documents to retry. A pending document is only nudged (job re-queued); not_required and synced are refused. */
  async function retry(ctx: CbmsCtx, raw: unknown): Promise<{ cbms_state: 'pending' }> {
    scope(ctx);
    const { documentKind, documentId } = checkDoc(raw);
    const tx = ctx.tx as never, tenantId = ctx.tenantId;
    const row = (await repo.getCbmsDocumentForUpdate(tx, { tenantId, documentKind, documentId })) as Record<string, any> | undefined;
    if (!row) throw new LimsError('common.not_found'); // unknown and another tenant's id look the same
    const idp = ctx.ports?.IdentityPort;
    if (!idp) throw new LimsError('common.internal');
    const tenant = await idp.getTenantSettings(ctx, { keys: ['trainingMode'] });
    if (tenant?.trainingMode === true) throw bad(); // LD-26 (2026-11-07, A33-3): never queue anything of a training tenant for CBMS
    const state = row['cbms_state'] as CbmsState;
    if (state === 'failed_permanent') {
      if (!canTransition(state, 'pending')) throw new LimsError('common.internal');
      await repo.resetCbmsToPending(tx, { tenantId, documentKind, documentId, userId: ctx.actor.id });
    } else if (state !== 'pending') throw bad(); // synced is terminal; not_required was never owed
    await repo.enqueueCbmsSync(tx, { tenantId, documentKind, documentId });
    return { cbms_state: 'pending' };
  }

  /** B30. Rows carry the published CbmsDocumentRow fields only. */
  async function listDocuments(ctx: CbmsCtx, raw: unknown) {
    scope(ctx);
    const q = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    if (q['state'] !== undefined && (typeof q['state'] !== 'string' || !STATES.includes(q['state']))) throw bad();
    if (q['documentKind'] !== undefined && (typeof q['documentKind'] !== 'string' || !KINDS.includes(q['documentKind'] as CbmsDocumentKind))) throw bad();
    const l = q['limit'];
    const limit = l === undefined ? DEFAULT_LIMIT : typeof l === 'string' && /^[0-9]{1,3}$/.test(l) ? Number(l) : typeof l === 'number' ? l : 0;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw bad();
    const after = q['cursor'] === undefined ? undefined : decodeCursor(q['cursor'], 'cbms_documents', 'int');
    const rows = (await repo.listCbmsDocuments(ctx.tx as never, {
      tenantId: ctx.tenantId, limit: limit + 1,
      ...(q['state'] === undefined ? {} : { state: q['state'] as string }), ...(q['documentKind'] === undefined ? {} : { documentKind: q['documentKind'] as CbmsDocumentKind }),
      ...(after === undefined ? {} : { afterKey: { id: after.id, kindIdx: after.value as number } }),
    })) as Record<string, any>[];
    const more = rows.length > limit;
    const last = more ? rows[limit - 1] : undefined;
    return {
      data: rows.slice(0, limit).map((r) => present({
        document_kind: r['document_kind'], document_id: r['document_id'], document_no: r['document_no'], cbms_state: r['cbms_state'], attempts: Number(r['attempts']),
        last_attempt_at: r['last_attempt_at'] == null ? undefined : iso(r['last_attempt_at']), last_outcome: r['last_outcome'],
      })),
      page: { limit, ...(last === undefined ? {} : { next_cursor: encodeCursor('cbms_documents', cbmsKindIdx(last['document_kind']), String(last['document_id'])) }) },
    };
  }

  return { submit, retry, listDocuments };
}
export type CbmsService = ReturnType<typeof createCbmsService>;
