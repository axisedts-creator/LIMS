// T0B-PARTYSET-1 done_when (2,5) doctor fields (additive): speciality, hospital, commission_bp (0..10000), national_id_number (masked in every read, full only via
// revealPartyIdNumber). createDoctor / updateDoctor / getDoctor / listDoctors / searchDoctors. Real PG17.
import { beforeEach, describe, expect, it } from 'vitest';
import { manifest } from '../../index.js';
import { ADMIN_A, ADMIN_B, P, T, TENANT_A, TENANT_B, auditRows, dbRow, fire, idem, ifm, mask, mkDoctor, ok, rejected, req, wipe } from '../../../partners/__tests__/partyset/helpers.js';

const M = { manifest: manifest as never };
const NID = 'SYN-NID-0001';
const create = (body: unknown) => fire('createDoctor', req({ headers: idem(), body }), ADMIN_A, M);
const update = (id: string, body: unknown, v = 1) => fire('updateDoctor', req({ params: { doctor_id: id }, headers: ifm(v), body }), ADMIN_A, M);
const get = (id: string, who = ADMIN_A) => fire('getDoctor', req({ params: { doctor_id: id } }), who, M);
const phone = () => `+1555555${String(Math.floor(Math.random() * 1e4)).padStart(4, '0')}`;
const BASE = () => ({ display_name: `Synthetic Doctor ${Math.random().toString(36).slice(2, 8)}`, phone_e164: phone(), quick_add: false });

beforeEach(async () => { await wipe(TENANT_A, TENANT_B); }, T);

describe('createDoctor / updateDoctor with the new fields', () => {
  it('stores speciality, hospital, commission_bp and the FULL national_id_number; the reply shows the id masked', async () => {
    const o = await create({ ...BASE(), speciality: 'Pathology (synthetic)', hospital: 'Synthetic Hospital', commission_bp: 1500, national_id_number: NID });
    const b = ok(o, 201);
    expect(b).toMatchObject({ speciality: 'Pathology (synthetic)', hospital: 'Synthetic Hospital', commission_bp: 1500, national_id_number: mask(NID) });
    expect(JSON.stringify([b, o.probe.logs])).not.toContain(NID);
    expect(await dbRow('catalog.doctors', b.id)).toMatchObject({ speciality: 'Pathology (synthetic)', hospital: 'Synthetic Hospital', commission_bp: 1500, national_id_number: NID });
    expect(JSON.stringify(await auditRows('catalog.doctors', b.id))).not.toContain(NID);
  }, T);
  it('update round trip; an omitted field keeps its value; reads (get, list, search) are masked', async () => {
    const d = await mkDoctor(TENANT_A, { speciality: 'Cardiology', national_id_number: NID });
    const u = ok(await update(d.id, { hospital: 'Synthetic Clinic', commission_bp: 250 }));
    expect(u).toMatchObject({ speciality: 'Cardiology', hospital: 'Synthetic Clinic', commission_bp: 250, national_id_number: mask(NID) });
    const g = await get(d.id);
    expect(ok(g)).toMatchObject({ national_id_number: mask(NID), commission_bp: 250 });
    const l = await fire('listDoctors', req({ query: { is_active: 'all' } }), ADMIN_A, M);
    expect(ok(l).data.find((x: any) => x.id === d.id)).toMatchObject({ national_id_number: mask(NID) });
    const s = await fire('searchDoctors', req({ body: { q: d.display_name, limit: 5 } }), ADMIN_A, M);
    expect(JSON.stringify(ok(s))).not.toContain(NID);
    for (const o of [g, l, s]) expect(JSON.stringify([o.reply?.body, o.probe.logs])).not.toContain(NID);
  }, T);
  it.each([
    ['commission_bp', -1], ['commission_bp', 10001], ['commission_bp', 1.5], ['commission_bp', '5'],
    ['speciality', ''], ['speciality', 's'.repeat(121)], ['hospital', ''], ['hospital', 'h'.repeat(201)],
    ['national_id_number', ''], ['national_id_number', 'N'.repeat(33)], ['national_id_number', 'NI\u0000D'], ['national_id_number', 'NI<D1'], ['national_id_number', "NI'D1"], ['national_id_number', 9],
  ])('%s = %j is refused with its path, never echoed, nothing written', async (field, value) => {
    const d = await mkDoctor(TENANT_A);
    const o = await update(d.id, { [field]: value });
    rejected(o, 'common.validation_failed', `/${field}`, typeof value === 'string' && value.length > 4 ? value : undefined);
    expect(o.probe.writes).toEqual([]);
    const c = await create({ ...BASE(), [field]: value });
    rejected(c, 'common.validation_failed', `/${field}`);
  }, T);
  it('commission_bp 0 and 10000 are valid', async () => {
    const d = await mkDoctor(TENANT_A);
    expect(ok(await update(d.id, { commission_bp: 0 })).commission_bp).toBe(0);
    expect(ok(await update(d.id, { commission_bp: 10000 }, 2)).commission_bp).toBe(10000);
  }, T);
  it('another tenant cannot read or update the doctor (common.not_found), and sees no id value', async () => {
    const d = await mkDoctor(TENANT_A, { national_id_number: NID });
    rejected(await get(d.id, ADMIN_B), 'common.not_found');
    rejected(await fire('updateDoctor', req({ params: { doctor_id: d.id }, headers: ifm(1), body: { hospital: 'x' } }), ADMIN_B, M), 'common.not_found');
    expect((await dbRow('catalog.doctors', d.id)).hospital).toBeNull();
  }, T);
  it('reveal: the doctor id number comes only from revealPartyIdNumber (permission + audit)', async () => {
    const { manifest: partners } = await import('../../../partners/index.js');
    const d = await mkDoctor(TENANT_A, { national_id_number: NID });
    const o = await fire('revealPartyIdNumber', req({ params: { party_kind: 'doctor', party_id: d.id }, body: { field: 'national_id_number' } }), ADMIN_A, { manifest: partners as never });
    expect(ok(o).value).toBe(NID);
    expect(o.probe.identity).toContain(P.idRead);
    expect(o.probe.access).toHaveLength(1);
    expect(JSON.stringify(o.probe.access)).not.toContain(NID);
  }, T);
});
