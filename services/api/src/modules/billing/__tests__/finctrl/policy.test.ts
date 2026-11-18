// T0B-FINCTRL-1 (LD-321, LD-310) done_when (3) LIMITS masters + (1) handlers for the reason, limit, authority and my-policy operations + (7) audit and integer money + (8) isolation.
// Real PG17 under RLS. Fails now: the operations are pending (no handler).
// PINS (CONV, none is in the contract): user_id = core.users.id; a limit PUT without If-Match is applied (the contract lists no 428 for it), with a stale If-Match -> 409 version_conflict;
// one ACTIVE limit per user (a second PUT updates the row in place, version + 1); a duplicate reason code -> 400 common.validation_failed with path /code (the contract lists no conflict code);
// the eight evidence reasons are present after the first read of a tenant (billing.seed_discount_reasons is idempotent, the writer calls it); getMyDiscountPolicy resolves the actor's user
// through core.memberships (ctx.actor.id is the membership id in this kit) and lists ACTIVE reasons by display_order then code.
import { describe, expect, it } from 'vitest';
import { moneyIsInteger, notFound, rejected } from '../accounts/helpers.js';
import { T, TENANT_A, TENANT_B, dbRows, fire, ifm, req, listAuthorities, listLimits, listReasons, mkAuthority, mkReason, myPolicy, offAuthority, ok, person, putLimit, rowAudit, tag, uid, updReason } from './kit.js';

const EIGHT = ['PARTNER_FAMILY', 'PARTNER_FRIENDS_RELATIVES', 'PRESCRIBED_BY_DOCTOR', 'EMPLOYEES_FAMILY', 'EMPLOYEE_RELATIVES', 'REGULAR_PATIENT', 'WALKING_PATIENT', 'GOLD_MEMBERSHIP'];
const paths = (e: any): string[] => (e.errors ?? []).map((x: any) => x.path);
const code = () => `SYN_${tag()}`;

describe('discount reasons', () => {
  it('the eight reasons of the evidence are there for the tenant, active, in their display order, integer fields only', async () => {
    const body = ok(await listReasons(TENANT_A, { limit: '200' }));
    const byCode = Object.fromEntries(body.data.map((r: any) => [r.code, r]));
    for (const c of EIGHT) expect(byCode[c], c).toMatchObject({ code: c, is_active: true, version: expect.any(Number) });
    expect(byCode['PARTNER_FAMILY']).toMatchObject({ name: 'Partner Family', display_order: 1 });
    expect(byCode['GOLD_MEMBERSHIP']).toMatchObject({ name: 'Gold membership', display_order: 8 });
    const orders = EIGHT.map((c) => byCode[c].display_order);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
  }, T);

  it('create: 201, upper case code, audited INSERT; the same code again -> 400 with path /code; another tenant may reuse the code', async () => {
    const c = code();
    const r = ok(await mkReason(TENANT_A, { code: c, name: 'Synthetic reason', display_order: 40 }), 201);
    expect(r).toMatchObject({ code: c, name: 'Synthetic reason', display_order: 40, is_active: true, version: 1 });
    expect(await rowAudit(TENANT_A, 'discount_reason', r.id)).toEqual(['INSERT']);
    expect(paths(rejected(await mkReason(TENANT_A, { code: c, name: 'Again' })))).toContain('/code');
    ok(await mkReason(TENANT_B, { code: c, name: 'Other tenant, same code' }), 201);
  }, T);

  it.each<[string, Record<string, unknown>, string]>([
    ['a lower case code', { code: 'lower', name: 'x' }, '/code'], ['a code with a space', { code: 'A B', name: 'x' }, '/code'], ['a 33 character code', { code: 'A'.repeat(33), name: 'x' }, '/code'],
    ['an empty name', { code: 'OK_CODE', name: '' }, '/name'], ['a 201 character name', { code: 'OK_CODE', name: 'n'.repeat(201) }, '/name'],
    ['display_order 10000', { code: 'OK_CODE', name: 'x', display_order: 10_000 }, '/display_order'], ['display_order -1', { code: 'OK_CODE', name: 'x', display_order: -1 }, '/display_order'],
    ['unknown field', { code: 'OK_CODE', name: 'x', is_active: false }, '/is_active'],
  ])('refuses %s with 400 and the path', async (_n, body, path) => {
    const e = rejected(await mkReason(TENANT_A, body));
    expect(paths(e), JSON.stringify(e.errors)).toContain(path);
  }, T);

  it('update: name and order change, version + 1, audited; the code never changes; If-Match is required; a stale version -> 409', async () => {
    const r = ok(await mkReason(TENANT_A, { code: code(), name: 'Before' }), 201);
    rejected(await updReason(TENANT_A, r.id, 'none', { name: 'x' }), 'common.precondition_required');
    rejected(await updReason(TENANT_A, r.id, 9, { name: 'x' }), 'common.version_conflict');
    rejected(await updReason(TENANT_A, r.id, 1, { code: 'NEW_CODE' }));
    const u = ok(await updReason(TENANT_A, r.id, 1, { name: 'After', display_order: 77 }));
    expect(u).toMatchObject({ id: r.id, code: r.code, name: 'After', display_order: 77, version: 2 });
    expect(await rowAudit(TENANT_A, 'discount_reason', r.id)).toEqual(['INSERT', 'UPDATE']);
    notFound(await updReason(TENANT_A, uid(), 1, { name: 'x' }));
  }, T);

  it('an inactive reason leaves the active filter; tenant B never sees or edits A\'s reason', async () => {
    const r = ok(await mkReason(TENANT_A, { code: code(), name: 'To retire' }), 201);
    const off = await fire('updateDiscountReason', req({ params: { discount_reason_id: r.id }, headers: ifm(1), body: { is_active: false } }), { tenant: TENANT_A });
    if (off.reply?.status === 200) {
      expect(ok(off).is_active).toBe(false);
      expect(ok(await listReasons(TENANT_A, { is_active: 'true', limit: '200' })).data.map((x: any) => x.id)).not.toContain(r.id);
    } else rejected(off);                                                                                                         // the contract may keep is_active out of the patch; then it is a clean 400
    expect(JSON.stringify(ok(await listReasons(TENANT_B, { limit: '200' })))).not.toContain(r.id);
    notFound(await updReason(TENANT_B, r.id, 1, { name: 'hijack' }));
  }, T);
});

describe('setUserDiscountLimit / listUserDiscountLimits', () => {
  it('first PUT creates (version 1), a second updates in place (version 2): one active row per user, audited', async () => {
    const p = await person();
    const a = ok(await putLimit(TENANT_A, p.userId, { max_discount_bp: 1000, max_discount_paisa: 50_000 }));
    expect(a).toMatchObject({ user_id: p.userId, max_discount_bp: 1000, max_discount_paisa: 50_000, is_active: true, version: 1 });
    expect(moneyIsInteger(a)).toEqual([]);
    const b = ok(await putLimit(TENANT_A, p.userId, { max_discount_bp: 2000, max_discount_paisa: 90_000 }, 1));
    expect(b).toMatchObject({ id: a.id, max_discount_bp: 2000, max_discount_paisa: 90_000, version: 2 });
    expect(await dbRows(TENANT_A, `SELECT 1 FROM billing.user_discount_limit WHERE tenant_id = $1 AND user_id = $2 AND is_active`, [p.userId])).toHaveLength(1);
    expect(await rowAudit(TENANT_A, 'user_discount_limit', a.id)).toEqual(['INSERT', 'UPDATE']);
  }, T);

  it('a stale If-Match -> 409 version_conflict and nothing changes; zero limits are valid (a user who may give no discount)', async () => {
    const p = await person();
    ok(await putLimit(TENANT_A, p.userId, { max_discount_bp: 0, max_discount_paisa: 0 }));
    rejected(await putLimit(TENANT_A, p.userId, { max_discount_bp: 500, max_discount_paisa: 5 }, 5), 'common.version_conflict');
    expect(ok(await listLimits(TENANT_A, { user_id: p.userId })).data).toMatchObject([{ max_discount_bp: 0, max_discount_paisa: 0, version: 1 }]);
  }, T);

  it('is_active false switches the limit off; the user then has none', async () => {
    const p = await person();
    ok(await putLimit(TENANT_A, p.userId, { max_discount_bp: 100, max_discount_paisa: 100 }));
    expect(ok(await putLimit(TENANT_A, p.userId, { max_discount_bp: 100, max_discount_paisa: 100, is_active: false }, 1)).is_active).toBe(false);
    expect(ok(await listLimits(TENANT_A, { user_id: p.userId, is_active: 'true' })).data).toEqual([]);
    expect(ok(await myPolicy(TENANT_A, { actor: p.membershipId })).own_limit).toBeUndefined();
  }, T);

  it.each<[string, Record<string, unknown>, string]>([
    ['bp 10001', { max_discount_bp: 10_001, max_discount_paisa: 1 }, '/max_discount_bp'], ['negative bp', { max_discount_bp: -1, max_discount_paisa: 1 }, '/max_discount_bp'],
    ['fractional bp', { max_discount_bp: 1.5, max_discount_paisa: 1 }, '/max_discount_bp'], ['negative paisa', { max_discount_bp: 1, max_discount_paisa: -5 }, '/max_discount_paisa'],
    ['paisa as a string', { max_discount_bp: 1, max_discount_paisa: '5' }, '/max_discount_paisa'], ['paisa as a float', { max_discount_bp: 1, max_discount_paisa: 5.5 }, '/max_discount_paisa'],
    ['paisa above 2^53-1', { max_discount_bp: 1, max_discount_paisa: Number.MAX_SAFE_INTEGER + 2 }, '/max_discount_paisa'], ['missing paisa', { max_discount_bp: 1 }, '/max_discount_paisa'],
    ['unknown field', { max_discount_bp: 1, max_discount_paisa: 1, user_id: uid() }, '/user_id'],
  ])('refuses %s with 400 and the path', async (_n, body, path) => {
    const p = await person();
    const e = rejected(await putLimit(TENANT_A, p.userId, body));
    expect(paths(e), JSON.stringify(e.errors)).toContain(path);
    expect(ok(await listLimits(TENANT_A, { user_id: p.userId })).data).toEqual([]);
  }, T);

  it('an unknown user and another tenant\'s user -> 404; the other tenant never sees the limit', async () => {
    const pa = await person(TENANT_A), pb = await person(TENANT_B);
    notFound(await putLimit(TENANT_A, uid(), { max_discount_bp: 1, max_discount_paisa: 1 }));
    notFound(await putLimit(TENANT_A, pb.userId, { max_discount_bp: 1, max_discount_paisa: 1 }));
    ok(await putLimit(TENANT_A, pa.userId, { max_discount_bp: 7, max_discount_paisa: 7 }));
    expect(ok(await listLimits(TENANT_B, { user_id: pa.userId })).data).toEqual([]);
    expect(ok(await listLimits(TENANT_B, {})).data.map((x: any) => x.user_id)).not.toContain(pa.userId);
  }, T);
});

describe('discount authorities', () => {
  it('create 201 (integer paisa, audited INSERT); deactivate needs If-Match, bumps the version, leaves the active list', async () => {
    const p = await person();
    const a = ok(await mkAuthority(TENANT_A, { user_id: p.userId, max_discount_bp: 3000, max_discount_paisa: 500_000 }), 201);
    expect(a).toMatchObject({ user_id: p.userId, max_discount_bp: 3000, max_discount_paisa: 500_000, is_active: true, version: 1 });
    expect(moneyIsInteger(a)).toEqual([]);
    expect(await rowAudit(TENANT_A, 'discount_authority', a.id)).toEqual(['INSERT']);
    rejected(await offAuthority(TENANT_A, a.id, 'none'), 'common.precondition_required');
    rejected(await offAuthority(TENANT_A, a.id, 4), 'common.version_conflict');
    const d = ok(await offAuthority(TENANT_A, a.id, 1));
    expect(d).toMatchObject({ id: a.id, is_active: false, version: 2 });
    expect(await rowAudit(TENANT_A, 'discount_authority', a.id)).toEqual(['INSERT', 'UPDATE']);
    expect(ok(await listAuthorities(TENANT_A, { user_id: p.userId, is_active: 'true' })).data).toEqual([]);
    expect(ok(await listAuthorities(TENANT_A, { user_id: p.userId })).data.map((x: any) => x.id)).toEqual([a.id]);
  }, T);

  it.each<[string, Record<string, unknown>, string]>([
    ['bp 10001', { max_discount_bp: 10_001, max_discount_paisa: 1 }, '/max_discount_bp'], ['paisa as a string', { max_discount_bp: 1, max_discount_paisa: '5' }, '/max_discount_paisa'],
    ['negative paisa', { max_discount_bp: 1, max_discount_paisa: -1 }, '/max_discount_paisa'], ['user_id not a uuid', { user_id: 'x', max_discount_bp: 1, max_discount_paisa: 1 }, '/user_id'],
    ['unknown field', { max_discount_bp: 1, max_discount_paisa: 1, is_active: false }, '/is_active'],
  ])('refuses %s with 400 and the path', async (_n, over, path) => {
    const p = await person();
    const e = rejected(await mkAuthority(TENANT_A, { user_id: p.userId, ...over }));
    expect(paths(e), JSON.stringify(e.errors)).toContain(path);
  }, T);

  it('an unknown user, another tenant\'s user and another tenant\'s authority id -> 404', async () => {
    const pa = await person(TENANT_A), pb = await person(TENANT_B);
    notFound(await mkAuthority(TENANT_A, { user_id: uid(), max_discount_bp: 1, max_discount_paisa: 1 }));
    notFound(await mkAuthority(TENANT_A, { user_id: pb.userId, max_discount_bp: 1, max_discount_paisa: 1 }));
    const a = ok(await mkAuthority(TENANT_A, { user_id: pa.userId, max_discount_bp: 1, max_discount_paisa: 1 }), 201);
    notFound(await offAuthority(TENANT_B, a.id, 1));
    expect(ok(await listAuthorities(TENANT_B, { user_id: pa.userId })).data).toEqual([]);
    expect(ok(await listAuthorities(TENANT_A, { user_id: pa.userId, is_active: 'true' })).data).toHaveLength(1);
  }, T);
});

describe('getMyDiscountPolicy', () => {
  it('own limit, authority and the active reasons of the caller; nobody else\'s numbers', async () => {
    const me = await person(), other = await person();
    const empty = ok(await myPolicy(TENANT_A, { actor: me.membershipId }));
    expect(empty).not.toHaveProperty('own_limit');
    expect(empty).not.toHaveProperty('authority');
    expect(Array.isArray(empty.reasons)).toBe(true);
    ok(await putLimit(TENANT_A, me.userId, { max_discount_bp: 1500, max_discount_paisa: 75_000 }));
    ok(await putLimit(TENANT_A, other.userId, { max_discount_bp: 9999, max_discount_paisa: 9_999_999 }));
    const a = ok(await mkAuthority(TENANT_A, { user_id: me.userId, max_discount_bp: 4000, max_discount_paisa: 800_000 }), 201);
    ok(await mkAuthority(TENANT_A, { user_id: other.userId, max_discount_bp: 8888, max_discount_paisa: 8_888_888 }), 201);
    const p = ok(await myPolicy(TENANT_A, { actor: me.membershipId }));
    expect(p.own_limit).toEqual({ max_discount_bp: 1500, max_discount_paisa: 75_000 });
    expect(p.authority).toEqual({ max_discount_bp: 4000, max_discount_paisa: 800_000 });
    expect(JSON.stringify(p)).not.toMatch(/9999|8888/);
    expect(moneyIsInteger(p)).toEqual([]);
    ok(await offAuthority(TENANT_A, a.id, 1));
    expect(ok(await myPolicy(TENANT_A, { actor: me.membershipId })).authority).toBeUndefined();
  }, T);

  it('reasons: active only, ordered by display_order then code, each {code, name, display_order}', async () => {
    const me = await person();
    const hi = ok(await mkReason(TENANT_A, { code: code(), name: 'Policy zzz', display_order: 9000 }), 201);
    const lo = ok(await mkReason(TENANT_A, { code: code(), name: 'Policy aaa', display_order: 0 }), 201);
    const p = ok(await myPolicy(TENANT_A, { actor: me.membershipId }));
    const codes = p.reasons.map((r: any) => r.code);
    expect(codes.indexOf(lo.code)).toBeGreaterThanOrEqual(0);
    expect(codes.indexOf(lo.code)).toBeLessThan(codes.indexOf(hi.code));
    for (const c of EIGHT) expect(codes, c).toContain(c);
    for (const r of p.reasons) expect(Object.keys(r).sort().filter((k) => k !== 'display_order')).toEqual(['code', 'name']);
    const orders = p.reasons.map((r: any) => r.display_order ?? 0);
    expect(orders).toEqual([...orders].sort((x: number, y: number) => x - y));
  }, T);

  it('tenant isolation: tenant B\'s caller sees none of A\'s limits, authorities or custom reasons', async () => {
    const a = await person(TENANT_A), b = await person(TENANT_B);
    const r = ok(await mkReason(TENANT_A, { code: code(), name: 'A only' }), 201);
    ok(await putLimit(TENANT_A, a.userId, { max_discount_bp: 123, max_discount_paisa: 456 }));
    const p = ok(await myPolicy(TENANT_B, { actor: b.membershipId }));
    expect(p).not.toHaveProperty('own_limit');
    expect(p.reasons.map((x: any) => x.code)).not.toContain(r.code);
  }, T);
});
