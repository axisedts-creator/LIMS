// C14 T03 — deny-term endpoints #23 listSmartDenyTerms, #24 createSmartDenyTerm, #25 deactivateSmartDenyTerm (06-PLAN row T03; 02-TRD §5, §9.5; 03-APP-FLOW §2.8).
// ACs: AC-18.2 (global deny terms cannot be deactivated by a tenant; tenant terms can be added and deactivated), AC-18.3 (case / NFC / zero-width: stored folded copy).
// Security (07-SECURITY): T1 row, abuse case AB-2, test plan items 3-5 (probes, privilege escalation, wording). Tests: integration (handler + real IdentityPort fake + repo emulator) + probes.
// Seams: see t03.helpers.ts. Additional pinned choices (spec silent):
//   #23 `include_global` absent/false -> tenant ACTIVE terms only; true (boolean or 'true') -> tenant terms, then global terms (scope 'global', no id/version). Tenant rows via listDenyTerms(rc) WITHOUT includeInactive.
//   #24 inserts through insertDenyTerm(rc, { id: <uuid>, term: NFC(term), term_folded: normaliseForMatch(term), language, reason? }) and returns 201 + DenyTerm (scope 'tenant', version 1, is_active true).
//       Body is validated again in the handler (additionalProperties false; term 2–60 chars; language en|ne|any; reason <= 200; folded term 1–60 chars) -> common.validation_failed, nothing written.
//   #25 If-Match `"<n>"` required (absent -> common.precondition_required); getDenyTerm(rc, term_id) null -> common.not_found; then updateDenyTerm(rc, term_id, n, { is_active: false }) -> 200 DenyTerm.
// Fails now: handlers 23-25 are T01 stubs (common.internal / 501).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LimsError } from '../../../../core/errors.js';

vi.mock('../../repository/denyTerms.repo.js', async () => (await import('./t03.fakes.js')).denyTermsRepoFake);
vi.mock('../../repository/codedSets.repo.js', async () => (await import('./t03.fakes.js')).codedSetsRepoFake);

import { IDS, TA, TB, call, callsOf, codeOf, denyTermDtoProblems, fails, ifMatch, repoCalls, request, seed, UUID, world } from './t03.helpers.js';

const LIST = 'listSmartDenyTerms', CREATE = 'createSmartDenyTerm', DEACT = 'deactivateSmartDenyTerm';
const MANAGE = 'smartreport.template.manage';
const GLOBALS = ['cure', 'diagnos', 'guarantee', 'http', 'prescri', 'supplement', 'www.'];
beforeEach(() => { seed(); vi.clearAllMocks(); });

describe('C14-T03 #23 listSmartDenyTerms', () => {
  it('lab_manager: 200 with the tenant\'s ACTIVE terms only, valid DenyTerm shapes, no globals by default, no other tenant\'s rows', async () => {
    const c = call(LIST, 'lab_manager', request());
    const r = await c.run();
    expect(r.status).toBe(200);
    expect(Object.keys(r.body)).toEqual(['data']);
    expect(r.body.data.map((t: any) => t.term)).toEqual(['guaranteed cure', 'zeta term']);   // inactive 'old term' and tenant B 'b-only-term' absent
    for (const t of r.body.data) { expect(denyTermDtoProblems(t), t.term).toEqual([]); expect(t.scope).toBe('tenant'); }
    expect(r.body.data[0]).toMatchObject({ id: IDS.aActive, language: 'en', reason: 'Synthetic wording rule', is_active: true, version: 1 });
    expect('reason' in r.body.data[1]).toBe(false);                                           // null reason is omitted, never null
    expect(c.asserted.map((a) => a.permission)).toEqual([MANAGE]);
    expect(c.asserted[0]).not.toHaveProperty('centreId');
    for (const k of callsOf('listDenyTerms', 'listGlobalDenyTerms')) expect(k.tenantId).toBe(TA);
    expect(callsOf('listGlobalDenyTerms')).toHaveLength(0);
    expect((callsOf('listDenyTerms')[0]!.args[0] as any)?.includeInactive).not.toBe(true);
  });

  it.each([[true], ['true']])('include_global=%j appends the global terms (scope global, no id/version), tenant terms first', async (flag) => {
    const r = await call(LIST, 'lab_manager', request({ query: { include_global: flag } })).run();
    expect(r.status).toBe(200);
    const [tenant, global] = [r.body.data.filter((t: any) => t.scope === 'tenant'), r.body.data.filter((t: any) => t.scope === 'global')];
    expect(tenant.map((t: any) => t.term)).toEqual(['guaranteed cure', 'zeta term']);
    expect(global.map((t: any) => t.term).sort()).toEqual(GLOBALS);
    expect(r.body.data.slice(0, 2).every((t: any) => t.scope === 'tenant')).toBe(true);
    for (const t of r.body.data) expect(denyTermDtoProblems(t), t.term).toEqual([]);
    expect(global.every((t: any) => t.is_active === true)).toBe(true);
  });

  it.each([[false], ['false'], [undefined]])('include_global=%j adds no global term', async (flag) => {
    const r = await call(LIST, 'pathologist', request({ query: flag === undefined ? {} : { include_global: flag } })).run();
    expect(r.body.data.every((t: any) => t.scope === 'tenant')).toBe(true);
  });

  it('tenant isolation: tenant B sees only its own term', async () => {
    const r = await call(LIST, 'pathologist', request(), 'B').run();
    expect(r.body.data.map((t: any) => t.term)).toEqual(['b-only-term']);
    expect(callsOf('listDenyTerms')[0]!.tenantId).toBe(TB);
  });

  it.each(['front_desk', 'lab_technologist', 'revoked_lab_manager'] as const)('%s -> 403 auth.forbidden before any repository access', async (persona) => {
    const e = await fails(call(LIST, persona, request()).run());
    expect(codeOf(e)).toBe('auth.forbidden');
    expect(repoCalls()).toBe(0);
  });

  it('unknown actor -> auth.unauthenticated, nothing read', async () => {
    const e = await fails(call(LIST, 'ghost', request()).run());
    expect(codeOf(e)).toBe('auth.unauthenticated');
    expect(repoCalls()).toBe(0);
  });
});

describe('C14-T03 #24 createSmartDenyTerm — AC-18.2 (tenants can add) and AC-18.3 (stored folded copy)', () => {
  const create = (body: unknown, persona: 'lab_manager' | 'pathologist' = 'lab_manager', tenant: 'A' | 'B' = 'A') => call(CREATE, persona, request({ body }), tenant);

  it('lab_manager: 201 + DenyTerm; the row sent to the repo carries NFC term and the folded copy, nothing tenant-/audit-related', async () => {
    const c = create({ term: 'Miracle CURE', language: 'en', reason: 'Synthetic wording rule' });
    const r = await c.run();
    expect(r.status).toBe(201);
    expect(denyTermDtoProblems(r.body)).toEqual([]);
    expect(r.body).toMatchObject({ term: 'Miracle CURE', language: 'en', scope: 'tenant', reason: 'Synthetic wording rule', is_active: true, version: 1 });
    expect(r.body.id).toMatch(UUID);
    const row = callsOf('insertDenyTerm')[0]!.args[0] as Record<string, unknown>;
    expect(row).toMatchObject({ term: 'Miracle CURE', term_folded: 'miracle cure', language: 'en', reason: 'Synthetic wording rule' });
    expect(Object.keys(row).filter((k) => ['tenant_id', 'created_by', 'updated_by', 'version'].includes(k))).toEqual([]);
    expect(callsOf('insertDenyTerm')[0]!.tenantId).toBe(TA);
    expect(c.asserted.map((a) => a.permission)).toEqual([MANAGE]);
    const listed = await call(LIST, 'lab_manager', request()).run();
    expect(listed.body.data.map((t: any) => t.term)).toContain('Miracle CURE');
  });

  it('AC-18.3: term is stored NFC; term_folded = NFC -> zero-width removed -> case folded', async () => {
    const r = await create({ term: 'Café OFFER', language: 'en' }).run();
    expect(r.body.term).toBe('Café OFFER');
    expect((callsOf('insertDenyTerm')[0]!.args[0] as any).term_folded).toBe('café offer');
  });

  it.each([['U+200B', '​'], ['U+200C', '‌'], ['U+200D', '‍'], ['U+FEFF', '﻿']])('AC-18.3 / AB-2: a term typed with %s is folded to the plain term', async (_n, zw) => {
    const r = await create({ term: `SUPP${zw}LEMENT`, language: 'any' }).run();
    expect(r.status).toBe(201);
    expect((callsOf('insertDenyTerm')[0]!.args[0] as any).term_folded).toBe('supplement');
  });

  it('Devanagari term: language ne, folded copy equals the NFC term', async () => {
    const r = await create({ term: 'औषधि', language: 'ne' }).run();
    expect(r.body).toMatchObject({ term: 'औषधि', language: 'ne', scope: 'tenant' });
    expect((callsOf('insertDenyTerm')[0]!.args[0] as any).term_folded).toBe('औषधि');
  });

  it('pathologist may add too (holds template.manage)', async () => {
    expect((await create({ term: 'free scan', language: 'en' }, 'pathologist').run()).status).toBe(201);
  });

  it('tenant comes from the context: a tenant B actor writes a tenant B row only', async () => {
    await create({ term: 'only for b', language: 'en' }, 'pathologist', 'B').run();
    expect(callsOf('insertDenyTerm')[0]!.tenantId).toBe(TB);
    expect(world.tenantTerms.filter((t) => t.term === 'only for b').map((t) => t.tenant_id)).toEqual([TB]);
  });

  it('adversarial text is stored as data, verbatim (SQL fragment, HTML)', async () => {
    for (const term of ["x'; DROP TABLE smartreport.wording_deny_terms; --", '<script>alert(1)</script>']) {
      const r = await create({ term, language: 'en' }).run();
      expect(r.status, term).toBe(201);
      expect(r.body.term).toBe(term);
    }
    expect(world.tenantTerms.some((t) => t.term === "x'; DROP TABLE smartreport.wording_deny_terms; --")).toBe(true);
  });

  const LONG = 'x'.repeat(61);
  it.each([
    ['missing term', { language: 'en' }], ['missing language', { term: 'abcd' }], ['empty body', {}], ['null body', null], ['array body', [{ term: 'abcd', language: 'en' }]],
    ['term 1 char', { term: 'a', language: 'en' }], ['term 61 chars', { term: LONG, language: 'en' }], ['term number', { term: 1234, language: 'en' }],
    ['term null', { term: null, language: 'en' }], ['term object', { term: { a: 1 }, language: 'en' }], ['term array', { term: ['abcd'], language: 'en' }],
    ['language fr', { term: 'abcd', language: 'fr' }], ['language EN (case)', { term: 'abcd', language: 'EN' }], ['language number', { term: 'abcd', language: 1 }],
    ['reason 201 chars', { term: 'abcd', language: 'en', reason: 'r'.repeat(201) }], ['reason number', { term: 'abcd', language: 'en', reason: 5 }],
    ['unknown key', { term: 'abcd', language: 'en', note: 'x' }],
    ['mass assignment tenant_id', { term: 'abcd', language: 'en', tenant_id: TB }], ['mass assignment scope global', { term: 'abcd', language: 'en', scope: 'global' }],
    ['mass assignment is_active', { term: 'abcd', language: 'en', is_active: false }], ['mass assignment term_folded', { term: 'abcd', language: 'en', term_folded: 'zzz' }],
    ['mass assignment id', { term: 'abcd', language: 'en', id: IDS.bActive }], ['mass assignment version', { term: 'abcd', language: 'en', version: 9 }],
    ['mass assignment created_by', { term: 'abcd', language: 'en', created_by: TB }],
    ['zero-width only (folds to empty)', { term: '​‌‍', language: 'en' }], ['BOM only', { term: '﻿﻿', language: 'en' }],
    ['folds longer than 60 (dotted capital I x40 -> 80)', { term: 'İ'.repeat(40), language: 'en' }],
  ])('rejects %s with common.validation_failed and writes nothing', async (_n, body) => {
    const e = await fails(create(body).run());
    expect(codeOf(e)).toBe('common.validation_failed');
    expect(callsOf('insertDenyTerm')).toHaveLength(0);
    expect(world.tenantTerms).toHaveLength(4);
  });

  it('boundaries accepted: term of exactly 2 and exactly 60 characters, reason of exactly 200', async () => {
    expect((await create({ term: 'ab', language: 'any' }).run()).status).toBe(201);
    expect((await create({ term: 'y'.repeat(60), language: 'en', reason: 'r'.repeat(200) }).run()).status).toBe(201);
  });

  it('the validation error never echoes request values', async () => {
    const planted = 'PLANTED-TOKEN-9f3a';
    const e = await fails(create({ term: 'abcd', language: 'en', extra: planted }).run());
    expect(codeOf(e)).toBe('common.validation_failed');
    expect(JSON.stringify({ code: e.code, message: e.message, detail: e.detail, errors: e.errors })).not.toContain(planted);
  });

  it.each(['front_desk', 'lab_technologist', 'revoked_lab_manager'] as const)('%s -> 403 auth.forbidden, nothing written', async (persona) => {
    const e = await fails(call(CREATE, persona, request({ body: { term: 'abcd', language: 'en' } })).run());
    expect(codeOf(e)).toBe('auth.forbidden');
    expect(repoCalls()).toBe(0);
    expect(world.tenantTerms).toHaveLength(4);
  });

  it('authorisation precedes validation: a forbidden caller with an invalid body gets 403, not 400', async () => {
    expect(codeOf(await fails(call(CREATE, 'front_desk', request({ body: { nonsense: 1 } })).run()))).toBe('auth.forbidden');
  });

  it('unknown actor -> auth.unauthenticated, nothing written', async () => {
    expect(codeOf(await fails(call(CREATE, 'ghost', request({ body: { term: 'abcd', language: 'en' } })).run()))).toBe('auth.unauthenticated');
    expect(repoCalls()).toBe(0);
  });
});

describe('C14-T03 #25 deactivateSmartDenyTerm — AC-18.2 (tenant terms can be deactivated; global ones cannot)', () => {
  const deact = (termId: string, headers: object, persona: 'lab_manager' | 'pathologist' | 'front_desk' = 'lab_manager', tenant: 'A' | 'B' = 'A') =>
    call(DEACT, persona, request({ params: { term_id: termId }, headers, body: {} }), tenant);
  const stateOf = (termId: string) => world.tenantTerms.find((t) => t.id === termId)!;

  it('lab_manager: 200, term inactive, version + 1; the repo patch is exactly { is_active: false } with the If-Match version', async () => {
    const c = deact(IDS.aActive, ifMatch(1));
    const r = await c.run();
    expect(r.status).toBe(200);
    expect(denyTermDtoProblems(r.body)).toEqual([]);
    expect(r.body).toMatchObject({ id: IDS.aActive, term: 'guaranteed cure', scope: 'tenant', is_active: false, version: 2 });
    const u = callsOf('updateDenyTerm')[0]!;
    expect(u.args).toEqual([IDS.aActive, 1, { is_active: false }]);
    expect(u.tenantId).toBe(TA);
    expect(c.asserted.map((a) => a.permission)).toEqual([MANAGE]);
    const listed = await call(LIST, 'lab_manager', request()).run();
    expect(listed.body.data.map((t: any) => t.term)).not.toContain('guaranteed cure');
  });

  it('AC-18.2: deactivating a tenant term that duplicates a global term leaves the global term active and listed', async () => {
    const created = await call(CREATE, 'lab_manager', request({ body: { term: 'Cure', language: 'en' } })).run();
    await deact(created.body.id, ifMatch(1)).run();
    const listed = await call(LIST, 'lab_manager', request({ query: { include_global: true } })).run();
    const globals = listed.body.data.filter((t: any) => t.scope === 'global');
    expect(globals.map((t: any) => t.term).sort()).toEqual(GLOBALS);
    expect(globals.every((t: any) => t.is_active)).toBe(true);
    expect(world.globalTerms.every((t) => t.is_active)).toBe(true);
  });

  it('AC-18.2: global terms are not addressable — no id exists, any id that is not the tenant\'s own is 404 and nothing is updated', async () => {
    for (const termId of ['00000000-0000-7000-8000-000000000000', IDS.bActive, '01900000-0000-7000-8000-00000000dead']) {
      const e = await fails(deact(termId, ifMatch(1)).run());
      expect(codeOf(e), termId).toBe('common.not_found');
    }
    expect(callsOf('updateDenyTerm').filter((c) => c.args[0] === IDS.bActive)).toHaveLength(0);
    expect(stateOf(IDS.bActive).is_active).toBe(true);
    expect(world.globalTerms.every((t) => t.is_active)).toBe(true);
  });

  it('tenant B cannot deactivate tenant A\'s term (404 parity) and A\'s term stays active', async () => {
    expect(codeOf(await fails(deact(IDS.aActive, ifMatch(1), 'pathologist', 'B').run()))).toBe('common.not_found');
    expect(stateOf(IDS.aActive)).toMatchObject({ is_active: true, version: 1 });
  });

  it('missing If-Match -> 428 common.precondition_required, term unchanged', async () => {
    expect(codeOf(await fails(deact(IDS.aActive, {}).run()))).toBe('common.precondition_required');
    expect(callsOf('updateDenyTerm')).toHaveLength(0);
    expect(stateOf(IDS.aActive)).toMatchObject({ is_active: true, version: 1 });
  });

  it('stale If-Match -> common.version_conflict, term unchanged', async () => {
    expect(codeOf(await fails(deact(IDS.aActive, ifMatch(7)).run()))).toBe('common.version_conflict');
    expect(stateOf(IDS.aActive)).toMatchObject({ is_active: true, version: 1 });
  });

  it.each([['unquoted', '1'], ['weak', 'W/"1"'], ['zero', '"0"'], ['negative', '"-1"'], ['text', '"abc"'], ['star', '*'], ['list', '"1", "2"'], ['float', '"1.5"'], ['huge', '"99999999999999999999"'], ['empty', ''], ['sql', `"1"; DROP TABLE x`]])(
    'malformed If-Match (%s) is refused with an API error and nothing is updated', async (_n, h) => {
      const e = await fails(deact(IDS.aActive, { 'if-match': h }).run());
      expect(e).toBeInstanceOf(LimsError);
      expect(['common.precondition_required', 'common.validation_failed', 'common.version_conflict'], `got ${codeOf(e)}`).toContain(codeOf(e));
      expect(callsOf('updateDenyTerm')).toHaveLength(0);
      expect(stateOf(IDS.aActive)).toMatchObject({ is_active: true, version: 1 });
    });

  it.each(['front_desk', 'lab_technologist'] as const)('%s -> 403 auth.forbidden, nothing read or written', async (persona) => {
    const e = await fails(call(DEACT, persona, request({ params: { term_id: IDS.aActive }, headers: ifMatch(1), body: {} })).run());
    expect(codeOf(e)).toBe('auth.forbidden');
    expect(repoCalls()).toBe(0);
    expect(stateOf(IDS.aActive).is_active).toBe(true);
  });

  it('unknown actor -> auth.unauthenticated', async () => {
    expect(codeOf(await fails(call(DEACT, 'ghost', request({ params: { term_id: IDS.aActive }, headers: ifMatch(1), body: {} })).run()))).toBe('auth.unauthenticated');
    expect(repoCalls()).toBe(0);
  });
});
