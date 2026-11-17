// C6-T13 test helpers (not a test file). Synthetic data only. Shared by the API R6 handler tests and the worker task / consumer / sweep tests.
// Builds on the T08 world (assemble.helpers.ts: reports LAB + NARR, versions, settings) and the T04 single-transaction fake (consumers.helpers.ts).
// Adds: a programmable BillingPort fake (scripted getReleaseEligibility per order, call recording), a FrontdeskPort fake that serves patient consents,
// recording ctx.events.publish / ctx.audit.access, a tx wrapper that enforces the DDL rules the fake does not model (one `released` version per report =
// partial unique index; status = 'released' => released_at / release_basis / audiences NOT NULL; rendered|released|superseded => pdf_* NOT NULL),
// and a pipeline-like rollback (SAVEPOINT / ROLLBACK TO SAVEPOINT) so "failure leaves nothing behind" is observable.
// ASSUMED (spec gives no signatures) and repeated in .orchestra/notes/C6-T13-tests.md:
//   - R6 handler `releaseReportVersion` takes the tenant tx and ports from the handler context like R8 does:
//       ctx = { tenantId, actor:{type,id,membershipId}, tx, ports:{ billing, frontdesk }, events:{ publish(ctx,type,{aggregate,idempotencyKey,payload}) }, audit:{ access(entry) }, now() }
//   - worker task module `tasks/release_if_eligible.ts` exports `releaseIfEligible` (TaskHandler) or `createReleaseIfEligible()`; ports from ctx.ports.billing / ctx.ports.frontdesk
//   - consumer `consumers/billing.balance.changed.v1.ts` exports `handle`; cron.ts exports `sweepHeldReleases` + `SWEEP_HELD` ('reporting.sweep_held_releases')
//   - patient consent for the audiences comes from FrontdeskPort.getPatientDemographics({ patientId, purpose: 'notification' }).consents.shareWithReferrer
import {
  pgError, SYSTEM_ACTOR, NOW, makeCtx, makeLog, TENANT_A, TENANT_B, idN, type Row,
} from './consumers.helpers.js';
import {
  world, versionRow, I, LAB, NARR, PARTNER, REG_NO, FULL_NAME, PHONE, EMAIL, type WorldOpts,
} from './assemble.helpers.js';
import { eventValidators } from '../../../../../api/src/core/events/publish.js';

export { TENANT_A, TENANT_B, idN, makeLog, SYSTEM_ACTOR, NOW, LAB, NARR, I, PARTNER, REG_NO, FULL_NAME, PHONE, EMAIL, versionRow, world };
export type { Row };

export const USER = idN(0xa001);
export const MEMBERSHIP = idN(0x3001);
export const OVERRIDE_ID = idN(0x0ee1);
export const ORDER = I.order;
export const V = (n: number) => idN(0xc000 + n);           // id of version n of the laboratory report (versionRow)
export const RELEASE_TASK = 'reporting.release_if_eligible';
export const DISPATCH_TASK = 'reporting.dispatch_release_deliveries';
export const SWEEP_HELD = 'reporting.sweep_held_releases';
export const EVENT = 'reporting.report.released.v1';
export const money = (amountPaisa: number) => ({ amountPaisa, currency: 'NPR' as const });

// ------------------------------------------------------------------------------------------------ versions
/** A `rendered` version n of the laboratory report with row `version` 3 (If-Match "3"). */
export const rendered = (n = 1, over: Row = {}): Row => versionRow(n, { status: 'rendered', version: 3, rendered_at: '2026-11-07T11:55:00.000Z', created_at: '2026-11-07T11:50:00.000Z', ...over });
/** A `released` version n (release fields set as the DDL CHECK demands). */
export const released = (n = 1, over: Row = {}): Row => rendered(n, {
  status: 'released', released_at: '2026-11-06T09:00:00.000Z', released_by: USER, release_mode: 'manual', release_basis: 'paid_in_full', audiences: ['patient', 'centre'], version: 4, ...over });

// ------------------------------------------------------------------------------------------------ BillingPort (programmable)
export type Eligibility = { eligible: boolean; basis: string; balanceDue?: { amountPaisa: number; currency: 'NPR' }; overrideId?: string };
export const ELIGIBLE = { eligible: true, basis: 'paid_in_full', balanceDue: money(0) } satisfies Eligibility;
export const DUE_500 = { eligible: false, basis: 'due_outstanding', balanceDue: money(50_000) } satisfies Eligibility;     // NPR 500.00
export function makeBilling(reply: Eligibility | Error | ((orderId: string, n: number) => Eligibility | Error) = ELIGIBLE) {
  const calls: Array<{ orderId: string; actorType?: string; tenantId?: string }> = []; const other: string[] = [];
  const port = {
    async getReleaseEligibility(ctx: any, input: { orderId: string }) {
      calls.push({ orderId: input.orderId, actorType: ctx?.actor?.type, tenantId: ctx?.tenantId });
      const r = typeof reply === 'function' ? reply(input.orderId, calls.length) : reply;
      if (r instanceof Error) throw r;
      return { orderId: input.orderId, evaluatedAt: NOW, ...r };
    },
    // C6 never writes billing data (TRD §4.6 rule 3) and never needs the balance for a release; any other call is recorded for the tests to refuse.
    async getOrderBalance() { other.push('getOrderBalance'); throw new Error('unexpected getOrderBalance'); },
    async recordGatewayPayment() { other.push('recordGatewayPayment'); throw new Error('C6 must not write billing'); },
    async recordGatewayRefund() { other.push('recordGatewayRefund'); throw new Error('C6 must not write billing'); },
    async createReleaseOverride() { other.push('createReleaseOverride'); throw new Error('C6 must not create overrides'); },
  };
  return { port, calls, other };
}
export const billingDown = () => Object.assign(new Error('billing down'), { code: 'common.unavailable' });

// ------------------------------------------------------------------------------------------------ FrontdeskPort (consents)
export interface ConsentOpts { shareWithReferrer?: boolean; sms?: boolean; whatsapp?: boolean; email?: boolean; down?: boolean }
export function makeFrontdesk(o: ConsentOpts = {}) {
  const calls: Array<{ patientId: string; purpose: string }> = [];
  const port = {
    async getPatientDemographics(_ctx: unknown, i: { patientId: string; purpose: string }) {
      calls.push({ patientId: i.patientId, purpose: i.purpose });
      if (o.down) throw Object.assign(new Error('frontdesk down'), { code: 'common.unavailable' });
      if (i.purpose !== 'notification') throw Object.assign(new Error('purpose not allowed for release'), { code: 'common.forbidden' });
      return { patientId: i.patientId, patientCode: 'P0042', fullName: FULL_NAME, sex: 'female', phoneE164: PHONE, email: EMAIL, status: 'active',
        consents: { sms: o.sms ?? false, whatsapp: o.whatsapp ?? false, email: o.email ?? false, shareWithReferrer: o.shareWithReferrer ?? false, consentTextVersion: 'v1' } };
    },
  };
  return { port, calls };
}

// ------------------------------------------------------------------------------------------------ recording events / audit + DDL-rule tx wrapper
export interface Published { type: string; input: any; ctxTxIsOurTx: boolean; ctxActor: any }
export function makeEvents(getTx: () => unknown, failWith?: Error) {
  const published: Published[] = [];
  const events = { async publish(c: any, type: string, input: any) {
    if (failWith) throw failWith;
    published.push({ type, input: structuredClone(input), ctxTxIsOurTx: c?.tx === getTx(), ctxActor: c?.actor }); return { eventId: idN(0xe000 + published.length), duplicate: false }; } };
  return { events, published };
}
export function makeAudit() {
  const entries: any[] = [];
  return { audit: { async access(entry: any) { entries.push(structuredClone(entry)); } }, entries };
}

/** Wraps the fake tx: after every write, the DDL rules the fake does not model are checked (23505 / 23514 like Postgres). */
export function ddlChecked(db: ReturnType<typeof world>['db']) {
  const base = db.tx;
  const tx: any = {
    startedAt: base.startedAt, savepoint: async <T>(fn: (t: unknown) => Promise<T>) => fn(tx),
    async query(text: string, values: unknown[] = []) {
      const res = await base.query(text, values);
      if (/^\s*(update|insert)/i.test(text)) {
        const vs = db.all('reporting.report_versions'); const seen = new Map<string, number>();
        for (const v of vs) {
          if (v['status'] === 'released') {
            seen.set(v['report_id'], (seen.get(v['report_id']) ?? 0) + 1);
            if (seen.get(v['report_id'])! > 1) throw pgError('23505', 'duplicate key value violates unique constraint "report_versions__one_released__uq"');
            if (v['released_at'] == null || v['release_basis'] == null || v['audiences'] == null) throw pgError('23514', 'report_versions__released__ck');
          }
          if (['rendered', 'released', 'superseded'].includes(v['status']) && (v['pdf_object_path'] == null || v['pdf_sha256'] == null || v['page_count'] == null)) throw pgError('23514', 'report_versions__pdf__ck');
        }
      }
      return res;
    },
  };
  return tx;
}

/** Runs fn like the request pipeline does: a failure rolls back every write made on the tx (rows and enqueued jobs). */
export async function atomically<T>(tx: any, fn: () => Promise<T>): Promise<T> {
  await tx.query('SAVEPOINT pipeline_tx', []);
  try { return await fn(); } catch (e) { await tx.query('ROLLBACK TO SAVEPOINT pipeline_tx', []); throw e; }
}

// ------------------------------------------------------------------------------------------------ the setup
export interface ReleaseWorldOpts extends WorldOpts {
  billing?: Parameters<typeof makeBilling>[0]; consent?: ConsentOpts; autoRelease?: 'when_eligible' | 'manual'; eventsFail?: Error;
  links?: Row[]; reportOver2?: Row;
}
const ctxBase = { tenant_id: TENANT_A, centre_id: I.centre, created_by: SYSTEM_ACTOR, updated_by: SYSTEM_ACTOR };
export function releaseSetup(o: ReleaseWorldOpts = {}) {
  const w = world({
    ...o,
    reportOver: { referrer_id: I.referrer, version: 5, first_released_at: null, final_released_at: null, patient_display_name: FULL_NAME, ...o.reportOver },
    extraSeed: {
      'reporting.settings': [{ ...ctxBase, id: idN(0x5e7), narrative_report_mode: 'separate', auto_release: o.autoRelease ?? 'when_eligible', print_critical_label: false }],
      'reporting.portal_links': o.links ?? [],
      ...o.extraSeed,
    },
  });
  const tx = ddlChecked(w.db);
  const billing = makeBilling(o.billing); const frontdesk = makeFrontdesk(o.consent);
  const ev = makeEvents(() => tx, o.eventsFail); const au = makeAudit(); const logs = makeLog();
  const ports = { billing: billing.port, frontdesk: frontdesk.port } as any;
  const report = () => w.db.all('reporting.reports').find((r) => r['id'] === LAB)!;
  const version = (n: number) => w.db.all('reporting.report_versions').find((v) => v['report_id'] === LAB && v['version_no'] === n)!;
  const links = () => w.db.all('reporting.portal_links');
  const jobs = (id: string) => w.db.jobs.filter((j) => j.identifier === id);
  return { ...w, tx, billing, frontdesk, published: ev.published, events: ev.events, audit: au.audit, accessLog: au.entries, logs, ports, report, version, links, jobs,
    /** handler ctx (API, user actor) */
    userCtx(over: Row = {}): any {
      return { tenantId: TENANT_A, actor: { type: 'user', id: USER, membershipId: MEMBERSHIP }, requestId: idN(0xf1), operationId: 'releaseReportVersion', clientIp: '203.0.113.9',
        tx, ports, events: ev.events, audit: au.audit, now: () => NOW, log: logs.log, ...over };
    },
    /** worker job ctx (system actor) */
    jobCtx(over: Row = {}): any {
      const c = makeCtx(w.db, { ports, logs }).ctx;
      return Object.assign(c, { tx, events: ev.events, audit: au.audit, ports, attempt: 1, maxAttempts: 10, ...over });
    },
    allText: () => JSON.stringify({ p: ev.published, j: w.db.jobs, a: au.entries, l: logs.text() }),
  };
}
export type RS = ReturnType<typeof releaseSetup>;

export const ifMatch = (n: number) => `"${n}"`;
export const rejection = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected rejection, got success'); };
/** Resolves to the thrown error or 'ok' (a missing module is re-thrown, so negative tests cannot pass just because the code does not exist yet). */
export const settle = (p: Promise<unknown>) => p.then(() => 'ok' as const, (e) => { if (e?.name === 'TaskLoadError') throw e; return e as Error; });

// ------------------------------------------------------------------------------------------------ released event vs the contract schema
/** The API's own compiled validator for contracts/events/reporting.report.released.v1.schema.json, applied to a full envelope built from what was published. */
export function releasedEventValid(p: Published, tenant = TENANT_A): boolean {
  const validate = eventValidators().get(EVENT)!;
  return validate({ event_id: idN(0xe9), event_type: EVENT, tenant_id: tenant, occurred_at: NOW, actor: { type: p.ctxActor?.type ?? 'system', id: p.ctxActor?.id ?? SYSTEM_ACTOR },
    idempotency_key: p.input.idempotencyKey, producer: 'reporting', aggregate: p.input.aggregate, request_id: idN(0xf1), payload: p.input.payload });
}
