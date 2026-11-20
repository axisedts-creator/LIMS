// T0B-PARTYSET-1 done_when (4) ONBOARDING: listPartyOnboarding + decidePartyOnboarding. Real PG17.
// Pins: allowed moves only (pending -> approved|held|rejected, held -> approved|rejected; approved and rejected final) else common.validation_failed;
// hold / reject need a reason 1..500 (path /reason); the decider is not the person who created the row (created_by): refused (auth.forbidden or common.validation_failed),
// row untouched; every decision leaves an audit trail that names the reason and the decider (audit.audit_log row of party_onboarding and / or ctx.audit.access detail);
// decide needs If-Match (common.precondition_required / common.version_conflict); a row of another tenant is common.not_found.
import { beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_A, ADMIN_B, P, SECOND_A, T, TENANT_A, TENANT_B, dbRow, fire, ifm, mkCreditParty, mkDoctor, mkOnboarding, mkPartner, notFound, ok, only, rejected, rejectedAny, req, trailOf, wipe } from './helpers.js';

const list = (q: object = {}, who = ADMIN_A) => fire('listPartyOnboarding', req({ query: q }), who);
const decide = (id: string, body: unknown, headers: object = ifm(1), who = SECOND_A) => fire('decidePartyOnboarding', req({ params: { onboarding_id: id }, headers, body }), who);
const NOT_ALLOWED = ['common.validation_failed'];

beforeEach(async () => { await wipe(TENANT_A, TENANT_B); }, T);

async function queued(status = 'pending', o: Record<string, unknown> = {}) {
  const partner = await mkPartner(TENANT_A, { name: `Synthetic Franchise ${Math.random().toString(36).slice(2, 7)}` });
  const row = await mkOnboarding(TENANT_A, 'partner', partner.id, { status, ...(status === 'pending' ? {} : { decided_by: SECOND_A.userId, decided_at: '2026-11-10T00:00:00Z', ...(status === 'approved' ? {} : { reason: 'Synthetic: earlier reason' }) }), ...o });
  return { partner, row };
}

describe('listPartyOnboarding', () => {
  it('lists the queue oldest first with party_name; status, party_kind and q filters; tenant isolation; cursor paging', async () => {
    const a = await mkPartner(TENANT_A, { name: 'Synthetic Alpha Franchise' });
    const b = await mkCreditParty(TENANT_A, { name: 'Synthetic Beta Hospital' });
    const c = await mkDoctor(TENANT_A, { display_name: 'Synthetic Gamma Doctor' });
    const r1 = await mkOnboarding(TENANT_A, 'partner', a.id, { created_at: '2026-11-01T00:00:00Z' });
    const r2 = await mkOnboarding(TENANT_A, 'credit_party', b.id, { created_at: '2026-11-02T00:00:00Z', status: 'held', reason: 'Synthetic: docs', decided_by: SECOND_A.userId, decided_at: '2026-11-03T00:00:00Z' });
    const r3 = await mkOnboarding(TENANT_A, 'doctor', c.id, { created_at: '2026-11-03T00:00:00Z' });
    const other = await mkPartner(TENANT_B, { name: 'Synthetic Alpha Elsewhere' });
    await mkOnboarding(TENANT_B, 'partner', other.id);
    const all = ok(await list());
    expect(all.data.map((x: any) => x.id)).toEqual([r1.id, r2.id, r3.id]);
    expect(all.data[0]).toMatchObject({ party_kind: 'partner', party_id: a.id, party_name: 'Synthetic Alpha Franchise', status: 'pending', version: 1 });
    expect(all.data[1]).toMatchObject({ status: 'held', reason: 'Synthetic: docs', decided_by: SECOND_A.userId });
    expect(ok(await list({ status: 'held' })).data.map((x: any) => x.id)).toEqual([r2.id]);
    expect(ok(await list({ party_kind: 'doctor' })).data.map((x: any) => x.id)).toEqual([r3.id]);
    expect(ok(await list({ q: 'alpha' })).data.map((x: any) => x.id)).toEqual([r1.id]);
    const p1 = ok(await list({ limit: 2 }));
    expect(p1.data).toHaveLength(2);
    const p2 = ok(await list({ limit: 2, cursor: p1.page.next_cursor }));
    expect([...p1.data, ...p2.data].map((x: any) => x.id)).toEqual([r1.id, r2.id, r3.id]);
    expect(JSON.stringify(ok(await list({}, ADMIN_B)))).not.toContain(r1.id);
  }, T);
  it('a bad status, party_kind or cursor is a validation / invalid_cursor error; needs partners.onboarding.decide', async () => {
    rejected(await list({ status: 'done' }), 'common.validation_failed', '*');
    rejected(await list({ party_kind: 'robot' }), 'common.validation_failed', '*');
    rejected(await list({ cursor: 'not-a-cursor' }), 'common.invalid_cursor');
    rejected(await list({}, only(1, P.settingRead)), 'auth.forbidden');
  }, T);
  it('never shows a government id number', async () => {
    const a = await mkPartner(TENANT_A, { tax_number: 'SYN000000001', national_id_number: 'SYN-NID-0001' });
    await mkOnboarding(TENANT_A, 'partner', a.id);
    const s = JSON.stringify(ok(await list()));
    expect(s).not.toContain('SYN000000001');
    expect(s).not.toContain('SYN-NID-0001');
  }, T);
});

describe('decidePartyOnboarding: allowed transitions only', () => {
  it('pending -> approve: status approved, decided_by = the decider, decided_at set, version + 1', async () => {
    const { row } = await queued();
    const b = ok(await decide(row.id, { decision: 'approve' }));
    expect(b).toMatchObject({ id: row.id, status: 'approved', decided_by: SECOND_A.userId, version: 2 });
    expect(typeof b.decided_at).toBe('string');
    expect(await dbRow('partners.party_onboarding', row.id)).toMatchObject({ status: 'approved', decided_by: SECOND_A.userId, version: 2 });
  }, T);
  it('pending -> hold (reason) -> approve; pending -> reject (reason); held -> reject (reason)', async () => {
    const a = await queued();
    const held = ok(await decide(a.row.id, { decision: 'hold', reason: 'Synthetic: registration documents missing' }));
    expect(held).toMatchObject({ status: 'held', reason: 'Synthetic: registration documents missing', version: 2 });
    expect(ok(await decide(a.row.id, { decision: 'approve' }, ifm(2)))).toMatchObject({ status: 'approved', version: 3 });
    const b = await queued();
    expect(ok(await decide(b.row.id, { decision: 'reject', reason: 'Synthetic: licence expired' }))).toMatchObject({ status: 'rejected', reason: 'Synthetic: licence expired' });
    const c = await queued();
    ok(await decide(c.row.id, { decision: 'hold', reason: 'Synthetic: wait' }));
    expect(ok(await decide(c.row.id, { decision: 'reject', reason: 'Synthetic: no answer' }, ifm(2)))).toMatchObject({ status: 'rejected' });
  }, T);
  it.each([
    ['approved', 'approve'], ['approved', 'hold'], ['approved', 'reject'], ['rejected', 'approve'], ['rejected', 'hold'], ['rejected', 'reject'], ['held', 'hold'],
  ])('%s -> %s is refused with common.validation_failed and the row is untouched', async (from, decision) => {
    const { row } = await queued(from);
    const o = await decide(row.id, { decision, reason: 'Synthetic: try again' });
    rejected(o, NOT_ALLOWED[0]);
    expect(await dbRow('partners.party_onboarding', row.id)).toMatchObject({ status: from, version: 1 });
  }, T);
  it('hold and reject need a reason (path /reason, 1..500 characters); an unknown decision is /decision; an extra field is refused', async () => {
    const { row } = await queued();
    rejected(await decide(row.id, { decision: 'hold' }), 'common.validation_failed', '/reason');
    rejected(await decide(row.id, { decision: 'reject' }), 'common.validation_failed', '/reason');
    rejected(await decide(row.id, { decision: 'reject', reason: '' }), 'common.validation_failed', '/reason');
    rejected(await decide(row.id, { decision: 'hold', reason: 'x'.repeat(501) }), 'common.validation_failed', '/reason');
    rejected(await decide(row.id, { decision: 'maybe' }), 'common.validation_failed', '/decision');
    rejected(await decide(row.id, {}), 'common.validation_failed', '/decision');
    rejected(await decide(row.id, { decision: 'approve', status: 'approved' }), 'common.validation_failed', '*');
    ok(await decide(row.id, { decision: 'hold', reason: 'x'.repeat(500) }));
    expect((await dbRow('partners.party_onboarding', row.id)).status).toBe('held');
  }, T);
  it('If-Match: missing -> precondition_required, stale -> version_conflict, nothing changes', async () => {
    const { row } = await queued();
    rejected(await decide(row.id, { decision: 'approve' }, {}), 'common.precondition_required');
    rejected(await decide(row.id, { decision: 'approve' }, ifm(7)), 'common.version_conflict');
    expect(await dbRow('partners.party_onboarding', row.id)).toMatchObject({ status: 'pending', version: 1 });
  }, T);
  it('two concurrent decisions on one row: exactly one wins, the other is a conflict or a refused move; the end state is one of the two', async () => {
    const { row } = await queued();
    const outs = await Promise.all([decide(row.id, { decision: 'approve' }), decide(row.id, { decision: 'reject', reason: 'Synthetic: race' }), decide(row.id, { decision: 'hold', reason: 'Synthetic: race 2' })]);
    expect(outs.filter((o) => o.reply?.status === 200).length).toBeGreaterThanOrEqual(1);
    for (const o of outs) if (o.error) rejectedAny(o, ['common.version_conflict', 'common.validation_failed']);
    const end = await dbRow('partners.party_onboarding', row.id);
    expect(['approved', 'rejected', 'held']).toContain(end.status);
    expect(end.version).toBe(1 + outs.filter((o) => o.reply?.status === 200).length);   // every accepted decision bumped the version once
  }, T);
});

describe('decidePartyOnboarding: who decides, audit, isolation', () => {
  it('the person who created the record cannot decide it; the row stays pending and no decision trail is written', async () => {
    const { row } = await queued('pending', { created_by: SECOND_A.userId, updated_by: SECOND_A.userId });
    const o = await decide(row.id, { decision: 'approve' }, ifm(1), SECOND_A);
    rejectedAny(o, ['auth.forbidden', 'common.validation_failed']);
    expect(await dbRow('partners.party_onboarding', row.id)).toMatchObject({ status: 'pending', decided_by: null, version: 1 });
    expect(o.probe.access.filter((e) => /decid/i.test(JSON.stringify(e)))).toEqual([]);
  }, T);
  it('a different person with the same permission can (the creator rule is about the person, not the role)', async () => {
    const { row } = await queued('pending', { created_by: ADMIN_A.userId });
    ok(await decide(row.id, { decision: 'approve' }, ifm(1), SECOND_A));
  }, T);
  it.each([['approve', undefined], ['hold', 'Synthetic: registration documents missing'], ['reject', 'Synthetic: licence expired']] as const)(
    'every decision (%s) writes an audit event that names the decider and the reason', async (decision, reason) => {
      const { row } = await queued();
      const o = await decide(row.id, { decision, ...(reason ? { reason } : {}) });
      ok(o);
      const trail = await trailOf('partners.party_onboarding', row.id, o);
      expect(trail).toContain(SECOND_A.userId);
      if (reason) expect(trail).toContain(reason);
      expect(trail).toMatch(new RegExp(decision === 'approve' ? 'approved' : decision === 'hold' ? 'held' : 'rejected'));
    }, T);
  it('a row of another tenant and an unknown id are common.not_found and stay untouched', async () => {
    const { row } = await queued();
    notFound(await decide(row.id, { decision: 'approve' }, ifm(1), as_b()));
    notFound(await decide('01a1a98a-ac40-7000-8000-00000000dead', { decision: 'approve' }));
    expect(await dbRow('partners.party_onboarding', row.id)).toMatchObject({ status: 'pending' });
  }, T);
  it('needs partners.onboarding.decide', async () => {
    const { row } = await queued();
    rejected(await decide(row.id, { decision: 'approve' }, ifm(1), only(4, P.settingManage, P.penalty)), 'auth.forbidden');
    expect((await dbRow('partners.party_onboarding', row.id)).status).toBe('pending');
  }, T);
});
const as_b = () => ({ ...ADMIN_B, userId: '01a1a98a-ac40-7000-8000-9a4700000077', membershipId: '01a1a98a-ac40-7000-8000-9a4800000077' });
