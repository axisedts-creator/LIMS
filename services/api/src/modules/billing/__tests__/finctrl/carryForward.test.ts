// T0B-FINCTRL-1 (LD-321, LD-310, founder 09:19 offline note) done_when (6) CARRY FORWARD: closing a day stores previous_outstanding_cash_paisa for the NEXT day, the first day is zero,
// month and year boundaries are tested; deposit_paisa is validated not above the cash on hand. Real PG17 under RLS. Fails now: the columns are never filled / validated.
// PINS (CONV, none is in the contract text; the writer may dispute through the ruling path):
//   - a "day" = one cash session of a (membership, centre) (sessions are per cashier and centre, billing.cash_sessions); cash on hand of a session = its previous_outstanding_cash_paisa
//     + its COUNTED cash (methods with is_cash); carried to the next session = cash on hand - deposit_paisa (never below 0, never reset by a month / year / fiscal year change).
//   - the carry is written when the next session OPENS (T0C note: set at open, immutable after) and every opener (recordPayment, refund, ...) goes through the shared repository function
//     cashSessions.repo.insertCashSession, which therefore fills the column: the test opens through it, the real open path of the handlers.
//   - deposit_paisa > cash on hand -> 400 common.validation_failed with path /deposit_paisa; absent deposit = 0.
import { describe, expect, it } from 'vitest';
import { bsToAd } from '../../../../../../../packages/shared-ts/src/bsdate/index.js';
import { insertCashSession } from '../../repository/cashSessions.repo.js';
import { appTx, moneyIsInteger, rejected } from '../accounts/helpers.js';
import { SYS_ACTOR, T, TENANT_B, addDays, dbRows, fire, idem, ifm, ok, person, req, seedClosedSession, sessionRow, superTx, uid, world, type Person } from './kit.js';

const at = (day: string, hhmm = '10:00') => `${day}T${hhmm}:00.000Z`;
const paths = (e: any): string[] => (e.errors ?? []).map((x: any) => x.path);
const branchOf = async (tenant: string) => (await dbRows(tenant, 'SELECT id FROM core.branches WHERE tenant_id = $1 LIMIT 1'))[0].id as string;

/** Open a session the way the handlers do (the shared repo function) and read the stored row. */
async function open(w: { tenant: string; centre: string }, p: Person, openedAt: string): Promise<any> {
  const branchId = await branchOf(w.tenant);
  const row: any = await appTx(w.tenant, async (tx: any) => insertCashSession(tx, { id: uid(), tenantId: w.tenant, branchId, centreId: w.centre, membershipId: p.membershipId, openedAt, userId: SYS_ACTOR }));
  expect(row, 'a fresh (membership, centre) pair opens a session').toBeDefined();
  return sessionRow(w.tenant, row.id);
}
const close = (w: { tenant: string }, p: Person, id: string, body: Record<string, unknown>, version = 1) =>
  fire('closeCashSession', req({ params: { cash_session_id: id }, headers: { ...idem(), ...ifm(version) }, body }), { tenant: w.tenant, membershipId: p.membershipId });
const myCurrent = (w: { tenant: string }, p: Person) => fire('getMyCashSession', req({}), { tenant: w.tenant, membershipId: p.membershipId });

describe('previous outstanding cash: carried to the next day', () => {
  it('the first day is zero', async () => {
    const w = await world('a'); const p = await person();
    expect(Number((await open(w, p, at('2026-11-01'))).previous_outstanding_cash_paisa)).toBe(0);
  }, T);

  it('next day = last closing cash on hand - deposit; a day with no deposit carries everything', async () => {
    const w = await world('a'); const p = await person(), q = await person();
    await seedClosedSession(w, p.membershipId, { openedAt: at('2026-11-01'), closedAt: at('2026-11-01', '16:00'), cashPaisa: 500_000, previous: 0, deposit: 200_000 });
    expect(Number((await open(w, p, at('2026-11-02'))).previous_outstanding_cash_paisa)).toBe(300_000);
    await seedClosedSession(w, q.membershipId, { openedAt: at('2026-11-01'), closedAt: at('2026-11-01', '16:00'), cashPaisa: 123_456 });
    expect(Number((await open(w, q, at('2026-11-02'))).previous_outstanding_cash_paisa)).toBe(123_456);
  }, T);

  it('what an earlier day left over is part of the next cash on hand: previous + counted - deposit chains over three days through closeCashSession', async () => {
    const w = await world('a'); const p = await person();
    await seedClosedSession(w, p.membershipId, { openedAt: at('2026-11-01'), closedAt: at('2026-11-01', '16:00'), cashPaisa: 100_000, previous: 0, deposit: 0 });
    const d2 = await open(w, p, at('2026-11-02'));
    expect(Number(d2.previous_outstanding_cash_paisa)).toBe(100_000);
    const closed = ok(await close(w, p, d2.id, { counted: [{ method_code: 'cash', amount_paisa: 50_000 }], deposit_paisa: 120_000 }));
    expect(closed).toMatchObject({ id: d2.id, status: 'closed', previous_outstanding_cash_paisa: 100_000, deposit_paisa: 120_000 });
    expect(moneyIsInteger(closed)).toEqual([]);
    expect(Number((await open(w, p, at('2026-11-03'))).previous_outstanding_cash_paisa)).toBe(100_000 + 50_000 - 120_000);
  }, T);

  it('month, year, BS year and fiscal year boundaries and long gaps never reset the carry', async () => {
    const w = await world('a');
    const days = [
      '2026-10-31',                                                                           // AD month end
      '2025-12-31',                                                                           // AD year end
      addDays(bsToAd({ year: 2083, month: 1, day: 1 }) as string, -1),                       // last day of BS 2082 (Chaitra end)
      addDays(bsToAd({ year: 2083, month: 4, day: 1 }) as string, -1),                       // last day of the fiscal year 2082/83 (Asar end)
      '2024-02-29',                                                                           // leap day
    ];
    for (const last of days) {
      const p = await person();
      await seedClosedSession(w, p.membershipId, { openedAt: at(last), closedAt: at(last, '17:00'), cashPaisa: 400_000, previous: 50_000, deposit: 150_000 });
      expect(Number((await open(w, p, at(addDays(last, 1)))).previous_outstanding_cash_paisa), `next day of ${last}`).toBe(300_000);
    }
    const gap = await person();
    await seedClosedSession(w, gap.membershipId, { openedAt: at('2025-01-10'), closedAt: at('2025-01-10', '17:00'), cashPaisa: 70_000 });
    expect(Number((await open(w, gap, at('2026-11-17'))).previous_outstanding_cash_paisa), 'a 400 day gap').toBe(70_000);
  }, T * 2);

  it('the carry belongs to one (membership, centre): another cashier and another tenant start at zero, and the most recent closed session wins', async () => {
    const a = await world('a'), b = await world('b');
    const p = await person(), other = await person(), pb = await person(TENANT_B);
    await seedClosedSession(a, p.membershipId, { openedAt: at('2026-11-01'), closedAt: at('2026-11-01', '16:00'), cashPaisa: 900_000 });
    await seedClosedSession(a, p.membershipId, { openedAt: at('2026-11-02'), closedAt: at('2026-11-02', '16:00'), cashPaisa: 10_000, previous: 0, deposit: 4_000 });
    expect(Number((await open(a, p, at('2026-11-03'))).previous_outstanding_cash_paisa)).toBe(6_000);
    expect(Number((await open(a, other, at('2026-11-03'))).previous_outstanding_cash_paisa)).toBe(0);
    expect(Number((await open(b, pb, at('2026-11-03'))).previous_outstanding_cash_paisa)).toBe(0);
  }, T);

  it('the carry is fixed when the session opens: no later UPDATE can change it, not even by the owner session', async () => {
    const w = await world('a'); const p = await person();
    await seedClosedSession(w, p.membershipId, { openedAt: at('2026-11-01'), closedAt: at('2026-11-01', '16:00'), cashPaisa: 10_000 });
    const s = await open(w, p, at('2026-11-02'));
    await expect(superTx(async (tx) => { await tx.query(`UPDATE billing.cash_sessions SET previous_outstanding_cash_paisa = 1 WHERE tenant_id = $1 AND id = $2`, [w.tenant, s.id]); }, w.tenant)).rejects.toBeDefined();
    expect(Number((await sessionRow(w.tenant, s.id)).previous_outstanding_cash_paisa)).toBe(10_000);
  }, T);

  it('getMyCashSession shows the carried amount and the deposit of the open session', async () => {
    const w = await world('a'); const p = await person();
    await seedClosedSession(w, p.membershipId, { openedAt: at('2026-11-01'), closedAt: at('2026-11-01', '16:00'), cashPaisa: 33_000 });
    await open(w, p, at('2026-11-02'));
    const s = ok(await myCurrent(w, p));
    expect(s).toMatchObject({ status: 'open', previous_outstanding_cash_paisa: 33_000, deposit_paisa: 0 });
    expect(moneyIsInteger(s)).toEqual([]);
  }, T);
});

describe('deposit_paisa is validated against the cash on hand', () => {
  async function dayWith(previous: number) {
    const w = await world('a'); const p = await person();
    if (previous > 0) await seedClosedSession(w, p.membershipId, { openedAt: at('2026-11-01'), closedAt: at('2026-11-01', '16:00'), cashPaisa: previous });
    const s = await open(w, p, at('2026-11-02'));
    return { w, p, s };
  }

  it('a deposit above previous + counted cash -> 400 with the path /deposit_paisa, the session stays open; exactly the cash on hand is accepted; the next day then starts at zero', async () => {
    const { w, p, s } = await dayWith(100_000);
    const counted = [{ method_code: 'cash', amount_paisa: 20_000 }];
    expect(paths(rejected(await close(w, p, s.id, { counted, deposit_paisa: 120_001 })))).toContain('/deposit_paisa');
    expect((await sessionRow(w.tenant, s.id)).status).toBe('open');
    const done = ok(await close(w, p, s.id, { counted, deposit_paisa: 120_000 }));
    expect(done).toMatchObject({ status: 'closed', deposit_paisa: 120_000, previous_outstanding_cash_paisa: 100_000 });
    expect(Number((await open(w, p, at('2026-11-03'))).previous_outstanding_cash_paisa)).toBe(0);
  }, T);

  it('only CASH counts as cash on hand: a large non-cash count does not allow a bigger deposit', async () => {
    const { w, p, s } = await dayWith(0);
    const counted = [{ method_code: 'cash', amount_paisa: 10_000 }, { method_code: 'esewa_qr', amount_paisa: 900_000 }];
    expect(paths(rejected(await close(w, p, s.id, { counted, deposit_paisa: 10_001 })))).toContain('/deposit_paisa');
    expect(ok(await close(w, p, s.id, { counted, deposit_paisa: 10_000 })).deposit_paisa).toBe(10_000);
  }, T);

  it('no deposit given = 0 and everything is carried; a zero deposit is valid; a day with no cash counted allows only 0', async () => {
    const a = await dayWith(0);
    expect(ok(await close(a.w, a.p, a.s.id, { counted: [{ method_code: 'cash', amount_paisa: 5_000 }] })).deposit_paisa).toBe(0);
    expect(Number((await open(a.w, a.p, at('2026-11-03'))).previous_outstanding_cash_paisa)).toBe(5_000);
    const z = await dayWith(0);
    expect(paths(rejected(await close(z.w, z.p, z.s.id, { counted: [], deposit_paisa: 1 })))).toContain('/deposit_paisa');
    expect(ok(await close(z.w, z.p, z.s.id, { counted: [], deposit_paisa: 0 })).deposit_paisa).toBe(0);
  }, T);

  it.each<[string, unknown]>([['negative', -1], ['a float', 10.5], ['a string (money never travels as one)', '100'], ['above 2^53-1', Number.MAX_SAFE_INTEGER + 2], ['null', null]])(
    'a deposit that is %s -> 400 /deposit_paisa, session stays open', async (_n, deposit) => {
      const { w, p, s } = await dayWith(1_000_000);
      expect(paths(rejected(await close(w, p, s.id, { counted: [{ method_code: 'cash', amount_paisa: 1_000 }], deposit_paisa: deposit })))).toContain('/deposit_paisa');
      expect((await sessionRow(w.tenant, s.id)).status).toBe('open');
    }, T);

  it('another cashier cannot close the session (and so cannot set its deposit): auth.forbidden; another tenant\'s session id -> 404', async () => {
    const { w, s } = await dayWith(1_000);
    const thief = await person();
    rejected(await close(w, thief, s.id, { counted: [], deposit_paisa: 0 }), 'auth.forbidden');
    const b = await world('b'); const pb = await person(TENANT_B);
    rejected(await close(b, pb, s.id, { counted: [], deposit_paisa: 0 }), 'common.not_found');
    expect((await sessionRow(w.tenant, s.id)).status).toBe('open');
  }, T);
});
