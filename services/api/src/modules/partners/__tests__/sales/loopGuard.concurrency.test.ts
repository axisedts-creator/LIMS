// T0B-SALES-1 done_when (6): "the loop guard under concurrency (two requests that would close a loop: exactly one wins)", plus the same for overlapping assignments.
// Real PG17, separate transactions per request. Fails now: handlers pending. Synthetic data only.
import { beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_A, T, TENANT_A, dbRows, fire, idem, ifm, mkCreditParty, mkDesignation, mkRep, rejected, req, wipe } from './helpers.js';

let D: any;
beforeEach(async () => { await wipe(TENANT_A); D = await mkDesignation(TENANT_A, 2); }, T);
const move = (id: string, manager: string, v = 1) => fire('updateSalesRepresentative', req({ params: { representative_id: id }, headers: ifm(v), body: { manager_id: manager } }), ADMIN_A);
/** true when no representative of the tenant reaches itself by walking up manager_id (checked by the owner, no trigger involved) */
async function acyclic(): Promise<boolean> {
  const r = await dbRows('partners.sales_representative', 'tenant_id = $1', [TENANT_A]);
  const up = new Map(r.map((x) => [x.id, x.manager_id as string | null]));
  return r.every((x) => { const seen = new Set<string>(); for (let cur: string | null | undefined = x.id; cur; cur = up.get(cur)) { if (seen.has(cur)) return false; seen.add(cur); } return true; });
}

describe('two requests that would close a manager loop: exactly one wins', () => {
  it('a under b and b under a at the same time (10 rounds)', { timeout: T }, async () => {
    for (let i = 0; i < 10; i++) {
      const a = await mkRep(TENANT_A, D.id), b = await mkRep(TENANT_A, D.id);
      const outs = await Promise.all([move(a.id, b.id), move(b.id, a.id)]);
      expect(outs.filter((o) => o.reply?.status === 200), `round ${i}`).toHaveLength(1);
      const lost = outs.find((o) => o.reply?.status !== 200)!; rejected(lost, 'common.validation_failed', '/manager_id');   // never 500 / deadlock error
      expect(await acyclic()).toBe(true);
    }
  });
  it('three requests c under a, a under b, b under c: at most two win, the graph stays acyclic, losers are validation errors', { timeout: T }, async () => {
    for (let i = 0; i < 5; i++) {
      const [a, b, c] = [await mkRep(TENANT_A, D.id), await mkRep(TENANT_A, D.id), await mkRep(TENANT_A, D.id)];
      const outs = await Promise.all([move(c.id, a.id), move(a.id, b.id), move(b.id, c.id)]);
      const won = outs.filter((o) => o.reply?.status === 200).length;
      expect(won, `round ${i}`).toBeGreaterThanOrEqual(1); expect(won).toBeLessThanOrEqual(2);
      for (const o of outs.filter((x) => x.reply?.status !== 200)) rejected(o, 'common.validation_failed', '/manager_id');
      expect(await acyclic()).toBe(true);
    }
  });
  it('20 random concurrent moves over 6 representatives never leave a loop and never fail with anything but validation_failed / version_conflict', { timeout: T }, async () => {
    const reps = await Promise.all(Array.from({ length: 6 }, () => mkRep(TENANT_A, D.id)));
    const outs = await Promise.all(Array.from({ length: 20 }, (_, i) => move(reps[i % 6]!.id, reps[(i * 5 + 1) % 6]!.id, 1)));
    for (const o of outs) if (o.reply) expect(o.reply.status).toBe(200); else expect(['common.validation_failed', 'common.version_conflict']).toContain((o.error as any)?.code);
    expect(await acyclic()).toBe(true);
  });
});

describe('two requests that would create the same overlapping assignment: exactly one wins', () => {
  it('same party, same representative, same window (5 rounds)', { timeout: T }, async () => {
    const r = await mkRep(TENANT_A, D.id);
    for (let i = 0; i < 5; i++) {
      const p = await mkCreditParty(TENANT_A);
      const go = () => fire('assignPartyToRepresentative', req({ headers: idem(), body: { party_kind: 'credit_party', party_id: p.id, representative_id: r.id, effective_from: '2026-11-18' } }), ADMIN_A);
      const outs = await Promise.all([go(), go(), go()]);
      expect(outs.filter((o) => o.reply?.status === 201), `round ${i}`).toHaveLength(1);
      for (const o of outs.filter((x) => x.reply?.status !== 201)) rejected(o, 'common.validation_failed', '*');
      expect(await dbRows('partners.party_sales_assignment', 'party_id = $1', [p.id])).toHaveLength(1);
    }
  });
});
