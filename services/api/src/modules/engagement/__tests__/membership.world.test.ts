// Self-test of membership.world.ts (T-M1 tester): proves the fake enforces what the handler tests rely on, so a failing handler test points at the handler, not the fake.
import { describe, expect, it } from 'vitest';
import { ACC1, ACC2, ID, PAT1, PAT2, PAT_B, PLAN_GOLD, TA, TB, TOKEN_OK, makeWorld, membership } from './membership.world.js';

const ins = (id: number, patient: string, o: Record<string, unknown> = {}) => ({
  text: `INSERT INTO engagement.patient_memberships (id, tenant_id, patient_id, plan_id, card_no, card_token, valid_from, valid_to, enrolled_by, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $9) RETURNING *`,
  values: [ID(id), TA, patient, PLAN_GOLD, `MB26${String(id).padStart(6, '0')}`, `${String(id).padStart(2, '0')}${TOKEN_OK.slice(2)}`, '2026-11-05', '2027-11-05', ID(9)],
  ...o,
});
const run = (w: ReturnType<typeof makeWorld>, q: { text: string; values: unknown[] }, who: 'staff' | 'patient' = 'staff', account?: string) => (account ? w.session(who, {}, undefined, account) : w.session(who)).tx.query(q.text, q.values);
const err = async (p: Promise<unknown>): Promise<any> => p.then(() => ({}), (e) => e);

describe('membership world', () => {
  it('partial unique index: a second ACTIVE membership of the same patient -> 23505 with the spec constraint name and the row is gone; a cancelled/expired one does not clash', async () => {
    const w = makeWorld();
    await run(w, ins(1, PAT1));
    const e = await err(run(w, ins(2, PAT1)));
    expect(e).toMatchObject({ code: '23505', constraint: 'patient_memberships__tenant_id_patient_active__p_uq' });
    expect(w.tables['patient_memberships']).toHaveLength(1);
    const w2 = makeWorld({ seed: (s) => s.tables['patient_memberships']!.push(membership({ status: 'expired' })) });
    await run(w2, ins(2, PAT1));
    expect(w2.tables['patient_memberships']).toHaveLength(2);
  });
  it('CHECKs: bad card token / card_no, valid_to <= valid_from; FK: patient of another tenant', async () => {
    const w = makeWorld();
    expect((await err(run(w, ins(1, PAT1, { values: ins(1, PAT1).values.map((v, i) => (i === 5 ? 'U'.repeat(26) : v)) })))).code).toBe('23514');
    expect((await err(run(w, ins(1, PAT1, { values: ins(1, PAT1).values.map((v, i) => (i === 7 ? '2026-11-05' : v)) })))).code).toBe('23514');
    expect((await err(run(w, ins(1, PAT_B)))).code).toBe('23503');
  });
  it('number_counters: key card_no:26 increments atomically', async () => {
    const w = makeWorld();
    await run(w, { text: 'INSERT INTO engagement.number_counters (tenant_id, counter_key, last_value, created_by) VALUES ($1, $2, 0, $3) ON CONFLICT DO NOTHING', values: [TA, 'card_no:26', ID(9)] });
    const r1: any = await run(w, { text: 'UPDATE engagement.number_counters SET last_value = last_value + 1, updated_at = now() WHERE tenant_id = $1 AND counter_key = $2 RETURNING last_value', values: [TA, 'card_no:26'] });
    expect(r1.rows[0].last_value).toBe(1);
    expect((await err(run(w, { text: 'INSERT INTO engagement.number_counters (tenant_id, counter_key, last_value, created_by) VALUES ($1, $2, 0, $3)', values: [TA, 'card:26', ID(9)] }))).code).toBe('23514');
  });
  it('RLS: staff of tenant A never reads tenant B; a patient session sees only its account\'s links and its linked patients\' memberships', async () => {
    const w = makeWorld({ seed: (s) => s.tables['patient_memberships']!.push(membership(), membership({ id: ID(0x302), patient_id: PAT2, card_no: 'MB26000002', card_token: '7ABCDEFGHJKMNPQRSTVWXYZ012' }), membership({ id: ID(0x303), tenant_id: TB, patient_id: PAT_B, card_no: 'MB26000009', card_token: '8ABCDEFGHJKMNPQRSTVWXYZ012' })) });
    const q = { text: 'SELECT * FROM engagement.patient_memberships WHERE status = $1', values: ['active'] };
    expect(((await run(w, q)) as any).rows.map((r: any) => r.id).sort()).toEqual([ID(0x301), ID(0x302)]);
    expect(((await run(w, q, 'patient', ACC1)) as any).rows.map((r: any) => r.id)).toEqual([ID(0x301)]);
    expect(((await run(w, q, 'patient', ACC2)) as any).rows.map((r: any) => r.id)).toEqual([ID(0x302)]);
    const links: any = await run(w, { text: 'SELECT * FROM engagement.account_patient_links WHERE status = $1', values: ['active'] }, 'patient', ACC1);
    expect(links.rows.map((r: any) => r.patient_id)).toEqual([PAT1]);
  });
  it('assertRole fake: aal1 + privileged -> auth.mfa_required; denied -> auth.forbidden; records the statement count at the time of the assert', async () => {
    const w = makeWorld(); w.identity.aal = 1;
    expect((await err(w.identity.assertRole({}, { permission: 'engagement.membership_plan.manage' }))).code).toBe('auth.mfa_required');
    w.identity.deny.add('engagement.membership.read');
    expect((await err(w.identity.assertRole({}, { permission: 'engagement.membership.read' }))).code).toBe('auth.forbidden');
    expect(w.identity.asserted).toHaveLength(2);
  });
  it('catalog fake: published+active ok, unknown -> common.not_found', async () => {
    const w = makeWorld();
    expect(await w.catalog.port.getPriceListStatus({}, { priceListId: '01a1a98a-ac40-7000-8000-000000000701' })).toMatchObject({ isActive: true, status: 'published' });
    expect((await err(w.catalog.port.getPriceListStatus({}, { priceListId: ID(0x704) }))).code).toBe('common.not_found');
  });
});
