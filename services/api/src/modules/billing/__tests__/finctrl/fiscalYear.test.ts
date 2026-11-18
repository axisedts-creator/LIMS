// T0B-FINCTRL-1 (LD-321, LD-310) done_when (5) FISCAL YEAR: fiscal_year_label (e.g. 2083/84) is computed SERVER SIDE at write time from the entry date and the tenant fiscal year start
// (default Shrawan 1 in the BS calendar, through the existing BS date library packages/shared-ts/src/bsdate); statements accept a fiscal year filter.
// Real PG17 under RLS. Fails now: createAccountLedgerEntry stores no label (column NULL, DTO has none).
// ORACLE: bsdate.fiscalYearBs(date).long (the library of the repo) plus hard coded pairs of the evidence (2026-11-17 = 2083/84).
// PINS (CONV): the label follows the entry's own entry_date (also for a reversal row); the tenant start comes from IdentityPort.getTenantSettings `fiscal_year_start_bs` { month, day }
// (absent = Shrawan 1 = { month: 4, day: 1 }) and the label is "<BS year the FY started>/<next year, 2 digits>"; the statement operation has NO fiscal year parameter in the contract, so the
// filter is asserted on listAccountLedgerEntries (fiscal_year_label), the ElabAssist "Financial Year" search (CR needed if getAccountStatement must filter too: see the notes).
import { describe, expect, it } from 'vitest';
import { bsToAd, fiscalYearBs, type IsoDate } from '../../../../../../../packages/shared-ts/src/bsdate/index.js';
import { entry, moneyIsInteger, ok, post, prng, rejected, reverse } from '../accounts/helpers.js';
import { T, addDays, dbEntry, dbRows, fire, idem, listEntries, req, superTx, world } from './kit.js';

const label = (d: string) => fiscalYearBs(d as IsoDate).long;
const shrawan1 = (y: number) => bsToAd({ year: y, month: 4, day: 1 }) as string;

describe('fiscal_year_label at write time', () => {
  it('today (2026-11-17 = BS 2083 Mangsir) is 2083/84 in the response and in the database; the label is never a request field', async () => {
    const w = await world('a');
    const e = await entry(w, { entry_date: '2026-11-17' });
    expect(e.fiscal_year_label).toBe('2083/84');
    expect((await dbEntry(w.tenant, e.id)).fiscal_year_label).toBe('2083/84');
    for (const extra of ['2000/01', '2083/84', '']) rejected(await post(w, { fiscal_year_label: extra }));
  }, T);

  it('Shrawan 1 starts the year: the day before is the old year, the day itself the new one, also at the Chaitra / Baisakh turn and a year earlier', async () => {
    const w = await world('a');
    const cases: Array<[string, string]> = [
      [shrawan1(2083), '2083/84'], [addDays(shrawan1(2083), -1), '2082/83'],
      [shrawan1(2082), '2082/83'], [addDays(shrawan1(2082), -1), '2081/82'],
      [bsToAd({ year: 2083, month: 1, day: 1 }) as string, '2082/83'], [addDays(bsToAd({ year: 2083, month: 1, day: 1 }) as string, -1), '2082/83'],
      [bsToAd({ year: 2082, month: 12, day: 1 }) as string, '2082/83'],       // Chaitra still belongs to the year that began the Shrawan before
    ];
    for (const [date, want] of cases) {
      const e = await entry(w, { entry_date: date });
      expect(e.fiscal_year_label, `${date}`).toBe(want);
      expect(label(date), `oracle ${date}`).toBe(want);
    }
  }, T);

  it('60 random dates over three years agree with the BS library, in the response and in the stored column', async () => {
    const SEED = 83; const rnd = prng(SEED);
    const w = await world('a');
    for (let i = 0; i < 60; i++) {
      const date = addDays('2024-01-01', Math.floor(rnd() * 1050));            // up to 2026-11-16
      const e = await entry(w, { entry_date: date });
      expect(e.fiscal_year_label, `${date} seed ${SEED}`).toBe(label(date));
      expect((await dbEntry(w.tenant, e.id)).fiscal_year_label, `stored ${date}`).toBe(label(date));
    }
  }, T * 2);

  it('a reversal row carries the label of its own entry_date (today), not of the original', async () => {
    const w = await world('a');
    const old = await entry(w, { entry_date: addDays(shrawan1(2083), -30) });
    expect(old.fiscal_year_label).toBe('2082/83');
    const r = ok(await reverse(w, old.id), 201);
    expect(r.fiscal_year_label).toBe(label(r.entry_date));
  }, T);

  it('the stored label can never be edited afterwards, not even by the owner session', async () => {
    const w = await world('a');
    const e = await entry(w);
    await expect(superTx(async (tx) => { await tx.query(`UPDATE billing.account_ledger_entries SET fiscal_year_label = '2000/01' WHERE tenant_id = $1 AND id = $2`, [w.tenant, e.id]); }, w.tenant)).rejects.toBeDefined();
    expect((await dbEntry(w.tenant, e.id)).fiscal_year_label).toBe('2083/84');
  }, T);

  it('a tenant whose fiscal year starts on Magh 1 (pinned setting fiscal_year_start_bs) gets labels from that start; the default start is Shrawan 1', async () => {
    const w = await world('a');
    const prev = bsToAd({ year: 2082, month: 10, day: 1 }) as string;                        // Magh 1 2082
    const settings = { fiscal_year_start_bs: { month: 10, day: 1 } };
    const control = ok(await post(w, { entry_date: addDays(prev, -1) }), 201);               // no setting: Poush 2082 is in the Shrawan 1 year 2082/83
    expect(control.fiscal_year_label).toBe('2082/83');
    const mk = (date: string) => fire('createAccountLedgerEntry', req({ headers: idem(), body: { centre_id: w.centre, party_kind: 'credit_party', party_id: w.partyId, entry_date: date, account_particular_id: w.particularId, entry_type: 'credit', amount_paisa: 1000, payment_mode: 'cash' } }), { tenant: w.tenant, settings });
    expect(ok(await mk(addDays(prev, -1)), 201).fiscal_year_label).toBe('2081/82');           // day before Magh 1 2082: the year that started on Magh 1 2081
    expect(ok(await mk(prev), 201).fiscal_year_label).toBe('2082/83');                        // Magh 1 2082 itself
    expect(ok(await mk('2026-11-17'), 201).fiscal_year_label).toBe('2082/83');                // Mangsir 2083 is before Magh 1 2083
  }, T);
});

describe('fiscal year filter', () => {
  it('listAccountLedgerEntries?fiscal_year_label returns exactly the entries of that year; a bad label is 400; money stays integer', async () => {
    const w = await world('a');
    const a = await entry(w, { entry_date: addDays(shrawan1(2083), -3) });
    const b = await entry(w, { entry_date: shrawan1(2083) });
    const c = await entry(w, { entry_date: '2026-11-17' });
    const ids = async (fy: string) => ok(await listEntries(w.tenant, { party_kind: 'credit_party', party_id: w.partyId, fiscal_year_label: fy })).data.map((x: any) => x.id).sort();
    expect(await ids('2082/83')).toEqual([a.id]);
    expect(await ids('2083/84')).toEqual([b.id, c.id].sort());
    expect(await ids('2001/02')).toEqual([]);
    const both = ok(await listEntries(w.tenant, { party_id: w.partyId, fiscal_year_label: '2083/84', entry_date_from: '2026-11-01', entry_date_to: '2026-11-30' }));
    expect(both.data.map((x: any) => x.id)).toEqual([c.id]);
    expect(moneyIsInteger(both)).toEqual([]);
    for (const bad of ['2083-84', '2083/8', '83/84', '2083/084', 'abcd/ef', '']) rejected(await listEntries(w.tenant, { party_id: w.partyId, fiscal_year_label: bad }));
  }, T);

  it('tenant isolation: tenant B\'s list with the same label never contains tenant A entries', async () => {
    const a = await world('a'), b = await world('b');
    const ea = await entry(a);
    ok(await post(b, {}, { tenant: b.tenant }), 201);
    const rows = ok(await listEntries(b.tenant, { fiscal_year_label: '2083/84', limit: '200' })).data;
    expect(rows.map((x: any) => x.id)).not.toContain(ea.id);
    expect((await dbRows(b.tenant, `SELECT count(*)::int AS c FROM billing.account_ledger_entries WHERE tenant_id = $1 AND id = $2`, [ea.id]))[0].c).toBe(0);
  }, T);
});
