// T-29 (C3) — REAL CatalogPort.resolveCommentCodes (CR-C3-001, absorbs CR-C5-001; 08 §4.14).
// Spec: 02-TRD §6.1 (signature + method row: upper-case codes; active (code, department_id = input) else active (code, department_id IS NULL); with asOf the text version effective then
//       from catalog.comment_code_texts; <= 50 codes else common.validation_failed), §14 contract cases (16) (26); 01-PRD AC-09.1, AC-09.2, AC-09.3 (text edit -> version +1, history kept);
//       07-SECURITY S-1 (tenant), S-6 (binds only). Shape: CommentCodeResolution { resolved[{code, commentCodeId, version, departmentId?, text}], unknown[] } of contracts/ports/CatalogPort.ts.
// Seed: comment_codes.version = the latest comment_code_texts.text_version (AC-09.3), so `version` is unambiguous. Fake: helpers/commentsDb.ts. Interface: helpers/t29.ts.
// Assumptions beyond the spec (see .orchestra/notes/C3.T-29-tests.md): `resolved` keeps INPUT order and each code appears once; `unknown` holds the upper-cased codes in input order;
// a code with no text version effective at asOf is `unknown`; asOf bounds are [effective_from, effective_to).
import { describe, expect, it } from 'vitest';
import { cc, ccText, dept } from '../helpers/commentsDb.js';
import { T, TENANT_A, TENANT_B, WRITE, cmtEnv, codeOf, keysOf } from '../helpers/t29.js';

const A = TENANT_A, B = TENANT_B;
const EPOCH = new Date('2026-01-01T00:00:00.000Z'), OCT = new Date('2026-10-01T00:00:00.000Z');
const HAEM = dept(1, A, { code: 'HAEM' }), BIO = dept(2, A, { code: 'BIOCHEM' }), B_DEPT = dept(9, B, { code: 'THEIRS' });

const SC1 = cc(1, A, { code: 'SC1', text: 'Suite tenant-wide' });
const SC1H = cc(2, A, { code: 'SC1', department_id: HAEM.id, text: 'Suite haematology' });
const SC2 = cc(3, A, { code: 'SC2', text: 'Suite new text', version: 2 });                      // text changed once (AC-09.3)
const SC3 = cc(4, A, { code: 'SC3', text: 'Suite inactive', is_active: false });
const SC4 = cc(5, A, { code: 'SC4', text: 'Suite tenant-wide 4' });
const SC4H = cc(6, A, { code: 'SC4', department_id: HAEM.id, text: 'Suite haematology 4 (inactive)', is_active: false });
const SCD = cc(7, A, { code: 'SCD', department_id: HAEM.id, text: 'Haematology only' });
const SCB = cc(9, B, { code: 'SCB', text: 'Tenant B only' });
const SC1B = cc(10, B, { code: 'SC1', text: 'Tenant B version of SC1' });
const ALL = [SC1, SC1H, SC2, SC3, SC4, SC4H, SCD, SCB, SC1B];
const TEXTS = [
  ...ALL.filter((c) => c !== SC2).map((c, i) => ccText(i + 1, c.id as string, c.tenant_id as string, { text: c.text, effective_from: EPOCH })),
  ccText(20, SC2.id as string, A, { text_version: 1, text: 'Suite old text', effective_from: EPOCH, effective_to: OCT }),
  ccText(21, SC2.id as string, A, { text_version: 2, text: 'Suite new text', effective_from: OCT }),
];
const world = () => cmtEnv({ departments: [HAEM, BIO, B_DEPT], rows: { comment_codes: ALL, comment_code_texts: TEXTS } });
const resolve = (codes: unknown, extra: Record<string, unknown> = {}) => ({ codes, ...extra });
const FIVE_O_ONE = (n: number) => Array.from({ length: n }, (_, i) => `ZZ${i}`);

describe('resolveCommentCodes (contract 16; AC-09.1, AC-09.2)', () => {
  it('is a function on the real port', { timeout: T }, () => { expect(typeof world().port['resolveCommentCodes']).toBe('function'); });
  it('(16) AC-09.1 the department entry wins over the tenant-wide one and carries its version; unknown codes are listed', { timeout: T }, async () => {
    const r = await world().one(resolve(['SC1', 'SUITE_NOPE'], { departmentId: HAEM.id }));
    expect(r.resolved).toEqual([{ code: 'SC1', commentCodeId: SC1H.id, version: 1, departmentId: HAEM.id, text: 'Suite haematology' }]);
    expect(r.unknown).toEqual(['SUITE_NOPE']);
  });
  it('(16) another department, or none: the tenant-wide entry (no departmentId key at all)', { timeout: T }, async () => {
    const env = world();
    for (const input of [resolve(['SC1'], { departmentId: BIO.id }), resolve(['SC1'])]) {
      const r = await env.one(input);
      expect(r.resolved).toEqual([{ code: 'SC1', commentCodeId: SC1.id, version: 1, text: 'Suite tenant-wide' }]);
      expect(r.resolved[0]).not.toHaveProperty('departmentId');
      expect(r.unknown).toEqual([]);
    }
  });
  it('a department-only code is unknown without departmentId and for another department', { timeout: T }, async () => {
    const env = world();
    expect((await env.one(resolve(['SCD']))).unknown).toEqual(['SCD']);
    expect((await env.one(resolve(['SCD'], { departmentId: BIO.id }))).unknown).toEqual(['SCD']);
    expect((await env.one(resolve(['SCD'], { departmentId: HAEM.id }))).resolved.map((x: any) => x.code)).toEqual(['SCD']);
  });
  it('AC-09.2 an inactive code is unknown; an inactive department entry falls back to the active tenant-wide one', { timeout: T }, async () => {
    const env = world();
    expect(await env.one(resolve(['SC3']))).toEqual({ resolved: [], unknown: ['SC3'] });
    const r = await env.one(resolve(['SC4'], { departmentId: HAEM.id }));
    expect(r.resolved).toEqual([{ code: 'SC4', commentCodeId: SC4.id, version: 1, text: 'Suite tenant-wide 4' }]);
  });
  it('codes are upper-cased (input "sc1" resolves as "SC1"; unknown ones come back upper-cased); order of `resolved` and `unknown` follows the input; no duplicates', { timeout: T }, async () => {
    const r = await world().one(resolve(['sc2', 'nope_b', 'SC1', 'Nope_A', 'sc2']));
    expect(r.resolved.map((x: any) => x.code)).toEqual(['SC2', 'SC1']);
    expect(r.unknown).toEqual(['NOPE_B', 'NOPE_A']);
  });
  it('no asOf: the current text and version (SC2 was edited once -> version 2)', { timeout: T }, async () => {
    const r = await world().one(resolve(['SC2']), { at: new Date('2026-11-07T12:00:00.000Z') });
    expect([r.resolved[0].text, r.resolved[0].version]).toEqual(['Suite new text', 2]);
  });
  it('(26) asOf before a text change returns the old text and version; at/after the change the new one; the boundary is [from, to)', { timeout: T }, async () => {
    const env = world();
    const at = (asOf: string) => env.one(resolve(['SC2'], { asOf })).then((r) => [r.resolved[0]?.text, r.resolved[0]?.version]);
    expect(await at('2026-09-01T00:00:00.000Z')).toEqual(['Suite old text', 1]);
    expect(await at('2026-09-30T23:59:59.999Z')).toEqual(['Suite old text', 1]);
    expect(await at('2026-10-01T00:00:00.000Z')).toEqual(['Suite new text', 2]);
    expect(await at('2026-11-01T00:00:00.000Z')).toEqual(['Suite new text', 2]);
  });
  it('asOf also works for a code with a single text version, and with a department', { timeout: T }, async () => {
    const r = await world().one(resolve(['SC1'], { departmentId: HAEM.id, asOf: '2026-06-01T00:00:00.000Z' }));
    expect(r.resolved).toEqual([{ code: 'SC1', commentCodeId: SC1H.id, version: 1, departmentId: HAEM.id, text: 'Suite haematology' }]);
  });
  it('asOf before the first text version: the code is not resolved to a later text (never the future text)', { timeout: T }, async () => {
    const r = await world().one(resolve(['SC2'], { asOf: '2025-06-01T00:00:00.000Z' }));
    expect(r.resolved.map((x: any) => x.text)).not.toContain('Suite new text');
    expect(r.resolved.map((x: any) => x.text)).not.toContain('Suite old text');
  });
  it('result keys are exactly {code, commentCodeId, version, departmentId?, text}; no snake_case, no tenant / audit internals, no isActive', { timeout: T }, async () => {
    const r = await world().one(resolve(['SC1', 'SC2'], { departmentId: HAEM.id }));
    expect(Object.keys(r).sort()).toEqual(['resolved', 'unknown']);
    for (const x of r.resolved) expect(Object.keys(x).filter((k) => !['code', 'commentCodeId', 'version', 'departmentId', 'text'].includes(k))).toEqual([]);
    expect(keysOf(r).filter((k) => k.includes('_'))).toEqual([]);
  });
  it('empty-looking results are well formed: nothing known -> { resolved: [], unknown: [...] }', { timeout: T }, async () => {
    expect(await world().one(resolve(['NOPE1', 'NOPE2']))).toEqual({ resolved: [], unknown: ['NOPE1', 'NOPE2'] });
  });
});

describe('resolveCommentCodes: limits and validation (common.validation_failed)', () => {
  it('(16) more than 50 codes -> common.validation_failed; exactly 50 is fine', { timeout: T }, async () => {
    const env = world();
    expect(await codeOf(env.one(resolve(FIVE_O_ONE(51))))).toBe('common.validation_failed');
    expect(await codeOf(env.one(resolve(FIVE_O_ONE(500))))).toBe('common.validation_failed');
    const ok = await env.one(resolve(FIVE_O_ONE(50)));
    expect(ok.unknown).toHaveLength(50);
  });
  it('bad shapes -> common.validation_failed: codes not an array / not strings, bad asOf, bad departmentId, no input', { timeout: T }, async () => {
    const env = world();
    for (const bad of [resolve('SC1'), resolve([5]), resolve([null]), resolve([{}]), resolve(['SC1'], { asOf: 'yesterday' }), resolve(['SC1'], { asOf: '2026-10-01' }), resolve(['SC1'], { departmentId: 'not-a-uuid' }),
      resolve(['SC1'], { departmentId: 5 }), {}, undefined, null]) {
      expect(await codeOf(env.one(bad)), JSON.stringify(bad)).toBe('common.validation_failed');
    }
  });
  it('the 50-code limit applies before any query (a rejected call reads nothing)', { timeout: T }, async () => {
    const env = world();
    await codeOf(env.one(resolve(FIVE_O_ONE(51))));
    expect(env.db.stmts.filter((s) => /comment_codes|comment_code_texts/i.test(s.text))).toEqual([]);
  });
});

describe('resolveCommentCodes: tenant isolation, read-only, injection (S-1, S-6)', () => {
  it('tenant A never resolves tenant B\'s codes and vice versa; same code in both tenants resolves to each tenant\'s own text', { timeout: T }, async () => {
    const env = world();
    expect(await env.one(resolve(['SCB']))).toEqual({ resolved: [], unknown: ['SCB'] });
    const b = await env.one(resolve(['SCB', 'SC1']), { tenantId: B });
    expect(b.resolved.map((x: any) => [x.code, x.text])).toEqual([['SCB', 'Tenant B only'], ['SC1', 'Tenant B version of SC1']]);
    expect((await env.one(resolve(['SC2']), { tenantId: B })).unknown).toEqual(['SC2']);
    expect((await env.one(resolve(['SC1']))).resolved[0].text).toBe('Suite tenant-wide');
  });
  it('a department id from another tenant resolves nothing department-specific (falls back to tenant-wide, leaks nothing)', { timeout: T }, async () => {
    const r = await world().one(resolve(['SC1'], { departmentId: B_DEPT.id }));
    expect(r.resolved).toEqual([{ code: 'SC1', commentCodeId: SC1.id, version: 1, text: 'Suite tenant-wide' }]);
  });
  it('read-only and parameterised: no write / lock statement, every statement names tenant_id, binds the tenant, no code or id spliced into the SQL; statement count independent of the code count', { timeout: T }, async () => {
    const env = world();
    const from = env.db.stmts.length;
    await env.one(resolve(['SC1', 'SC2', 'SC4', 'SCD', 'NOPE'], { departmentId: HAEM.id, asOf: '2026-09-01T00:00:00.000Z' }));
    const mine = env.db.stmts.slice(from).filter((s) => /comment_codes|comment_code_texts/i.test(s.text));
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.filter((s) => WRITE.test(s.text))).toEqual([]);
    for (const s of mine) { expect(s.text, s.text).toMatch(/\btenant_id\b/i); expect(s.values).toContain(A); expect(s.text).not.toMatch(/SC1|SC2|SCD|NOPE/); expect(s.text).not.toContain(String(HAEM.id)); }
    expect(mine.length).toBeLessThanOrEqual(6);                                                         // a bulk read, not one query per code
  });
  it('SQL-injection shaped codes are data: unknown or rejected as invalid, and the table is intact', { timeout: T }, async () => {
    const env = world();
    const evil = "SC1'; DROP TABLE catalog.comment_codes;--";
    const out = await env.one(resolve([evil, 'SC1'])).then((r) => r, (e: any) => e);
    if (out?.resolved) { expect(out.resolved.map((x: any) => x.code)).toEqual(['SC1']); expect(out.unknown).toHaveLength(1); } else expect(out.code).toBe('common.validation_failed');
    expect(env.db.rows('comment_codes', A)).toHaveLength(ALL.filter((c) => c.tenant_id === A).length);
    expect(env.db.stmts.filter((s) => s.text.includes('DROP TABLE'))).toEqual([]);
  });
  it('does not mutate its input and returns plain data', { timeout: T }, async () => {
    const codes = Object.freeze(['sc1', 'SC2']) as readonly string[];
    const input = Object.freeze({ codes, departmentId: HAEM.id });
    const r = await world().one(input);                                  // a mutation of the frozen input would throw a TypeError here
    expect(r.resolved.map((x: any) => x.code)).toEqual(['SC1', 'SC2']);  });
});
