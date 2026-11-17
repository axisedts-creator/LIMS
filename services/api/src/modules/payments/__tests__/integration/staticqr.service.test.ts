// PG-T16 (C15) — static-QR worksheet, operations P17–P19 (02-TRD §5 rows P17–P19, §6.8; 05-SCHEMA payments.static_qr_reconciliations;
// 01-PRD US-PG-12 = AC-PG-12.2 (preview from billing.v_pub_payment_collection [CR-C15-009], difference, stored row, note when difference <> 0) and AC-PG-12.3
// (the worksheet never touches the ledger / never implies verification); 07-SECURITY REQ-SEC-046 (no server-computable value from the client), D-112 (row audit, no access log)).
// Seam (the spec fixes the FILE only; names below are the tester's contract — the writer may dispute via .orchestra/cr):
//   service/staticqr.service.ts  export function createStaticQrService(deps?: { newId?: () => string })
//     listStaticQrReconciliations(ctx, query?)  -> { data: StaticQrReconDto[], page: { limit, next_cursor? } }      query: business_date_from/_to, centre_id, cursor, limit
//     previewStaticQrReconciliation(ctx, query) -> { business_date, centre_id?, system_entries, system_total: Money }  query: business_date (required), centre_id?
//     createStaticQrReconciliation(ctx, body)   -> StaticQrReconDto                                                    body: { business_date, centre_id?, statement_total_paisa, statement_reference, note? }
//   Money = { amount_paisa, currency: 'NPR' } (same as reconciliation.service.ts); difference = statement_total - system_total is signed.
//   ctx = { tenantId, actor, tx: { query }, audit, ports, now() }; SQL stays in the dialect of helpers/staticQrDb.ts. Errors are LimsError:
//   common.validation_failed (also: note required when difference <> 0), payments.static_qr_already_reconciled, common.invalid_cursor, auth.forbidden.
//   [CONV] pinned here: list is newest business_date first (like P12); the centre filter returns rows of exactly that centre; a whitespace-only note is no note.
//   Permission (payments.reconciliation.read / payments.intent.resolve) and the Idempotency-Key header are the core pipeline's job, not the service's.
import { describe, expect, it } from 'vitest';
import { isLimsError } from '../../../../core/errors.js';
import { createStaticQrService } from '../../service/staticqr.service.js';
import { CENTRE_1, CENTRE_2, CENTRE_B, OTHER_USER, TENANT_A, TENANT_B, USER, makeStaticQrDb, viewRow, type StaticQrDb, type ViewRow } from '../helpers/staticQrDb.js';

type Svc = Record<string, (ctx: any, input?: any) => Promise<any>>;
const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/;
const D = '2026-11-10';
const money = (n: number) => ({ amount_paisa: n, currency: 'NPR' });
const wid = (n: number): string => `01930000-0000-7000-8000-${String(n + 100).padStart(12, '0')}`;

// Day D, Fonepay QR: 3 entries / 300 000 (centre 1, collector USER) + 2 entries / 150 000 (centre 2, gateway-less collector) = 5 / 450 000.
// Everything else must be ignored: other method, other days, other tenant, 'fonepay' (the blocked gateway code is not 'fonepay_qr').
const seedView = (): ViewRow[] => [
  viewRow({ business_date: D, payment_method_code: 'fonepay_qr', entries: 3, net_collected_paisa: 300_000, centre_id: CENTRE_1 }),
  viewRow({ business_date: D, payment_method_code: 'fonepay_qr', entries: 2, net_collected_paisa: 150_000, centre_id: CENTRE_2, collected_by_membership_id: null }),
  viewRow({ business_date: D, payment_method_code: 'cash', entries: 9, net_collected_paisa: 999_000 }),
  viewRow({ business_date: D, payment_method_code: 'esewa', entries: 4, net_collected_paisa: 777_000, collected_by_membership_id: null }),
  viewRow({ business_date: D, payment_method_code: 'fonepay', entries: 1, net_collected_paisa: 11_000 }),
  viewRow({ business_date: '2026-11-09', payment_method_code: 'fonepay_qr', entries: 7, net_collected_paisa: 555_000 }),
  viewRow({ business_date: '2026-11-11', payment_method_code: 'fonepay_qr', entries: 6, net_collected_paisa: 444_000 }),
  viewRow({ business_date: D, payment_method_code: 'fonepay_qr', entries: 8, net_collected_paisa: 888_000, tenant_id: TENANT_B, centre_id: CENTRE_B }),
];
const setup = (o: { view?: ViewRow[]; worksheets?: Record<string, any>[]; newId?: () => string } = {}) => {
  const db = makeStaticQrDb({ view: o.view ?? seedView() });
  for (const w of o.worksheets ?? []) db.putWorksheet(w);
  const svc = createStaticQrService(o.newId ? { newId: o.newId } : undefined) as unknown as Svc;
  return { db, svc };
};
type S = ReturnType<typeof setup>;
const preview = ({ db, svc }: S, q: object, o: { tenantId?: string } = {}) => db.run((ctx) => svc['previewStaticQrReconciliation']!(ctx, q), o);
const create = ({ db, svc }: S, body: object, o: { tenantId?: string; rollback?: boolean; actor?: Record<string, any> } = {}) => db.run((ctx) => svc['createStaticQrReconciliation']!(ctx, body), o);
const list = ({ db, svc }: S, q?: object, o: { tenantId?: string } = {}) => db.run((ctx) => svc['listStaticQrReconciliations']!(ctx, q), o);
const body = (extra: object = {}) => ({ business_date: D, statement_total_paisa: 450_000, statement_reference: 'FP-STMT-2026-11-10', ...extra });

const rejection = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { expect(e, `crash: ${(e as Error)?.message}`).not.toBeInstanceOf(TypeError); return e; } throw new Error('expected rejection, got success'); };
const invalid = async (p: Promise<unknown>, path?: string): Promise<void> => {
  const e = await rejection(p);
  expect(isLimsError(e, 'common.validation_failed'), `got ${(e as any).code ?? (e as Error).message}`).toBe(true);
  if (path) expect((e as any).errors?.map((f: any) => f.path)).toContain(path);
};
const code = async (p: Promise<unknown>): Promise<string> => { const e = await rejection(p); return (e as any).code ?? `RAW:${(e as Error).message}`; };

describe('P18 previewStaticQrReconciliation — AC-PG-12.2 system total from billing.v_pub_payment_collection', () => {
  it('sums net_collected_paisa and entries of method fonepay_qr for the business date across collectors and centres; nothing else', async () => {
    const r = await preview(setup(), { business_date: D });
    expect(r).toEqual({ business_date: D, system_entries: 5, system_total: money(450_000) });
    expect(typeof r.system_entries).toBe('number');                                  // SUM() comes back as a string from node-pg
    expect(r).not.toHaveProperty('centre_id');
  });
  it('centre filter narrows to that centre and echoes it', async () => {
    const s = setup();
    expect(await preview(s, { business_date: D, centre_id: CENTRE_1 })).toEqual({ business_date: D, centre_id: CENTRE_1, system_entries: 3, system_total: money(300_000) });
    expect(await preview(s, { business_date: D, centre_id: CENTRE_2 })).toEqual({ business_date: D, centre_id: CENTRE_2, system_entries: 2, system_total: money(150_000) });
  });
  it('uses the NET figure: reversals and refunds reduce the total (view rule), gross is not used', async () => {
    const view = [viewRow({ business_date: D, payment_method_code: 'fonepay_qr', entries: 4, reversals: 1, gross_collected_paisa: 500_000, reversed_paisa: 120_000, net_collected_paisa: 380_000 })];
    expect(await preview(setup({ view }), { business_date: D })).toMatchObject({ system_entries: 4, system_total: money(380_000) });
  });
  it('a date without fonepay_qr entries previews 0 / 0 (not null, not NaN, not an error)', async () => {
    const r = await preview(setup(), { business_date: '2026-01-01' });
    expect(r).toEqual({ business_date: '2026-01-01', system_entries: 0, system_total: money(0) });
  });
  it('is tenant scoped: tenant B sees only its own rows and the query itself carries the tenant predicate (TRD §6.8)', async () => {
    const s = setup();
    expect(await preview(s, { business_date: D }, { tenantId: TENANT_B })).toMatchObject({ system_entries: 8, system_total: money(888_000) });
    const viewStmt = s.db.stmts.find((x) => /v_pub_payment_collection/i.test(x.text))!;
    expect(viewStmt.text).toMatch(/tenant_id/i);
    expect(viewStmt.values).toContain(TENANT_B);
  });
  it('is read only: no worksheet row, no access-log row, no port call', async () => {
    const s = setup();
    await preview(s, { business_date: D });
    expect(s.db.worksheets()).toEqual([]); expect(s.db.access).toEqual([]);
    expect(s.db.stmts.every((x) => /^\s*select/i.test(x.text))).toBe(true);
  });
  it.each([
    ['missing business_date', {}], ['business_date null', { business_date: null }], ['not a date', { business_date: 'yesterday' }], ['impossible date', { business_date: '2026-02-30' }],
    ['unpadded date', { business_date: '2026-1-1' }], ['timestamp instead of date', { business_date: '2026-11-10T00:00:00Z' }], ['date as number', { business_date: 20261110 }],
    ['centre_id not a uuid', { business_date: D, centre_id: 'c1' }], ['centre_id v4 uuid', { business_date: D, centre_id: '4e6c5b3a-6f0d-4f0e-9a3b-1c2d3e4f5a6b' }],
    ['tenant_id smuggled in', { business_date: D, tenant_id: TENANT_B }], ['method override', { business_date: D, payment_method_code: 'cash' }], ['unknown key', { business_date: D, foo: 1 }],
    ['array body', [D]], ['SQL in the date', { business_date: `${D}' OR '1'='1` }], ['SQL in the centre', { business_date: D, centre_id: `${CENTRE_1}' OR '1'='1` }],
  ])('rejects %s with common.validation_failed before touching the database', async (_n, q) => {
    const s = setup();
    await invalid(preview(s, q as object));
    expect(s.db.stmts).toHaveLength(0);
  });
  it('values reach the database only as bound parameters (no date / centre / tenant text inside the SQL)', async () => {
    const s = setup();
    await preview(s, { business_date: D, centre_id: CENTRE_1 });
    for (const st of s.db.stmts) { expect(st.text).not.toContain(D); expect(st.text).not.toContain(CENTRE_1); expect(st.text).not.toContain(TENANT_A); }
  });
});

describe('P19 createStaticQrReconciliation — AC-PG-12.2 stored worksheet, difference, note rule', () => {
  it('statement equals system: stores a matched worksheet with the server-computed system figures', async () => {
    const s = setup({ newId: () => wid(1) });
    const r = await create(s, body());
    expect(r).toEqual({ id: wid(1), business_date: D, system_entries: 5, system_total: money(450_000), statement_total: money(450_000), difference: money(0),
      statement_reference: 'FP-STMT-2026-11-10', status: 'matched', reconciled_by: USER, created_at: expect.stringMatching(ISO) });
    expect(r.created_at).toBe('2026-11-11T06:00:00.000Z');
    const [row] = s.db.worksheets();
    expect(s.db.worksheets()).toHaveLength(1);
    expect(row).toMatchObject({ id: wid(1), tenant_id: TENANT_A, centre_id: null, system_entries: 5, system_total_paisa: 450_000, statement_total_paisa: 450_000, difference_paisa: 0,
      status: 'matched', statement_reference: 'FP-STMT-2026-11-10', reconciled_by: USER, created_by: USER, updated_by: USER });
    expect(String(row!['business_date']).slice(0, 10)).toBe(D);
  });
  it('mints a uuidv7 id by itself when no newId is injected', async () => {
    const s = setup();
    expect((await create(s, body())).id).toMatch(UUIDV7);
  });
  it('a statement lower than the system total: accepted_with_difference with the note, difference negative', async () => {
    const s = setup();
    const r = await create(s, body({ statement_total_paisa: 440_000, note: 'Bank fee 100.00 netted by the acquirer' }));
    expect(r).toMatchObject({ status: 'accepted_with_difference', statement_total: money(440_000), system_total: money(450_000), difference: money(-10_000), note: 'Bank fee 100.00 netted by the acquirer' });
    expect(s.db.worksheets()[0]).toMatchObject({ difference_paisa: -10_000, status: 'accepted_with_difference', note: 'Bank fee 100.00 netted by the acquirer' });
  });
  it('a statement higher than the system total: difference positive', async () => {
    const r = await create(setup(), body({ statement_total_paisa: 475_000, note: 'Entry missing in the ledger, see C4' }));
    expect(r).toMatchObject({ status: 'accepted_with_difference', difference: money(25_000) });
  });
  it('a non-zero difference without a note is refused and stores nothing (note missing / empty / blank / null)', async () => {
    for (const note of [undefined, '', '   ', '\n\t', null]) {
      const s = setup();
      await invalid(create(s, body({ statement_total_paisa: 440_000, ...(note === undefined ? {} : { note }) })), 'note');
      expect(s.db.worksheets()).toEqual([]);
    }
  });
  it('a matched worksheet needs no note; an optional note is kept', async () => {
    expect((await create(setup(), body())).note).toBeUndefined();
    expect((await create(setup(), body({ note: 'Totals agree' }))).note).toBe('Totals agree');
  });
  it('note length: 1000 characters accepted, 1001 refused', async () => {
    expect(await create(setup(), body({ statement_total_paisa: 1, note: 'n'.repeat(1000) }))).toMatchObject({ status: 'accepted_with_difference' });
    await invalid(create(setup(), body({ statement_total_paisa: 1, note: 'n'.repeat(1001) })), 'note');
    await invalid(create(setup(), body({ note: 1001 })), 'note');
  });
  it('statement_reference: required, 1…100 characters', async () => {
    expect(await create(setup(), body({ statement_reference: 'R' }))).toMatchObject({ statement_reference: 'R' });
    expect(await create(setup(), body({ statement_reference: 'r'.repeat(100) }))).toMatchObject({ status: 'matched' });
    for (const bad of [undefined, '', 'r'.repeat(101), 5, null]) {
      const s = setup();
      await invalid(create(s, { business_date: D, statement_total_paisa: 450_000, ...(bad === undefined ? {} : { statement_reference: bad }) }), 'statement_reference');
      expect(s.db.worksheets()).toEqual([]);
    }
  });
  it('statement_total_paisa: 0 is a valid figure (a day with no QR money) and is matched against an empty system total', async () => {
    const r = await create(setup(), body({ business_date: '2026-01-01', statement_total_paisa: 0 }));
    expect(r).toMatchObject({ status: 'matched', system_entries: 0, system_total: money(0), statement_total: money(0), difference: money(0) });
    await invalid(create(setup(), body({ statement_total_paisa: 0 })), 'note');                                  // 0 against 450 000 is a difference
  });
  it.each([
    ['negative', -1], ['fraction', 1.5], ['numeric string', '450000'], ['NaN', Number.NaN], ['Infinity', Number.POSITIVE_INFINITY], ['above the safe integer range', Number.MAX_SAFE_INTEGER + 2],
    ['null', null], ['boolean', true], ['object', { amount_paisa: 1 }], ['array', [450_000]], ['money-looking string', 'NPR 4500.00'],
  ])('statement_total_paisa %s is refused', async (_n, v) => {
    const s = setup();
    await invalid(create(s, body({ statement_total_paisa: v })), 'statement_total_paisa');
    expect(s.db.worksheets()).toEqual([]);
  });
  it('statement_total_paisa missing is refused', async () => {
    await invalid(create(setup(), { business_date: D, statement_reference: 'X' }), 'statement_total_paisa');
  });
  it.each([
    ['missing business_date', { statement_total_paisa: 1, statement_reference: 'X' }], ['impossible date', body({ business_date: '2026-13-01' })], ['unpadded date', body({ business_date: '2026-1-10' })],
    ['timestamp', body({ business_date: `${D}T00:00:00Z` })], ['centre_id not uuid', body({ centre_id: 'centre-1' })], ['centre_id empty string', body({ centre_id: '' })],
  ])('%s is refused with common.validation_failed and nothing is written', async (_n, b) => {
    const s = setup();
    await invalid(create(s, b as object));
    expect(s.db.worksheets()).toEqual([]);
  });
  it.each([
    'system_total', 'system_total_paisa', 'system_entries', 'difference', 'difference_paisa', 'status', 'reconciled_by', 'tenant_id', 'id', 'created_by', 'version', 'payment_method_code', 'is_active',
  ])('a client-supplied %s is refused — only the bank-statement figure may come from the caller (REQ-SEC-046, CR-C15-012)', async (key) => {
    const s = setup();
    const v = key === 'status' ? 'matched' : key.includes('by') || key === 'tenant_id' || key === 'id' ? OTHER_USER : 1;
    await invalid(create(s, body({ [key]: v })), key);
    expect(s.db.worksheets()).toEqual([]);
  });
  it('the system figures are read at save time inside the same transaction, never taken from the earlier preview', async () => {
    const s = setup();
    expect((await preview(s, { business_date: D })).system_total).toEqual(money(450_000));
    s.db.addView(viewRow({ business_date: D, payment_method_code: 'fonepay_qr', entries: 1, net_collected_paisa: 50_000 }));        // C4 posted one more entry meanwhile
    await invalid(create(s, body()), 'note');                                                                                       // 450 000 no longer matches 500 000
    const r = await create(s, body({ statement_total_paisa: 450_000, note: 'Statement printed before the last entry' }));
    expect(r).toMatchObject({ system_entries: 6, system_total: money(500_000), difference: money(-50_000), status: 'accepted_with_difference' });
  });
  it('with centre_id: the system figures are that centre\'s and the DTO carries centre_id', async () => {
    const s = setup();
    const r = await create(s, body({ centre_id: CENTRE_1, statement_total_paisa: 300_000 }));
    expect(r).toMatchObject({ centre_id: CENTRE_1, system_entries: 3, system_total: money(300_000), status: 'matched' });
    expect(s.db.worksheets()[0]).toMatchObject({ centre_id: CENTRE_1, system_total_paisa: 300_000 });
  });
  it('system figures count only this tenant\'s fonepay_qr rows of the date (other tenant / method / days excluded)', async () => {
    const s = setup();
    await invalid(create(s, body({ statement_total_paisa: 450_000 + 888_000 })), 'note');
    expect(await create(s, body({ statement_total_paisa: 888_000 }), { tenantId: TENANT_B })).toMatchObject({ system_entries: 8, system_total: money(888_000), status: 'matched' });
  });
  it('the DTO exposes exactly the StaticQrReconDto fields (no tenant, version, audit columns)', async () => {
    const r = await create(setup(), body({ note: 'ok' }));
    expect(Object.keys(r).sort()).toEqual(['business_date', 'created_at', 'difference', 'id', 'note', 'reconciled_by', 'statement_reference', 'statement_total', 'status', 'system_entries', 'system_total'].sort());
  });
  it('the persisted audit columns come from the actor (membership id for a user)', async () => {
    const s = setup();
    await create(s, body(), { actor: { type: 'user', id: OTHER_USER, membershipId: OTHER_USER } });
    expect(s.db.worksheets()[0]).toMatchObject({ reconciled_by: OTHER_USER, created_by: OTHER_USER, updated_by: OTHER_USER });
  });
});

describe('P19 one worksheet per (tenant, business_date, centre or all) — payments.static_qr_already_reconciled', () => {
  it('a second worksheet for the same date and "all centres" is refused with 409 and changes nothing', async () => {
    const s = setup();
    const first = await create(s, body());
    expect(await code(create(s, body({ statement_reference: 'SECOND' })))).toBe('payments.static_qr_already_reconciled');
    expect(await code(create(s, body({ statement_total_paisa: 1, note: 'again' })))).toBe('payments.static_qr_already_reconciled');
    expect(s.db.worksheets()).toHaveLength(1);
    expect(s.db.worksheets()[0]).toMatchObject({ id: first.id, statement_reference: 'FP-STMT-2026-11-10' });
  });
  it('the same date and the same centre twice is refused; another centre, another date, "all", another tenant are free', async () => {
    const s = setup();
    await create(s, body({ centre_id: CENTRE_1, statement_total_paisa: 300_000 }));
    expect(await code(create(s, body({ centre_id: CENTRE_1, statement_total_paisa: 300_000 })))).toBe('payments.static_qr_already_reconciled');
    await create(s, body({ centre_id: CENTRE_2, statement_total_paisa: 150_000 }));
    await create(s, body());                                                                  // "all centres" next to the per-centre rows
    await create(s, body({ business_date: '2026-11-09', statement_total_paisa: 555_000 }));
    await create(s, body({ statement_total_paisa: 888_000 }), { tenantId: TENANT_B });
    expect(s.db.worksheets()).toHaveLength(4); expect(s.db.worksheets(TENANT_B)).toHaveLength(1);
  });
  it('two simultaneous saves of the same date: exactly one stored, the other gets the 409 (never a raw database error)', async () => {
    const s = setup();
    const res = await Promise.allSettled([create(s, body()), create(s, body({ statement_reference: 'RIVAL' }))]);
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = res.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(isLimsError(lost.reason, 'payments.static_qr_already_reconciled'), String(lost.reason?.message)).toBe(true);
    expect(s.db.worksheets()).toHaveLength(1);
  });
  it('a stored worksheet of the date is detected even if it was written by another membership', async () => {
    const s = setup({ worksheets: [{ id: wid(9), business_date: D, centre_id: null, system_entries: 5, system_total_paisa: 450_000, statement_total_paisa: 450_000, statement_reference: 'OLD', status: 'matched', reconciled_by: OTHER_USER }] });
    expect(await code(create(s, body()))).toBe('payments.static_qr_already_reconciled');
  });
});

describe('P19 safety — centre ownership, actor, ledger untouched (AC-PG-12.3)', () => {
  it('a centre that does not exist for the tenant (or belongs to another tenant) is a handled error, not a raw FK failure, and stores nothing', async () => {
    for (const centre_id of [CENTRE_B, '01930000-0000-7000-8000-0000000000ff']) {
      const s = setup();
      const c = await code(create(s, body({ centre_id })));
      expect(['common.validation_failed', 'common.not_found'], c).toContain(c);
      expect(s.db.worksheets()).toEqual([]);
    }
  });
  it('a patient / device actor is refused before any state is read', async () => {
    for (const type of ['patient', 'device', 'agent', undefined]) {
      const s = setup();
      expect(await code(create(s, body(), { actor: { type, id: USER } }))).toBe('auth.forbidden');
      expect(s.db.stmts).toHaveLength(0);
    }
  });
  it('a system actor may save (reconciled_by falls back to the actor id)', async () => {
    const s = setup();
    const r = await create(s, body(), { actor: { type: 'system', id: OTHER_USER } });
    expect(r.reconciled_by).toBe(OTHER_USER);
  });
  it('writes only to payments.static_qr_reconciliations: no ledger write, no BillingPort/FrontdeskPort call, no access-log row (row audit only, D-112)', async () => {
    const s = setup();
    await create(s, body({ statement_total_paisa: 440_000, note: 'diff' }));
    const writes = s.db.stmts.filter((x) => !/^\s*select/i.test(x.text));
    expect(writes).toHaveLength(1);
    expect(writes[0]!.text).toMatch(/insert\s+into\s+payments\.static_qr_reconciliations/i);
    expect(s.db.stmts.some((x) => /billing\.ledger|billing\.payments|update\s+billing|insert\s+into\s+billing/i.test(x.text))).toBe(false);
    expect(s.db.access).toEqual([]);
  });
  it('never inserts the generated difference column (the database computes it)', async () => {
    const s = setup();
    await create(s, body());
    expect(s.db.stmts.filter((x) => /insert/i.test(x.text)).every((x) => !/difference_paisa/i.test(x.text))).toBe(true);
  });
  it('values reach the database only as bound parameters (note / reference with quotes cannot break out)', async () => {
    const s = setup();
    const evil = `x'); DROP TABLE payments.static_qr_reconciliations; --`;
    const r = await create(s, body({ statement_reference: evil.slice(0, 100), statement_total_paisa: 1, note: evil }));
    expect(r.note).toBe(evil);
    for (const st of s.db.stmts) { expect(st.text).not.toContain('DROP TABLE'); expect(st.text).not.toContain(D); }
  });
  it('a refused request rolls nothing forward: rejected note rule leaves the unique slot free for a correct retry', async () => {
    const s = setup();
    await invalid(create(s, body({ statement_total_paisa: 440_000 })), 'note');
    expect(await create(s, body({ statement_total_paisa: 440_000, note: 'second try with note' }))).toMatchObject({ status: 'accepted_with_difference' });
  });
});

describe('P17 listStaticQrReconciliations', () => {
  const ws = (n: number, date: string, o: Record<string, any> = {}) => ({ id: wid(n), business_date: date, centre_id: null, system_entries: 2, system_total_paisa: 1000, statement_total_paisa: 1000,
    statement_reference: `REF-${n}`, status: 'matched', ...o });
  const three = () => [
    ws(1, '2026-11-08'),
    ws(2, '2026-11-09', { centre_id: CENTRE_1, statement_total_paisa: 900, status: 'accepted_with_difference', note: 'fee' }),
    ws(3, '2026-11-10'),
    { ...ws(4, '2026-11-10'), tenant_id: TENANT_B },
  ];
  it('returns this tenant\'s worksheets newest business date first, with the StaticQrReconDto shape', async () => {
    const r = await list(setup({ worksheets: three() }));
    expect(r.data.map((x: any) => x.id)).toEqual([wid(3), wid(2), wid(1)]);
    expect(r.page).toEqual({ limit: 50 });
    expect(r.data[1]).toEqual({ id: wid(2), business_date: '2026-11-09', centre_id: CENTRE_1, system_entries: 2, system_total: money(1000), statement_total: money(900), difference: money(-100),
      statement_reference: 'REF-2', status: 'accepted_with_difference', note: 'fee', reconciled_by: USER, created_at: '2026-11-11T06:00:00.000Z' });
    expect(r.data[0]).not.toHaveProperty('centre_id'); expect(r.data[0]).not.toHaveProperty('note');
    expect(r.data.every((x: any) => typeof x.difference.amount_paisa === 'number' && typeof x.system_entries === 'number')).toBe(true);   // bigint columns arrive as strings
  });
  it('is tenant isolated and read only', async () => {
    const s = setup({ worksheets: three() });
    expect((await list(s, undefined, { tenantId: TENANT_B })).data.map((x: any) => x.id)).toEqual([wid(4)]);
    expect(s.db.stmts.every((x) => /^\s*select/i.test(x.text))).toBe(true);
  });
  it('filters: date range is inclusive, centre_id returns that centre\'s rows only', async () => {
    const s = setup({ worksheets: three() });
    expect((await list(s, { business_date_from: '2026-11-09', business_date_to: '2026-11-09' })).data.map((x: any) => x.id)).toEqual([wid(2)]);
    expect((await list(s, { business_date_from: '2026-11-09' })).data.map((x: any) => x.id)).toEqual([wid(3), wid(2)]);
    expect((await list(s, { business_date_to: '2026-11-08' })).data.map((x: any) => x.id)).toEqual([wid(1)]);
    expect((await list(s, { centre_id: CENTRE_1 })).data.map((x: any) => x.id)).toEqual([wid(2)]);
    expect((await list(s, { centre_id: CENTRE_2 })).data).toEqual([]);
  });
  it('keyset pagination: limit 2 of 3 gives a cursor, the next page the rest, no row twice', async () => {
    const s = setup({ worksheets: three() });
    const p1 = await list(s, { limit: 2 });
    expect(p1.data).toHaveLength(2); expect(typeof p1.page.next_cursor).toBe('string'); expect(p1.page.limit).toBe(2);
    const p2 = await list(s, { limit: 2, cursor: p1.page.next_cursor });
    expect(p2.data.map((x: any) => x.id)).toEqual([wid(1)]); expect(p2.page.next_cursor).toBeUndefined();
    expect([...p1.data, ...p2.data].map((x: any) => x.id)).toEqual([wid(3), wid(2), wid(1)]);
  });
  it.each([
    ['limit 0', { limit: 0 }], ['limit 201', { limit: 201 }], ['limit text', { limit: 'ten' }], ['bad from date', { business_date_from: '2026-02-30' }], ['bad to date', { business_date_to: 'x' }],
    ['bad centre_id', { centre_id: 'c1' }], ['unknown key', { status: 'matched' }], ['tenant_id smuggled', { tenant_id: TENANT_B }],
  ])('rejects %s with common.validation_failed', async (_n, q) => {
    await invalid(list(setup({ worksheets: three() }), q as object));
  });
  it('a garbage or foreign cursor is common.invalid_cursor', async () => {
    const s = setup({ worksheets: three() });
    for (const cursor of ['!!!', Buffer.from('{"k":"runs","s":"-business_date","v":["2026-11-09","x"]}').toString('base64url'), 'a'.repeat(600)]) {
      expect(await code(list(s, { cursor }))).toBe('common.invalid_cursor');
    }
  });
  it('an empty list is { data: [], page: { limit: 50 } }', async () => {
    expect(await list(setup())).toEqual({ data: [], page: { limit: 50 } });
  });
});
