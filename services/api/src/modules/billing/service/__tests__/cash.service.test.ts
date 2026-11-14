// BL-T08 cash sessions (B17 getMyCashSession / closeCashSession). Spec: 02-TRD §5 B17, §6.5 "Cash sessions"; 03-APP-FLOW §5 "Close: own open session only ...";
//   PRD US-BL-11.2 (close with counted 10,450.00 vs expected 10,500.00 -> variance -50.00, next payment opens a new session), US-BL-11.3; 05-SCHEMA billing.cash_sessions (open -> closed only).
// Fails now: ../cash.service.js does not exist.
// ASSUMED API (writer: object via a dispute if wrong):
//   cash.service.ts : createCashService(deps:{ repo }) -> { getMyCashSession(ctx), closeCashSession(ctx, { sessionId, expectedVersion, counted, note? }) }, both return a CashSessionDto
//     (snake_case, contracts/openapi billing.yaml): { id, opened_by:{membership_id,display_name}, centre_id, status, opened_at, closed_at?, rows:[{method_code,expected,counted?,variance?}], note?, version }.
//   display_name comes from IdentityPort.getActor(ctx) (own session only). expectedVersion = the If-Match number; undefined -> common.precondition_required.
//   open session: rows = live expected per method (Σ signed ledger rows of the session: payments, reversals, refunds), counted/variance absent.
//   close: expected per method = repo.sumLedgerBySession; counted from body (a method not counted = 0; a counted method with no ledger rows has expected 0);
//          per-row variance = counted - expected; billing.cash_sessions.variance_paisa = Σ variance of CASH methods only (is_cash, "variance = counted_cash - expected_cash", APP-FLOW §5);
//          repo.closeCashSession({expected,counted,variancePaisa,note,expectedVersion,closedAt: ctx.now()}); activity 'cash_session_closed'.
//   No repo getMyCashSession seam is assumed beyond: findOpenCashSession(tx,{tenantId,membershipId,centreId?}) - centreId is NOT known to B17 (GET has no params), so the
//   service may call repo.findOpenCashSession once per centre it knows OR a new repo fn; tests stub only through the t08 world, which resolves findOpenCashSession without centreId when centreId is omitted.
import { describe, expect, it } from 'vitest';
import { createBillingEvents } from '../../events/publish.js';
import { createCashService } from '../cash.service.js';
import { createLedgerService } from '../ledger.service.js';
import { BASE, errCode, IDS, makeLedgerWorld, MEMBERSHIP, money, npr, OTHER_MEMBER, OTHER_TENANT, TENANT_A, USER, V7, type LedgerWorld } from './t08.helpers.js';

const SESSION = V7('0000000d0001');
const OTHER_SESSION = V7('0000000d0002');
const identity = { getActor: async () => ({ displayName: 'Synthetic Cashier' }), getTenantSettings: async () => ({ numbering: { receiptNoPattern: 'RC-{fy}-{seq:6}' }, releaseRequiresPayment: true, timezone: 'Asia/Kathmandu' }) };
const ctxOf = (w: LedgerWorld, over: Record<string, unknown> = {}) => w.ctx({ ports: { IdentityPort: identity }, ...over });
const svcOf = (w: LedgerWorld) => createCashService({ repo: w.repo as never });
const open = (w: LedgerWorld, over: Record<string, unknown> = {}) => w.addSession({ id: SESSION, membership_id: MEMBERSHIP, ...over });
const row = (w: LedgerWorld, method: string, paisa: number, over: Record<string, unknown> = {}) =>
  w.addLedger({ id: V7(`0000000e${String(w.ledger().length + 1).padStart(4, '0')}`), cash_session_id: SESSION, method_code: method, amount_paisa: paisa, collected_by_membership_id: MEMBERSHIP, ...over });
const close = (w: LedgerWorld, ctx: never, over: Record<string, unknown> = {}) =>
  w.tx(() => svcOf(w).closeCashSession(ctx, { sessionId: SESSION, expectedVersion: 1, counted: [{ method_code: 'cash', amount_paisa: 0 }], ...over } as never) as Promise<any>);
const closeWrites = (w: LedgerWorld) => w.repoCalls.filter((c) => c.name === 'closeCashSession' || c.name === 'insertActivity');

describe('B17 getMyCashSession', () => {
  it('own open session -> CashSessionDto with live expected per method (payments minus reversals), no counted/variance, version', async () => {
    const w = makeLedgerWorld(); open(w);
    row(w, 'cash', 100000); row(w, 'cash', -30000, { entry_kind: 'reversal' }); row(w, 'card', 50000);
    const dto = await svcOf(w).getMyCashSession(ctxOf(w)) as any;
    expect(dto).toMatchObject({ id: SESSION, centre_id: IDS.centre, status: 'open', opened_at: BASE, version: 1, opened_by: { membership_id: MEMBERSHIP, display_name: expect.any(String) } });
    expect(dto.closed_at).toBeUndefined();
    const rows = Object.fromEntries(dto.rows.map((r: any) => [r.method_code, r]));
    expect(rows['cash'].expected).toEqual(money(70000)); expect(rows['card'].expected).toEqual(money(50000));
    for (const r of dto.rows) { expect(r.counted).toBeUndefined(); expect(r.variance).toBeUndefined(); }
    for (const k of ['tenant_id', 'membership_id', 'created_by', 'expected_jsonb']) expect(Object.keys(dto)).not.toContain(k);
  });
  it('no open session -> common.not_found; someone else\'s open session, a closed session and another tenant\'s session are never returned', async () => {
    const w = makeLedgerWorld();
    w.addSession({ id: OTHER_SESSION, membership_id: OTHER_MEMBER });
    w.addSession({ id: V7('0000000d0003'), membership_id: MEMBERSHIP, status: 'closed', closed_at: BASE, counted: [], expected: [], variance_paisa: 0, version: 2 });
    w.addSession({ id: V7('0000000d0004'), tenant_id: OTHER_TENANT, membership_id: MEMBERSHIP });
    expect((await errCode(Promise.resolve(svcOf(w).getMyCashSession(ctxOf(w))))).code).toBe('common.not_found');
  });
  it('ctx without tenantId / actor / tx -> auth.unauthenticated', async () => {
    const w = makeLedgerWorld();
    expect((await errCode(Promise.resolve(svcOf(w).getMyCashSession({} as never)))).code).toBe('auth.unauthenticated');
  });
});

describe('US-BL-11.2 close with variance', () => {
  it('expected cash 10,500.00, counted 10,450.00 -> closed, row variance -50.00, variance_paisa -5000, closed_at = now, version 2; stored expected/counted/note', async () => {
    const w = makeLedgerWorld(); open(w); row(w, 'cash', 1050000);
    const dto = await close(w, ctxOf(w) as never, { counted: [{ method_code: 'cash', amount_paisa: 1045000 }], note: 'two notes torn' });
    expect(dto).toMatchObject({ id: SESSION, status: 'closed', closed_at: BASE, version: 2, note: 'two notes torn' });
    expect(dto.rows).toEqual([{ method_code: 'cash', expected: money(1050000), counted: money(1045000), variance: money(-5000) }]);
    const call = w.repoCalls.find((c) => c.name === 'closeCashSession')!.args;
    expect(call).toMatchObject({ tenantId: TENANT_A, sessionId: SESSION, expectedVersion: 1, variancePaisa: -5000, note: 'two notes torn', closedAt: BASE, userId: USER });
    expect(w.sessions()[0]).toMatchObject({ status: 'closed', variance_paisa: -5000, version: 2 });
    expect(JSON.stringify(w.sessions()[0].expected)).toContain('1050000'); expect(JSON.stringify(w.sessions()[0].counted)).toContain('1045000');
  });
  it('multi-method: reversals reduce expected; an uncounted method counts as 0; an unexpected counted method has expected 0; variance_paisa is the CASH variance only', async () => {
    const w = makeLedgerWorld(); open(w);
    row(w, 'cash', 100000); row(w, 'cash', -30000, { entry_kind: 'reversal' }); row(w, 'card', 50000);
    const dto = await close(w, ctxOf(w) as never, { counted: [{ method_code: 'cash', amount_paisa: 70000 }, { method_code: 'wallet', amount_paisa: 1000 }] });
    const rows = Object.fromEntries(dto.rows.map((r: any) => [r.method_code, r]));
    expect(rows['cash']).toMatchObject({ expected: money(70000), counted: money(70000), variance: money(0) });
    expect(rows['card']).toMatchObject({ expected: money(50000), counted: money(0), variance: money(-50000) });
    expect(rows['wallet']).toMatchObject({ expected: money(0), counted: money(1000), variance: money(1000) });
    expect(w.sessions()[0].variance_paisa).toBe(0);
  });
  it('overage: counted above expected -> positive variance', async () => {
    const w = makeLedgerWorld(); open(w); row(w, 'cash', 10000);
    const dto = await close(w, ctxOf(w) as never, { counted: [{ method_code: 'cash', amount_paisa: 10500 }] });
    expect(dto.rows[0].variance).toEqual(money(500)); expect(w.sessions()[0].variance_paisa).toBe(500);
  });
  it('payments without a session (home_collection, B22 credit-party) never enter expected', async () => {
    const w = makeLedgerWorld(); open(w); row(w, 'cash', 10000);
    row(w, 'cash', 999900, { cash_session_id: null, capture_kind: 'home_collection' });
    row(w, 'cash', 888800, { cash_session_id: null, order_id: null, credit_party_id: V7('0000000f0001'), invoice_id: V7('000000a00009') });
    const dto = await close(w, ctxOf(w) as never, { counted: [{ method_code: 'cash', amount_paisa: 10000 }] });
    expect(dto.rows).toEqual([{ method_code: 'cash', expected: money(10000), counted: money(10000), variance: money(0) }]);
    expect(w.repoCalls.find((c) => c.name === 'sumLedgerBySession')!.args).toMatchObject({ tenantId: TENANT_A, sessionId: SESSION });
  });
  it('activity cash_session_closed: one row, tenant/actor from ctx, document = the session, centre set; money amounts only (no free text beyond the note)', async () => {
    const w = makeLedgerWorld(); open(w); row(w, 'cash', 10000);
    await close(w, ctxOf(w) as never, { counted: [{ method_code: 'cash', amount_paisa: 9000 }] });
    const rows = w.s.activity.filter((a: any) => a.action === 'cash_session_closed');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tenant_id: TENANT_A, centre_id: IDS.centre, document_id: SESSION, actor_id: USER, actor_membership_id: MEMBERSHIP });
  });
  it('the next payment after the close opens a NEW session (service-level integration with recordPayment)', async () => {
    const w = makeLedgerWorld(); await w.seedBalance();
    const ledger = createLedgerService({ repo: w.repo as never, counter: w.counter as never, events: createBillingEvents(w.events) as never });
    const ctx = ctxOf(w) as never;
    const pay = (key: string) => w.tx(() => ledger.recordPayment(ctx, { orderId: IDS.order, methodCode: 'cash', amount: npr(10000), captureKind: 'manual', idempotencyKey: key, issueReceiptNo: false } as never) as Promise<any>);
    await pay('a'); const first = w.sessions()[0];
    await w.tx(() => svcOf(w).closeCashSession(ctx, { sessionId: first.id, expectedVersion: 1, counted: [{ method_code: 'cash', amount_paisa: 10000 }] } as never) as Promise<any>);
    await pay('b');
    expect(w.sessions()).toHaveLength(2);
    expect(w.sessions()[1]).toMatchObject({ status: 'open' }); expect(w.sessions()[1].id).not.toBe(first.id);
    expect(w.ledger()[1].cash_session_id).toBe(w.sessions()[1].id); expect(w.ledger()[0].cash_session_id).toBe(first.id);
  });
});

describe('close: guards (TRD B17 errors; cash_sessions lifecycle open -> closed only)', () => {
  it('already closed -> common.immutable_record, nothing written', async () => {
    const w = makeLedgerWorld(); open(w, { status: 'closed', closed_at: BASE, counted: [], expected: [], variance_paisa: 0, version: 2 });
    const e = await errCode(close(w, ctxOf(w) as never, { expectedVersion: 2 }));
    expect(e.code).toBe('common.immutable_record'); expect(closeWrites(w)).toEqual([]);
  });
  it('closing a session twice (second call) -> common.immutable_record; the stored variance is untouched', async () => {
    const w = makeLedgerWorld(); open(w); row(w, 'cash', 10000);
    await close(w, ctxOf(w) as never, { counted: [{ method_code: 'cash', amount_paisa: 9000 }] });
    expect((await errCode(close(w, ctxOf(w) as never, { expectedVersion: 2, counted: [{ method_code: 'cash', amount_paisa: 10000 }] }))).code).toBe('common.immutable_record');
    expect(w.sessions()[0].variance_paisa).toBe(-1000);
  });
  it('another user\'s session -> auth.forbidden (not own), nothing written', async () => {
    const w = makeLedgerWorld(); open(w, { membership_id: OTHER_MEMBER });
    const e = await errCode(close(w, ctxOf(w) as never));
    expect(e.code).toBe('auth.forbidden'); expect(closeWrites(w)).toEqual([]); expect(w.sessions()[0].status).toBe('open');
  });
  it('unknown session id and another tenant\'s session -> common.not_found (no existence leak across tenants)', async () => {
    const w = makeLedgerWorld(); w.addSession({ id: SESSION, tenant_id: OTHER_TENANT, membership_id: MEMBERSHIP });
    expect((await errCode(close(w, ctxOf(w) as never))).code).toBe('common.not_found');
    expect((await errCode(close(w, ctxOf(w) as never, { sessionId: V7('0000000d00ff') }))).code).toBe('common.not_found');
    expect(w.sessions()[0].status).toBe('open');
  });
  it('If-Match absent -> common.precondition_required; stale version -> common.version_conflict; both write nothing', async () => {
    const w = makeLedgerWorld(); open(w);
    expect((await errCode(close(w, ctxOf(w) as never, { expectedVersion: undefined }))).code).toBe('common.precondition_required');
    expect((await errCode(close(w, ctxOf(w) as never, { expectedVersion: 7 }))).code).toBe('common.version_conflict');
    expect(w.sessions()[0]).toMatchObject({ status: 'open', version: 1 }); expect(w.s.activity).toHaveLength(0);
  });
  it('a concurrent change between read and write (repo.closeCashSession returns nothing) -> common.version_conflict, no activity row', async () => {
    const w = makeLedgerWorld(); open(w);
    (w.repo as any).closeCashSession = async () => undefined;
    expect((await errCode(close(w, ctxOf(w) as never))).code).toBe('common.version_conflict');
    expect(w.s.activity).toHaveLength(0);
  });
});

describe('close: input validation (fail closed, before any write)', () => {
  const ok = { method_code: 'cash', amount_paisa: 100 };
  const BAD: Array<[string, Record<string, unknown>]> = [
    ['sessionId not a uuid', { sessionId: 'abc' }], ['counted missing', { counted: undefined }], ['counted not an array', { counted: 'cash' }],
    ['21 counted rows', { counted: Array.from({ length: 21 }, (_, i) => ({ method_code: `m${i}`, amount_paisa: 1 })) }],
    ['duplicate method rows', { counted: [ok, ok] }], ['negative amount', { counted: [{ ...ok, amount_paisa: -1 }] }], ['fractional amount', { counted: [{ ...ok, amount_paisa: 1.5 }] }],
    ['string amount', { counted: [{ ...ok, amount_paisa: '100' }] }], ['amount above 2^53-1', { counted: [{ ...ok, amount_paisa: 2 ** 53 }] }],
    ['method_code empty', { counted: [{ ...ok, method_code: '' }] }], ['row not an object', { counted: [null] }],
    ['note over 500 chars', { note: 'x'.repeat(501) }], ['note not a string', { note: 5 }], ['expectedVersion 0', { expectedVersion: 0 }], ['expectedVersion fractional', { expectedVersion: 1.5 }],
  ];
  for (const [name, over] of BAD) {
    it(`${name} -> common.validation_failed, no close, no activity`, async () => {
      const w = makeLedgerWorld(); open(w); row(w, 'cash', 100);
      const raw = { sessionId: SESSION, expectedVersion: 1, counted: [ok], ...over } as Record<string, unknown>;
      for (const k of Object.keys(raw)) if (raw[k] === undefined) delete raw[k];
      const e = await errCode(w.tx(() => svcOf(w).closeCashSession(ctxOf(w) as never, raw as never) as Promise<unknown>));
      expect(e.code).toBe('common.validation_failed'); expect(closeWrites(w)).toEqual([]);
    });
  }
  it('boundaries accepted: 20 counted rows, note of 500 chars, amount 0', async () => {
    const w = makeLedgerWorld(); open(w);
    const counted = Array.from({ length: 20 }, (_, i) => ({ method_code: i === 0 ? 'cash' : `m${i}`, amount_paisa: 0 }));
    const dto = await close(w, ctxOf(w) as never, { counted, note: 'n'.repeat(500) });
    expect(dto.status).toBe('closed');
  });
  it('ctx without tenantId / actor / tx -> auth.unauthenticated', async () => {
    const w = makeLedgerWorld(); open(w);
    expect((await errCode(Promise.resolve(svcOf(w).closeCashSession({} as never, { sessionId: SESSION, expectedVersion: 1, counted: [] } as never)))).code).toBe('auth.unauthenticated');
  });
  it('every repo call is scoped to the caller tenant', async () => {
    const w = makeLedgerWorld(); open(w); row(w, 'cash', 100);
    await close(w, ctxOf(w) as never, { counted: [{ method_code: 'cash', amount_paisa: 100 }] });
    for (const c of w.repoCalls) expect(c.args.tenantId ?? c.args.tenant_id, c.name).toBe(TENANT_A);
  });
});
