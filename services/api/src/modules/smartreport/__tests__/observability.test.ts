// C14-T17 — observability: metrics (02-TRD §12), log fields, PHI log scan (AC-21.3; 07-SECURITY row 098 + S-10 "Logs"; 02-CV §9.1/§9.2).
// done_when: "metrics in 02-TRD §12 exported; rule file lists the six rules (worker test); log scan finds no block text/values".
// SEAMS (the spec fixes names/labels/fields, not TypeScript shapes; precedent = lab/__tests__/observability.test.ts, LD-120):
//  (1) the 15 lims_smartreport_* metrics are registered in services/api/src/core/observability/metrics.ts DEFS (createMetrics / REQUIRED_METRICS), the one registry /metrics exposes; an
//      unknown name THROWS there. NOTE for the writer: DEFS and core/observability/__tests__/metrics.test.ts (EXPECTED map) are C0 paths -> lead decision / CR first (LD-88, LD-120 precedent).
//  (2) emission goes through the optional sink `ctx.metrics?.inc?.(name, labels, by)` / `?.set?.(name, value, labels)` / `?.observe?.(name, value, labels)`. It MUST be optional: existing
//      T12/T15 tests pass a ctx with `metrics: { inc }` only, or none. `path` is one of port|staff|prebuild|preview; mode 'prebuild' => path 'prebuild'. `cached` is 'true'|'false'.
//  (3) build log lines carry the 02-TRD §12 fields as object args of ctx.log.info|warn|error (pino style `log.info({ ... }, 'msg')`; any object argument counts): summary_id, order_id,
//      library_version_id, outcome, duration_ms (number) on success/cached; outcome + error_code on a refusal. Ids only, never text or values.
//  (4) LLM metrics (llm_runs/items/calls_while_disabled/circuit_open/endpoint_refused) are Phase 3: registered here, not emitted by any code yet.
// Fails now: no lims_smartreport_* metric is registered or emitted, buildOrGet logs nothing.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../repository/summaries.repo.js', async () => (await import('./t12.fakes.js')).summariesRepoFake);
vi.mock('../repository/bindings.repo.js', async () => (await import('./t12.fakes.js')).bindingsRepoFake);
vi.mock('../repository/library.repo.js', async () => (await import('./t12.fakes.js')).libraryRepoFake);
vi.mock('../repository/blocks.repo.js', async () => (await import('./t12.fakes.js')).blocksRepoFake);
vi.mock('../repository/rules.repo.js', async () => (await import('./t12.fakes.js')).rulesRepoFake);
vi.mock('../repository/mappings.repo.js', async () => (await import('./t12.fakes.js')).mappingsRepoFake);
vi.mock('../repository/groups.repo.js', async () => (await import('./t12.fakes.js')).groupsRepoFake);
vi.mock('../repository/codedSets.repo.js', async () => (await import('./t12.fakes.js')).codedSetsRepoFake);

import { REPO_ROOT } from '../../../core/module.js';
import { createMetrics, REQUIRED_METRICS } from '../../../core/observability/metrics.js';
import { buildOrGet } from '../summary.service.js';
import {
  CENTRE, LabPort, LimsError, ORDER, PATIENT, REG_NO, TA, VER, ac081, approveLibrary, libOf, lib, makeCtx, retireLibrary, run, seed, setResults, amend, w,
} from './t12.fakes.js';

type Kind = 'counter' | 'gauge' | 'histogram';
/** 02-TRD §12 metric table, verbatim names/types/labels. */
const SR: Record<string, readonly [Kind, readonly string[]]> = {
  lims_smartreport_builds_total: ['counter', ['path', 'outcome']],
  lims_smartreport_build_duration_seconds: ['histogram', ['path', 'cached']],
  lims_smartreport_supersede_total: ['counter', ['reason']],
  lims_smartreport_drafts_pending: ['gauge', ['tenant_id']],
  lims_smartreport_draft_age_seconds: ['histogram', []],
  lims_smartreport_reviews_total: ['counter', ['action']],
  lims_smartreport_library_transitions_total: ['counter', ['to_status']],
  lims_smartreport_followup_skipped_total: ['counter', ['reason']],
  lims_smartreport_trend_unavailable_total: ['counter', []],
  lims_smartreport_llm_runs_total: ['counter', ['outcome']],
  lims_smartreport_llm_items_total: ['counter', ['outcome', 'failure_code']],
  lims_smartreport_llm_calls_while_disabled_total: ['counter', []],
  lims_smartreport_drafts_oldest_age_seconds: ['gauge', ['tenant_id']],
  lims_smartreport_llm_circuit_open: ['gauge', []],
  lims_smartreport_llm_endpoint_refused_total: ['counter', []],
};
const PATHS = ['port', 'staff', 'prebuild', 'preview'];
const TRD = join(REPO_ROOT, 'spec', 'chunks', 'C14-smart-report', '02-TRD.md');
const API_SR = join(REPO_ROOT, 'services', 'api', 'src', 'modules', 'smartreport');
const WK_SR = join(REPO_ROOT, 'services', 'worker', 'src', 'jobs', 'smartreport');

function sources(dir: string): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) { if (n !== '__tests__' && n !== 'node_modules') out.push(...sources(p)); continue; }
    if (/\.ts$/.test(n) && !/\.(test|spec)\.ts$/.test(n)) out.push({ file: relative(REPO_ROOT, p).replace(/\\/g, '/'), text: readFileSync(p, 'utf8') });
  }
  return out;
}
const SRC = [...sources(API_SR), ...sources(WK_SR)];

// ------------------------------------------------------------------------------------------------------------------------------------------------------------ registry
const T = '01a1a98a-ac40-7000-8000-00000000a001';
const L: Record<string, string> = { tenant_id: T, path: 'port', outcome: 'built', cached: 'false', reason: 'results_changed', action: 'approved', to_status: 'approved', failure_code: 'x' };
const pick = (names: readonly string[]) => Object.fromEntries(names.map((n) => [n, L[n]!]));
const emit = (m: ReturnType<typeof createMetrics>, name: string, kind: Kind, lb: Record<string, string>) => {
  const n = name as never;
  if (kind === 'counter') m.inc(n, lb); else if (kind === 'gauge') m.set(n, 1, lb); else m.observe(n, 3, lb);
};

describe('smartreport metrics registry (02-TRD §12 Metrics)', () => {
  it('the TRD §12 section names exactly the 15 metrics pinned here (guards this file against TRD drift)', () => {
    const text = readFileSync(TRD, 'utf8');
    const sec = text.slice(text.indexOf('## 12. Observability'), text.indexOf('## 13. Error codes used'));
    expect(sec.length).toBeGreaterThan(500);
    const names = new Set([...sec.matchAll(/\blims_smartreport_\w+/g)].map((x) => x[0]));
    names.add('lims_smartreport_llm_items_total');                               // written `_llm_items_total` in the TRD table row
    expect([...names].sort()).toEqual(Object.keys(SR).sort());
  });

  it('all 15 lims_smartreport_* metrics are registered in REQUIRED_METRICS, and nothing else with that prefix', () => {
    expect(REQUIRED_METRICS.filter((n) => n.startsWith('lims_smartreport_')).sort()).toEqual(Object.keys(SR).sort());
  });

  it.each(Object.entries(SR))('%s is exposed with the TRD type and its exact label set', async (name, [kind, labels]) => {
    const m = createMetrics();
    emit(m, name, kind, pick(labels));
    const text = await m.render();
    expect(text).toContain(`# TYPE ${name} ${kind}`);
    for (const l of labels) expect(text).toMatch(new RegExp(`^${name}\\w*\\{[^}]*\\b${l}="${L[l]}"`, 'm'));
  });

  it.each(Object.entries(SR))('%s rejects a PHI / id label outside its set (order_id, patient_id, summary_id, registration_no, text never become labels)', (name, [kind, labels]) => {
    const m = createMetrics();
    expect(() => emit(m, name, kind, pick(labels)), `${name} valid labels`).not.toThrow();   // not vacuous: an unknown metric also throws
    for (const bad of ['order_id', 'patient_id', 'summary_id', 'registration_no', 'patient_name', 'analyte_name', 'text', 'value']) {
      expect(() => emit(m, name, kind, { ...pick(labels), [bad]: 'x' }), `${name}+${bad}`).toThrow();
    }
  });

  it('the two draft gauges are per tenant (alert expr is max by (tenant_id))', async () => {
    const m = createMetrics();
    m.set('lims_smartreport_drafts_oldest_age_seconds' as never, 90000, { tenant_id: T });
    expect(await m.render()).toMatch(new RegExp(`lims_smartreport_drafts_oldest_age_seconds\\{[^}]*tenant_id="${T}"[^}]*\\} 90000\\b`));
  });

  it.each(Object.keys(SR).filter((n) => !/_llm_|llm_/.test(n)))('%s is emitted by smartreport code (non-test source under api smartreport/** or worker jobs/smartreport/**), not only declared', (name) => {
    const hit = SRC.filter((s) => s.text.includes(name)).map((s) => s.file);
    expect(hit, `no smartreport source references ${name}`).not.toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------ emission from buildOrGet
type Call = { kind: Kind; name: string; labels: Record<string, string | number>; value: number };
function recorder() {
  const calls: Call[] = [];
  const rec = (kind: Kind, name: string, labels: Record<string, string | number> = {}, value = 1) => { calls.push({ kind, name, labels, value }); };
  return { calls, sink: { inc: (n: string, l?: any, by?: number) => rec('counter', n, l, by ?? 1), set: (n: string, v: number, l?: any) => rec('gauge', n, l, v), observe: (n: string, v: number, l?: any) => rec('histogram', n, l, v) } };
}
const fails = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected the call to be refused'); };
const build = (ctx: any, input: Record<string, unknown> = {}) => run(ctx, () => buildOrGet(ctx, { orderId: ORDER.a, ...input } as any));
const metered = (tenant: 'A' | 'B' = 'A', type: 'system' | 'user' = 'system') => { const ctx = makeCtx(tenant, type); const r = recorder(); ctx.metrics = r.sink; return { ctx, calls: r.calls }; };
const named = (calls: Call[], name: string) => calls.filter((c) => c.name === name);
/** every object argument of every log call, flattened: the structured fields (02-TRD §12). */
const logFields = (ctx: any): Record<string, unknown>[] => [ctx.log.info, ctx.log.warn, ctx.log.error].flatMap((f) => f.mock.calls.map((a: unknown[]) => Object.assign({}, ...a.filter((x) => x && typeof x === 'object'))));
const logLines = (ctx: any): string => JSON.stringify([ctx.log.info.mock.calls, ctx.log.warn.mock.calls, ctx.log.error.mock.calls]);

beforeEach(() => { seed(); approveLibrary(1); vi.clearAllMocks(); });

describe('C14-T17 buildOrGet emits the 02-TRD §12 metrics', () => {
  it('every emitted call is a TRD metric of the right kind with labels inside the declared set (what core createMetrics would enforce)', async () => {
    const { ctx, calls } = metered();
    await build(ctx);
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(SR[c.name], `unknown metric ${c.name}`).toBeDefined();
      expect(SR[c.name]![0], c.name).toBe(c.kind);
      for (const k of Object.keys(c.labels)) expect(SR[c.name]![1], `${c.name} label ${k}`).toContain(k);
    }
  });

  it('first build: builds_total{outcome built} once and build_duration_seconds{path, cached false} once; path is one of the four', async () => {
    const { ctx, calls } = metered();
    await build(ctx);
    const b = named(calls, 'lims_smartreport_builds_total');
    expect(b).toHaveLength(1);
    expect(b[0]!.labels['outcome']).toBe('built');
    expect(PATHS).toContain(b[0]!.labels['path']);
    const d = named(calls, 'lims_smartreport_build_duration_seconds');
    expect(d).toHaveLength(1);
    expect(d[0]!.labels).toMatchObject({ path: b[0]!.labels['path'], cached: 'false' });
    expect(d[0]!.value).toBeGreaterThanOrEqual(0);
  });

  it('mode "prebuild" is path "prebuild"', async () => {
    const { ctx, calls } = metered();
    await build(ctx, { mode: 'prebuild' });
    expect(named(calls, 'lims_smartreport_builds_total')[0]!.labels).toMatchObject({ path: 'prebuild', outcome: 'built' });
  });

  it('same call again: outcome "cached" and duration cached "true"; nothing is superseded', async () => {
    await build(makeCtx());
    const { ctx, calls } = metered();
    await build(ctx);
    expect(named(calls, 'lims_smartreport_builds_total').map((c) => c.labels['outcome'])).toEqual(['cached']);
    expect(named(calls, 'lims_smartreport_build_duration_seconds')[0]!.labels['cached']).toBe('true');
    expect(named(calls, 'lims_smartreport_supersede_total')).toEqual([]);
  });

  it('results changed: supersede_total{reason results_changed} once, then the rebuild counts as built', async () => {
    await build(makeCtx());
    amend(ORDER.a, w.results.get(ORDER.a)![0]!.resultId);
    const { ctx, calls } = metered();
    await build(ctx);
    expect(named(calls, 'lims_smartreport_supersede_total').map((c) => c.labels)).toEqual([{ reason: 'results_changed' }]);
    expect(named(calls, 'lims_smartreport_builds_total').map((c) => c.labels['outcome'])).toEqual(['built']);
  });

  it('rebuild_with_active_library onto a newer library: supersede_total{reason library_rebuild}', async () => {
    await build(makeCtx());
    retireLibrary(1); approveLibrary(2);
    const { ctx, calls } = metered('A', 'user');
    await build(ctx, { mode: 'rebuild_with_active_library' });
    expect(named(calls, 'lims_smartreport_supersede_total').map((c) => c.labels)).toEqual([{ reason: 'library_rebuild' }]);
  });

  it('refusals are counted by outcome: no approved results -> no_eligible; no approved library -> not_approved', async () => {
    setResults(ORDER.a, []);
    const a = metered();
    expect((await fails(build(a.ctx))).code).toBe('smartreport.no_eligible_results');
    expect(named(a.calls, 'lims_smartreport_builds_total').map((c) => c.labels['outcome'])).toEqual(['no_eligible']);
    setResults(ORDER.a, ac081()); lib.versions.length = 0;
    const b = metered();
    expect((await fails(build(b.ctx))).code).toBe('smartreport.template_not_approved');
    expect(named(b.calls, 'lims_smartreport_builds_total').map((c) => c.labels['outcome'])).toEqual(['not_approved']);
  });

  it('an unexpected failure is counted outcome "error" (feeds SmartBuildErrors) and still propagates unchanged', async () => {
    const spy = vi.spyOn(LabPort, 'getOrderResults').mockRejectedValueOnce(new LimsError('common.internal'));
    const { ctx, calls } = metered();
    expect((await fails(build(ctx))).code).toBe('common.internal');
    expect(named(calls, 'lims_smartreport_builds_total').map((c) => c.labels['outcome'])).toEqual(['error']);
    spy.mockRestore();
  });

  it('metrics are optional: no ctx.metrics, or one with only inc, still builds (existing T12/T15 contexts)', async () => {
    const a = makeCtx(); delete a.metrics;
    expect((await build(a)).created).toBe(true);
    seed(); approveLibrary(1);
    const b = makeCtx(); b.metrics = { inc: vi.fn() };
    expect((await build(b)).created).toBe(true);
  });

  it('metric labels never carry an id, registration number, name or value (planted synthetic values across a full journey)', async () => {
    const { ctx, calls } = metered();
    await build(ctx, { reportVersionNo: 1 });
    amend(ORDER.a, w.results.get(ORDER.a)![0]!.resultId);
    await build(ctx);
    const blob = JSON.stringify(calls);
    expect(calls.length, 'a scan of no metric calls proves nothing').toBeGreaterThan(0);
    for (const p of [REG_NO, PATIENT.a, ORDER.a, CENTRE.a, TA, VER(1), '13.40', 'Hemoglobin']) expect(blob, p).not.toContain(p);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------ log fields
describe('C14-T17 build log fields (02-TRD §12: 02-CV §9.1 fields + summary_id, order_id, library_version_id, outcome, duration_ms, error_code)', () => {
  it('a built summary logs one line with summary_id, order_id, library_version_id, outcome "built" and a numeric duration_ms', async () => {
    const ctx = makeCtx();
    const { summary } = await build(ctx);
    const hit = logFields(ctx).filter((f) => f['summary_id'] === summary.id);
    expect(hit).toHaveLength(1);
    expect(hit[0]).toMatchObject({ order_id: ORDER.a, library_version_id: VER(1), outcome: 'built' });
    expect(typeof hit[0]!['duration_ms']).toBe('number');
    expect(hit[0]!['duration_ms'] as number).toBeGreaterThanOrEqual(0);
  });

  it('a cached build logs outcome "cached" with the same summary_id', async () => {
    const first = await build(makeCtx());
    const ctx = makeCtx();
    await build(ctx);
    expect(logFields(ctx).filter((f) => f['summary_id'] === first.summary.id).map((f) => f['outcome'])).toEqual(['cached']);
  });

  it('a refusal logs outcome and error_code, plus order_id; no summary_id (none exists)', async () => {
    setResults(ORDER.a, []);
    const ctx = makeCtx();
    await fails(build(ctx));
    const hit = logFields(ctx).filter((f) => f['error_code'] === 'smartreport.no_eligible_results');
    expect(hit).toHaveLength(1);
    expect(hit[0]).toMatchObject({ outcome: 'no_eligible', order_id: ORDER.a });
    expect(typeof hit[0]!['duration_ms']).toBe('number');
  });
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------ PHI log scan (AC-21.3)
const BLOCK_TEXTS = (): string[] => libOf().blocks.map((b: any) => b.textEn).filter((t: unknown): t is string => typeof t === 'string' && t.length >= 8);
const PLANTED = { value: '13.40', analyte: 'Hemoglobin', analyte2: 'Creatinine', test: 'Complete blood count', reg: REG_NO, valueText: 'see comment' };

describe('C14-T17 PHI log scan (AC-21.3; 07-SECURITY 098; 02-CV §9.2 "smart-report text")', () => {
  it('static: no log / console call in smartreport API or worker source mentions text, value, name, registration, comment or LLM input/output fields', () => {
    const bad: string[] = [], seen: string[] = [];
    const FORBIDDEN = /\b(textEn|text_en|filledText|filled_text|valueText|value_text|valueNumeric|value_numeric|valueRaw|registration_?no|patient_?name|analyte_?name|test_?name|llm_?input|llm_?output|prompt|content|text|value|comment|name)\b/i;
    for (const { file, text } of SRC) {
      for (const m of text.matchAll(/\b(?:ctx|c|jobCtx|log|logger)\??\.(?:log\??\.)?(?:info|warn|error|debug)\??\.?\(|\bconsole\.\w+\(/g)) {
        let depth = 0, i = m.index! + m[0].length - 1;
        const start = i;
        for (; i < text.length; i++) { if (text[i] === '(') depth++; else if (text[i] === ')' && --depth === 0) break; }
        const call = text.slice(start, i + 1);
        seen.push(file);
        if (/\bconsole\./.test(m[0])) bad.push(`${file}: console call`);
        else if (FORBIDDEN.test(call.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, ''))) bad.push(`${file}: ${call.replace(/\s+/g, ' ').slice(0, 120)}`);   // string literals (log messages) are stripped; identifiers are scanned
      }
    }
    expect(seen.length, 'the scan must find the existing build-refused warn plus the new build line').toBeGreaterThanOrEqual(2);
    expect(bad).toEqual([]);
  });

  it('dynamic: a full journey (build, cached, amend -> supersede, refusal, error) leaves no block text, filled text, value, analyte/test name or registration number in any log line or metric call', async () => {
    const texts = BLOCK_TEXTS();
    expect(texts.length, 'starter library blocks give the scan something to look for').toBeGreaterThan(0);
    const ctxs: any[] = [];
    const calls: Call[] = [];
    const go = async (fn: (ctx: any) => Promise<unknown>) => { const ctx = makeCtx(); const r = recorder(); ctx.metrics = r.sink; ctxs.push(ctx); try { await fn(ctx); } catch { /* refusals are part of the journey */ } calls.push(...r.calls); };
    await go((c) => build(c, { reportVersionNo: 1 }));
    await go((c) => build(c, { reportVersionNo: 1 }));
    amend(ORDER.a, w.results.get(ORDER.a)![0]!.resultId);
    await go((c) => build(c));
    setResults(ORDER.a, []);
    await go((c) => build(c));
    setResults(ORDER.a, ac081());
    const spy = vi.spyOn(LabPort, 'getOrderResults').mockRejectedValueOnce(new LimsError('common.internal', `failed for ${REG_NO}`));
    await go((c) => build(c));
    spy.mockRestore();
    const all = ctxs.map(logLines).join('\n') + JSON.stringify(calls);
    expect(ctxs.reduce((n, c) => n + logFields(c).length, 0), 'the journey must log (a scan of nothing proves nothing)').toBeGreaterThanOrEqual(4);
    for (const p of [...Object.values(PLANTED), ...texts]) expect(all, p).not.toContain(p);
  });

  it('dynamic: an error message that carries a registration number is not copied into the log line (log the code, not the message)', async () => {
    const spy = vi.spyOn(LabPort, 'getOrderResults').mockRejectedValueOnce(new LimsError('common.internal', `lookup failed for ${REG_NO}`));
    const ctx = makeCtx();
    await fails(build(ctx));
    spy.mockRestore();
    expect(logFields(ctx).some((f) => f['error_code'] === 'common.internal')).toBe(true);
    expect(logLines(ctx)).not.toContain(REG_NO);
  });
});
