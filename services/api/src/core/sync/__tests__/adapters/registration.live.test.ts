// T0B-SYNC-3 done_when (1), (2), (5), (6): registration.create_order through the real engine + the real adapter on a real PG17 (RLS on); the frontdesk SERVICE LAYER (`create`, `quote`)
// is replaced by recording doubles (./doubles.ts) that write through ctx.tx, so a rolled back operation must leave no effect and no number. Pinned surface: ./doubles.ts header.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../../../modules/frontdesk/service/registration.service.js', async (orig) => (await import('./doubles.js')).registrationMock(orig as never));
vi.mock('../../../../modules/billing/service/ledger.service.js', async (orig) => (await import('./doubles.js')).ledgerMock(orig as never));
vi.mock('../../../../modules/lab/service/specimen.service.js', async (orig) => (await import('./doubles.js')).specimenMock(orig as never));
import { LimsError } from '../../../errors.js';
import { A1, B1, TENANT_A, TENANT_B, USER, CENTRE, code, conflictsOf, devicePush, engine, ledger, newDevice, okBody, op, ownerRows, reserve, setCounters, uid, ok } from '../helpers2.js';
import { behave, calls, ensureCounter, lastNo, nextNo, registrationPayload, reset, NEW_PATIENT } from './doubles.js';
import { registrationCreateOrderAdapter } from '../../../../modules/frontdesk/sync/registration.adapter.js';

const T = 120_000;
const H = engine({}, [registrationCreateOrderAdapter]);
const reg = (o: Record<string, unknown> = {}, centre: string = CENTRE.a1): any => ({ ...op('registration.create_order', { payload: registrationPayload(centre) }), ...o });
const one = (o: any): any => okBody(o).results[0];
const PROVISIONAL = /^OFF-[A-Za-z0-9-]+$/;
beforeAll(ensureCounter);
beforeEach(reset);

describe('the adapter calls the frontdesk service layer as the signed in user (done_when 1, 5)', () => {
  it('accepted: create() ran once with the SAME actor and tenant, the payload untouched, and the entity id is the new order', async () => {
    const dev = await newDevice(A1);
    const r = reg();
    const res = one(await devicePush(H, A1, dev, [r]));
    expect(res).toMatchObject({ op_id: r.op_id, status: 'accepted' });
    expect(res.entity_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls.create).toHaveLength(1);
    const c = calls.create[0]!;
    expect(c.ctx.tenantId).toBe(TENANT_A);
    expect(c.ctx.actor).toMatchObject({ id: USER.a1, membershipId: USER.a1, type: 'user' });   // the original actor, never a system / sync actor
    expect(c.args[0]).toEqual(r.payload);
  }, T);
  it('a payload the service refuses is rejected per operation with the closed code and leaves no effect and no number', async () => {
    const dev = await newDevice(A1);
    behave.create = async (ctx: any) => { await nextNo(ctx, 'INV'); throw new LimsError('frontdesk.referrer_required'); };
    const before = await lastNo(TENANT_A, 'INV');
    const r = reg();
    expect(one(await devicePush(H, A1, dev, [r]))).toMatchObject({ status: 'rejected', error_code: 'frontdesk.referrer_required' });
    expect(await lastNo(TENANT_A, 'INV')).toBe(before);
  }, T);
  it('permission removed meanwhile: rejected auth.forbidden, the service is never called', async () => {
    const dev = await newDevice(A1);
    const r = reg();
    const o = await devicePush(H, A1, dev, [r], { grants: { codes: ['sync.use'] } });
    expect(one(o)).toMatchObject({ status: 'rejected', error_code: 'auth.forbidden' });
    expect(calls.create).toHaveLength(0);
    expect(o.asserted).toContain('frontdesk.registration.create');
  }, T);
  it('cross tenant: a tenant B user runs it as tenant B only', async () => {
    const dev = await newDevice(B1);
    const r = reg({}, CENTRE.b1);
    expect(one(await devicePush(H, B1, dev, [r]))).toMatchObject({ status: 'accepted' });
    expect(calls.create[0]!.ctx.tenantId).toBe(TENANT_B);
    expect(calls.create[0]!.ctx.actor.id).toBe(USER.b1);
    expect((await ledger([r.op_id])).map((x) => x.tenant_id)).toEqual([TENANT_B]);
  }, T);
  it('replay of the same operation: duplicate with the first outcome, create() ran once', async () => {
    const dev = await newDevice(A1);
    const r = reg();
    const first = one(await devicePush(H, A1, dev, [r]));
    const again = one(await devicePush(H, A1, dev, [r]));
    expect(again).toMatchObject({ status: 'duplicate', entity_id: first.entity_id, number_mappings: first.number_mappings });
    expect(calls.create).toHaveLength(1);
  }, T);
});

describe('provisional to final numbers (done_when 2, 3; design section 4)', () => {
  it('invoice and receipt come back as OFF- provisional -> final mappings; a replay returns the identical mapping', async () => {
    const dev = await newDevice(A1);
    const r = reg();
    const first = one(await devicePush(H, A1, dev, [r]));
    const m: any[] = first.number_mappings;
    expect(m.map((x) => x.document_type).sort()).toEqual(['invoice', 'receipt']);
    for (const x of m) { expect(x.provisional_number).toMatch(PROVISIONAL); expect(x.provisional_number.length).toBeLessThanOrEqual(60); expect(x.final_number).toMatch(/^(INV|RC)-2083-\d{6}$/); expect(x.final_number).not.toMatch(/^OFF-/); }
    expect(new Set(m.map((x) => x.provisional_number)).size).toBe(m.length);
    const again = one(await devicePush(H, A1, dev, [r]));
    expect(again.status).toBe('duplicate');
    expect(again.number_mappings).toEqual(m);
  }, T);
  it('final numbers are assigned in server arrival order, one after the other (no gap, no repeat)', async () => {
    const dev = await newDevice(A1);
    const start = await lastNo(TENANT_A, 'INV');
    const ops = [0, 1, 2].map((i) => reg({}, CENTRE.a1)).map((x, i) => ({ ...x, device_created_at: new Date(Date.parse(x.device_created_at) + i * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') }));
    const rs = okBody(await devicePush(H, A1, dev, ops)).results;
    const finals = rs.map((x: any) => Number(x.number_mappings.find((m: any) => m.document_type === 'invoice').final_number.slice(-6)));
    expect(finals).toEqual([start + 1, start + 2, start + 3]);
  }, T);
});

describe('reserved patient id and lab codes belong to the block of that device (done_when 2)', () => {
  let dev: string; let other: string; let pBlock: any; let lBlock: any;
  beforeAll(async () => {
    await setCounters(TENANT_A, { patient: 1000, lab: 5000 });
    dev = await newDevice(A1); other = await newDevice(A1);
    pBlock = ok(await reserve(A1, dev, 'patient_id', 100)).block; lBlock = ok(await reserve(A1, dev, 'lab_code', 200)).block;
    await reserve(A1, other, 'patient_id', 100);
  }, T);
  const rn = (patient: number | undefined, labs: number[] | undefined): any => ({ reserved_numbers: { ...(patient !== undefined ? { patient_id: patient } : {}), ...(labs ? { lab_codes: labs } : {}) } });

  it('inside the block of this device (first and last number): accepted', async () => {
    const r1 = reg(rn(pBlock.from_value, [lBlock.from_value, lBlock.to_value]));
    const r2 = reg(rn(pBlock.to_value, undefined));
    const rs = okBody(await devicePush(H, A1, dev, [r1, r2])).results;
    expect(rs.map((x: any) => x.status)).toEqual(['accepted', 'accepted']);
  }, T);
  it('a patient id just outside the block (one below, one above) is rejected sync.number_out_of_block and nothing is created', async () => {
    for (const n of [pBlock.from_value - 1, pBlock.to_value + 1]) {
      const r = reg(rn(n, undefined));
      expect(one(await devicePush(H, A1, dev, [r]))).toMatchObject({ status: 'rejected', error_code: 'sync.number_out_of_block' });
    }
    expect(calls.create).toHaveLength(0);
  }, T);
  it('one lab code outside the block rejects the whole operation, even when the patient id is inside', async () => {
    const r = reg(rn(pBlock.from_value, [lBlock.from_value, lBlock.to_value + 1]));
    expect(one(await devicePush(H, A1, dev, [r]))).toMatchObject({ status: 'rejected', error_code: 'sync.number_out_of_block' });
    expect(calls.create).toHaveLength(0);
  }, T);
  it('a number of ANOTHER device block (same user) is out of block for this device', async () => {
    const ob = (await ownerRows(`SELECT from_value FROM core.number_block WHERE device_id = $1 AND series = 'patient_id'`, [other]))[0];
    const r = reg(rn(Number(ob.from_value), undefined));
    expect(one(await devicePush(H, A1, dev, [r]))).toMatchObject({ status: 'rejected', error_code: 'sync.number_out_of_block' });
  }, T);
  it('a patient id is not a lab code: a lab series number inside the lab block but sent as patient id is rejected', async () => {
    const r = reg(rn(lBlock.from_value, undefined));
    expect(one(await devicePush(H, A1, dev, [r]))).toMatchObject({ status: 'rejected', error_code: 'sync.number_out_of_block' });
  }, T);
  it('malformed reserved numbers (negative, fraction, string, too many) are rejected common.validation_failed for the whole request', async () => {
    for (const bad of [{ patient_id: -1 }, { patient_id: 1.5 }, { patient_id: '1001' }, { lab_codes: 'x' }, { lab_codes: Array.from({ length: 51 }, (_, i) => i) }, { other: 1 }]) {
      const o = await devicePush(H, A1, dev, [reg({ reserved_numbers: bad })]);
      expect(code(o) ?? one(o).error_code, JSON.stringify(bad)).toBe('common.validation_failed');
    }
  }, T);
  it('no reserved numbers (block ran out, label shows PENDING): accepted, the server finalises', async () => {
    expect(one(await devicePush(H, A1, dev, [reg()]))).toMatchObject({ status: 'accepted' });
  }, T);
});

describe('conflicts instead of silent changes (done_when 2)', () => {
  it('a patient registered on the server meanwhile (duplicate rule): CONFLICT with a merge suggestion, never a second patient, the order is not created', async () => {
    const dev = await newDevice(A1);
    const existing = uid();
    behave.create = async (ctx: any) => {
      await nextNo(ctx, 'INV');
      await ctx.tx.query(`INSERT INTO sync2_test.effect (tenant_id, op_id, op_type, actor_id, tag) VALUES ($1, $2, 'svc', $3, 'second-patient')`, [ctx.tenantId, uid(), ctx.actor.id]);
      throw Object.assign(new LimsError('frontdesk.patient_duplicate_suspected'), { candidates: [{ id: existing, patient_code: 'P-000042' }] });
    };
    const before = await lastNo(TENANT_A, 'INV');
    const r = reg();
    const res = one(await devicePush(H, A1, dev, [r]));
    expect(res).toMatchObject({ status: 'conflict', error_code: 'frontdesk.patient_duplicate_suspected' });
    expect(res.conflict_id).toMatch(/^[0-9a-f-]{36}$/);
    const [c] = await conflictsOf([r.op_id]);
    expect(c.entity_type).toBe('patient');
    expect(c.server_payload.merge_suggestion.patient_id).toBe(existing);
    expect(c.local_payload).toEqual(r.payload);
    expect(await lastNo(TENANT_A, 'INV')).toBe(before);
    expect((await ownerRows(`SELECT 1 FROM sync2_test.effect WHERE tag = 'second-patient' AND tenant_id = $1 AND actor_id = $2 AND at > now() - interval '1 minute'`, [TENANT_A, USER.a1])).length).toBe(0);
    expect(JSON.stringify(c.server_payload)).not.toContain(NEW_PATIENT.full_name);   // the server version never repeats the offline person
  }, T);
  it('price changed on the server: CONFLICT carrying the server total next to the offline payload, money unchanged, no number consumed', async () => {
    const dev = await newDevice(A1);
    behave.create = async (ctx: any) => { await nextNo(ctx, 'INV'); await nextNo(ctx, 'RC'); throw new LimsError('common.version_conflict', 'Prices changed'); };
    const inv = await lastNo(TENANT_A, 'INV'), rc = await lastNo(TENANT_A, 'RC');
    const r = reg();
    const res = one(await devicePush(H, A1, dev, [r]));
    expect(res).toMatchObject({ status: 'conflict', error_code: 'common.version_conflict' });
    const [c] = await conflictsOf([r.op_id]);
    expect(JSON.stringify(c.server_payload)).toContain('120000');                   // the server total from quote(), paisa
    expect(JSON.stringify(c.server_payload)).toContain('e'.repeat(64));             // the server fingerprint, to compare with the device one
    expect(c.local_payload.quote_fingerprint).toBe('a'.repeat(64));                  // the device side: what the device saw
    expect(calls.quote).toHaveLength(1);
    expect(await lastNo(TENANT_A, 'INV')).toBe(inv); expect(await lastNo(TENANT_A, 'RC')).toBe(rc);
  }, T);
  it('a conflict is not repeated by a replay: duplicate with the same conflict id, create() ran once', async () => {
    const dev = await newDevice(A1);
    behave.create = async () => { throw new LimsError('common.version_conflict'); };
    const r = reg();
    const a = one(await devicePush(H, A1, dev, [r])); const b = one(await devicePush(H, A1, dev, [r]));
    expect(a.status).toBe('conflict'); expect(b).toMatchObject({ status: 'duplicate', conflict_id: a.conflict_id });
    expect(calls.create).toHaveLength(1);
    expect(await conflictsOf([r.op_id])).toHaveLength(1);
  }, T);
});

describe('no personal data in logs or results (done_when 5)', () => {
  it('neither the logs of the request nor the result carry the name or phone of the offline person, also when the service fails', async () => {
    const dev = await newDevice(A1);
    behave.create = async () => { throw new Error(`boom ${NEW_PATIENT.full_name}`); };
    const o = await devicePush(H, A1, dev, [reg()]);
    const blob = JSON.stringify(o.reply?.body) + o.logs.join('\n');
    expect(blob).not.toContain('Testperson'); expect(blob).not.toContain(NEW_PATIENT.phone_e164);
    expect(one(o)).toMatchObject({ status: 'rejected', error_code: 'common.internal' });
  }, T);
});
