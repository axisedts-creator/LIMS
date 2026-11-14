// C16.T-BK1 — E37 listMyAddresses, E38 createMyAddress, E39 updateMyAddress, E40 deactivateMyAddress (patient addresses for home collection; A19).
// (06-PLAN row T-BK1 "address ownership"; 02-TRD §5 E37-E40 (≤ 10 per account [CONV]), §9.1; 05-SCHEMA addresses (account_id NULL when staff-entered; P2 PII), PAT_ACC; 01-PRD US-EN-13.1;
//  07-SECURITY AB-6, REQ-SEC-024 / 098 (addresses never in logs / URLs / event payloads), §6.1 / §6.3 probes.)
// Fails now: handlers/index.ts maps these four operationIds to the T-01 placeholder (common.service_unavailable).
//
// SEAMS (same conventions as mybookings.handlers.test.ts; world = __tests__/mybooking.world.ts):
//   E37 GET (query profile_id? = link id) -> 200 {data: Address[] (≤ 10)}; E38 POST body AddressInput {profile_id (link id), label, address_text, ...} -> 201 Address (profile_id = link id, version 1);
//   E39 PUT /{address_id} body AddressInput + If-Match -> 200 Address (version + 1); E40 POST /{address_id}/deactivate + If-Match -> 204 (no body), is_active false, version + 1.
//   The row's account_id = the caller's account (from claims, never from input), patient_id = the profile's patient (the link's patient_id, never from input). Only ACTIVE links may own addresses (P-L5).
//   RLS: a patient sees only account_id = own; the service must still bind account_id / tenant_id. Foreign / staff-entered / unknown / tenant-B ids -> 404 common.not_found (AB-6), checked BEFORE version.
//   If-Match: absent -> 428 common.precondition_required BEFORE any DB access; malformed -> 400; stale -> 409 common.version_conflict.
// NOT pinned (spec silent): cursor / paging of E37 (≤ 10 rows, no cursor), NFC normalisation, whether a deactivated address still counts toward the 10 cap, changing profile_id on E39, idempotent re-deactivate.
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, loadSpec } from '../../../../core/module.js';
import { handlers } from '../../handlers/index.js';
import { ID, PERMS, S, SLOT, makeBookingWorld, plus, type Row } from '../../__tests__/mybooking.world.js';

const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/engagement.yaml'));
const requireAjv = createRequire(createRequire(import.meta.url).resolve('@fastify/ajv-compiler'));
const Ajv2020 = requireAjv('ajv/dist/2020.js').default as new (o: object) => any;
const ajv = new Ajv2020({ strict: false, allErrors: true });
const schemaErrors = (name: string, x: unknown): string[] => { const v = ajv.compile({ $ref: `#/components/schemas/${name}`, components: spec.components }); return v(x) ? [] : (v.errors as any[]).map((e) => `${e.instancePath} ${e.message}`); };
const opOf = (id: string): any => { for (const p of Object.values<any>(spec.paths)) for (const m of Object.values<any>(p)) if (m?.operationId === id) return m; };
const hdr = (res: any, name: string): unknown => { const k = Object.keys(res?.headers ?? {}).find((h) => h.toLowerCase() === name.toLowerCase()); return k ? res.headers[k] : undefined; };

const X = ID(0x800), X2 = ID(0x801), Y = ID(0x802);
const IDEM = { 'idempotency-key': 'k-bk1-addr-01' };
const ifm = (v: number | string) => ({ 'if-match': typeof v === 'number' ? `"${v}"` : v });
const code = (r: { error?: any }) => r.error?.code;
const expectErr = (r: { error?: any; out?: any }, c: string, status?: number) => { expect(r.out, `expected ${c}, got a response`).toBeUndefined(); expect(r.error?.code).toBe(c); if (status) expect(r.error?.statusCode).toBe(status); };

function setup() {
  const w = makeBookingWorld(); const a1 = w.seedAccount(), a2 = w.seedAccount({ phone_e164: '+99001000002' });
  const lx = w.seedLink(a1, X, { sex_snapshot: 'female' }), lx2 = w.seedLink(a1, X2, { relationship: 'child' }), ly = w.seedLink(a2, Y);
  const run = (op: string, req: any = {}, who: Row = a1, extra: Record<string, unknown> = {}) => w.call(handlers as any, op, { account: who, ...extra }, req);
  const input = (o: Row = {}) => Object.fromEntries(Object.entries({ profile_id: lx['id'], label: 'home', address_text: 'Synthetic Tole 4, Ward 2', ...o }).filter(([, v]) => v !== undefined));
  const create = (o: Row = {}, who: Row = a1) => run('createMyAddress', { body: input(o), headers: IDEM }, who);
  const update = (id: string, o: Row = {}, headers: object = ifm(1), who: Row = a1) => run('updateMyAddress', { params: { address_id: id }, body: input(o), headers }, who);
  const deactivate = (id: string, headers: object = ifm(1), who: Row = a1) => run('deactivateMyAddress', { params: { address_id: id }, headers }, who);
  const untouched = (r: { calls: any[] }, before: string) => { expect(w.dml(r.calls)).toEqual([]); expect(w.snapshot()).toBe(before); };
  return { w, a1, a2, lx, lx2, ly, run, input, create, update, deactivate, untouched };
}

describe('contract sanity', () => {
  it('floors and idempotency: E37 self.read none; E38 self.manage required (P-8); E39 / E40 self.manage optional + If-Match', () => {
    expect(opOf('listMyAddresses')).toMatchObject({ 'x-permission': PERMS.READ, 'x-idempotency': 'none' }); expect(opOf('createMyAddress')).toMatchObject({ 'x-permission': PERMS.MANAGE, 'x-idempotency': 'required' });
    for (const op of ['updateMyAddress', 'deactivateMyAddress']) expect(opOf(op)).toMatchObject({ 'x-permission': PERMS.MANAGE, 'x-idempotency': 'optional' });
    expect(opOf('createMyAddress')['x-error-codes']).toContain('engagement.link_limit_reached');
  });
});

const REQS: Array<[string, string, (f: ReturnType<typeof setup>) => any]> = [
  ['listMyAddresses', PERMS.READ, () => ({})], ['createMyAddress', PERMS.MANAGE, (f) => ({ body: f.input(), headers: IDEM })],
  ['updateMyAddress', PERMS.MANAGE, (f) => ({ params: { address_id: f.w.seedAddress(f.a1, X)['id'] }, body: f.input(), headers: ifm(1) })],
  ['deactivateMyAddress', PERMS.MANAGE, (f) => ({ params: { address_id: f.w.seedAddress(f.a1, X)['id'] }, headers: ifm(1) })],
];
describe('guards: permission first, patient actors only', () => {
  for (const [op, perm, req] of REQS) {
    it(`${op}: assertRole(${perm}) runs before any query; without the grant -> auth.forbidden and no statement`, async () => {
      const f = setup(); const ok = await f.run(op, req(f)); expect(ok.error, `${op} must not fail for a granted patient`).toBeUndefined(); expect(f.w.identityCalls[0]).toMatchObject({ permission: perm, at: 0 });
      const g = setup(); const r = await g.run(op, req(g), g.a1, { grants: [] }); expectErr(r, 'auth.forbidden', 403); expect(r.calls).toHaveLength(0);
    });
    it(`${op}: a staff / display actor is refused with auth.forbidden before any query`, async () => { const f = setup(); const r = await f.run(op, req(f), f.a1, { actorType: 'user' }); expectErr(r, 'auth.forbidden', 403); expect(r.calls).toHaveLength(0); });
  }
});

describe('E38 createMyAddress (A19; US-EN-13.1 "owned by A1, for profile X")', () => {
  it('201 Address: schema-valid, profile_id = the link id; the row is owned by the caller\'s account for the profile\'s patient, version 1, active; optional fields kept', async () => {
    const f = setup(); const r = await f.create({ label: 'work', landmark: 'Near the temple', municipality: 'Synthetic Municipality', ward_no: 7, district: 'Synthetic District', contact_phone_e164: '+99001000009' });
    expect(r.error).toBeUndefined(); expect(r.out.status).toBe(201); expect(schemaErrors('Address', r.out.body)).toEqual([]);
    expect(r.out.body).toMatchObject({ profile_id: f.lx['id'], label: 'work', address_text: 'Synthetic Tole 4, Ward 2', landmark: 'Near the temple', ward_no: 7, version: 1 }); expect(JSON.stringify(r.out.body)).not.toContain(X); expect(String(hdr(r.out, 'cache-control'))).toMatch(/no-store/i);
    expect(f.w.row('addresses', r.out.body.id)).toMatchObject({ tenant_id: f.w.t['accounts']![0]!['tenant_id'], account_id: f.a1['id'], patient_id: X, label: 'work', is_active: true, version: 1, created_by: f.a1['user_id'] });
    expect(f.w.row('addresses', r.out.body.id)!['latitude']).toBeNull(); // pin on map is NOT in v1: the app never sends coordinates
  });
  it('account and patient come from the session and the link, never from the body: account_id / patient_id / latitude in the body are a 400; the second profile of the account works too', async () => {
    const f = setup(); const before = f.w.snapshot(); for (const extra of [{ account_id: f.a2['id'] }, { patient_id: Y }, { id: ID(0x1234) }, { is_active: false }, { version: 9 }]) { const r = await f.create(extra); expectErr(r, 'common.validation_failed', 400); f.untouched(r, before); }
    const r2 = await f.create({ profile_id: f.lx2['id'] }); expect(f.w.row('addresses', r2.out.body.id)).toMatchObject({ patient_id: X2, account_id: f.a1['id'] });
  });
  it('profile ownership (AB-6, P-L5): another account\'s profile, a revoked or suspended link, an unknown id and a patient id are 404 common.not_found with zero writes', async () => {
    const f = setup(); const rev = f.w.seedLink(f.a1, ID(0x8a1), { status: 'revoked' }), sus = f.w.seedLink(f.a1, ID(0x8a2), { status: 'suspended' }); const before = f.w.snapshot();
    for (const pid of [f.ly['id'], rev['id'], sus['id'], ID(0x8fe), X]) { const r = await f.create({ profile_id: pid }); expectErr(r, 'common.not_found', 404); f.untouched(r, before); }
  });
  it('validation: label enum, address_text 1-300, landmark ≤ 120, municipality ≤ 80, district ≤ 60, ward 1-99, phone E.164 - each violation is a 400 with nothing written and no echo of the value', async () => {
    const f = setup(); const before = f.w.snapshot(); const bad: Row[] = [{ label: 'office' }, { label: undefined }, { address_text: '' }, { address_text: 'x'.repeat(301) }, { address_text: undefined }, { landmark: 'x'.repeat(121) },
      { municipality: 'x'.repeat(81) }, { district: 'x'.repeat(61) }, { ward_no: 0 }, { ward_no: 100 }, { ward_no: 'seven' }, { contact_phone_e164: '9800000000' }, { contact_phone_e164: '+1' }, { profile_id: undefined }, { profile_id: 'not-a-uuid' }];
    for (const o of bad) { const r = await f.create(o); expectErr(r, 'common.validation_failed', 400); f.untouched(r, before); }
    const edge = await f.create({ address_text: 'x'.repeat(300), landmark: 'y'.repeat(120), municipality: 'm'.repeat(80), district: 'd'.repeat(60), ward_no: 99 }); expect(edge.out.status).toBe(201);
  });
  it('more than 10 addresses per account [CONV] -> 409 engagement.link_limit_reached; the 10th is accepted; other accounts and staff-entered addresses do not count', async () => {
    const f = setup(); for (let i = 0; i < 9; i++) f.w.seedAddress(f.a1, X); for (let i = 0; i < 12; i++) f.w.seedAddress(f.a2, Y); f.w.seedAddress(null, X);
    expect((await f.create()).out.status).toBe(201); const before = f.w.snapshot(); const r = await f.create(); expectErr(r, 'engagement.link_limit_reached', 409); f.untouched(r, before);
    expect((await f.create({ profile_id: f.ly['id'] }, f.a2)).error?.code).toBe('engagement.link_limit_reached'); // a2 holds 12 already: its own limit applies
  });
  it('PHI hygiene: the address text, landmark and phone never reach logs, metrics or errors (REQ-SEC-098)', async () => {
    const f = setup(); await f.create({ address_text: 'Hidden Tole 99, Ward 7', landmark: 'Hidden Landmark', contact_phone_e164: '+99001000077' }); await f.create({ address_text: 'x'.repeat(301) });
    const text = f.w.observed(); for (const v of ['Hidden Tole', 'Hidden Landmark', '+99001000077', 'x'.repeat(40)]) expect(text).not.toContain(v);
  });
});

describe('E37 listMyAddresses', () => {
  it('lists the caller\'s ACTIVE addresses only (≤ 10), schema-valid, profile_id = link id; staff-entered, other-account, deactivated and tenant-B addresses are absent', async () => {
    const f = setup(); const mine = f.w.seedAddress(f.a1, X, { address_text: 'Mine One' }), mine2 = f.w.seedAddress(f.a1, X2, { address_text: 'Mine Two', label: 'work' }); f.w.seedAddress(f.a1, X, { is_active: false }); f.w.seedAddress(f.a2, Y); f.w.seedAddress(null, X); f.w.seedAddress(f.a1, X, { tenant_id: ID(0xdead) });
    const r = await f.run('listMyAddresses'); expect(r.out.status).toBe(200); expect(r.out.body.data.map((d: any) => d.id).sort()).toEqual([mine['id'], mine2['id']].sort());
    for (const d of r.out.body.data) expect(schemaErrors('Address', d)).toEqual([]); expect(r.out.body.data.find((d: any) => d.id === mine2['id']).profile_id).toBe(f.lx2['id']); expect(r.out.body.data.length).toBeLessThanOrEqual(10);
    expect(JSON.stringify(r.out.body)).not.toMatch(/account_id|patient_id|tenant_id|is_active|created_by/); expect(String(hdr(r.out, 'cache-control'))).toMatch(/no-store/i);
    expect((await f.run('listMyAddresses', {}, f.a2)).out.body.data).toHaveLength(1);
  });
  it('profile_id narrows to one of the caller\'s profiles; a foreign or unknown profile_id never yields anything (empty list or 404); a non-uuid is a 400', async () => {
    const f = setup(); const a = f.w.seedAddress(f.a1, X), b = f.w.seedAddress(f.a1, X2); f.w.seedAddress(f.a2, Y);
    expect((await f.run('listMyAddresses', { query: { profile_id: f.lx['id'] } })).out.body.data.map((d: any) => d.id)).toEqual([a['id']]); expect((await f.run('listMyAddresses', { query: { profile_id: f.lx2['id'] } })).out.body.data.map((d: any) => d.id)).toEqual([b['id']]);
    for (const pid of [f.ly['id'], ID(0x8fe)]) { const r = await f.run('listMyAddresses', { query: { profile_id: pid } }); if (r.error) expect(code(r)).toBe('common.not_found'); else expect(r.out.body.data).toEqual([]); }
    expectErr(await f.run('listMyAddresses', { query: { profile_id: 'nope' } }), 'common.validation_failed', 400);
  });
  it('a read writes nothing', async () => { const f = setup(); f.w.seedAddress(f.a1, X); const before = f.w.snapshot(); const r = await f.run('listMyAddresses'); f.untouched(r, before); });
});

describe('E39 updateMyAddress', () => {
  it('200 Address with version + 1 and the new text; account / patient unchanged', async () => {
    const f = setup(); const d = f.w.seedAddress(f.a1, X); const r = await f.update(d['id'], { address_text: 'New Text 5', label: 'other', ward_no: 3 }); expect(r.error).toBeUndefined(); expect(r.out.status).toBe(200); expect(schemaErrors('Address', r.out.body)).toEqual([]);
    expect(r.out.body).toMatchObject({ id: d['id'], address_text: 'New Text 5', label: 'other', ward_no: 3, version: 2, profile_id: f.lx['id'] }); expect(f.w.row('addresses', d['id'])).toMatchObject({ account_id: f.a1['id'], patient_id: X, version: 2, updated_by: f.a1['user_id'] });
  });
  it('If-Match: absent -> 428 before any DB access; malformed -> 400; stale -> 409 common.version_conflict; nothing written in any case', async () => {
    const f = setup(); const d = f.w.seedAddress(f.a1, X); const before = f.w.snapshot();
    const none = await f.run('updateMyAddress', { params: { address_id: d['id'] }, body: f.input() }); expectErr(none, 'common.precondition_required', 428); expect(none.calls).toHaveLength(0);
    expectErr(await f.update(d['id'], {}, ifm('banana')), 'common.validation_failed', 400); const stale = await f.update(d['id'], {}, ifm(5)); expectErr(stale, 'common.version_conflict', 409); f.untouched(stale, before);
  });
  it('probes (AB-6): another account\'s address, a staff-entered one, a tenant-B one and an unknown id are 404 BEFORE the version check; a non-uuid is a 400; nothing changes', async () => {
    const f = setup(); const theirs = f.w.seedAddress(f.a2, Y), staff = f.w.seedAddress(null, X), tb = f.w.seedAddress(f.a1, X, { tenant_id: ID(0xdead) }); const before = f.w.snapshot();
    for (const id of [theirs['id'], staff['id'], tb['id'], ID(0x8fd)]) { const r = await f.update(id, {}, ifm(99)); expectErr(r, 'common.not_found', 404); f.untouched(r, before); }
    expectErr(await f.update('not-a-uuid'), 'common.validation_failed', 400);
  });
  it('moving the address to another profile: of the same account is allowed (patient follows the link), of another account / a revoked link is 404; nothing is written on refusal', async () => {
    const f = setup(); const d = f.w.seedAddress(f.a1, X); const ok = await f.update(d['id'], { profile_id: f.lx2['id'] }); if (!ok.error) expect(f.w.row('addresses', d['id'])).toMatchObject({ patient_id: X2, account_id: f.a1['id'] });
    const g = setup(); const e = g.w.seedAddress(g.a1, X); const before = g.w.snapshot(); const r = await g.update(e['id'], { profile_id: g.ly['id'] }); expectErr(r, 'common.not_found', 404); g.untouched(r, before);
  });
  it('validation failures are 400 and keep the row as it was', async () => {
    const f = setup(); const d = f.w.seedAddress(f.a1, X); const before = f.w.snapshot(); for (const o of [{ label: 'office' }, { address_text: '' }, { address_text: 'x'.repeat(301) }, { ward_no: 0 }, { contact_phone_e164: 'abc' }, { account_id: f.a2['id'] }]) { const r = await f.update(d['id'], o); expectErr(r, 'common.validation_failed', 400); f.untouched(r, before); }
  });
  it('a deactivated address cannot be updated (404); an update never reactivates', async () => { const f = setup(); const d = f.w.seedAddress(f.a1, X, { is_active: false }); expectErr(await f.update(d['id']), 'common.not_found', 404); expect(f.w.row('addresses', d['id'])!['is_active']).toBe(false); });
});

describe('E40 deactivateMyAddress', () => {
  it('204 with no body; is_active false, version + 1; the address leaves E37; a booking that already uses it keeps its home_address_id and stays readable', async () => {
    const f = setup(); const d = f.w.seedAddress(f.a1, X); const oc = f.w.seedOccupancy(S('02:15'), 1);
    const bk = f.w.seedBooking(f.a1, f.lx, X, { booking_kind: 'home_collection', home_address_id: d['id'], slot_start: S('02:15'), slot_end: plus(S('02:15'), 60), slot_occupancy_id: oc['id'] });
    const r = await f.deactivate(d['id']); expect(r.error).toBeUndefined(); expect(r.out.status).toBe(204); expect(r.out.body ?? null).toBeNull(); expect(f.w.row('addresses', d['id'])).toMatchObject({ is_active: false, version: 2, updated_by: f.a1['user_id'] });
    expect((await f.run('listMyAddresses')).out.body.data).toEqual([]); const b = await f.run('getMyBooking', { params: { booking_id: bk['id'] } }); expect(b.out.status === 200 ? b.out.body.home_address_id : d['id']).toBe(d['id']);
    expect(f.w.t['addresses']).toHaveLength(1); // deactivated, never deleted (lims_app has no DELETE)
  });
  it('a deactivated address can no longer be used for a new home booking (E33 -> 404 / address_required)', async () => {
    const f = setup(); const d = f.w.seedAddress(f.a1, X); expect((await f.deactivate(d['id'])).out.status).toBe(204);
    const r = await f.run('createMyBooking', { headers: IDEM, body: { profile_id: f.lx['id'], booking_kind: 'home_collection', slot_start: S('02:15'), orderable_ids: [ID(0x301)], home_address_id: d['id'] } });
    expect(['common.not_found', 'engagement.address_required']).toContain(code(r)); expect(r.out).toBeUndefined();
  });
  it('If-Match: absent -> 428 before any DB access; malformed -> 400; stale -> 409 common.version_conflict; nothing written', async () => {
    const f = setup(); const d = f.w.seedAddress(f.a1, X); const before = f.w.snapshot();
    const none = await f.run('deactivateMyAddress', { params: { address_id: d['id'] } }); expectErr(none, 'common.precondition_required', 428); expect(none.calls).toHaveLength(0);
    expectErr(await f.deactivate(d['id'], ifm('x')), 'common.validation_failed', 400); const stale = await f.deactivate(d['id'], ifm(4)); expectErr(stale, 'common.version_conflict', 409); f.untouched(stale, before);
  });
  it('probes (AB-6): another account\'s, staff-entered, tenant-B and unknown addresses are 404 before the version check; nothing changes', async () => {
    const f = setup(); const theirs = f.w.seedAddress(f.a2, Y), staff = f.w.seedAddress(null, X), tb = f.w.seedAddress(f.a1, X, { tenant_id: ID(0xdead) }); const before = f.w.snapshot();
    for (const id of [theirs['id'], staff['id'], tb['id'], ID(0x8fd)]) { const r = await f.deactivate(id, ifm(99)); expectErr(r, 'common.not_found', 404); f.untouched(r, before); }
    expectErr(await f.deactivate('not-a-uuid'), 'common.validation_failed', 400);
  });
});

describe('cross-operation: the booking wizard\'s inline "Add address" flow (A17 step 4 -> E38 -> E33)', () => {
  it('an address created through E38 is immediately usable for a home booking of the same profile, and not for another account\'s profile', async () => {
    const f = setup(); const d = (await f.create()).out.body; const slot = S('02:15'); void SLOT;
    const mk = (who: Row, pid: string) => f.run('createMyBooking', { headers: IDEM, body: { profile_id: pid, booking_kind: 'home_collection', slot_start: slot, orderable_ids: [ID(0x301)], home_address_id: d.id } }, who);
    const mine = await mk(f.a1, f.lx['id']); expect(mine.error).toBeUndefined(); expect(mine.out.body).toMatchObject({ booking_kind: 'home_collection', home_address_id: d.id });
    const theirs = await mk(f.a2, f.ly['id']); expect(['common.not_found']).toContain(code(theirs));
  });
});
