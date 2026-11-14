// C9 T-26 - observability: the 16 lims_quality_* metrics (02-TRD §14 "Observability" table), alert rule file quality.rules.yml (§14 "Alert rules for C1", CR-C9-008, 08 A13 P-14),
// runbook + user-manual pages (04-UI-UX §5; 05-DoD §3.7-3.8). done_when: "metrics in 02-TRD §14 exported; every metric named in quality.rules.yml is one of the §14 metrics".
// NOTE: the plan/brief say "14 metrics" but "02-TRD 14" means section 14; its table holds 16 metrics and 7 alert rules. The table is parsed below so this file cannot drift from it.
// SEAMS (spec fixes behaviour, not names; precedent = C5 T-31 / CR-C5-T31-001 / LD-120, C8 LD-88):
//  (1) metrics are registered in services/api/src/core/observability/metrics.ts DEFS (the one registry /metrics exposes; createMetrics / REQUIRED_METRICS). DEFS and
//      core/observability/__tests__/metrics.test.ts (EXPECTED map, updated alongside this task) are C0 paths: the writer needs a CR to C0 (.orchestra/cr/C9.T-26.md), as C5/C14/C11 did.
//      Instrumentation is asserted by reference: every name appears in non-test source under api quality/** or worker jobs/quality/** (an alert on a never-emitted metric is dead).
//  (2) rule file path = TRD §14 / §3 tree: services/worker/src/jobs/quality/ops/quality.rules.yml (brief's shorthand "services/worker/src/ops/" is the plan's "WK ops/"; sibling modules use jobs/<m>/ops).
//      expr + for verbatim from the TRD table; C1 adds team/runbook_url, so severity is checked only when present.
//  (3) promtool is not installed on every dev box: runs when PROMTOOL or `promtool` on PATH resolves, else that one test is skipped (CI has it, 08 A13 P-14); the structural tests always run.
//  (4) manual page file names are not fixed by the spec (04-UI-UX §5 lists topics + runbook.md), so topics are matched by markdown headings across docs/manual/quality/*.md.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { REPO_ROOT } from '../../../core/module.js';
import { createMetrics, REQUIRED_METRICS } from '../../../core/observability/metrics.js';

const API_Q = join(REPO_ROOT, 'services', 'api', 'src', 'modules', 'quality');
const WK_Q = join(REPO_ROOT, 'services', 'worker', 'src', 'jobs', 'quality');
const RULES = join(WK_Q, 'ops', 'quality.rules.yml');
const MANUAL = join(REPO_ROOT, 'docs', 'manual', 'quality');
const TRD = join(REPO_ROOT, 'spec', 'chunks', 'C9-quality-engine', '02-TRD.md');
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
const SRC = [...sources(API_Q), ...sources(WK_Q)];

// ------------------------------------------------------------------------------------------------------------------------------------------------------------ TRD §14 pins
const trdText = () => readFileSync(TRD, 'utf8');
const trdSection = () => {
  const text = trdText();
  const a = text.indexOf('## 14. Observability'), b = text.indexOf('#### Alert rules for C1', a), c = text.indexOf('#### CI jobs for C0-0A', b);
  expect(a, 'TRD §14 heading').toBeGreaterThan(-1); expect(b, 'TRD alert heading').toBeGreaterThan(a); expect(c, 'TRD CI heading').toBeGreaterThan(b);
  return { metrics: text.slice(a, b), alerts: text.slice(b, c) };
};

/** TRD §14 metric table: name, type, label names (backticked identifiers in the third cell, before any parenthetical). */
function trdMetrics(): Record<string, readonly ['counter' | 'gauge' | 'histogram', readonly string[]]> {
  const out: Record<string, ['counter' | 'gauge' | 'histogram', string[]]> = {};
  for (const line of trdSection().metrics.split('\n')) {
    const m = /^\|\s*`(lims_quality_\w+)`\s*\|\s*(counter|gauge|histogram)\s*\|\s*(.*?)\s*\|\s*$/.exec(line);
    if (!m) continue;
    const labelCell = m[3]!.replace(/\(.*$/, '');   // drop the "(§6.3 statuses ..." / "(age of ..." commentary
    out[m[1]!] = [m[2] as 'counter', [...labelCell.matchAll(/`(\w+)`/g)].map((x) => x[1]!)];
  }
  return out;
}

/** TRD §14 "Alert rules for C1" table: alert, expr (first backtick span), for, severity (first word). */
function trdAlerts(): { alert: string; expr: string; for: string; severity: string }[] {
  const out = [];
  for (const line of trdSection().alerts.split('\n')) {
    const m = /^\|\s*`(Quality\w+)`\s*\|\s*`([^`]+)`[^|]*\|\s*(\d+m)\s*\|\s*(page|warn)\b/.exec(line);
    if (m) out.push({ alert: m[1]!, expr: m[2]!, for: m[3]!, severity: m[4]! });
  }
  return out;
}

const QUALITY: Record<string, readonly ['counter' | 'gauge' | 'histogram', readonly string[]]> = {
  lims_quality_qc_observations_total: ['counter', ['status']],
  lims_quality_qc_sync_last_success_timestamp_seconds: ['gauge', ['tenant_id']],
  lims_quality_qc_rejected_without_action_oldest_age_seconds: ['gauge', ['tenant_id']],
  lims_quality_qc_runs_total: ['counter', ['outcome', 'rule_mode', 'n']],
  lims_quality_qc_rule_hits_total: ['counter', ['rule']],
  lims_quality_qc_eval_lag_seconds: ['histogram', []],
  lims_quality_qc_open_rejected_runs: ['gauge', ['tenant_id']],
  lims_quality_qc_overdue_pairs: ['gauge', ['tenant_id']],
  lims_quality_unassigned_observations: ['gauge', ['status', 'tenant_id']],
  lims_quality_port_duration_seconds: ['histogram', ['method']],
  lims_quality_autoverify_decisions_total: ['counter', ['mode', 'decision', 'reason']],
  lims_quality_autoverify_short_circuit_total: ['counter', ['reason']],
  lims_quality_tat_sweep_duration_seconds: ['histogram', []],
  lims_quality_tat_alerts_total: ['counter', ['level', 'segment']],
  lims_quality_tat_open_alerts: ['gauge', ['level', 'tenant_id']],
  lims_quality_tat_alert_lag_seconds: ['histogram', []],
};
const T = '01a1a98a-ac40-7000-8000-00000000a001', TB = '01a1a98a-ac40-7000-8000-00000000b001';
const L: Record<string, string> = { tenant_id: T, status: 'accepted', outcome: 'accepted', rule_mode: 'multirule', n: '2', rule: '1_3s', method: 'canAutoVerify', mode: 'live', decision: 'deny', reason: 'qc_rejected', level: 'warn', segment: 'collect_to_receive' };
const pick = (names: readonly string[]) => Object.fromEntries(names.map((n) => [n, L[n]!]));
const emit = (m: ReturnType<typeof createMetrics>, name: string, kind: string, lb: Record<string, string>) => {
  const n = name as never;
  if (kind === 'counter') m.inc(n, lb); else if (kind === 'gauge') m.set(n, 1, lb); else m.observe(n, 3, lb);
};

describe('quality metrics registry (TRD §14 Observability)', () => {
  it('the TRD §14 table parse finds the 16 metrics pinned here, with the same types and label sets (guards this file against TRD drift)', () => {
    const got = trdMetrics();
    expect(Object.keys(got).sort()).toEqual(Object.keys(QUALITY).sort());
    for (const [name, [kind, labels]] of Object.entries(QUALITY)) {
      expect(got[name]![0], `${name} type`).toBe(kind);
      expect([...got[name]![1]].sort(), `${name} labels`).toEqual([...labels].sort());
    }
  });

  it('all 16 lims_quality_* metrics are registered in REQUIRED_METRICS, and nothing else with that prefix', () => {
    expect(REQUIRED_METRICS.filter((n) => n.startsWith('lims_quality_')).sort()).toEqual(Object.keys(QUALITY).sort());
  });

  it.each(Object.entries(QUALITY))('%s is exposed with the TRD type and its exact label set', async (name, [kind, labels]) => {
    const m = createMetrics();
    emit(m, name, kind, pick(labels));
    const text = await m.render();
    expect(text).toContain(`# TYPE ${name} ${kind}`);
    for (const l of labels) expect(text).toMatch(new RegExp(`^${name}\\w*\\{[^}]*\\b${l}="${L[l]}"`, 'm'));
  });

  it.each(Object.entries(QUALITY))('%s rejects a PHI / id label outside its set (barcode, patient, value, run id never become labels; tenant_id only where TRD lists it)', (name, [kind, labels]) => {
    const m = createMetrics();
    expect(() => emit(m, name, kind, pick(labels)), `${name} valid labels`).not.toThrow();   // not vacuous: an unknown metric also throws
    const bad = ['sample_barcode', 'barcode', 'patient_id', 'patient_name', 'value', 'user_id', 'actor_id', 'qc_run_id', 'plan_id', 'order_id', ...(labels.includes('tenant_id') ? [] : ['tenant_id'])];
    for (const b of bad) expect(() => emit(m, name, kind, { ...pick(labels), [b]: 'x' }), `${name}+${b}`).toThrow();
  });

  it('the per-tenant gauges keep one series per tenant and take 0 when nothing is open (alert exprs are max by (tenant_id))', async () => {
    const m = createMetrics();
    m.set('lims_quality_qc_rejected_without_action_oldest_age_seconds' as never, 20000, { tenant_id: T });
    m.set('lims_quality_qc_rejected_without_action_oldest_age_seconds' as never, 0, { tenant_id: TB });
    const text = await m.render();
    expect(text).toMatch(new RegExp(`lims_quality_qc_rejected_without_action_oldest_age_seconds\\{[^}]*tenant_id="${T}"[^}]*\\} 20000\\b`));
    expect(text).toMatch(new RegExp(`lims_quality_qc_rejected_without_action_oldest_age_seconds\\{[^}]*tenant_id="${TB}"[^}]*\\} 0\\b`));
  });

  it.each(Object.keys(QUALITY))('%s is emitted by quality code (non-test source under api quality/** or worker jobs/quality/**), not only declared', (name) => {
    const hit = SRC.filter((s) => s.text.includes(name)).map((s) => s.file);
    expect(hit, `no quality source references ${name}`).not.toEqual([]);
  });

  it('no quality source puts a person-level / barcode / value field into a lims_quality_* label set (02-CV §9.2, TRD §14 "ids and codes only")', () => {
    const bad: string[] = [];
    for (const { file, text } of SRC) {
      for (const m of text.matchAll(/\.(?:inc|set|observe)\(\s*['"`]?(?:lims_quality_\w+|[A-Z_]+)['"`]?[^;]*?\{([^{}]*)\}/g)) {
        if (/\b(barcode|sample_barcode|patient\w*|value\w*|user_?id|actor\w*|qc_run_id|plan_id)\b/i.test(m[1]!)) bad.push(`${file}: ${norm(m[0]).slice(0, 100)}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------ alert rule file
interface Rule { alert: string; expr: string; for?: string; labels?: Record<string, string> }
const rulesOf = (file: string): Rule[] => (parse(readFileSync(file, 'utf8')) as { groups: { rules: Rule[] }[] }).groups.flatMap((g) => g.rules);

describe('quality.rules.yml (CR-C9-008, 08 A13 P-14)', () => {
  it('the TRD table parse finds the seven rules (guards the comparisons against an empty parse)', () => {
    expect(trdAlerts().map((r) => r.alert)).toEqual([
      'QualityRejectedRunWithoutAction', 'QualityConsumerDeadLetter', 'QualityQcSyncStalled', 'QualityQcImportError', 'QualityPortSlow', 'QualityTatSweepSlow', 'QualityAutoverifyAllowWithReasons',
    ]);
  });

  it('the file exists at services/worker/src/jobs/quality/ops/quality.rules.yml and holds exactly the seven rules of TRD §14, no more, no fewer, no duplicates', () => {
    expect(existsSync(RULES), RULES).toBe(true);
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

  it('every metric a rule uses is one of the TRD §14 quality metrics or the C0 dead-letter counter (done_when); no rule filters or groups by a person-level / barcode label', () => {
    const allowed = new Set([...Object.keys(QUALITY), 'lims_core_dead_letters_total']);
    for (const r of rulesOf(RULES)) {
      const used = r.expr.match(/\blims_[a-z0-9_]+/g) ?? [];
      expect(used.length, `${r.alert} names a metric`).toBeGreaterThan(0);
      for (const m of used) expect(allowed.has(m.replace(/_(bucket|sum|count)$/, '')), `${r.alert} ${m}`).toBe(true);
      expect(r.expr, r.alert).not.toMatch(/\b(barcode|registration|patient|user|actor|specimen)_?(id|no|name)?\b\s*(=|!=|=~|,|\))/i);
    }
  });

  it('every rule carries a summary annotation and the file is valid YAML with a single top-level `groups` list', () => {
    const doc = parse(readFileSync(RULES, 'utf8')) as { groups?: { name: string; rules: { annotations?: { summary?: string } }[] }[] };
    expect(Array.isArray(doc.groups)).toBe(true);
    for (const r of doc.groups!.flatMap((g) => g.rules)) expect(r.annotations?.summary?.length ?? 0).toBeGreaterThan(10);
  });

  const promtool = process.env['PROMTOOL'] ?? 'promtool';
  const have = spawnSync(promtool, ['--version'], { encoding: 'utf8' }).status === 0;
  it.skipIf(!have)('promtool check rules passes (08 A13 P-14)', () => {
    // C1 appends team + runbook_url on import; the C9 file alone must already be a valid Prometheus rule file.
    const r = spawnSync(promtool, ['check', 'rules', RULES], { encoding: 'utf8' });
    expect(r.stdout + r.stderr).toMatch(/SUCCESS: 7 rules found/);
    expect(r.status).toBe(0);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------ runbook + manual (05-DoD §3.8; 04-UI-UX §5)
const mdFiles = () => (existsSync(MANUAL) ? readdirSync(MANUAL).filter((n) => n.endsWith('.md')) : []);
const headings = (n: string) => readFileSync(join(MANUAL, n), 'utf8').split('\n').filter((l) => /^#{1,3}\s/.test(l)).join('\n');

describe('runbook + user manual (docs/manual/quality, 04-UI-UX §5, 05-DoD §3.8)', () => {
  it('docs/manual/quality/runbook.md exists and carries the three runbook entries of 04-UI-UX §5, each as a heading', () => {
    const p = join(MANUAL, 'runbook.md');
    expect(existsSync(p), p).toBe(true);
    const h = headings('runbook.md');
    expect(h).toMatch(/QC rejected but C5 shows no hold/i);
    expect(h).toMatch(/QC values not appearing/i);
    expect(h).toMatch(/Auto-verify never allows/i);
  });

  it('the runbook names the signals the spec points to (dead-letter event, unassigned gauge + page, sync lag alert, deny_by_reason, tenant switch, active version, QC plan coverage)', () => {
    const t = readFileSync(join(MANUAL, 'runbook.md'), 'utf8');
    for (const s of ['evt.lab.quality.qc_run.rejected.v1', 'lims_quality_unassigned_observations', 'QualityQcSyncStalled', 'deny_by_reason']) expect(t, s).toContain(s);
    expect(t).toMatch(/Unassigned QC/);
    expect(t).toMatch(/tenant switch|tenant-level switch|feature switch/i);
    expect(t).toMatch(/active version/i);
    expect(t).toMatch(/QC plan coverage|plan coverage/i);
  });

  const TOPICS: [string, RegExp][] = [
    ['status board', /status board/i],
    ['runs and corrective actions', /corrective action/i],
    ['LJ charts', /levey|\bLJ\b/i],
    ['set-up (materials, maps, plans, targets)', /set-?up/i],
    ['auto-verification simulation', /simulat/i],
    ['four-eyes activation', /four-eyes|activation/i],
    ['TAT alerts', /\bTAT\b/],
    ['settings', /settings/i],
  ];
  it.each(TOPICS)('a user-manual page heading covers: %s', (_t, re) => {
    expect(mdFiles().filter((n) => n !== 'runbook.md').some((n) => re.test(headings(n))), `no heading in docs/manual/quality/*.md matches ${re}`).toBe(true);
  });

  it('every page starts with an H1, has real content, and carries no placeholder text', () => {
    const files = mdFiles();
    expect(files.length, 'at least the runbook and 7 topic pages').toBeGreaterThanOrEqual(8);
    for (const n of files) {
      const t = readFileSync(join(MANUAL, n), 'utf8');
      expect(t.trimStart().startsWith('# '), `${n} H1`).toBe(true);
      expect(t.length, `${n} length`).toBeGreaterThan(300);
      expect(t, `${n} placeholder`).not.toMatch(/\b(TODO|TBD|FIXME|lorem ipsum)\b/i);
    }
  });
});
