// C10 T-25 — S-20 log scan (07-SECURITY §5 S-20, T-D1; 02-TRD §11 denylist; REQ-SEC-095/098; 05-DoD §1.8) and S-21 (no console / URL leaks in module source).
// No database. (a) static: no console.* and no logger/metrics call in non-test micro source mentions a denylisted field or uses a metric label other than tenant_id/status/outcome;
// (b) dynamic: every operation with a JSON body is driven with a planted synthetic marker in EVERY string field (scripted empty tx, all permissions granted); whatever the
// outcome (success, 4xx, TypeError), the marker must not appear in captured log calls, metric labels, or the error's message/detail/field errors (error responses never echo values).
// The live-DB half of S-20 (real rows under RLS) is in rls.probes.test.ts. Synthetic data only.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LimsError } from '../../../../core/errors.js';
import { mkCtx, run, spec, specOps, READ, WORK, MANAGE, type Row } from '../../handlers/__tests__/helpers/cultureReads.js';

/** 02-TRD §11 "Logger denylist additions for this module" (review #13), copied verbatim. */
export const DENY = ['sample_barcode', 'barcode', 'barcode_snapshot', 'raw_value', 'raw_numeric', 'raw_qualifier', 'finding_text', 'culture_summary_text', 'summaryText', 'comments_text', 'comment',
  'colony_description', 'quantity_text', 'incubation_text', 'media_code', 'growth_code', 'outcome_code', 'organism_code', 'organism_code_raw', 'antibiotic_code', 'antibiotic_code_raw', 'category_code',
  'interpretation_raw', 'isolates', 'ast', 'amendment_reason_text', 'reasonText', 'early_final_reason', 'cancel_comment', 'withdraw_comment', 'ignore_comment', 'licence_attestation_text',
  'specimen_type_code', 'specimen_site_code'] as const;
const MODULE = join(__dirname, '..', '..');

function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === '__tests__' || e === 'node_modules') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) sources(p, out); else if (/\.ts$/.test(e)) out.push(p);
  }
  return out;
}
/** text of each `<recv>.log…(` / `logger.…(` / `metrics.inc(` call, parentheses matched */
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

describe('S-20 (a) static scan of the module source', () => {
  const files = sources(MODULE);
  it('scans the module sources', () => expect(files.length).toBeGreaterThan(30));

  it('no console.* in the module (REQ-SEC-098)', () => {
    for (const f of files) expect(readFileSync(f, 'utf8'), f).not.toMatch(/\bconsole\.(log|info|warn|error|debug|trace)\s*\(/);
  });

  it('no logger call mentions a denylisted field', () => {
    const re = /\b(?:log|logger|ctx\.log|c\.log)\??\.(?:info|warn|error|debug|trace|fatal|child)\s*\(/g;
    for (const f of files) for (const c of calls(readFileSync(f, 'utf8'), re))
      for (const k of DENY) expect(c, `${f}: log call mentions ${k}`).not.toMatch(new RegExp(`\\b${k}\\b`));
  });

  it('metrics labels are tenant_id / status / outcome only (07-SECURITY §6: no organism / antibiotic labels)', () => {
    const re = /\bmetrics\??\.(?:inc|observe|set|gauge)\s*\(/g;
    for (const f of files) for (const c of calls(readFileSync(f, 'utf8'), re)) {
      for (const k of DENY) expect(c, `${f}: metric mentions ${k}`).not.toMatch(new RegExp(`\\b${k}\\b`));
      const labels = /\{([^}]*)\}/.exec(c)?.[1] ?? '';
      // label names declared in 02-TRD §11 metric table (status/outcome-type codes and tenant only)
      const TRD_LABELS = ['tenant_id', 'tenantId', 'status', 'outcome', 'phase', 'kind', 'error_code', 'record_kind', 'match_status'];
      for (const key of labels.split(',').map((s) => s.split(':')[0]!.trim()).filter(Boolean)) expect(TRD_LABELS, `${f}: label ${key}`).toContain(key);
    }
  });

  it('the scanner detects a planted violation', () => {
    const bad = "ctx.log.info('x', { barcode: b }); metrics.inc('m', { organism_code: o })";
    expect(calls(bad, /\bctx\.log\.(?:info)\s*\(/g)[0]).toMatch(/\bbarcode\b/);
    expect(calls(bad, /\bmetrics\??\.(?:inc)\s*\(/g)[0]).toMatch(/\borganism_code\b/);
  });
});

// ---------------------------------------------------------------- (b) dynamic
const ops = specOps();
const deref = (s: any): any => (s && typeof s.$ref === 'string' ? deref(spec.components.schemas[s.$ref.replace('#/components/schemas/', '')]) : s);
const MARK = 'SYNTH-PLANTED-9f3a';
/** a body with the marker planted in every free string; enums/uuids/dates get a valid shape so the handler gets as deep as it can */
function plant(s: any, key: string): unknown {
  const d = deref(s);
  if (!d) return null;
  if (d.allOf) return Object.assign({}, ...d.allOf.map((x: any) => plant(x, key)));
  if (d.oneOf ?? d.anyOf) return plant((d.oneOf ?? d.anyOf)[0], key);
  if (d.enum) return d.enum[0];
  switch (d.type) {
    case 'object': return Object.fromEntries(Object.entries<any>(d.properties ?? {}).map(([k, v]) => [k, plant(v, k)]));
    case 'array': return [plant(d.items, key)];
    case 'integer': case 'number': return d.minimum ?? 1;
    case 'boolean': return true;
    case 'string':
      if (d.format === 'uuid') return '0190c60c-0000-7000-8000-00000000f001';
      if (d.format === 'date-time') return '2026-11-05T05:00:00.000Z';
      if (d.format === 'date') return '2026-11-05';
      return `${MARK}-${key}`.slice(0, d.maxLength ?? 1000);
    default: return null;
  }
}
const pathParams = (name: string): Row => {
  for (const [path, item] of Object.entries<any>(spec.paths)) for (const op of Object.values<any>(item)) if (op?.operationId === name)
    return Object.fromEntries([...path.matchAll(/\{(\w+)\}/g)].map((m) => [m[1]!, m[1] === 'set_name' ? 'organisms' : m[1] === 'code' ? 'syn_code' : m[1] === 'version_no' ? '1' : '0190c60c-0000-7000-8000-00000000f001']));
  return {};
};
const bodyOps = Object.entries(ops).filter(([, o]) => o.requestBody?.content?.['application/json']?.schema);

describe('S-20 (b) planted markers never reach logs, metrics or error bodies', () => {
  it('there are body operations to drive', () => expect(bodyOps.length).toBeGreaterThan(15));

  it.each(bodyOps)('%s', async (name, op) => {
    const captured: unknown[] = [];
    const sink = (...a: unknown[]) => { captured.push(a); };
    const tx = { async query() { return { rows: [], rowCount: 0 }; }, async connect() { return this; }, release() {} };
    const { ctx } = mkCtx({ tenantId: '01a1a98a-ac40-7000-8000-00000000a001', tx, grants: [READ, WORK, MANAGE, 'micro.breakpoint.manage', 'lab.result.read'] });
    ctx.log = { info: sink, warn: sink, error: sink, debug: sink, child() { return this; } };
    ctx.metrics = { inc: sink, observe: sink };
    const body = plant(op.requestBody.content['application/json'].schema, 'root');
    const err: any = await run(name, { params: pathParams(name), query: {}, headers: { 'if-match': '"1"', 'idempotency-key': 'syn-key-0001' }, body }, ctx).then(() => undefined, (e: unknown) => e);
    const surfaced = err === undefined ? '' : JSON.stringify({
      m: err.message, d: err instanceof LimsError ? err.detail : undefined, e: err instanceof LimsError ? err.errors : undefined, c: err.code,
    });
    expect(JSON.stringify(captured), `${name}: logs/metrics`).not.toContain(MARK);
    expect(surfaced, `${name}: error message / detail / field errors`).not.toContain(MARK);
  });
});
