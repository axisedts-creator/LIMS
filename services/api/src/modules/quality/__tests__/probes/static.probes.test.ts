// C9 T-25 — static / no-database probes of 07-SECURITY §5: S-16 (range and limit caps), S-17 (log scan, static half), S-18 (no SECURITY DEFINER), S-15 (consumers keep no barcode/value), S-22 (access-log
// registry). Scans non-test sources of services/api/src/modules/quality and services/worker/src/jobs/quality, and every db migration/policy file that mentions schema `quality`.
// Fails now if: a log/metric call names a denylisted field (02-CV §9.2; 07-SECURITY §6), an `action:` literal is not one of the four registered codes, a quality function is SECURITY DEFINER or lacks
// `SET search_path = ''`, a consumer reads PHI columns, or a list/range operation accepts more than the documented span / limit.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { REPO_ROOT } from '../../../../core/module.js';
import { OPS, SPEC, fire, loadManifest, makeHarness, minimalValue, requestFor, seen, uid, type OpInfo } from './kit.js';

function walk(dir: string, accept: (p: string) => boolean, out: string[] = []): string[] {
  let entries: string[] = [];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    if (e === '__tests__' || e === 'node_modules' || e === 'dist') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, accept, out); else if (accept(p)) out.push(p);
  }
  return out;
}
const API_Q = join(REPO_ROOT, 'services/api/src/modules/quality');
const WK_Q = join(REPO_ROOT, 'services/worker/src/jobs/quality');
const SRC = [...walk(API_Q, (p) => /\.ts$/.test(p)), ...walk(WK_Q, (p) => /\.ts$/.test(p) && !/\.test\.ts$/.test(p))];
const text = (p: string) => readFileSync(p, 'utf8');
/** text of each call whose opener matches `re`, parentheses matched */
function calls(src: string, re: RegExp): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(re)) {
    let i = m.index! + m[0].length, depth = 1;
    const start = i;
    while (i < src.length && depth > 0) { const ch = src[i++]; if (ch === '(') depth++; else if (ch === ')') depth--; }
    out.push(src.slice(start, i));
  }
  return out;
}

describe('the scan sees the module', () => {
  it('finds the api and worker sources', () => {
    expect(SRC.length).toBeGreaterThan(40);
    expect(SRC.some((p) => p.includes('jobs') && p.includes('consumers'))).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------------ S-17 static half
/** 07-SECURITY §6 "Never logged" + 02-CV §9.2 categories, as key names (case-insensitive substrings per 02-CV §9.2). */
const DENY = ['inputs', 'value_numeric', 'value_text', 'raw_value', 'result_value', 'barcode', 'registration_no', 'patient_name', 'patient', 'phone', 'email', 'description', 'notes', 'comment', 'note',
  'change_reason', 'confirmation_text', 'control_id', 'raw_control', 'definition', 'token', 'password', 'authorization'];
describe('S-17 (static) the module never logs result values, decision inputs, free text or raw control ids', () => {
  it('no console.* in non-test source (REQ-SEC-098)', () => {
    for (const f of SRC) expect(text(f), f).not.toMatch(/\bconsole\.(log|info|warn|error|debug|trace)\s*\(/);
  });
  it('no log call names a denylisted field', () => {
    const re = /\b(?:log|logger|ctx\.log|c\.log|job\.log|this\.log)\??\.(?:info|warn|error|debug|trace|fatal|child)\s*\(/g;
    for (const f of SRC) for (const c of calls(text(f), re)) for (const k of DENY) expect(c, `${f}: log call mentions ${k}`).not.toMatch(new RegExp(`\\b${k}\\b`, 'i'));
  });
  it('no metric call carries an id / raw code / value label (labels: tenant_id, status, outcome, rule, reason codes only)', () => {
    const re = /\bmetrics\??\.(?:inc|observe|set|gauge|counter|histogram)\s*\(/g;
    const BAD = ['instrument_code', 'raw', 'result_id', 'order_id', 'barcode', 'patient', 'control_id', 'value', 'plan_id', 'run_id', 'observation_id'];
    for (const f of SRC) for (const c of calls(text(f), re)) {
      const labels = /\{([^}]*)\}/.exec(c)?.[1] ?? '';
      for (const k of BAD) expect(labels, `${f}: metric label ${k}`).not.toMatch(new RegExp(`\\b${k}\\b`));
    }
  });
  it('error construction never interpolates a body value into the message / detail', () => {
    for (const f of SRC) for (const c of calls(text(f), /new LimsError\(/g)) expect(c, `${f}: LimsError(${c.slice(0, 60)}...)`).not.toMatch(/\$\{[^}]*(body|input|value|inputs)[^}]*\}/i);
  });
});

// ------------------------------------------------------------------------------------------------ S-15 consumers keep no PHI
describe('S-15 the instruments.result.received.v1 consumer reads ids / codes / timestamps only (07-SECURITY §6)', () => {
  const consumers = walk(WK_Q, (p) => /consumers[\\/]instruments\.result\.received\.v1\.ts$/.test(p));
  it('the consumer exists', () => expect(consumers.length).toBe(1));
  it('its source names no barcode / value / result-text / patient field and does not store or log the envelope', () => {
    const src = text(consumers[0]!);
    for (const k of ['barcode', 'value_numeric', 'value_text', 'raw_value', 'raw_text', 'patient', 'registration_no', 'result_value']) expect(src, k).not.toMatch(new RegExp(`\\b${k}\\b`, 'i'));
    expect(src).not.toMatch(/JSON\.stringify\(\s*(event|envelope|payload|e)\b/);
    expect(src).not.toMatch(/\b(log|logger)\??\.\w+\([^)]*(event|envelope|payload)\b/);
  });
});

// ------------------------------------------------------------------------------------------------ S-22 access-log registry
const FOUR = ['autoverify.activate', 'autoverify.retire', 'autoverify_decision.view', 'autoverify_simulation.view'];
describe('S-22 every access-log action literal is one of the four registered codes (02-TRD §5.6; 08 A13 P-3)', () => {
  const seed = text(join(REPO_ROOT, 'db/seeds/003_audit__g_cs_access_actions.sql'));
  it('the four codes exist in the audit.g_cs_access_actions seed', () => { for (const c of FOUR) expect(seed, c).toContain(`'${c}'`); });
  it('every `action: \'...\'` literal in services/**/quality/** is one of them, and each of the four is used', () => {
    const used = new Set<string>();
    // access-log codes are `autoverify.*` / `autoverify_*.view`; the run-event `action:` strings of review/run code are not access-log actions
    for (const f of SRC) for (const m of text(f).matchAll(/['"`](autoverify[a-z_]*\.[a-z_]+)['"`]/g)) used.add(m[1]!);
    expect([...used].filter((a) => !FOUR.includes(a)), 'unregistered action literals').toEqual([]);
    expect([...used].sort(), 'each registered code is written by the module').toEqual([...FOUR].sort());
  });
});

// ------------------------------------------------------------------------------------------------ S-18
describe('S-18 no SECURITY DEFINER among the quality functions; triggers are INVOKER with an empty search_path (REQ-SEC-019/020/021)', () => {
  const sqlFiles = [...walk(join(REPO_ROOT, 'db/migrations'), (p) => /\.sql$/.test(p)), ...walk(join(REPO_ROOT, 'db/policies'), (p) => /\.sql$/.test(p))];
  const fns: Array<{ file: string; name: string; body: string }> = [];
  for (const f of sqlFiles) {
    const t = text(f);
    for (const m of t.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(quality\.[a-z_0-9]+)\s*\(([\s\S]*?)(?=;\s*(?:--[^\n]*)?\n\s*(?:CREATE|ALTER|GRANT|REVOKE|COMMENT|DO|SELECT|INSERT|$))/gi)) fns.push({ file: f, name: m[1]!, body: m[0] });
  }
  it('scans the SQL tree', () => expect(sqlFiles.length).toBeGreaterThan(20));
  it('none of the C9 functions is SECURITY DEFINER; each sets search_path = \'\'', () => {
    for (const f of fns) {
      expect(f.body, `${f.name} (${f.file})`).not.toMatch(/SECURITY\s+DEFINER/i);
      expect(f.body, `${f.name} (${f.file})`).toMatch(/SET\s+search_path\s*=\s*''/i);
    }
  });
});

// ------------------------------------------------------------------------------------------------ S-16
describe('S-16 range and page caps', () => {
  let handlers: Record<string, (...a: any[]) => Promise<any>>;
  beforeAll(async () => { vi.stubEnv('LIMS_QUALITY_ENABLED', 'true'); handlers = (await loadManifest()).handlers; });
  const ALL = ['quality.autoverify.manage', 'quality.autoverify.read', 'quality.config.manage', 'quality.qc.manage', 'quality.qc_run.read', 'quality.qc_run.review', 'quality.tat_alert.ack', 'quality.tat_alert.read'];
  const DAY = 86_400_000;
  const NOW = Date.parse('2026-11-14T10:00:00.000Z');
  const iso = (ms: number) => new Date(ms).toISOString();
  const queryParams = (o: OpInfo): any[] => ((o.operation.parameters ?? []) as any[]).filter((p) => p.in === 'query' || p.$ref);

  it('every list operation takes the shared Limit parameter (maximum 200) and Cursor', () => {
    const lists = OPS.filter((o) => o.isList);
    expect(lists.length).toBeGreaterThanOrEqual(8);
    for (const o of lists) expect(JSON.stringify(o.operation.parameters), o.id).toMatch(/Limit/);
    expect((SPEC.components?.parameters?.Limit?.schema?.maximum) ?? 200).toBeLessThanOrEqual(200);
  });

  // [operationId, cap in days, name of the from/to pair as the spec declares it]
  const CAPS: Array<[string, number]> = [['listQcObservations', 92], ['listQcRuns', 92], ['listAutoverifyDecisions', 31], ['getLeveyJenningsChart', 400]];
  const pairOf = (o: OpInfo): [string, string] => {
    const names = queryParams(o).map((p) => p.name as string);
    const to = names.find((n) => /(^|_)to$/.test(n));
    const from = names.find((n) => /(^|_)from$/.test(n));
    if (!to || !from) throw new Error(`${o.id}: the spec declares no from/to query pair (${names.join(',')})`);
    return [from, to];
  };
  const q = (o: OpInfo, from: string, to: string, fromMs: number, toMs: number, extra: Record<string, unknown> = {}) => {
    const base: Record<string, unknown> = {};
    for (const p of queryParams(o)) if (p.required && p.name !== from && p.name !== to) base[p.name] = minimalValue(p.schema);
    if (o.id === 'getLeveyJenningsChart') base['level_id'] = uid();   // required by the service for view=level (spec marks it conditional)
    return { ...base, ...extra, [from]: iso(fromMs), [to]: iso(toMs) };
  };
  it.each(CAPS)('%s: a span of cap+1 days is 400 common.validation_failed, the cap itself is accepted (the boundary is exact)', async (id, cap) => {
    const op = OPS.find((o) => o.id === id)!;
    const [from, to] = pairOf(op);
    const over = makeHarness({ permissions: ALL, aal: 'aal2' }, id);
    const a = await fire(handlers[id]!, requestFor(op, { query: q(op, from, to, NOW - (cap + 1) * DAY, NOW) }), over.ctx);
    expect(a.reply, `span ${cap + 1} d answered ${a.reply?.status}`).toBeUndefined();
    expect(a.error?.code, String(a.error?.message)).toBe('common.validation_failed');
    expect(over.queries, 'rejected before any SQL').toEqual([]);
    const ok = makeHarness({ permissions: ALL, aal: 'aal2' }, id);
    const b = await fire(handlers[id]!, requestFor(op, { query: q(op, from, to, NOW - cap * DAY, NOW) }), ok.ctx);
    expect(b.error?.code, `span ${cap} d must not be a span error: ${seen(b.error)}`).not.toBe('common.validation_failed');
  });
  it.each(CAPS)('%s: to before from is 400', async (id) => {
    const op = OPS.find((o) => o.id === id)!;
    const [from, to] = pairOf(op);
    const h = makeHarness({ permissions: ALL, aal: 'aal2' }, id);
    const out = await fire(handlers[id]!, requestFor(op, { query: q(op, from, to, NOW, NOW - DAY) }), h.ctx);
    expect(out.error?.code).toBe('common.validation_failed');
  });
  it.each(OPS.filter((o) => o.isList).map((o) => [o.id, o] as const))('%s: limit=201 -> 400 common.validation_failed (never a page of 201)', async (_id, op) => {
    const h = makeHarness({ permissions: ALL, aal: 'aal2' }, op.id);
    const query: Record<string, unknown> = {};
    for (const p of queryParams(op)) if (p.required) query[p.name] = minimalValue(p.schema);
    query['limit'] = 201;
    const out = await fire(handlers[op.id]!, requestFor(op, { query }), h.ctx);
    expect(out.reply?.status, `limit 201 answered ${out.reply?.status}`).toBeUndefined();
    expect(out.error?.code, String(out.error?.message)).toBe('common.validation_failed');
  });
});
