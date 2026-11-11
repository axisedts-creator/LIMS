// C5 T-18 — short codes: server-side resolution in result.service bulkEnterResults (PRD US-10; AC-10.2, AC-10.3; 02-TRD CR-C5-001 = CR-C3-001 `CatalogPort.resolveCommentCodes`;
//   05-SCHEMA lab.results.comment_codes / comment_lib_versions / comment_text; 07-SECURITY S-14 (plain text) + P-01 (tenant from ctx only)). AC-10.1 (UI expansion) is in the web component test.
// Same in-memory seam as result.service.enter.test.ts (no database: the production SQL store is wired by the core pipeline task; DB integration is NOT covered, see notes).
//
// SEAM (spec fixes behaviour, not names; the writer may dispute a name via the ruling flow):
//   ctx.ports.CatalogPort.resolveCommentCodes(ctx, { codes: Code[]; departmentId?; asOf? }): { resolved: { code, commentCodeId, version, departmentId?, text }[]; unknown: Code[] }   (03-IC §4.2, C3 shape)
//   bulkEnterResults, for the entries that carry `commentCodes`:
//     * ONE up-front resolution for the whole batch, before any row is processed (distinct, upper-cased codes, <= 50 per catalog call — C3 02-TRD §4.14), so an unknown code saves nothing;
//     * unknown code -> the call REJECTS with LimsError common.validation_failed (HTTP 400) and errors[] = [{ path: '/entries/<n>/comment_codes/<k>', code: 'common.field_invalid', message }]
//       (n = index in the request's entries[], k = index in that entry's comment_codes; every unknown code is listed). It is a request-level failure (AC-10.3 says 400), not a per-row outcome;
//     * saveEntry receives `commentCodes` (as resolved: upper-case), `commentLibVersions` ({ CODE: libraryVersion } — the jsonb stored in comment_lib_versions) and `commentText`:
//         - no commentText sent -> the expanded library texts of the codes, in entry order, joined by one space (the stored expansion, AC-10.2);
//         - commentText sent    -> kept verbatim (the UI already expanded the token, AC-10.1; free text typed around it must not be lost); codes + versions are still recorded;
//     * > 10 codes on one entry (CHECK results__comment_codes__ck) -> 400 common.validation_failed at '/entries/<n>/comment_codes', catalog not called;
//     * an entry without commentCodes never calls the catalog for comments (and an empty commentCodes: [] neither).
//   Out of scope here: amendResult (T-17) — its comment_codes resolution is not part of T-18's done_when (see notes).
import { describe, expect, it } from 'vitest';
import { LimsError } from '../../../../core/errors.js';
import { bulkEnterResults } from '../result.service.js';

const TENANT = '01a1a98a-ac40-7000-8000-00000000a001';
const ACTOR = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const MEMBERSHIP = '01a1b34e-2000-7eee-9d29-d7ca59a102b6';
const NOW = new Date('2026-06-15T05:00:00Z');
const ORDER = '01a1a98a-ac40-7000-8000-0000000c0001', ITEM = '01a1a98a-ac40-7000-8000-0000000b0001', PATIENT = '01a1a98a-ac40-7000-8000-0000000d0001', CENTRE = '01a1a98a-ac40-7000-8000-00000000a201';
const SPEC1 = '01a1a98a-ac40-7000-8000-0000000e0001';
const id = (n: number) => `01a1a98a-ac40-7000-8000-0000000a${n.toString(16).padStart(4, '0')}`;
const HB = { id: 'a-HB', code: 'HB', resultType: 'numeric', decimals: 1 };
// synthetic comment library: code -> { version, text }
const LIB: Record<string, { version: number; text: string }> = {
  HYPO: { version: 3, text: 'Hypochromia present.' },
  MICRO: { version: 1, text: 'Microcytosis noted.' },
  ANISO: { version: 7, text: 'Anisocytosis mild.' },
};

const row = (resultId: string, over: Record<string, unknown> = {}) => ({
  resultId, rowVersion: 3, status: 'pending', orderId: ORDER, orderItemId: ITEM, specimenId: SPEC1, patientId: PATIENT, testId: 't-cbc', analyteId: 'a-HB', centreId: CENTRE,
  currentVersionNo: 1, sex: 'female', patientAgeDays: 10950, specimenTypeCode: 'WB', unitCode: 'g/dL', analyte: HB, ...over,
});
const entry = (resultId: string, over: Record<string, unknown> = {}) => ({ resultId, version: 3, valueNumeric: '13.4', ...over });

function make(rows: any[], opt: { lib?: Record<string, { version: number; text: string }>; deptLib?: Record<string, Record<string, { version: number; text: string }>>; resolveFails?: Error; saveFails?: Record<string, Error> } = {}) {
  const tx = { id: 'tx-1' };
  const log: { fn: string; tenantId: unknown; arg: any }[] = [];
  const byId = new Map(rows.map((r) => [r.resultId, r]));
  const lib = opt.lib ?? LIB;
  const rec = (fn: string, tenantId: unknown, arg: any) => log.push({ fn, tenantId, arg });
  const store = {
    async lockResults(_t: unknown, tenantId: unknown, ids: string[]) { rec('lockResults', tenantId, ids); return ids.map((i) => byId.get(i)).filter(Boolean); },
    async deltaInputs() { return { candidates: [] }; },
    async saveEntry(_t: unknown, tenantId: unknown, a: any) {
      rec('saveEntry', tenantId, a);
      if (opt.saveFails?.[a.resultId]) throw opt.saveFails[a.resultId];
      const src = byId.get(a.resultId);
      return { id: a.resultId, version: a.expectedRowVersion + 1, status: a.transition ? 'resulted' : src.status, origin: 'manual', order_id: src.orderId, order_item_id: src.orderItemId, specimen_id: src.specimenId,
        test_id: src.testId, analyte_id: src.analyteId, analyte_code: src.analyte.code, value_numeric: a.value?.numeric ?? null, flag: a.evaluation?.flag ?? null, on_hold: false,
        comment_codes: a.commentCodes ?? [], comment_lib_versions: a.commentLibVersions ?? null, comment_text: a.commentText ?? null };
    },
    async rollupSpecimen() { /* not under test */ },
    async getResults(_t: unknown, _tenantId: unknown, ids: string[]) { return ids.map((i) => ({ id: i, version: 9, status: 'resulted', origin: 'calculated' })); },
    async listCriticalLog() { return []; },
    async insertCriticalLog() { return { criticalEventId: 'ce-1' }; },
    async markCriticalValueChanged() { /* not under test */ },
    async listCalculatedTargets() { return []; },
    async listInputs() { return []; },
    async inputUnitByCode() { return {}; },
    async applyComputed() { /* not under test */ },
    async amendCalculated() { /* not under test */ },
  };
  const ctx = {
    tenantId: TENANT, actor: { type: 'user', id: ACTOR, membershipId: MEMBERSHIP }, tx, now: () => NOW, store,
    events: { async publish() { return { eventId: 'ev', duplicate: false }; } },
    audit: { async access() { /* not under test */ } },
    ports: {
      CatalogPort: {
        async referenceRangeFor() { return { referenceRangeId: 'rr-1', version: 2, low: '12.0', high: '16.0', unitCode: 'g/dL' }; },
        async criticalLimitsFor() { return undefined; },
        // mirrors C3 02-TRD §4.14: upper-cases the codes, ≤50 per call, unknown codes are returned in `unknown` (never thrown)
        async resolveCommentCodes(_c: unknown, q: { codes: string[]; departmentId?: string; asOf?: string }) {
          rec('resolveCommentCodes', ctx.tenantId, q);
          if (opt.resolveFails) throw opt.resolveFails;
          if (q.codes.length > 50) throw new LimsError('common.validation_failed');
          const up = [...new Set(q.codes.map((c) => c.toUpperCase()))];
          // 03-IC §4.2 / C3 02-TRD: a department-specific active code wins over the tenant-wide one (only when departmentId is sent)
          const dl = (q.departmentId && opt.deptLib?.[q.departmentId]) || {};
          const pick = (c: string) => dl[c] ?? lib[c];
          return {
            resolved: up.filter((c) => pick(c)).map((c) => ({ code: c, commentCodeId: `cc-${c}`, version: pick(c)!.version, text: pick(c)!.text })),
            unknown: up.filter((c) => !pick(c)),
          };
        },
      },
      IdentityPort: { async assertRole() { /* allowed */ } },
    },
  };
  return { ctx: ctx as any, log, saves: () => log.filter((l) => l.fn === 'saveEntry').map((l) => l.arg), resolveCalls: () => log.filter((l) => l.fn === 'resolveCommentCodes').map((l) => l.arg) };
}
const run = (m: ReturnType<typeof make>, entries: any[]): Promise<any> => bulkEnterResults(m.ctx, { entries } as any);
const fail = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected rejection'); };

describe('T-18 AC-10.2 server re-resolves the codes and stores code + library version + expanded text', () => {
  it('codes only: saveEntry gets the code, { code: version } and the library text as comment text; the saved row carries all three', async () => {
    const m = make([row(id(1))]);
    const out = await run(m, [entry(id(1), { commentCodes: ['HYPO'] })]);
    expect(out.results[0].outcome).toBe('ok');
    const [s] = m.saves();
    expect(s.commentCodes).toEqual(['HYPO']);
    expect(s.commentLibVersions).toEqual({ HYPO: 3 });
    expect(s.commentText).toBe('Hypochromia present.');
    expect(out.results[0].result).toMatchObject({ comment_codes: ['HYPO'], comment_lib_versions: { HYPO: 3 }, comment_text: 'Hypochromia present.' });
  });
  it('several codes: versions per code, texts in the order sent joined by one space', async () => {
    const m = make([row(id(1))]);
    await run(m, [entry(id(1), { commentCodes: ['ANISO', 'HYPO', 'MICRO'] })]);
    const [s] = m.saves();
    expect(s.commentCodes).toEqual(['ANISO', 'HYPO', 'MICRO']);
    expect(s.commentLibVersions).toEqual({ ANISO: 7, HYPO: 3, MICRO: 1 });
    expect(s.commentText).toBe('Anisocytosis mild. Hypochromia present. Microcytosis noted.');
  });
  it('commentText sent together with codes (UI already expanded the token) is kept verbatim; codes and versions are still recorded', async () => {
    const m = make([row(id(1))]);
    await run(m, [entry(id(1), { commentCodes: ['HYPO'], commentText: 'Hypochromia present. Repeat smear advised.' })]);
    const [s] = m.saves();
    expect(s.commentText).toBe('Hypochromia present. Repeat smear advised.');
    expect(s.commentCodes).toEqual(['HYPO']);
    expect(s.commentLibVersions).toEqual({ HYPO: 3 });
  });
  it('lower-case input is upper-cased before the catalog call and stored upper-case (C3 resolves upper-case codes)', async () => {
    const m = make([row(id(1))]);
    await run(m, [entry(id(1), { commentCodes: ['hypo'] })]);
    expect(m.resolveCalls()[0].codes).toEqual(['HYPO']);
    expect(m.saves()[0]).toMatchObject({ commentCodes: ['HYPO'], commentLibVersions: { HYPO: 3 } });
  });
  it('a comment-only row (no value) with a code is saved without a status transition and without evaluation', async () => {
    const m = make([row(id(1), { status: 'resulted' })]);
    const out = await run(m, [{ resultId: id(1), version: 3, commentCodes: ['MICRO'] }]);
    expect(out.results[0].outcome).toBe('ok');
    const [s] = m.saves();
    expect(s.transition).toBeUndefined();
    expect(s.value).toBeUndefined();
    expect(s).toMatchObject({ commentCodes: ['MICRO'], commentLibVersions: { MICRO: 1 }, commentText: 'Microcytosis noted.' });
  });
  it('stored text is a snapshot: a later library edit (new text, version 4) is NOT applied to the earlier save; a new save records the new version', async () => {
    const first = make([row(id(1))]);
    await run(first, [entry(id(1), { commentCodes: ['HYPO'] })]);
    const edited = make([row(id(2))], { lib: { ...LIB, HYPO: { version: 4, text: 'Marked hypochromia.' } } });
    await run(edited, [entry(id(2), { commentCodes: ['HYPO'] })]);
    expect(first.saves()[0]).toMatchObject({ commentLibVersions: { HYPO: 3 }, commentText: 'Hypochromia present.' });
    expect(edited.saves()[0]).toMatchObject({ commentLibVersions: { HYPO: 4 }, commentText: 'Marked hypochromia.' });
  });
  it('the catalog is asked once per batch with the DISTINCT upper-case codes of all entries, tenant from ctx', async () => {
    const m = make([row(id(1)), row(id(2)), row(id(3))]);
    await run(m, [entry(id(1), { commentCodes: ['HYPO', 'MICRO'] }), entry(id(2), { commentCodes: ['micro', 'ANISO'] }), entry(id(3))]);
    expect(m.resolveCalls()).toHaveLength(1);
    expect([...m.resolveCalls()[0].codes].sort()).toEqual(['ANISO', 'HYPO', 'MICRO']);
    expect(m.log.find((l) => l.fn === 'resolveCommentCodes')!.tenantId).toBe(TENANT);
    expect(m.saves().map((s) => s.commentCodes)).toEqual([['HYPO', 'MICRO'], ['MICRO', 'ANISO'], undefined]);
  });
  it('more than 50 distinct codes in a batch: every catalog call carries <= 50 codes and all codes are resolved', async () => {
    const lib: Record<string, { version: number; text: string }> = {};
    const codes = Array.from({ length: 60 }, (_, i) => { const c = `C${String(i).padStart(2, '0')}`; lib[c] = { version: 1, text: `Text ${c}.` }; return c; });
    const m = make([row(id(1)), row(id(2)), row(id(3)), row(id(4)), row(id(5)), row(id(6))], { lib });
    const entries = [0, 1, 2, 3, 4, 5].map((n) => entry(id(n + 1), { commentCodes: codes.slice(n * 10, n * 10 + 10) }));
    const out = await run(m, entries);
    expect(out.results.every((r: any) => r.outcome === 'ok')).toBe(true);
    expect(m.resolveCalls().length).toBeGreaterThanOrEqual(2);
    for (const c of m.resolveCalls()) expect(c.codes.length).toBeLessThanOrEqual(50);
    expect(m.saves().map((s) => s.commentCodes.length)).toEqual([10, 10, 10, 10, 10, 10]);
  });
  it('no commentCodes (absent or empty): the catalog is not asked and nothing comment-related is added to the save', async () => {
    const m = make([row(id(1)), row(id(2))]);
    await run(m, [entry(id(1)), entry(id(2), { commentCodes: [], commentText: 'free text' })]);
    expect(m.resolveCalls()).toHaveLength(0);
    expect(m.saves()[0].commentLibVersions).toBeUndefined();
    expect(m.saves()[1].commentLibVersions).toBeUndefined();
    expect(m.saves()[1].commentText).toBe('free text');
  });
});

describe('T-18 review: department-specific codes (03-IC §4.2: department code wins over tenant-wide)', () => {
  const DEPT_H = '01a1a98a-ac40-7000-8000-0000000f0001', DEPT_M = '01a1a98a-ac40-7000-8000-0000000f0002';
  it('a code that exists only for the row\'s department resolves (no 400); the catalog receives that departmentId; the dept version + text are stored', async () => {
    const m = make([row(id(1), { departmentId: DEPT_H })], { deptLib: { [DEPT_H]: { HEMO: { version: 5, text: 'Haematology-only comment.' } } } });
    const out = await run(m, [entry(id(1), { commentCodes: ['HEMO'] })]);
    expect(out.results[0].outcome).toBe('ok');
    expect(m.resolveCalls().some((c) => c.departmentId === DEPT_H && c.codes.includes('HEMO'))).toBe(true);
    expect(m.saves()[0]).toMatchObject({ commentCodes: ['HEMO'], commentLibVersions: { HEMO: 5 }, commentText: 'Haematology-only comment.' });
  });
  it('a department override of a tenant-wide code is stored with the department text and version, not the tenant-wide ones', async () => {
    const m = make([row(id(1), { departmentId: DEPT_H })], { deptLib: { [DEPT_H]: { HYPO: { version: 9, text: 'Dept hypochromia text.' } } } });
    await run(m, [entry(id(1), { commentCodes: ['HYPO'] })]);
    expect(m.saves()[0]).toMatchObject({ commentLibVersions: { HYPO: 9 }, commentText: 'Dept hypochromia text.' });
  });
  it('rows of different departments in one batch: each code is resolved against ITS row\'s department (no cross-department leak)', async () => {
    const m = make([row(id(1), { departmentId: DEPT_H }), row(id(2), { departmentId: DEPT_M })], {
      deptLib: { [DEPT_H]: { HEMO: { version: 5, text: 'H text.' } }, [DEPT_M]: { MBIO: { version: 2, text: 'M text.' } } },
    });
    const out = await run(m, [entry(id(1), { commentCodes: ['HEMO'] }), entry(id(2), { commentCodes: ['MBIO'] })]);
    expect(out.results.every((r: any) => r.outcome === 'ok')).toBe(true);
    expect(m.saves().map((s) => s.commentLibVersions)).toEqual([{ HEMO: 5 }, { MBIO: 2 }]);
    // a code of another department is unknown for this row -> 400 at that entry, nothing saved
    const x = make([row(id(1), { departmentId: DEPT_H })], { deptLib: { [DEPT_M]: { MBIO: { version: 2, text: 'M text.' } } } });
    const e = await fail(run(x, [entry(id(1), { commentCodes: ['MBIO'] })]));
    expect(e.code).toBe('common.validation_failed');
    expect(e.errors[0].path).toBe('/entries/0/comment_codes/0');
    expect(x.saves()).toHaveLength(0);
  });
  it('unknown code in a later department group still saves nothing from earlier groups (all resolution happens before the first save)', async () => {
    const m = make([row(id(1), { departmentId: DEPT_H }), row(id(2), { departmentId: DEPT_M })], { deptLib: { [DEPT_H]: { HEMO: { version: 5, text: 'H text.' } } } });
    await fail(run(m, [entry(id(1), { commentCodes: ['HEMO'] }), entry(id(2), { commentCodes: ['NOPE'] })]));
    expect(m.saves()).toHaveLength(0);
  });
});

describe('T-18 review: expanded text longer than 1000 chars (results__comment_text__ck, #24 contract) -> 400 before any save', () => {
  const long = (n: number, ch: string) => ({ version: 1, text: ch.repeat(n) });
  it('two long library texts (600 + 600 + 1 space = 1201) and no commentText: 400 common.validation_failed at /entries/n/comment_codes, nothing saved', async () => {
    const m = make([row(id(1)), row(id(2))], { lib: { ...LIB, LONGA: long(600, 'a'), LONGB: long(600, 'b') } });
    const e = await fail(run(m, [entry(id(1), { commentCodes: ['HYPO'] }), entry(id(2), { commentCodes: ['LONGA', 'LONGB'] })]));
    expect(e).toBeInstanceOf(LimsError);
    expect(e.code).toBe('common.validation_failed');
    expect(e.statusCode).toBe(400);
    expect(e.errors[0]).toMatchObject({ path: '/entries/1/comment_codes', code: 'common.field_invalid' });
    expect(m.saves()).toHaveLength(0);
  });
  it('boundary: expanded text of exactly 1000 chars (499 + space + 500) is accepted and stored whole', async () => {
    const m = make([row(id(1))], { lib: { LONGA: long(499, 'a'), LONGB: long(500, 'b') } });
    const out = await run(m, [entry(id(1), { commentCodes: ['LONGA', 'LONGB'] })]);
    expect(out.results[0].outcome).toBe('ok');
    expect(m.saves()[0].commentText).toHaveLength(1000);
  });
  it('one char over the boundary (1001) is rejected', async () => {
    const m = make([row(id(1))], { lib: { LONGA: long(500, 'a'), LONGB: long(500, 'b') } });
    const e = await fail(run(m, [entry(id(1), { commentCodes: ['LONGA', 'LONGB'] })]));
    expect(e.errors[0].path).toBe('/entries/0/comment_codes');
  });
  it('a client-sent commentText is kept verbatim: long library texts do not trigger the limit when the client supplied the text', async () => {
    const m = make([row(id(1))], { lib: { LONGA: long(600, 'a'), LONGB: long(600, 'b') } });
    const out = await run(m, [entry(id(1), { commentCodes: ['LONGA', 'LONGB'], commentText: 'short client text' })]);
    expect(out.results[0].outcome).toBe('ok');
    expect(m.saves()[0].commentText).toBe('short client text');
  });
});

describe('T-18 AC-10.3 unknown code -> 400 common.validation_failed at /entries/n/comment_codes/k', () => {
  it('one unknown code: rejects with the field path of that entry index and code index', async () => {
    const m = make([row(id(1))]);
    const e = await fail(run(m, [entry(id(1), { commentCodes: ['HYPO', 'NOPE'] })]));
    expect(e).toBeInstanceOf(LimsError);
    expect(e.code).toBe('common.validation_failed');
    expect(e.statusCode).toBe(400);
    expect(e.errors).toHaveLength(1);
    expect(e.errors[0]).toMatchObject({ path: '/entries/0/comment_codes/1', code: 'common.field_invalid' });
  });
  it('n is the index in the REQUEST (also for rows without codes before it); every unknown code is listed, repeated codes each at their own k', async () => {
    const m = make([row(id(1)), row(id(2)), row(id(3))]);
    const e = await fail(run(m, [entry(id(1)), entry(id(2), { commentCodes: ['BAD1', 'HYPO', 'BAD1'] }), entry(id(3), { commentCodes: ['BAD2'] })]));
    expect(e.code).toBe('common.validation_failed');
    expect(e.errors.map((x: any) => x.path).sort()).toEqual(['/entries/1/comment_codes/0', '/entries/1/comment_codes/2', '/entries/2/comment_codes/0']);
  });
  it('NOTHING is saved when any code is unknown — not even the valid rows of the batch (no partial save)', async () => {
    const m = make([row(id(1)), row(id(2))]);
    await fail(run(m, [entry(id(1), { commentCodes: ['HYPO'] }), entry(id(2), { commentCodes: ['NOPE'] })]));
    expect(m.saves()).toHaveLength(0);
  });
  it('the error never echoes the submitted comment text or value (S-19)', async () => {
    const m = make([row(id(1))]);
    const e = await fail(run(m, [entry(id(1), { valueNumeric: '13.45', commentText: 'secret-synthetic-note', commentCodes: ['NOPE'] })]));
    const dump = JSON.stringify({ message: e.message, detail: e.detail, errors: e.errors });
    expect(dump).not.toContain('13.45');
    expect(dump).not.toContain('secret-synthetic-note');
  });
  it('an unknown code that only differs by case from a known one is KNOWN (hypo = HYPO); an inactive / deleted code is unknown (catalog reports it in `unknown`)', async () => {
    const ok = make([row(id(1))]);
    expect((await run(ok, [entry(id(1), { commentCodes: ['hypo'] })])).results[0].outcome).toBe('ok');
    const gone = make([row(id(1))], { lib: { MICRO: LIB.MICRO! } });
    const e = await fail(run(gone, [entry(id(1), { commentCodes: ['HYPO'] })]));
    expect(e.errors[0].path).toBe('/entries/0/comment_codes/0');
  });
  it('more than 10 codes on one entry (CHECK results__comment_codes__ck) -> 400 at /entries/n/comment_codes, catalog not called, nothing saved', async () => {
    const lib: Record<string, { version: number; text: string }> = {};
    const codes = Array.from({ length: 11 }, (_, i) => { const c = `K${i}`; lib[c] = { version: 1, text: `T${i}` }; return c; });
    const m = make([row(id(1))], { lib });
    const e = await fail(run(m, [entry(id(1), { commentCodes: codes })]));
    expect(e.code).toBe('common.validation_failed');
    expect(e.errors[0].path).toBe('/entries/0/comment_codes');
    expect(m.resolveCalls()).toHaveLength(0);
    expect(m.saves()).toHaveLength(0);
  });
});

describe('T-18 failure of the catalog / robustness', () => {
  it('a catalog failure is not turned into "unknown code": it propagates, nothing is saved (caller rolls the transaction back)', async () => {
    const m = make([row(id(1))], { resolveFails: new Error('catalog down') });
    await expect(run(m, [entry(id(1), { commentCodes: ['HYPO'] })])).rejects.toThrow('catalog down');
    expect(m.saves()).toHaveLength(0);
  });
  it('S-14: library text containing markup is stored verbatim (inert at render time), not stripped or executed by the service', async () => {
    const m = make([row(id(1))], { lib: { XSS: { version: 1, text: '<img src=x onerror=alert(1)>' } } });
    await run(m, [entry(id(1), { commentCodes: ['XSS'] })]);
    expect(m.saves()[0].commentText).toBe('<img src=x onerror=alert(1)>');
  });
  it('code-shaped but hostile input (SQL / path / over-long) is only ever "unknown" — never reaches the store', async () => {
    const m = make([row(id(1))]);
    const e = await fail(run(m, [entry(id(1), { commentCodes: ["'; DROP TABLE lab.results;--", '../../etc/passwd', 'X'.repeat(64)] })]));
    expect(e.code).toBe('common.validation_failed');
    expect(e.errors).toHaveLength(3);
    expect(m.saves()).toHaveLength(0);
  });
});
