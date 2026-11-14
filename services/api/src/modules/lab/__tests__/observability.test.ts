// C5 T-31 - observability: metrics (02-TRD §11), alert rule file lab.rules.yml (§11 "Alert rules for C1", CR-C5-010, 08 A13 P-14), access-log coverage (§11 "Access log", 08 A13 P-3 / D-11),
// PHI log scan (07-SECURITY S-10 last clause, S-18, §6 "never in logs, metrics labels ..."; 02-CV §9.2). done_when: "metrics in 02-TRD §11 exist; promtool check rules passes on lab.rules.yml;
// every ctx.audit.access action is one of the six D-11 codes; log-scan test with planted PHI passes".
// SEAMS (spec fixes behaviour, not names; precedent = analytics AN-T22 / LD-88):
//  (1) the 14 lims_lab_* metrics are registered in services/api/src/core/observability/metrics.ts DEFS (createMetrics / REQUIRED_METRICS), the one registry /metrics exposes. NOTE for the writer: DEFS and
//      core/observability/__tests__/metrics.test.ts (EXPECTED map) are C0 paths; a lab-only write set needs a lead decision / CR first (LD-88 did the same for C8). Instrumentation is asserted two ways:
//      every name is referenced by non-test source under lab/** or worker jobs/lab/**, and the ingest service calls ctx.metrics.inc('lims_lab_results_ingested_total', { outcome }) (same optional-sink shape as analytics).
//  (2) services/worker/src/jobs/lab/ops/lab.rules.yml carries expr + for verbatim from the TRD table; C1 adds team/runbook_url (C1 02-TRD §11.3), so severity/route in the C5 file are only checked when present.
//  (3) access log: every `.access(` call site under lab/** (non-test) resolves to one of the six D-11 actions. ONE exemption, pinned: a call whose detail carries entry_mode 'downtime_backentry' (LD-25 stand-in
//      action until C0 rules on CR-C5-T07-001, .orchestra/cr/C5.T-07.md) in result.service.ts / specimen.service.ts. Remove the exemption when that CR lands.
//  (4) promtool is not installed on every dev box: `promtool check rules` runs when PROMTOOL or `promtool` on PATH resolves, else that one test is skipped (CI has it, 08 A13 P-14); the structural tests always run.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { LimsError } from '../../../core/errors.js';
import { REPO_ROOT } from '../../../core/module.js';
import { createMetrics, REQUIRED_METRICS } from '../../../core/observability/metrics.js';
import { createLogger } from '../../../../../../packages/shared-ts/src/logger/index.js';
import { handlers } from '../handlers/index.js';
import { applyInstrumentResultEvent } from '../service/ingest.service.js';

const API_LAB = join(REPO_ROOT, 'services', 'api', 'src', 'modules', 'lab');
const WK_LAB = join(REPO_ROOT, 'services', 'worker', 'src', 'jobs', 'lab');
const RULES = join(WK_LAB, 'ops', 'lab.rules.yml');
const TRD = join(REPO_ROOT, 'spec', 'chunks', 'C5-lab-workflow', '02-TRD.md');
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

function sources(dir: string): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) { if (n !== '__tests__' && n !== 'node_modules') out.push(...sources(p)); continue; }
    if (/\.ts$/.test(n) && !/\.(test|spec)\.ts$/.test(n)) out.push({ file: relative(REPO_ROOT, p).replace(/\\/g, '/'), text: readFileSync(p, 'utf8') });
  }
  return out;
}
const SRC = [...sources(API_LAB), ...sources(WK_LAB)];

// ------------------------------------------------------------------------------------------------------------------------------------------------------------ alert rule file
interface Rule { alert: string; expr: string; for?: string; labels?: Record<string, string> }
const rulesOf = (file: string): Rule[] => (parse(readFileSync(file, 'utf8')) as { groups: { rules: Rule[] }[] }).groups.flatMap((g) => g.rules);

/** TRD §11 "Alert rules for C1" table: alert, expr (first backtick span), for, severity (first word). */
function trdAlerts(): { alert: string; expr: string; for: string; severity: string }[] {
  const text = readFileSync(TRD, 'utf8');
  const a = text.indexOf('#### Alert rules for C1'), b = text.indexOf('#### CI jobs for C0-0A', a);
  expect(a, 'TRD alert heading').toBeGreaterThan(-1); expect(b, 'TRD CI heading').toBeGreaterThan(a);
  const out = [];
  for (const line of text.slice(a, b).split('\n')) {
    const m = /^\|\s*`(Lab\w+)`\s*\|\s*`([^`]+)`\s*\|\s*(\d+m)\s*\|\s*(page|warn)\b/.exec(line);
    if (m) out.push({ alert: m[1]!, expr: m[2]!, for: m[3]!, severity: m[4]! });
  }
  return out;
}

describe('lab.rules.yml (CR-C5-010)', () => {
  it('the TRD table parse finds the five rules (guards the comparisons against an empty parse)', () => {
    expect(trdAlerts().map((r) => r.alert)).toEqual(['LabCriticalValueUnnotified', 'LabIngestExceptionStale', 'LabConsumerDeadLetter', 'LabHostQuerySlow', 'LabBarcodeAllocationFailure']);
  });

  it('the file exists at services/worker/src/jobs/lab/ops/lab.rules.yml and holds exactly the five rules of TRD §11, no more, no fewer, no duplicates', () => {
    expect(rulesOf(RULES).map((r) => r.alert).sort()).toEqual(trdAlerts().map((r) => r.alert).sort());
  });

  it('expr and for are verbatim from the TRD (whitespace-folded); severity, when present, matches', () => {
    const got = new Map(rulesOf(RULES).map((r) => [r.alert, r]));
    for (const want of trdAlerts()) {
      const r = got.get(want.alert);
      expect(r, want.alert).toBeDefined();
      expect(norm(r!.expr), `${want.alert} expr`).toBe(norm(want.expr));
      expect(r!.for, `${want.alert} for`).toBe(want.for);
      if (r!.labels?.['severity'] !== undefined) expect(r!.labels['severity'], `${want.alert} severity`).toBe(want.severity);
    }
  });

  it('every metric a rule uses is a TRD §11 lab metric or the C0 dead-letter counter; no rule filters or groups by a person-level / barcode label', () => {
    for (const r of rulesOf(RULES)) {
      for (const m of r.expr.match(/\blims_[a-z0-9_]+/g) ?? []) {
        expect(m.replace(/_(bucket|sum|count)$/, ''), `${r.alert} ${m}`).toMatch(/^(lims_lab_[a-z_]+|lims_core_dead_letters_total)$/);
      }
      expect(r.expr, r.alert).not.toMatch(/\b(barcode|registration|patient|user|actor|specimen)_?(id|no|name)?\b\s*(=|!=|=~|,|\))/i);
    }
  });

  const promtool = process.env['PROMTOOL'] ?? 'promtool';
  const have = spawnSync(promtool, ['--version'], { encoding: 'utf8' }).status === 0;
  it.skipIf(!have)('promtool check rules passes (08 A13 P-14)', () => {
    // C1 appends team + runbook_url on import; the C5 file alone must already be a valid Prometheus rule file.
    const r = spawnSync(promtool, ['check', 'rules', RULES], { encoding: 'utf8' });
    expect(r.stdout + r.stderr).toMatch(/SUCCESS: 5 rules found/);
    expect(r.status).toBe(0);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------ metrics
const LAB: Record<string, readonly ['counter' | 'gauge' | 'histogram', readonly string[]]> = {
  lims_lab_specimen_transitions_total: ['counter', ['to_status']],
  lims_lab_specimen_creation_lag_seconds: ['histogram', []],
  lims_lab_results_ingested_total: ['counter', ['outcome']],
  lims_lab_ingest_exceptions_open: ['gauge', ['reason', 'tenant_id']],
  lims_lab_ingest_exception_age_seconds: ['histogram', ['reason']],
  lims_lab_ingest_exception_oldest_open_age_seconds: ['gauge', ['reason', 'tenant_id']],
  lims_lab_critical_unnotified_oldest_age_seconds: ['gauge', ['tenant_id']],
  lims_lab_result_transitions_total: ['counter', ['to_status', 'origin']],
  lims_lab_critical_detected_total: ['counter', ['direction']],
  lims_lab_critical_unnotified_open: ['gauge', ['tenant_id']],
  lims_lab_formula_errors_total: ['counter', ['reason']],
  lims_lab_host_query_duration_seconds: ['histogram', ['outcome']],
  lims_lab_readiness_emitted_total: ['counter', ['completeness']],
  lims_lab_barcode_alloc_failures_total: ['counter', ['reason']],
};
const T = '01a1a98a-ac40-7000-8000-00000000a001', TB = '01a1a98a-ac40-7000-8000-00000000b001';
const L: Record<string, string> = { tenant_id: T, to_status: 'received', outcome: 'applied', reason: 'unmapped_code', origin: 'instrument', direction: 'high', completeness: 'complete' };
const pick = (names: readonly string[]) => Object.fromEntries(names.map((n) => [n, L[n]!]));
const emit = (m: ReturnType<typeof createMetrics>, name: string, kind: string, lb: Record<string, string>) => {
  const n = name as never;
  if (kind === 'counter') m.inc(n, lb); else if (kind === 'gauge') m.set(n, 1, lb); else m.observe(n, 3, lb);
};

describe('lab metrics registry (TRD §11 Metrics)', () => {
  it('the TRD table lists exactly the 14 metrics pinned here (guards this file against TRD drift)', () => {
    const text = readFileSync(TRD, 'utf8');
    const a = text.indexOf('## 11. Observability'), b = text.indexOf('#### Alert rules for C1', a);
    const names = [...text.slice(a, b).matchAll(/^\|\s*`(lims_lab_\w+)`\s*\|/gm)].map((x) => x[1]!);
    expect(names.sort()).toEqual(Object.keys(LAB).sort());
  });

  it('all 14 lims_lab_* metrics are registered in REQUIRED_METRICS, and nothing else with that prefix', () => {
    expect(REQUIRED_METRICS.filter((n) => n.startsWith('lims_lab_')).sort()).toEqual(Object.keys(LAB).sort());
  });

  it.each(Object.entries(LAB))('%s is exposed with the TRD type and its exact label set', async (name, [kind, labels]) => {
    const m = createMetrics();
    emit(m, name, kind, pick(labels));
    const text = await m.render();
    expect(text).toContain(`# TYPE ${name} ${kind}`);
    for (const l of labels) expect(text).toMatch(new RegExp(`^${name}\\w*\\{[^}]*\\b${l}="${L[l]}"`, 'm'));
  });

  it.each(Object.entries(LAB))('%s rejects a PHI / id label outside its set (barcode, registration_no, patient_id, value, comment never become labels)', (name, [kind, labels]) => {
    const m = createMetrics();
    expect(() => emit(m, name, kind, pick(labels)), `${name} valid labels`).not.toThrow();   // not vacuous: an unknown metric also throws
    for (const bad of ['barcode', 'registration_no', 'patient_id', 'patient_name', 'specimen_id', 'value', 'comment']) {
      expect(() => emit(m, name, kind, { ...pick(labels), [bad]: 'x' }), `${name}+${bad}`).toThrow();
    }
  });

  it('the critical-unnotified gauges are per tenant (alert expr is max by (tenant_id)) and take 0 when none is open', async () => {
    const m = createMetrics();
    m.set('lims_lab_critical_unnotified_oldest_age_seconds' as never, 2000, { tenant_id: T });
    m.set('lims_lab_critical_unnotified_oldest_age_seconds' as never, 0, { tenant_id: TB });
    const text = await m.render();
    expect(text).toMatch(new RegExp(`lims_lab_critical_unnotified_oldest_age_seconds\\{[^}]*tenant_id="${T}"[^}]*\\} 2000\\b`));
    expect(text).toMatch(new RegExp(`lims_lab_critical_unnotified_oldest_age_seconds\\{[^}]*tenant_id="${TB}"[^}]*\\} 0\\b`));
  });

  it.each(Object.keys(LAB))('%s is emitted by lab code (non-test source under api lab/** or worker jobs/lab/**), not only declared', (name) => {
    const hit = SRC.filter((s) => s.text.includes(name)).map((s) => s.file);
    expect(hit, `no lab source references ${name}`).not.toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------ ingest fixtures (metrics + log scan)
const ACTOR = '01a1b34e-1000-7eee-9d29-d7ca59a102b5';
const INSTR = '01a1a98a-ac40-7000-8000-0000000d00f1', AGENT = '01a1a98a-ac40-7000-8000-0000000d00a1', MSG = '01a1a98a-ac40-7000-8000-0000000d00c1', EVENT = '01a1a98a-ac40-7000-8000-0000000d00e1';
const CENTRE = '01a1a98a-ac40-7000-8000-00000000a201';
const NOW = new Date('2026-06-15T05:00:00Z');
// planted synthetic PHI (S-18): none of these may reach a log line or a metric label
const P_BARCODE = 'SN2606150042', P_VALUE = '13.4731', P_NAME = 'Zorblax Quenthrop', P_COMMENT = 'plantedcomment-hemolysed-sample-zq9', P_REG = 'R2606159917';

function ingestCtx(over: { lastOutcome?: string; inserted?: boolean; log?: unknown } = {}) {
  const incs: { name: string; labels: Record<string, unknown> | undefined }[] = [], observes: unknown[] = [], sets: unknown[] = [];
  const store: Record<string, unknown> = {
    async claimKey() { return { inserted: over.inserted ?? true, logId: 'log-1', lastOutcome: over.lastOutcome ?? 'applied', resultId: 'r-1' }; },
    async upsertOpenException() { return { exceptionId: 'ex-1' }; },
    async finishLog() { return undefined; },
  };
  const ctx = {
    tenantId: T, actor: { type: 'system', id: ACTOR }, tx: { id: 'tx' }, now: () => NOW, store,
    config: { autoverifyHookEnabled: false },
    events: { async publish() { return { eventId: 'e', duplicate: false }; } },
    audit: { async access() { return undefined; } },
    ...(over.log === undefined ? {} : { log: over.log }),
    metrics: {
      inc: (name: string, labels?: Record<string, unknown>) => { incs.push({ name, labels }); },
      set: (...a: unknown[]) => { sets.push(a); }, observe: (...a: unknown[]) => { observes.push(a); },
    },
    ports: { CatalogPort: { async mapInstrumentCode() { throw new LimsError('catalog.instrument_code_unmapped'); } } },
  };
  return { ctx: ctx as never, incs, sets, observes };
}
const unmappedEnvelope = (over: Record<string, unknown> = {}) => ({
  event_id: EVENT, tenant_id: T, payload: {
    instrument_message_id: MSG, instrument_id: INSTR, agent_id: AGENT, centre_id: CENTRE, protocol: 'astm', sample_barcode: P_BARCODE, record_kind: 'quantitative', instrument_analyte_code: 'HGB',
    mapping_status: 'unmapped', value_raw: P_VALUE, value_numeric: P_VALUE, unit_raw: 'g/dL', unit_code: 'g/dL', instrument_result_time: '2026-06-15T04:55:00.000Z', received_at: '2026-06-15T04:56:00.000Z',
    comment: P_COMMENT, patient_name: P_NAME, ...over,
  },
}) as never;

describe('ingest counter lims_lab_results_ingested_total{outcome} (TRD §11)', () => {
  it('an unmapped record is counted once with outcome "unmatched" and no other label', async () => {
    const c = ingestCtx();
    const r = await applyInstrumentResultEvent(c.ctx, unmappedEnvelope());
    expect(r.outcome).toBe('unmatched');
    const hits = c.incs.filter((i) => i.name === 'lims_lab_results_ingested_total');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.labels).toEqual({ outcome: 'unmatched' });
  });

  it('a replayed key (already applied) is counted with outcome "duplicate"', async () => {
    const c = ingestCtx({ inserted: false, lastOutcome: 'applied' });
    const r = await applyInstrumentResultEvent(c.ctx, unmappedEnvelope());
    expect(r.outcome).toBe('duplicate');
    expect(c.incs.filter((i) => i.name === 'lims_lab_results_ingested_total').map((i) => i.labels)).toEqual([{ outcome: 'duplicate' }]);
  });

  it('every label value of every lims_lab_* metric emitted on this path is free of the planted barcode, value, name, comment (S-18, §6)', async () => {
    const c = ingestCtx();
    await applyInstrumentResultEvent(c.ctx, unmappedEnvelope());
    const blob = JSON.stringify([c.incs, c.sets, c.observes]);
    for (const p of [P_BARCODE, P_VALUE, P_NAME, P_COMMENT]) expect(blob, p).not.toContain(p);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------ access log
const SIX = ['specimen_label.print', 'lab_result.view', 'lab_result_history.view', 'critical_value.view', 'worksheet.print', 'ingest_exception.view'] as const;
const LD25_EXEMPT_FILES = ['services/api/src/modules/lab/service/result.service.ts', 'services/api/src/modules/lab/service/specimen.service.ts'];

/** every `.access(` call in non-test lab source: file, call text (paren-balanced) and the resolved `action`. */
function accessCalls() {
  const out: { file: string; call: string; action: string | undefined; exempt: boolean }[] = [];
  for (const { file, text } of SRC) {
    for (const m of text.matchAll(/\.access\(/g)) {
      let depth = 0, i = m.index! + m[0].length - 1;
      const start = i;
      for (; i < text.length; i++) { if (text[i] === '(') depth++; else if (text[i] === ')' && --depth === 0) break; }
      const call = text.slice(start, i + 1);
      const a = /\baction:\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_]\w*))/.exec(call);
      let action: string | undefined = a?.[1] ?? a?.[2];
      if (!action && a?.[3]) action = new RegExp(`\\b${a[3]}\\s*=\\s*'([^']+)'`).exec(text)?.[1];
      out.push({ file, call, action, exempt: /downtime_backentry/.test(call) });
    }
  }
  return out;
}

describe('access-log coverage (TRD §11 "Access log", D-11)', () => {
  const calls = accessCalls();

  it('the scan finds the access calls (guards the checks against an empty parse)', () => {
    expect(calls.length).toBeGreaterThanOrEqual(8);
  });

  it('every ctx.audit.access action resolves to a literal and is one of the six D-11 codes (only the LD-25 downtime stand-in is exempt)', () => {
    const bad = calls.filter((c) => !c.exempt).filter((c) => !c.action || !(SIX as readonly string[]).includes(c.action)).map((c) => `${c.file}: ${c.action ?? '<unresolved>'}`);
    expect(bad).toEqual([]);
  });

  it('the LD-25 exemption is narrow: only the two downtime back-entry sites, and only with entry_mode downtime_backentry in detail', () => {
    expect(calls.filter((c) => c.exempt).map((c) => c.file).filter((f) => !LD25_EXEMPT_FILES.includes(f))).toEqual([]);
  });

  it('all six D-11 actions are written by some call site (TRD table: #14 #16 #25/#26 #35/#36 #22 #39)', () => {
    const used = new Set(calls.map((c) => c.action));
    expect(SIX.filter((a) => !used.has(a))).toEqual([]);
  });

  it('no access call puts a barcode, registration number, value or comment text in detail (REQ-SEC-006, §6)', () => {
    for (const c of calls) expect(c.call, c.file).not.toMatch(/\b(barcode|registration_?no|valueRaw|value_raw|valueNumeric|value_numeric|commentText|comment_text|patientName|patient_name)\b/i);
  });

  it('#16 listOrderResults writes exactly one lab_result.view row { entityType order, entityId = order id } per call', async () => {
    const ORDER = '01a1a98a-ac40-7000-8000-0000000000c1';
    const access: any[] = [];
    const ctx = {
      operationId: 'listOrderResults', clientIp: '203.0.113.9', log: { info() {}, warn() {}, error() {} },
      tenantId: T, actor: { type: 'user', id: ACTOR, membershipId: '01a1b34e-2000-7eee-9d29-d7ca59a102b6' }, tx: { id: 'tx' }, now: () => NOW,
      store: { async getOrderResults() { return { centreId: CENTRE, order: { order_id: ORDER, registration_no: P_REG, specimens: [], order_tests: [] }, items: [] }; } },
      events: { async publish() { return { eventId: 'e', duplicate: false }; } },
      audit: { async access(e: unknown) { access.push(e); } },
      ports: { IdentityPort: { async assertRole() { return undefined; } } },
    };
    const r = await (handlers as any).listOrderResults({ params: { order_id: ORDER }, query: {}, headers: {}, body: undefined }, ctx);
    expect(r.status).toBe(200);
    expect(access).toHaveLength(1);
    expect(access[0]).toMatchObject({ action: 'lab_result.view', entityType: 'order', entityId: ORDER, outcome: 'allowed' });
    expect(JSON.stringify(access)).not.toContain(P_REG);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------ PHI log scan (S-18)
describe('PHI log scan (07-SECURITY S-18, §6; 02-TRD §11 "ids only")', () => {
  it('static: no log / console call in lab API or worker source mentions a barcode, registration no, value, comment or name field', () => {
    const bad: string[] = [];
    for (const { file, text } of SRC) {
      for (const m of text.matchAll(/\b(?:ctx|c|hctx|log|logger)\??\.log\??\.(?:info|warn|error|debug)\??\.?\(|\blog\??\.(?:info|warn|error|debug)\??\.?\(|\bconsole\.\w+\(/g)) {
        let depth = 0, i = m.index! + m[0].length - 1;
        const start = i;
        for (; i < text.length; i++) { if (text[i] === '(') depth++; else if (text[i] === ')' && --depth === 0) break; }
        const call = text.slice(start, i + 1);
        if (/\bconsole\./.test(m[0])) bad.push(`${file}: console call`);
        else if (/(barcode|registration|valueRaw|value_raw|valueNumeric|value_numeric|commentText|comment_text|\bcomment\b|patientName|patient_name|resultKey|result_key\b|\bname\b|\bvalue\b)/i.test(call)) bad.push(`${file}: ${norm(call).slice(0, 120)}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('dynamic: an ingest journey with planted barcode / value / name / comment through the real shared logger leaves none of them in the captured log lines', async () => {
    const lines: string[] = [];
    const logger = createLogger({ service: 'api', env: 'test', version: '0.0.0', level: 'debug', destination: { write: (l: string) => { lines.push(l); } } } as never) as unknown as { info: (m: string, f?: object) => void; warn: (m: string, f?: object) => void; error: (m: string, f?: object) => void };
    // lab code logs pino-style `info({ msg, ... })` or `warn(msg, fields)`; adapt both to the shared logger exactly as core/observability/logging.ts does.
    const log = {
      info: (a: unknown, b?: unknown) => (typeof a === 'string' ? logger.info(a, b as object) : logger.info(typeof (a as any)?.msg === 'string' ? (a as any).msg : '', a as object)),
      warn: (a: unknown, b?: unknown) => (typeof a === 'string' ? logger.warn(a, b as object) : logger.warn(typeof (a as any)?.msg === 'string' ? (a as any).msg : '', a as object)),
      error: (a: unknown, b?: unknown) => (typeof a === 'string' ? logger.error(a, b as object) : logger.error('', a as object)),
    };
    const a = ingestCtx({ log });
    await applyInstrumentResultEvent(a.ctx, unmappedEnvelope());
    const b = ingestCtx({ log, inserted: false, lastOutcome: 'applied' });
    await applyInstrumentResultEvent(b.ctx, unmappedEnvelope());
    const c = ingestCtx({ log });
    await applyInstrumentResultEvent(c.ctx, unmappedEnvelope({ record_kind: 'organism_id' }));
    expect(lines.length, 'the journey must log at least the ingest outcome line').toBeGreaterThan(0);
    const all = lines.join('\n');
    for (const p of [P_BARCODE, P_VALUE, P_NAME, P_COMMENT, P_REG, `${INSTR}:${P_BARCODE}`]) expect(all, p).not.toContain(p);
  });

  it('dynamic: the ingest log line carries the outcome and reason codes (ids/codes only), so the scan above is not vacuous', async () => {
    const seen: unknown[] = [];
    const a = ingestCtx({ log: { info: (...x: unknown[]) => { seen.push(x); }, warn: (...x: unknown[]) => { seen.push(x); } } });
    await applyInstrumentResultEvent(a.ctx, unmappedEnvelope());
    expect(JSON.stringify(seen)).toMatch(/unmatched/);
  });
});
