// C11 T-18 done_when: "Every operationId covered by generator + hand-written cases (07-SECURITY §5)". Runs without a database.
// What it proves: (1) the 02-TRD §5 numbering used by 07-SECURITY §5.1 matches the spec's own "(TRD §5 <code>)" summaries and covers exactly the 70 operationIds;
// (2) every operationId receives >= 1 probe kind from probe-matrix.ts (generator or hand-written table) and every §5.1 id kind has a path parameter in the spec;
// (3) no operationId is still a stub: a probe against a 501/"not implemented" handler would prove nothing (T-18 depends on T-07…T-16).
// Fails now (expected): saveAnatomicSlideAssessment (M4), listAnatomicStainOrders (M6), listAnatomicBlocks (M12) are still stubs in handlers/index.ts —
// 07-SECURITY §5.1 names M6 and M12 as list endpoints that must show zero tenant-B rows, so they must exist before the probes can mean anything.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { manifest } from '../../index.js';
import { OP, OPS, ops, PATH_KIND, probeKinds, SPEC, TRD, UPSERT_BY_KEY } from './probe-matrix.js';

describe('C11-T18 coverage of 07-SECURITY §5 over every operationId', () => {
  it('the TRD §5 codes (A1–A12, M1–M15, R1–R10, I1–I4, Q1–Q7, K1–K22) map 1:1 onto the 70 operationIds of anatomic.yaml', () => {
    const fam = (l: string) => Object.keys(TRD).filter((c) => c.startsWith(l)).length;
    expect([fam('A'), fam('M'), fam('R'), fam('I'), fam('Q'), fam('K')]).toEqual([12, 15, 10, 4, 7, 22]);
    expect(Object.values(TRD).sort()).toEqual([...OPS].sort());
    expect(OPS).toHaveLength(70);
  });

  it('each code agrees with the "(TRD §5 <code>)" the spec itself prints in the operation summary (the table is not a guess)', () => {
    const wrong: string[] = [];
    for (const [code, opId] of Object.entries(TRD)) {
      const summary: string = Object.values<any>(SPEC.paths).flatMap((i) => Object.values<any>(i)).find((o) => o?.operationId === opId)?.summary ?? '';
      if (!new RegExp(`\\(TRD §5 ${code}\\)`).test(summary)) wrong.push(`${code} ${opId}: "${summary}"`);
    }
    expect(wrong).toEqual([]);
  });

  it('every operationId is hit by at least one generated or hand-written probe kind', () => {
    const uncovered = ops().filter((o) => probeKinds(o).length === 0).map((o) => o.operationId);
    expect(uncovered).toEqual([]);
  });

  it('every path parameter of the spec is a 07-SECURITY §5.1 id kind (or a plain enum/number) — a new id kind cannot slip in unprobed', () => {
    const known = new Set([...Object.keys(PATH_KIND), 'set_name', 'version_no']);
    const unknown = ops().flatMap((o) => o.pathParams.filter((p) => !known.has(p.name)).map((p) => `${o.operationId}:${p.name}`));
    expect(unknown).toEqual([]);
  });

  it('every §5.1 path-id kind occurs in the spec (case, part, slide, block, stain_order, addendum, image, batch, template, stain, assay, text_template, test, code)', () => {
    const used = new Set(ops().flatMap((o) => o.pathParams.map((p) => p.name)));
    expect(Object.keys(PATH_KIND).filter((k) => !used.has(k))).toEqual([]);
  });

  it('only the two key-addressed upserts are exempt from the "foreign path id -> 404" generator, and each has another probe kind', () => {
    expect(UPSERT_BY_KEY.every((id) => OP[id] !== undefined)).toBe(true);
    for (const id of UPSERT_BY_KEY) expect(probeKinds(OP[id]!).some((k) => /path-id-of-tenant-B/.test(k))).toBe(false);
    for (const id of UPSERT_BY_KEY) expect(probeKinds(OP[id]!).length).toBeGreaterThan(0);
  });

  it('every case-scoped operation is probed for the cross-centre rule (07-SECURITY §5.2)', () => {
    const caseScoped = ops().filter((o) => o.pathParams.some((p) => p.name === 'case_id')).map((o) => o.operationId);
    expect(caseScoped.length).toBeGreaterThanOrEqual(20);
    expect(caseScoped.filter((id) => !probeKinds(OP[id]!).some((k) => /other-centre/.test(k)))).toEqual([]);
  });
});

describe('C11-T18 no operationId is a stub (probes against 501 / common.internal "not implemented" prove nothing)', () => {
  afterEach(() => { vi.unstubAllEnvs(); });
  const bare = { operationId: 'probe', clientIp: '127.0.0.1', log: { info() {}, warn() {}, error() {} } } as any;
  const isStub = async (id: string): Promise<boolean> => {
    vi.stubEnv('LIMS_CORE_ENV', 'dev');
    const r: any = await Promise.resolve(manifest.handlers[id]!({ params: {}, query: {}, headers: {}, body: {} }, bare)).then((v) => v, (e: any) => e);
    if (r && typeof r === 'object' && r.status === 501) return true;
    return /not implemented/i.test([r?.message, r?.detail, String(r)].join(' '));
  };

  it('all 70 handlers are real implementations', async () => {
    const stubs: string[] = [];
    for (const id of OPS) if (await isStub(id)) stubs.push(id);
    expect(stubs).toEqual([]);
  });
});
