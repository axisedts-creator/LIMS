// T0B-VERLEVEL-1 (LD-316) done_when (6) AMEND, (8) QUEUE, (9) EVENTS and the read side of the chain (getResultSignoffs).
//   AMEND: amendResult starts a new chain for the new result version; the old chain stays readable (append only).
//   QUEUE: listVerificationQueue returns signoff_count, signoff_required, next_step and a flag for results the caller already signed (the caller does not see those as theirs to act on).
//   EVENTS: the existing lab.result.verified.v1 / lab.result.approved.v1 names stay; one lab.result.signed_off.v1 per sign-off (contracts/events/lab.result.signed_off.v1.schema.json, writer creates).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../../../core/module.js';
import { T, closePools, live, objs, requireDb, seedResult, FULL_A } from '../probes/kit.js';
import { SIGNED_OFF, amend, approve, chainOf, code, dto, eventsOf, newCase, person, policyFor, rowOf, signoffs, verify, why } from './helpers.js';

afterAll(async () => { await closePools(); });
describe('harness', () => { it('the migrated database is provided (fails, never skips, under LIMS_T03_REQUIRE_DB=1)', () => { if (requireDb) expect(live).toBe(true); }); });

const SCHEMA_KEYS = ['result_version', 'seq', 'action', 'signer_user_id', 'signer_display_name', 'signer_title', 'signer_role_code', 'signer_is_pathologist', 'signer_registration_no', 'signed_at'];

describe.skipIf(!live)('getResultSignoffs (lab.result.read)', () => {
  it('returns the chain ordered by version then seq with the signer snapshot; only contract fields (no signature asset, no tenant id)', { timeout: T * 3 }, async () => {
    const k = await newCase(); await policyFor(k, 2);
    const [t, p] = [person('tech'), person('patho')];
    expect((await verify(t, k.id)).reply?.status).toBe(200);
    expect((await approve(p, k.id)).reply?.status).toBe(200);
    const o = await signoffs(person('tech'), k.id);
    expect(o.reply?.status, why(o)).toBe(200);
    const rows = dto(o).data;
    expect(rows).toHaveLength(2);
    expect(rows.map((r: any) => [r.result_version, r.seq, r.action, r.signer_user_id, r.signer_display_name, r.signer_role_code, r.signer_is_pathologist])).toEqual([
      [1, 1, 'verify', t.userId, t.displayName, 'lab_technologist', false], [1, 2, 'approve', p.userId, p.displayName, 'pathologist', true]]);
    expect(rows[1].signer_registration_no).toBe(p.registrationNo);
    expect(rows[0].signer_registration_no, 'a technologist without a registration number carries none').toBeUndefined();
    for (const r of rows) {
      expect(Object.keys(r).filter((x) => !SCHEMA_KEYS.includes(x)), 'only contract fields (additionalProperties false)').toEqual([]);
      expect(typeof r.signed_at).toBe('string');
    }
    expect(JSON.stringify(rows)).not.toContain(String(p.signatureAssetId));
  });
  it('a legacy approved result (before sign-off chains) reads an empty chain; an unknown id is 404; a caller without lab.result.read is 403', { timeout: T * 3 }, async () => {
    const S = await objs('a');
    const legacy = await seedResult(S, { status: 'approved' });
    const o = await signoffs(FULL_A, legacy);
    expect(o.reply?.status, why(o)).toBe(200);
    expect(dto(o)).toEqual({ data: [] });
    expect(code(await signoffs(person('tech'), '01a1a98a-ac40-7000-8000-00000000dead'))).toBe('common.not_found');
    expect(code(await signoffs(person('tech', 'a', { grants: [] }), legacy))).toBe('auth.forbidden');
  });
  it('the chain is append only evidence: reading it twice gives the same rows after more people sign (earlier rows never change)', { timeout: T * 3 }, async () => {
    const k = await newCase(); await policyFor(k, 3, { pathologist: false });
    expect((await verify(person('tech'), k.id)).reply?.status).toBe(200);
    const first = dto(await signoffs(person('tech'), k.id)).data;
    expect((await verify(person('tech'), k.id)).reply?.status).toBe(200);
    const second = dto(await signoffs(person('tech'), k.id)).data;
    expect(second.slice(0, 1)).toEqual(first);
    expect(second).toHaveLength(2);
  });
});

describe.skipIf(!live)('amend starts a new chain for the new version; the old chain stays readable (done_when 6)', () => {
  it('after the final sign-off a pathologist amends: version 2, the version 1 chain is unchanged and still readable, new rows belong to version 2 and start at seq 1', { timeout: T * 5 }, async () => {
    const k = await newCase(); await policyFor(k, 2);
    const [t, p, p2] = [person('tech'), person('patho'), person('patho')];
    expect((await verify(t, k.id)).reply?.status).toBe(200);
    expect((await approve(p, k.id)).reply?.status).toBe(200);
    const v1 = await chainOf(k.id);
    expect(v1).toHaveLength(2);
    const o = await amend(p2, k.id);
    expect(o.reply?.status, why(o)).toBe(200);
    const row = await rowOf(k.id);
    expect([row.status, row.current_version_no]).toEqual(['approved', 2]);
    const all = await chainOf(k.id);
    expect(all.filter((c) => c.result_version === 1), 'version 1 chain is exactly as it was').toEqual(v1);
    const v2 = all.filter((c) => c.result_version === 2);
    if (v2.length > 0) expect(v2.map((c) => c.seq)).toEqual(v2.map((_, i) => i + 1));
    expect(all.every((c) => c.result_version <= 2)).toBe(true);
    expect(row.signoff_count, 'the counter belongs to the current version: it equals the number of its chain rows').toBe(v2.length);
    const read = dto(await signoffs(person('tech'), k.id)).data;
    expect(read.filter((r: any) => r.result_version === 1).map((r: any) => [r.seq, r.action, r.signer_user_id])).toEqual([[1, 'verify', t.userId], [2, 'approve', p.userId]]);
    expect(read.map((r: any) => r.result_version), 'ordered by version then seq').toEqual([...read.map((r: any) => r.result_version)].sort((a, b) => a - b));
    // an amended, approved result cannot be signed off again through verify / approve
    expect(code(await verify(person('tech'), k.id))).toBe('lab.result_invalid_transition');
    expect(code(await approve(person('patho'), k.id))).toBe('lab.result_invalid_transition');
  });
});

describe.skipIf(!live)('listVerificationQueue (done_when 8)', () => {
  const trueKeys = (o: any): string[] => Object.entries(o ?? {}).flatMap(([k, v]) => (v === true ? [k] : v && typeof v === 'object' && !Array.isArray(v) ? Object.entries(v).filter(([, x]) => x === true).map(([x]) => `${k}.${x}`) : []));
  const fireQ = async (who: any, stage: 'verify' | 'approve', department: string) => {
    const { fire, req } = await import('../probes/kit.js');
    return fire('listVerificationQueue', req({ query: { stage, department_id: department } }), who);
  };
  const find = (o: any, id: string) => (dto(o)?.data ?? []).find((x: any) => x.result?.id === id);

  it('default policy = today: a resulted row is in the verify stage, after the technologist verifies it moves to the approve stage; items carry signoff_count, signoff_required, next_step', { timeout: T * 4 }, async () => {
    const k = await newCase();
    const [t, t2, p] = [person('tech'), person('tech'), person('patho')];
    const v0 = await fireQ(t2, 'verify', k.departmentId);
    expect(v0.reply?.status, why(v0)).toBe(200);
    const item = find(v0, k.id);
    expect(item, 'resulted row is in the verify stage').toBeDefined();
    expect([item.result.signoff_count, item.result.next_step]).toEqual([0, 'verify']);
    expect(find(await fireQ(p, 'approve', k.departmentId), k.id), 'not in the approve stage yet').toBeUndefined();
    expect((await verify(t, k.id)).reply?.status).toBe(200);
    expect(find(await fireQ(t2, 'verify', k.departmentId), k.id), 'verified at level 2: nothing more to verify').toBeUndefined();
    const a = find(await fireQ(p, 'approve', k.departmentId), k.id);
    expect(a, 'now in the approve stage').toBeDefined();
    expect([a.result.status, a.result.signoff_count, a.result.signoff_required, a.result.next_step]).toEqual(['verified', 1, 2, 'approve']);
  });
  it('level 3: after the first sign-off the row stays in the verify stage for the next technologist, and the first signer sees it flagged as already signed (or not at all)', { timeout: T * 4 }, async () => {
    const k = await newCase(); await policyFor(k, 3);
    const [t1, t2] = [person('tech'), person('tech')];
    expect((await verify(t1, k.id)).reply?.status).toBe(200);
    const { fire, req } = await import('../probes/kit.js');
    const view = (who: any) => fire('listVerificationQueue', req({ query: { stage: 'verify', department_id: k.departmentId } }), who);
    const theirs = find(await view(t2), k.id);
    expect(theirs, 'the second technologist still has to verify it').toBeDefined();
    expect([theirs.result.signoff_count, theirs.result.signoff_required, theirs.result.next_step]).toEqual([1, 3, 'verify']);
    const mine = find(await view(t1), k.id);
    if (mine) {
      // the caller already signed: shown with a flag, never as theirs to act on. The flag name is not in lab.yaml (VerificationQueueItem is closed): the writer names it (CR / ruling), the test only needs ONE extra true flag.
      const extra = trueKeys(mine).filter((x) => !trueKeys(theirs).includes(x));
      expect(extra.length, `item for the signer must carry a flag the other technologist's item does not: ${JSON.stringify(mine)}`).toBeGreaterThanOrEqual(1);
    }
  });
  it('a pathologist who already verified a level 2 result does not get it in the approve stage as theirs to approve (self approval is forbidden)', { timeout: T * 4 }, async () => {
    const k = await newCase(); await policyFor(k, 2);
    const p = person('patho');
    expect((await verify(p, k.id)).reply?.status).toBe(200);
    const { fire, req } = await import('../probes/kit.js');
    const mine = find(await fire('listVerificationQueue', req({ query: { stage: 'approve', department_id: k.departmentId } }), p), k.id);
    const other = find(await fire('listVerificationQueue', req({ query: { stage: 'approve', department_id: k.departmentId } }), person('patho')), k.id);
    expect(other, 'another pathologist sees it').toBeDefined();
    if (mine) expect(trueKeys(mine).filter((x) => !trueKeys(other).includes(x)).length, 'flagged for the signer').toBeGreaterThanOrEqual(1);
  });
  it('the queue never leaks tenant B rows and needs lab.result.read', { timeout: T * 3 }, async () => {
    const b = await newCase({ side: 'b' });
    const { fire, req } = await import('../probes/kit.js');
    const o = await fire('listVerificationQueue', req({ query: { stage: 'verify', department_id: b.departmentId } }), person('tech'));
    expect(o.reply?.status, why(o)).toBe(200);
    expect(JSON.stringify(dto(o))).not.toContain(b.id);
    expect(code(await fire('listVerificationQueue', req({ query: { stage: 'verify' } }), person('tech', 'a', { grants: [] })))).toBe('auth.forbidden');
  });
});

describe.skipIf(!live)('events (done_when 9)', () => {
  const load = () => { const schema = JSON.parse(readFileSync(join(REPO_ROOT, 'contracts/events/lab.result.signed_off.v1.schema.json'), 'utf8')); return { schema, payloadDef: schema.$defs?.Payload }; };
  it('the event contract exists: lab.result.signed_off.v1, aggregate type result, closed payload without PHI (no value, no names, no registration number, no signature)', () => {
    const { schema, payloadDef } = load();
    expect(schema.$id).toBe('urn:lims:event:lab.result.signed_off.v1');
    expect(JSON.stringify(schema)).toContain('"lab.result.signed_off.v1"');
    expect(payloadDef.additionalProperties).toBe(false);
    const props = Object.keys(payloadDef.properties);
    expect(payloadDef.required).toEqual(expect.arrayContaining(['result_id', 'result_version_no']));
    for (const bad of ['value', 'value_numeric', 'value_text', 'signer_display_name', 'signer_registration_no', 'signer_signature_asset_id', 'registration_no', 'barcode', 'patient_name']) expect(props, bad).not.toContain(bad);
  });
  it('each sign-off publishes ONE lab.result.signed_off.v1 (aggregate result, own idempotency key, payload matches the schema); the old verified / approved events keep their names', { timeout: T * 4 }, async () => {
    const { payloadDef } = load();
    const k = await newCase(); await policyFor(k, 2);
    const v = await verify(person('tech'), k.id);
    const a = await approve(person('patho'), k.id);
    const [e1, e2] = [eventsOf(v, SIGNED_OFF), eventsOf(a, SIGNED_OFF)];
    expect([e1.length, e2.length]).toEqual([1, 1]);
    for (const e of [e1[0]!, e2[0]!]) {
      expect(e.input.aggregate).toMatchObject({ type: 'result', id: k.id });
      const keys = Object.keys(e.input.payload);
      expect(keys.filter((x) => !Object.keys(payloadDef.properties).includes(x)), 'no key outside the schema').toEqual([]);
      for (const r of payloadDef.required) expect(keys, r).toContain(r);
      expect(e.input.payload.result_id).toBe(k.id);
      expect(e.input.payload.result_version_no).toBe(1);
    }
    expect(e1[0]!.input.idempotencyKey).not.toBe(e2[0]!.input.idempotencyKey);
    expect(String(e1[0]!.input.idempotencyKey)).toContain(k.id);
    expect(eventsOf(v, 'lab.result.verified.v1')).toHaveLength(1);
    expect(eventsOf(v, 'lab.result.approved.v1')).toHaveLength(0);
    expect(eventsOf(a, 'lab.result.approved.v1')).toHaveLength(1);
    expect(eventsOf(a, 'lab.result.verified.v1')).toHaveLength(0);
  });
  it('a refused sign-off publishes nothing', { timeout: T * 3 }, async () => {
    const k = await newCase(); await policyFor(k, 3);
    const t = person('tech');
    expect((await verify(t, k.id)).reply?.status).toBe(200);
    const again = await verify(t, k.id);
    expect(code(again)).toBe('lab.verifier_not_distinct');
    expect(again.probe.events).toEqual([]);
  });
});
