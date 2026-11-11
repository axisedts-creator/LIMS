// BL-T14 test helpers (not a test file). In-memory CBMS world on top of t06.helpers.ts (real core event publisher + tx snapshot/rollback) and a scriptable CbmsClient.
// ASSUMED seams (spec fixes behaviour, not signatures; writer: object via a dispute if wrong). Repo fns take (tx, args), carry tenantId from ctx only, snake_case rows:
//   repo.getCbmsDocumentForUpdate(tx,{tenantId,documentKind,documentId}) -> CbmsDocRow | undefined   SELECT … FOR UPDATE on invoices (kind invoice → cbms_*, kind invoice_cancellation → cbms_cancel_*,
//        NULL cbms_cancel_state = not cancelled = undefined) or credit_notes. CbmsDocRow = { document_kind, document_id, document_no, fiscal_year_bs, issued_at (ISO), date_bs,
//        seller_pan, buyer_name, buyer_pan, ref_invoice_no, gross_paisa, discount_paisa, exempt_paisa, taxable_paisa, vat_paisa, other_tax_paisa, net_paisa,
//        cbms_state, cbms_attempts, cbms_last_attempt_at }. For invoice_cancellation the totals/issued_at/date_bs are the cancelling credit note's.
//   repo.insertCbmsSubmission(tx,{tenantId,documentKind,documentId,attemptNo,clientMode,outcome,externalRef?,rawStatusRedacted?,submittedAt,userId}) -> void   (billing.cbms_submissions, append-only)
//   repo.recordCbmsAttempt(tx,{tenantId,documentKind,documentId,state,attempts,lastAttemptAt,externalRef?,userId}) -> void   writes cbms_* or cbms_cancel_* by kind; state 'synced' also sets *_synced_at
//        (= lastAttemptAt) and *_external_ref; the DB guard (invoices_lifecycle_guard / credit_notes) only allows pending → synced|failed_permanent and failed_permanent → pending.
//   repo.resetCbmsToPending(tx,{tenantId,documentKind,documentId,userId}) -> void   failed_permanent → pending (attempts kept). repo.enqueueCbmsSync exists (BL-T10).
//   repo.listCbmsDocuments(tx,{tenantId,state?,documentKind?,afterKey?,limit}) -> rows { document_kind, document_id, document_no, cbms_state, attempts, last_attempt_at, last_outcome, … }
// ASSUMED service seam: createCbmsService({ repo, client }) →
//   submit(ctx,{documentKind,documentId}) -> { submitted:boolean, reason?:'not_found'|'not_pending', outcome?, cbmsState?, attemptNo? }   never throws for a client outcome; a throwing client = retryable_error
//   retry(ctx,{documentKind,documentId}) -> { cbms_state:'pending' }                 B31 (permission/aal2/Idempotency-Key are the pipeline's)
//   listDocuments(ctx,{state?,documentKind?,cursor?,limit?}) -> { data:[{document_kind,document_id,document_no,cbms_state,attempts,last_attempt_at,last_outcome}], page:{…} }   B30
//   ctx.tx/tenantId/actor/now/ports.IdentityPort as everywhere in billing; trainingMode comes from ctx.ports.IdentityPort.getTenantSettings(ctx,{keys:[…,'trainingMode']}) (CR C2.T16).
// Synthetic data only.
import { canTransition } from '../../domain/cbms.state.js';
import { pgError } from '../../../../core/events/__tests__/helpers.js';
import { IDS, makeWorld, TENANT_A, V7, type WorldOpts } from './t06.helpers.js';

export { IDS, TENANT_A, V7 };
export { BASE, errCode, USER } from './t06.helpers.js';
export const TENANT_B = '0190a000-0000-7000-8000-00000000bbbb';
export const KINDS = ['invoice', 'invoice_cancellation', 'credit_note'] as const;
export type Kind = (typeof KINDS)[number];
export const DOC = { invoice: V7('000000e00001'), invoice_cancellation: V7('000000e00002'), credit_note: V7('000000e00003') } as const;
export const SECRET = 'SECRET-TOKEN-123'; // must never reach a row, a log line or an event

export interface Doc {
  tenant_id: string; document_kind: Kind; document_id: string; document_no: string; fiscal_year_bs: string; issued_at: string; date_bs: string;
  seller_pan: string | null; buyer_name: string; buyer_pan: string | null; ref_invoice_no: string | null;
  gross_paisa: number; discount_paisa: number; exempt_paisa: number; taxable_paisa: number; vat_paisa: number; other_tax_paisa: number; net_paisa: number;
  cbms_state: string; cbms_attempts: number; cbms_last_attempt_at: string | null; cbms_synced_at: string | null; cbms_external_ref: string | null;
  patient_name?: string; line_names?: string[]; // extra columns a careless projection could leak (07-SECURITY item 7)
}
export const doc = (kind: Kind, over: Partial<Doc> = {}): Doc => ({
  tenant_id: TENANT_A, document_kind: kind, document_id: DOC[kind], document_no: kind === 'invoice' ? '083/84-000001' : '083/84-CN-000001', fiscal_year_bs: '2083/84',
  issued_at: '2026-11-08T05:00:00.000Z', date_bs: '2083-07-22', seller_pan: '999999999', buyer_name: 'Synthetic Buyer One', buyer_pan: '123456789',
  ref_invoice_no: kind === 'invoice' ? null : '083/84-000001', gross_paisa: 100000, discount_paisa: 0, exempt_paisa: 0, taxable_paisa: 100000, vat_paisa: 13000, other_tax_paisa: 0,
  net_paisa: 113000, cbms_state: 'pending', cbms_attempts: 0, cbms_last_attempt_at: null, cbms_synced_at: null, cbms_external_ref: null,
  patient_name: 'Synthetic Patient', line_names: ['Complete blood count'], ...over,
});

export type Outcome = 'accepted' | 'rejected_permanent' | 'retryable_error' | 'stub_recorded';
/** A scriptable CbmsClient: answers the queued outcomes in order, then the last one forever; a function entry may throw. */
export function scriptedClient(script: Array<Outcome | (() => never)>, mode: 'stub' | 'live' = 'live') {
  const calls: any[] = [];
  let i = 0;
  return {
    mode, calls,
    async submit(input: any) {
      calls.push(structuredClone(input));
      const step = script[Math.min(i++, script.length - 1)]!;
      if (typeof step === 'function') return step();
      return step === 'accepted' ? { outcome: step, externalRef: 'EXT-0001' } : { outcome: step, rawStatusRedacted: step === 'retryable_error' ? 'timeout' : step === 'rejected_permanent' ? 'rejected' : 'recorded' };
    },
  };
}

interface X { docs: Doc[]; subs: any[] }

export function makeCbmsWorld(opts: WorldOpts = {}) {
  const w = makeWorld(opts);
  Object.assign(w.s, { docs: [], subs: [] } satisfies X); // part of the snapshot state: a rolled-back tx restores them
  const x = (): X => w.s as unknown as X;
  const calls = w.repoCalls;
  const rec = (name: string, a: any) => {
    if (typeof a?.tenantId !== 'string') throw new Error(`fake repo: ${name} called without a tenant id`);
    calls.push({ name, args: a });
  };
  const find = (a: any) => x().docs.find((d) => d.tenant_id === a.tenantId && d.document_kind === a.documentKind && d.document_id === a.documentId);
  Object.assign(w.repo, {
    async getCbmsDocumentForUpdate(_tx: unknown, a: any) {
      rec('getCbmsDocumentForUpdate', a);
      const d = find(a); return d ? structuredClone(d) : undefined;
    },
    async insertCbmsSubmission(_tx: unknown, a: any) {
      rec('insertCbmsSubmission', a);
      if (x().subs.some((s) => s.tenant_id === a.tenantId && s.document_kind === a.documentKind && s.document_id === a.documentId && s.attempt_no === a.attemptNo)) {
        throw Object.assign(pgError('23505', 'duplicate key value violates unique constraint "cbms_submissions__tenant_id_doc_attempt__uq"'), { constraint: 'cbms_submissions__tenant_id_doc_attempt__uq' });
      }
      x().subs.push({ tenant_id: a.tenantId, document_kind: a.documentKind, document_id: a.documentId, attempt_no: a.attemptNo, client_mode: a.clientMode, outcome: a.outcome,
        external_ref: a.externalRef ?? null, raw_status_redacted: a.rawStatusRedacted ?? null, submitted_at: a.submittedAt, created_by: a.userId });
    },
    async recordCbmsAttempt(_tx: unknown, a: any) {
      rec('recordCbmsAttempt', a);
      const d = find(a); if (!d) throw new Error('fake repo: recordCbmsAttempt on a missing document');
      if (d.cbms_state !== a.state && !canTransition(d.cbms_state as never, a.state)) throw Object.assign(pgError('P0001', 'immutable_row'), { detail: 'billing.invoices' }); // DB guard
      Object.assign(d, { cbms_state: a.state, cbms_attempts: a.attempts, cbms_last_attempt_at: a.lastAttemptAt,
        ...(a.state === 'synced' ? { cbms_synced_at: a.lastAttemptAt, cbms_external_ref: a.externalRef ?? null } : {}) });
    },
    async resetCbmsToPending(_tx: unknown, a: any) {
      rec('resetCbmsToPending', a);
      const d = find(a); if (!d) throw new Error('fake repo: reset on a missing document');
      if (!canTransition(d.cbms_state as never, 'pending')) throw Object.assign(pgError('P0001', 'immutable_row'), { detail: 'billing.invoices' });
      d.cbms_state = 'pending';
    },
    async listCbmsDocuments(_tx: unknown, a: any) {
      rec('listCbmsDocuments', a);
      return x().docs.filter((d) => d.tenant_id === a.tenantId && (a.state === undefined || d.cbms_state === a.state) && (a.documentKind === undefined || d.document_kind === a.documentKind))
        .slice(0, a.limit).map((d) => ({ ...structuredClone(d), attempts: d.cbms_attempts, last_attempt_at: d.cbms_last_attempt_at,
          last_outcome: [...x().subs].reverse().find((s) => s.tenant_id === d.tenant_id && s.document_kind === d.document_kind && s.document_id === d.document_id)?.outcome ?? null }));
    },
  });
  const put = (d: Doc) => { x().docs.push(d); return d; };
  const get = (kind: Kind, tenantId = TENANT_A) => x().docs.find((d) => d.tenant_id === tenantId && d.document_kind === kind)!;
  const subsOf = (kind: Kind) => x().subs.filter((s) => s.document_kind === kind);
  return Object.assign(w, { x, put, get, subsOf });
}
export type CbmsWorld = ReturnType<typeof makeCbmsWorld>;
