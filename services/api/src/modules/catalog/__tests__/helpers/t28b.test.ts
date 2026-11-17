// Self-check of the T-28b fixture (helpers/t28b.ts): the world prices as documented through the EXISTING quote engine (T-19), the revision-bump helper works, injected failures reach both fakes.
// Does not touch priceFor (the unit under test).
import { describe, expect, it } from 'vitest';
import { A, C2, DEF, DOC1, EXP, NOW, O1, O2, O4, P1, PRT, T, createQuoteService, setFallsThrough, setup28b, READ, actorIdentity, iso, query } from './t28b.js';
import { createEvents } from '../../../../core/events/publish.js';

const svc = () => createQuoteService({ events: createEvents({ producer: 'catalog' } as never), identity: actorIdentity([READ]) } as never) as unknown as { quotePrices: (c: any, b: any) => Promise<{ quotes: any[] }> };
const quote = async (env: ReturnType<typeof setup28b>, o: any, context: object = {}) =>
  (await env.db.run((ctx) => svc().quotePrices(ctx, { items: [{ orderable_id: o.id, priority: 'routine' }], context }), { at: NOW })).quotes[0];

describe('t28b world', () => {
  it('prices CBC 900 / 800 / 700 / 600 / 500 by source and has no price for the package', { timeout: T }, async () => {
    const env = setup28b();
    expect((await quote(env, O1)).unit_price.amount_paisa).toBe(90_000);
    expect((await quote(env, O1, { centre_id: C2.id })).unit_price.amount_paisa).toBe(80_000);
    expect((await quote(env, O1, { referrer_id: DOC1.id, centre_id: C2.id })).unit_price.amount_paisa).toBe(70_000);
    expect((await quote(env, O1, { credit_party_id: P1.id, referrer_id: DOC1.id, centre_id: C2.id })).unit_price.amount_paisa).toBe(60_000);
    expect((await quote(env, O1, { price_list_id: EXP.id })).unit_price.amount_paisa).toBe(50_000);
    expect(await quote(env, O4)).toEqual({ orderable_id: O4.id, error_code: 'catalog.no_price' });
    expect((await quote(env, O2, { credit_party_id: P1.id })).price_list_id).toBe(DEF.id);
  });
  it('setFallsThrough commits the change and bumps the revision exactly once', { timeout: T }, async () => {
    const env = setup28b();
    expect(env.db.price.revisionOf(A)).toBe(417);
    await setFallsThrough(env, PRT.id as string, false);
    expect(env.db.price.revisionOf(A)).toBe(418);
    expect(await quote(env, O2, { credit_party_id: P1.id })).toEqual({ orderable_id: O2.id, error_code: 'catalog.no_price' });
  });
  it('an injected failure reaches the price side and the tax side; query() builds the PriceQuery', { timeout: T }, async () => {
    for (const table of [/price_list_items/i, /tax_rules/i]) {
      const env = setup28b();
      env.db.price.fail(table); env.db.tax.fail(table);
      await expect(quote(env, O1)).rejects.toBeInstanceOf(Error);
    }
    expect(query(O1.id as string)).toEqual({ orderableId: O1.id, context: {}, priority: 'routine', at: iso(NOW) });
  });
});
