// T0B-VERLEVEL-1 (LD-316) done_when (3), (4), (11): the table driven matrix. Level 1, 2, 3 x pathologist required or not, every sign-off checked for the final status, signoff_count,
// signoff_required, next_step, the chain row it appended (snapshot of the signer) and the events. Real handlers, real PG17, RLS on.
//   Given a `resulted` manual result entered by a technologist (not a signer) and a TEST scope policy {level, require_pathologist}
//   When people sign in the order of the row, Then each answer/state is the row's expectation; a refused step changes nothing.
// People: t1 t2 t3 = technologists (hold lab.result.verify, NOT lab.result.approve); p1 = pathologist (holds lab.result.approve). signer_is_pathologist = held lab.result.approve at signing time.
import { afterAll, describe, expect, it } from 'vitest';
import { T, closePools, live, requireDb, type Who } from '../probes/kit.js';
import { SIGNED_OFF, approve, chainOf, code, dto, eventsOf, getResult, newCase, person, policyFor, rowOf, verify, why, type Case } from './helpers.js';

afterAll(async () => { await closePools(); });
describe('harness', () => { it('the migrated database is provided (fails, never skips, under LIMS_T03_REQUIRE_DB=1)', () => { if (requireDb) expect(live).toBe(true); }); });

type Op = 'verify' | 'approve';
interface Ok { status: 'verified' | 'approved'; count: number; next: 'verify' | 'approve' | 'none' }
interface Step { by: 't1' | 't2' | 't3' | 'p1'; op: Op; ok?: Ok; err?: string }
interface Row { name: string; level: 1 | 2 | 3; patho: boolean; steps: Step[] }

const V = (by: Step['by'], count: number, next: Ok['next'], status: Ok['status'] = 'verified'): Step => ({ by, op: 'verify', ok: { status, count, next } });
const A = (by: Step['by'], count: number): Step => ({ by, op: 'approve', ok: { status: 'approved', count, next: 'none' } });
const E = (by: Step['by'], op: Op, err: string): Step => ({ by, op, err });

const ROWS: Row[] = [
  // ---- pathologist required: the final sign-off is a pathologist one (approveResult, MFA); verifyResult can never be the final one
  { name: 'L1 + pathologist: pathologist approves from resulted', level: 1, patho: true, steps: [A('p1', 1)] },
  { name: 'L1 + pathologist: a technologist cannot be the final sign-off (lab.pathologist_required), then the pathologist approves', level: 1, patho: true,
    steps: [E('t1', 'verify', 'lab.pathologist_required'), A('p1', 1)] },
  { name: 'L2 + pathologist = today: technologist verifies, pathologist approves', level: 2, patho: true, steps: [V('t1', 1, 'approve'), A('p1', 2)] },
  { name: 'L2 + pathologist: approve straight from resulted is not allowed (only level 1)', level: 2, patho: true, steps: [E('p1', 'approve', 'lab.result_invalid_transition'), V('t1', 1, 'approve'), A('p1', 2)] },
  { name: 'L2 + pathologist: a second technologist cannot finish it (lab.pathologist_required); the pathologist can', level: 2, patho: true,
    steps: [V('t1', 1, 'approve'), E('t2', 'verify', 'lab.pathologist_required'), A('p1', 2)] },
  { name: 'L3 + pathologist: t1, t2 verify, pathologist approves', level: 3, patho: true, steps: [V('t1', 1, 'verify'), V('t2', 2, 'approve'), A('p1', 3)] },
  { name: 'L3 + pathologist: the third technologist cannot finish it', level: 3, patho: true,
    steps: [V('t1', 1, 'verify'), V('t2', 2, 'approve'), E('t3', 'verify', 'lab.pathologist_required'), A('p1', 3)] },
  // ---- no pathologist required: the count alone makes it final, by verifyResult or approveResult
  { name: 'L1 no pathologist: one technologist verify is final (approved)', level: 1, patho: false, steps: [V('t1', 1, 'none', 'approved')] },
  { name: 'L1 no pathologist: a pathologist approve from resulted is final too', level: 1, patho: false, steps: [A('p1', 1)] },
  { name: 'L2 no pathologist: two technologists', level: 2, patho: false, steps: [V('t1', 1, 'approve'), V('t2', 2, 'none', 'approved')] },
  { name: 'L2 no pathologist: technologist then pathologist approve', level: 2, patho: false, steps: [V('t1', 1, 'approve'), A('p1', 2)] },
  { name: 'L3 no pathologist: three technologists', level: 3, patho: false, steps: [V('t1', 1, 'verify'), V('t2', 2, 'approve'), V('t3', 3, 'none', 'approved')] },
  { name: 'L3 no pathologist: two technologists then the pathologist approve is final', level: 3, patho: false, steps: [V('t1', 1, 'verify'), V('t2', 2, 'approve'), A('p1', 3)] },
  // ---- after the end nothing more can be signed
  { name: 'L2 + pathologist: after the final sign-off verify and approve are lab.result_invalid_transition', level: 2, patho: true,
    steps: [V('t1', 1, 'approve'), A('p1', 2), E('t2', 'verify', 'lab.result_invalid_transition'), E('p1', 'approve', 'lab.result_invalid_transition')] },
  { name: 'L1 no pathologist: after the final sign-off a second verify is lab.result_invalid_transition', level: 1, patho: false,
    steps: [V('t1', 1, 'none', 'approved'), E('t2', 'verify', 'lab.result_invalid_transition')] },
];

describe.skipIf(!live)('verification level matrix (LD-316)', () => {
  it.each(ROWS.map((r) => [r.name, r] as const))('%s', { timeout: T * 3 }, async (_n, row) => {
    const k: Case = await newCase();
    await policyFor(k, row.level, { pathologist: row.patho });
    const who: Record<Step['by'], Who> = { t1: person('tech'), t2: person('tech'), t3: person('tech'), p1: person('patho') };
    let signed = 0;
    let before = await rowOf(k.id);
    // before the first sign-off the row says what is due next (lab.yaml ResultDto.next_step); the level is frozen only when the first sign-off is recorded
    const g0 = await getResult(who.t1, k.id);
    expect(g0.reply?.status, why(g0)).toBe(200);
    expect(dto(g0).next_step, 'before any sign-off').toBe(row.level === 1 ? 'approve' : 'verify');
    expect(dto(g0).signoff_count).toBe(0);

    for (const [i, s] of row.steps.entries()) {
      const label = `step ${i + 1} ${s.by} ${s.op}`;
      const out = s.op === 'verify' ? await verify(who[s.by], k.id) : await approve(who[s.by], k.id);
      const after = await rowOf(k.id);
      if (s.err) {
        expect(code(out), `${label}: ${why(out)}`).toBe(s.err);
        expect(after.status, `${label}: a refusal changes nothing`).toBe(before.status);
        expect(after.signoff_count, label).toBe(before.signoff_count);
        expect(await chainOf(k.id), label).toHaveLength(signed);
        expect(eventsOf(out, SIGNED_OFF), `${label}: no event for a refusal`).toHaveLength(0);
        continue;
      }
      const ok = s.ok!;
      expect(out.reply?.status, `${label}: ${why(out)}`).toBe(200);
      const body = dto(out);
      signed += 1;
      // the answer
      expect([body.status, body.signoff_count, body.signoff_required, body.next_step], label).toEqual([ok.status, ok.count, row.level, ok.next]);
      // the row (frozen number, counter), same transaction as the status change
      expect([after.status, after.signoff_count, after.signoff_required], label).toEqual([ok.status, ok.count, row.level]);
      // the chain: one more row, snapshot of the signer
      const chain = await chainOf(k.id);
      expect(chain, label).toHaveLength(signed);
      const last = chain[chain.length - 1]!;
      const w = who[s.by];
      expect({ seq: last.seq, action: last.action, user: last.signer_user_id, name: last.signer_display_name, role: last.signer_role_code, path: last.signer_is_pathologist, v: last.result_version }, label)
        .toEqual({ seq: signed, action: s.op, user: w.userId, name: w.displayName, role: w.roleCode, path: s.by === 'p1', v: 1 });
      if (s.by === 'p1') expect([last.signer_registration_no, last.signer_signature_asset_id], `${label}: pathologist registration number and signature asset are snapshotted`).toEqual([w.registrationNo, w.signatureAssetId]);
      else expect(last.signer_signature_asset_id, `${label}: technologists carry no signature asset`).toBeNull();
      // events: one lab.result.signed_off per sign-off; the approved event only at the end; the existing event names are kept
      expect(eventsOf(out, SIGNED_OFF), label).toHaveLength(1);
      expect(eventsOf(out, 'lab.result.approved.v1'), `${label}: approved event only when final`).toHaveLength(ok.status === 'approved' ? 1 : 0);
      if (s.op === 'verify' && ok.status !== 'approved') expect(eventsOf(out, 'lab.result.verified.v1'), `${label}: verified event kept`).toHaveLength(1);
      if (ok.status === 'approved') { expect(after.status).toBe('approved'); expect(chain.some((c) => c.signer_is_pathologist) || !row.patho, 'a pathologist signed when one is required').toBe(true); }
      before = after;
    }
  });

  it('the invariant: signoff_count is the number of chain rows of the current version, signoff_required never changes once set', { timeout: T * 3 }, async () => {
    const k = await newCase();
    await policyFor(k, 3, { pathologist: false });
    const [a, b, c] = [person('tech'), person('tech'), person('tech')];
    const seen: number[] = [];
    for (const w of [a, b, c]) {
      const o = await verify(w, k.id);
      expect(o.reply?.status, why(o)).toBe(200);
      const r = await rowOf(k.id);
      seen.push(r.signoff_required ?? -1);
      expect(r.signoff_count).toBe((await chainOf(k.id)).filter((x) => x.result_version === r.current_version_no).length);
    }
    expect(seen).toEqual([3, 3, 3]);
  });

  it('default policy (no policy of its own): lab default level 2 with a pathologist reproduces today exactly: verify, then approve by a different pathologist', { timeout: T * 3 }, async () => {
    const k = await newCase();   // no policyFor: test, department and the lab default apply (tenant A lab policy = 2 / pathologist / enterer no, seed 020)
    const [t, p] = [person('tech'), person('patho')];
    const v = await verify(t, k.id);
    expect(v.reply?.status, why(v)).toBe(200);
    expect([dto(v).status, dto(v).signoff_count, dto(v).signoff_required, dto(v).next_step]).toEqual(['verified', 1, 2, 'approve']);
    const a = await approve(p, k.id);
    expect(a.reply?.status, why(a)).toBe(200);
    expect([dto(a).status, dto(a).signoff_count, dto(a).signoff_required, dto(a).next_step]).toEqual(['approved', 2, 2, 'none']);
    expect((await chainOf(k.id)).map((c) => [c.seq, c.action, c.signer_is_pathologist])).toEqual([[1, 'verify', false], [2, 'approve', true]]);
  });

  it('approve straight from resulted at the default level 2 is lab.result_invalid_transition (today: resulted > approved is not a transition)', { timeout: T * 3 }, async () => {
    const k = await newCase();
    const o = await approve(person('patho'), k.id);
    expect(code(o), why(o)).toBe('lab.result_invalid_transition');
    expect((await rowOf(k.id)).status).toBe('resulted');
  });

  it('final sign-off keeps the lock: approved result rows cannot be edited afterwards (locked exactly as today)', { timeout: T * 3 }, async () => {
    const k = await newCase();
    await policyFor(k, 1, { pathologist: true });
    expect((await approve(person('patho'), k.id)).reply?.status).toBe(200);
    const { api, withClaims, claimsOf, TENANT_A } = await import('../probes/kit.js');
    await expect(withClaims(api(), claimsOf(TENANT_A), (c) => c.query('UPDATE lab.results SET value_numeric = 9 WHERE id = $1', [k.id]))).rejects.toThrow(/immutable_row/);
  });
});
