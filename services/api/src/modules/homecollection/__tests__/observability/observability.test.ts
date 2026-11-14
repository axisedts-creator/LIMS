// HC-T17 (no DB): Observability per 02-TRD §14 (metrics table, logs "Never" list, "Alert rules for C1", "CI jobs for C0-0A"), plan row HC-T17 (DoD §3.7, P-14), 07-SECURITY §5.10 / §6 / REQ-SEC-098/107,
// 08 A13 P-14. done_when: "metrics in TRD §14 exported; log PHI scan test passes; C1 and C0-0A wiring CRs filed". tests: "log-scan test with planted names/phones/barcodes".
// SEAMS (spec fixes behaviour, not names; precedent = lab T-31 / analytics AN-T22 / LD-88):
//  (1) the 8 lims_homecollection_* metrics are registered in services/api/src/core/observability/metrics.ts DEFS (REQUIRED_METRICS / createMetrics). NOTE for the writer: DEFS and
//      core/observability/__tests__/metrics.test.ts (EXPECTED map) are C0 paths; a C17-only write set needs a lead decision / CR first (LD-88 did it for C8, lab for C5). Instrumentation is also asserted
//      by source reference: every name appears in non-test source under api homecollection/** or worker jobs/homecollection/** (the three gauges are refreshed by a worker task).
//  (2) alert rules live at services/worker/src/jobs/homecollection/alerts.yaml (TRD §14 "file ..."; the plan row's bare `alerts.yaml` is this file). expr + for verbatim from the TRD table (whitespace-folded);
//      severity, when present, must match (C1 adds team + runbook_url on import). `promtool check rules` runs when PROMTOOL or `promtool` on PATH resolves, else that one test is skipped (CI has it).
//  (3) CI scripts apps/phlebo_app/tool/ci/{grep_forbidden.sh,scan_apk.sh}. Contract pinned here: `grep_forbidden.sh [APP_DIR]` (default = the app dir the script sits in) scans APP_DIR/lib/** and
//      APP_DIR/pubspec.yaml, ignores comment lines (`#`, `//`), exits 0 when clean and 1 on any hit, naming file:line. `scan_apk.sh <apk>` exits non-zero without an argument or with a missing file (fail closed).
//  (4) CRs: .orchestra/cr/*.md in the 04-CHANGE-REQUESTS template, one `From chunk: C17` / `To owner: C1` naming alerts.yaml, one `To owner: C0-0A` naming tool/ci.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { REPO_ROOT } from '../../../../core/module.js';
import { createMetrics, REQUIRED_METRICS } from '../../../../core/observability/metrics.js';

const API_HC = join(REPO_ROOT, 'services', 'api', 'src', 'modules', 'homecollection');
const WK_HC = join(REPO_ROOT, 'services', 'worker', 'src', 'jobs', 'homecollection');
const RULES = join(WK_HC, 'alerts.yaml');
const CI_DIR = join(REPO_ROOT, 'apps', 'phlebo_app', 'tool', 'ci');
const CR_DIR = join(REPO_ROOT, '.orchestra', 'cr');
const TRD = join(REPO_ROOT, 'spec', 'chunks', 'C17-home-collection', '02-TRD.md');
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const fwd = (p: string) => p.replace(/\\/g, '/');

function sources(dir: string): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) { if (n !== '__tests__' && n !== 'node_modules') out.push(...sources(p)); continue; }
    if (/\.ts$/.test(n) && !/\.(test|spec)\.ts$/.test(n)) out.push({ file: fwd(relative(REPO_ROOT, p)), text: readFileSync(p, 'utf8') });
  }
  return out;
}
const SRC = [...sources(API_HC), ...sources(WK_HC)];
const trdText = readFileSync(TRD, 'utf8');

// ------------------------------------------------------------------------------------------------------------------------------------------------------------ metrics
type Kind = 'counter' | 'gauge' | 'histogram';
/** TRD §14 metric table: name | type | labels (backticked words of the cell; `—` = none). */
function trdMetrics(): Record<string, readonly [Kind, readonly string[]]> {
  const a = trdText.indexOf('## 14. Observability'), b = trdText.indexOf('Alerts (registered with C1)', a);
  expect(a, 'TRD §14 heading').toBeGreaterThan(-1); expect(b, 'TRD alerts paragraph').toBeGreaterThan(a);
  const out: Record<string, readonly [Kind, readonly string[]]> = {};
  for (const m of trdText.slice(a, b).matchAll(/^\|\s*`(lims_homecollection_\w+)`\s*\|\s*(counter|gauge|histogram)\s*\|\s*([^|]*?)\s*\|\s*$/gm)) {
    out[m[1]!] = [m[2] as Kind, [...m[3]!.matchAll(/`(\w+)`/g)].map((x) => x[1]!)];
  }
  return out;
}
const HC = trdMetrics();
const T = '01a1a98a-ac40-7000-8000-00000000a001';
const L: Record<string, string> = { tenant_id: T, type: 'visit.arrived', outcome: 'applied', changed: 'true', clock_source: 'anchor' };
const pick = (names: readonly string[]) => Object.fromEntries(names.map((n) => [n, L[n]!]));
const emit = (m: ReturnType<typeof createMetrics>, name: string, kind: string, lb: Record<string, string>) => {
  const n = name as never;
  if (kind === 'counter') m.inc(n, lb); else if (kind === 'gauge') m.set(n, 1, lb); else m.observe(n, 3, lb);
};

describe('homecollection metrics registry (TRD §14 Metrics)', () => {
  it('the TRD table lists exactly the 8 metrics, with the types and labels pinned here (guards this file against TRD drift)', () => {
    expect(HC).toEqual({
      lims_homecollection_mutations_total: ['counter', ['type', 'outcome']],
      lims_homecollection_push_duration_seconds: ['histogram', []],
      lims_homecollection_snapshot_duration_seconds: ['histogram', ['changed']],
      lims_homecollection_held_open: ['gauge', ['tenant_id']],
      lims_homecollection_clock_skew_seconds: ['histogram', ['clock_source']],
      lims_homecollection_devices_stale_total: ['gauge', ['tenant_id']],
      lims_homecollection_handover_overdue_open: ['gauge', ['tenant_id']],
      lims_homecollection_events_published_total: ['counter', []],
    });
  });

  it('all 8 lims_homecollection_* metrics are registered in REQUIRED_METRICS, and nothing else with that prefix', () => {
    expect(REQUIRED_METRICS.filter((n) => n.startsWith('lims_homecollection_')).sort()).toEqual(Object.keys(HC).sort());
  });

  it.each(Object.entries(HC))('%s is exposed with the TRD type and its exact label set', async (name, [kind, labels]) => {
    const m = createMetrics();
    emit(m, name, kind, pick(labels));
    const text = await m.render();
    expect(text).toContain(`# TYPE ${name} ${kind}`);
    for (const l of labels) expect(text).toMatch(new RegExp(`^${name}\\w*\\{[^}]*\\b${l}="${L[l]}"`, 'm'));
  });

  it.each(Object.entries(HC))('%s rejects a PHI / id label outside its set (visit, device, patient, barcode, name, phone, gps never become labels)', (name, [kind, labels]) => {
    const m = createMetrics();
    expect(() => emit(m, name, kind, pick(labels)), `${name} valid labels`).not.toThrow();   // not vacuous: an unknown metric also throws
    for (const bad of ['visit_id', 'device_id', 'route_id', 'patient_id', 'barcode', 'patient_name', 'phone', 'address', 'latitude', 'reference']) {
      expect(() => emit(m, name, kind, { ...pick(labels), [bad]: 'x' }), `${name}+${bad}`).toThrow();
    }
  });

  it('the three gauges are per tenant (alert exprs are max by (tenant_id)) and take 0 when none is open', async () => {
    const TB = '01a1a98a-ac40-7000-8000-00000000b001';
    const m = createMetrics();
    for (const g of ['lims_homecollection_held_open', 'lims_homecollection_devices_stale_total', 'lims_homecollection_handover_overdue_open']) {
      m.set(g as never, 3, { tenant_id: T });
      m.set(g as never, 0, { tenant_id: TB });
      const text = await m.render();
      expect(text, g).toMatch(new RegExp(`${g}\\{[^}]*tenant_id="${T}"[^}]*\\} 3\\b`));
      expect(text, g).toMatch(new RegExp(`${g}\\{[^}]*tenant_id="${TB}"[^}]*\\} 0\\b`));
    }
  });

  it.each(Object.keys(HC))('%s is emitted by module code (non-test source under api homecollection/** or worker jobs/homecollection/**), not only declared', (name) => {
    expect(SRC.filter((s) => s.text.includes(name)).map((s) => s.file), `no homecollection source references ${name}`).not.toEqual([]);
  });

  it('metrics are emitted only through ctx.metrics / deps.metrics (no private prom-client registry, no second /metrics server)', () => {
    const bad = SRC.filter((s) => /from ['"]prom-client['"]|new (Counter|Gauge|Histogram|Registry)\(|createServer\(/.test(s.text)).map((s) => s.file);
    expect(bad).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------ alert rule file
interface Rule { alert: string; expr: string; for?: string; labels?: Record<string, string> }
const rulesOf = (file: string): Rule[] => (parse(readFileSync(file, 'utf8')) as { groups: { rules: Rule[] }[] }).groups.flatMap((g) => g.rules);

/** TRD "Alert rules for C1" table: alert, expr (backtick span; `\|` unescaped), for, severity. */
function trdAlerts(): { alert: string; expr: string; for: string; severity: string }[] {
  const a = trdText.indexOf('Alert rules for C1 (08 A13 P-14'), b = trdText.indexOf('CI jobs for C0-0A', a);
  expect(a, 'TRD alert paragraph').toBeGreaterThan(-1); expect(b, 'TRD CI paragraph').toBeGreaterThan(a);
  const out = [];
  for (const line of trdText.slice(a, b).split('\n')) {
    const m = /^\|\s*`(Homecollection\w+)`\s*\|\s*`(.+)`\s*\|\s*(\d+[mh])\s*\|\s*(warning|critical)\s*\|/.exec(line);
    if (m) out.push({ alert: m[1]!, expr: m[2]!.replace(/\\\|/g, '|'), for: m[3]!, severity: m[4]! });
  }
  return out;
}

describe('alerts.yaml (TRD §14 "Alert rules for C1", 08 A13 P-14)', () => {
  it('the TRD table parse finds the five rules (guards the comparisons against an empty parse)', () => {
    expect(trdAlerts().map((r) => r.alert)).toEqual(['HomecollectionHeldOpen', 'HomecollectionPush5xx', 'HomecollectionDeadLetter', 'HomecollectionClockSkew', 'HomecollectionDevicesStale']);
  });

  it('the file exists at services/worker/src/jobs/homecollection/alerts.yaml and holds exactly the five rules, no more, no fewer, no duplicates', () => {
    expect(existsSync(RULES), 'alerts.yaml missing').toBe(true);
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

  it('every metric a rule uses is a TRD §14 metric or a C0 metric the TRD names; no rule filters or groups by a visit / device / patient / barcode label', () => {
    for (const r of rulesOf(RULES)) {
      for (const m of r.expr.match(/\blims_[a-z0-9_]+/g) ?? []) {
        const base = m.replace(/_(bucket|sum|count)$/, '');
        expect(base, `${r.alert} ${m}`).toMatch(/^(lims_homecollection_[a-z_]+|lims_http_requests_total|lims_core_dead_letters_total)$/);
        if (base.startsWith('lims_homecollection_')) expect(Object.keys(HC), `${r.alert} ${m}`).toContain(base);
      }
      expect(r.expr, r.alert).not.toMatch(/\b(barcode|visit|device|route|patient|user|actor|specimen)_?(id|no|name)?\b\s*(=|!=|=~|,|\))/i);
    }
  });

  const promtool = process.env['PROMTOOL'] ?? 'promtool';
  const have = spawnSync(promtool, ['--version'], { encoding: 'utf8' }).status === 0;
  it.skipIf(!have)('promtool check rules passes (08 A13 P-14)', () => {
    const r = spawnSync(promtool, ['check', 'rules', RULES], { encoding: 'utf8' });
    expect(r.stdout + r.stderr).toMatch(/SUCCESS: 5 rules found/);
    expect(r.status).toBe(0);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------ static log scan
/** every log / console call in non-test module + worker source: file + the paren-balanced call text. */
function logCalls(): { file: string; call: string; console: boolean }[] {
  const out: { file: string; call: string; console: boolean }[] = [];
  for (const { file, text } of SRC) {
    for (const m of text.matchAll(/\b(?:log|logger)\??\.(?:info|warn|error|debug|fatal|trace)\??\.?\(|\bconsole\.\w+\(/g)) {
      let depth = 0, i = m.index! + m[0].length - 1;
      const start = i;
      for (; i < text.length; i++) { if (text[i] === '(') depth++; else if (text[i] === ')' && --depth === 0) break; }
      out.push({ file, call: text.slice(start, i + 1), console: m[0].startsWith('console') });
    }
  }
  return out;
}
/** the identifiers a call hands to the logger: string-literal text is dropped (a fixed message cannot carry PHI), `${...}` interpolations of template literals are kept. */
const idents = (call: string): string =>
  call.replace(/`([^`]*)`/g, (_m, s: string) => [...s.matchAll(/\$\{([^}]*)\}/g)].map((x) => x[1]).join(' ')).replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, '""');
// TRD §14 "Never": names, phones, addresses, landmark, notes, barcodes, GPS, payment references, consent text, tokens; plus whole-object dumps and raw error messages (a port error text may quote PHI).
const FORBIDDEN = /\b(name|names|first_?name|last_?name|full_?name|display_?name|phone|mobile|msisdn|address|landmark|note|notes|note_for_phlebotomist|barcode|barcodes|scanned_?barcode|lat|lng|latitude|longitude|gps|reference|consent|consent_?text|token|jwt|secret|password|message|stack|err|payload|body|mutation|mutations|row|rows|patient|visit|specimen|specimens|req|request|dto|JSON)\b/i;

describe('PHI log scan, static (TRD §14 "Never", 07-SECURITY §6, REQ-SEC-098)', () => {
  const calls = logCalls();

  it('the scan finds the module log calls (guards the checks against an empty parse)', () => {
    expect(calls.filter((c) => !c.console).length).toBeGreaterThanOrEqual(10);
  });

  it('no console.* call anywhere in module or worker source (all logging goes through ctx.log / the worker logger)', () => {
    expect(calls.filter((c) => c.console).map((c) => c.file)).toEqual([]);
  });

  it('no log call hands a name, phone, address, landmark, note, barcode, GPS, payment reference, consent text, token, raw error message or a whole payload/row object to the logger', () => {
    const bad = calls.filter((c) => !c.console && FORBIDDEN.test(idents(c.call))).map((c) => `${c.file}: ${norm(c.call).slice(0, 120)}`);
    expect(bad).toEqual([]);
  });

  it('the scanner itself catches planted offenders (so the check above is not vacuous)', () => {
    for (const planted of ['({ name: patient.name }, "x")', '({ code: e.message }, "x")', '({ barcode }, "x")', '({ phone: v.phone }, "x")', '({ gps }, "x")', '(`failed for ${visit.name}`)', '({ payload }, "x")', '({ ref: reference }, "x")'])
      expect(FORBIDDEN.test(idents(planted)), planted).toBe(true);
    for (const fine of ['({ code: code(e) }, "homecollection.lab_unavailable")', '({ visit_id: v.id, tenant_id: t, count: 3, outcome: "applied" }, "homecollection.sync")'])
      expect(FORBIDDEN.test(idents(fine)), fine).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------ CI job scripts
const BASH = process.env['BASH'] && existsSync(process.env['BASH']) ? process.env['BASH'] : existsSync('C:\\Program Files\\Git\\bin\\bash.exe') ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash';
const sh = (script: string, args: string[]) => spawnSync(BASH, [fwd(script), ...args.map(fwd)], { encoding: 'utf8', timeout: 60_000 });
const tmp: string[] = [];
afterAll(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });
/** a fake app dir: lib/main.dart + pubspec.yaml, plus any extra files */
function fakeApp(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'hc-t17-app-'));
  tmp.push(dir);
  const all: Record<string, string> = {
    'lib/main.dart': "import 'package:flutter/material.dart';\nvoid main() {}\n",
    'pubspec.yaml': 'name: fake_app\ndependencies:\n  flutter:\n    sdk: flutter\n  drift: 2.35.3\n',
    ...files,
  };
  for (const [f, text] of Object.entries(all)) { mkdirSync(join(dir, f, '..'), { recursive: true }); writeFileSync(join(dir, f), text); }
  return dir;
}

describe('c17-no-bad-cert-callback: tool/ci/grep_forbidden.sh (TRD §14 CI jobs, REQ-SEC-104/105, 02-CV §15.3)', () => {
  const script = join(CI_DIR, 'grep_forbidden.sh');
  it('the script exists with a bash shebang and fails on error (set -e)', () => {
    expect(existsSync(script), 'grep_forbidden.sh missing').toBe(true);
    const t = readFileSync(script, 'utf8');
    expect(t).toMatch(/^#!\/(usr\/)?bin\/(env )?bash/);
    expect(t).toMatch(/^set -[a-z]*e/m);
  });

  it('a clean app dir passes (exit 0)', () => {
    const r = sh(script, [fakeApp()]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
  });

  it('comment lines naming a forbidden symbol do not fail the job (the real pubspec says "sqlcipher_flutter_libs banned")', () => {
    const r = sh(script, [fakeApp({ 'pubspec.yaml': 'name: a\n# sqlcipher_flutter_libs banned (02-CV §15.3)\ndependencies:\n  drift: 2.35.3\n', 'lib/main.dart': '// never use badCertificateCallback\nvoid main() {}\n' })]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
  });

  it.each([
    ['badCertificateCallback in lib', { 'lib/net.dart': 'final c = HttpClient()..badCertificateCallback = (c, h, p) => true;\n' }, 'lib/net.dart'],
    ['sqlcipher_flutter_libs dependency', { 'pubspec.yaml': 'name: a\ndependencies:\n  sqlcipher_flutter_libs: 0.6.0\n' }, 'pubspec.yaml'],
    ['firebase_core import', { 'lib/f.dart': "import 'package:firebase_core/firebase_core.dart';\n" }, 'lib/f.dart'],
    ['firebase_messaging (FCM) import', { 'lib/f.dart': "import 'package:firebase_messaging/firebase_messaging.dart';\n" }, 'lib/f.dart'],
    ['firebase_messaging dependency', { 'pubspec.yaml': 'name: a\ndependencies:\n  firebase_messaging: 15.0.0\n' }, 'pubspec.yaml'],
    ['google_maps_flutter import', { 'lib/m.dart': "import 'package:google_maps_flutter/google_maps_flutter.dart';\n" }, 'lib/m.dart'],
    ['flutter_map dependency', { 'pubspec.yaml': 'name: a\ndependencies:\n  flutter_map: 7.0.0\n' }, 'pubspec.yaml'],
    ['mapbox import', { 'lib/m.dart': "import 'package:mapbox_maps_flutter/mapbox_maps_flutter.dart';\n" }, 'lib/m.dart'],
  ] as const)('%s fails the job (exit 1) and names the file', (_n, files, where) => {
    const r = sh(script, [fakeApp({ ...files })]);
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout + r.stderr).toContain(where);
  });

  it('a hit in a nested lib/ folder is found', () => {
    const r = sh(script, [fakeApp({ 'lib/core/net/deep/x.dart': 'x.badCertificateCallback = (_, __, ___) => true;\n' })]);
    expect(r.status).toBe(1);
  });

  it('the real apps/phlebo_app passes today (default app dir = the app the script sits in, no argument)', () => {
    const r = sh(script, []);
    expect(r.status, r.stdout + r.stderr).toBe(0);
  });
});

describe('c17-release-binary-scan: tool/ci/scan_apk.sh (TRD §14 CI jobs, REQ-SEC-107, 07-SECURITY §5.11)', () => {
  const script = join(CI_DIR, 'scan_apk.sh');
  it('the script exists with a bash shebang, set -e and names the three tools of the job: apktool, strings, gitleaks', () => {
    expect(existsSync(script), 'scan_apk.sh missing').toBe(true);
    const t = readFileSync(script, 'utf8');
    expect(t).toMatch(/^#!\/(usr\/)?bin\/(env )?bash/);
    expect(t).toMatch(/^set -[a-z]*e/m);
    for (const tool of ['apktool', 'strings', 'gitleaks']) expect(t, tool).toContain(tool);
  });

  it('fails closed: no argument → non-zero with a usage line; missing APK file → non-zero (never a silent pass)', () => {
    const none = sh(script, []);
    expect(none.status, none.stdout + none.stderr).not.toBe(0);
    expect(none.stdout + none.stderr).toMatch(/usage/i);
    const missing = sh(script, [join(tmpdir(), 'hc-t17-no-such-release.apk')]);
    expect(missing.status, missing.stdout + missing.stderr).not.toBe(0);
  });

  it('a file that is not an APK (planted secret inside) is not reported clean', () => {
    expect(existsSync(script), 'scan_apk.sh missing').toBe(true);   // a missing script is "non-zero" too: not a pass
    const dir = fakeApp({ 'fake.apk': 'not a zip. AKIAIOSFODNN7EXAMPLE planted-secret-for-scan\n' });
    const r = sh(script, [join(dir, 'fake.apk')]);
    expect(r.status, r.stdout + r.stderr).not.toBe(0);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------------------------------------ CRs
describe('wiring CRs filed (plan row HC-T17 done_when; 04-CHANGE-REQUESTS template; 08 A13 P-14)', () => {
  const crs = existsSync(CR_DIR) ? readdirSync(CR_DIR).filter((f) => f.endsWith('.md')).map((f) => ({ f, text: readFileSync(join(CR_DIR, f), 'utf8') })) : [];
  const owned = (owner: RegExp, mentions: RegExp) => crs.filter((c) => /^From chunk:\s*C17\b/m.test(c.text) && owner.test(c.text) && mentions.test(c.text));
  const FIELDS = [/^Title:\s*CR-C17-/m, /^Type:\s*\S/m, /^Blocking\?\s*\S/m, /^Problem:\s*\S/m, /^Proposed change \(exact\):\s*\S/m, /^Backward compatible\?\s*\S/m, /^Tenant\/security impact:\s*\S/m, /^Tests that will prove it:\s*\S/m];

  it('a C17→C1 CR names services/worker/src/jobs/homecollection/alerts.yaml and the five alert names', () => {
    const hit = owned(/^To owner:\s*C1\b/m, /services\/worker\/src\/jobs\/homecollection\/alerts\.yaml/);
    expect(hit.map((c) => c.f), 'no C17→C1 alert wiring CR').not.toEqual([]);
    for (const a of ['HomecollectionHeldOpen', 'HomecollectionPush5xx', 'HomecollectionDeadLetter', 'HomecollectionClockSkew', 'HomecollectionDevicesStale']) expect(hit.some((c) => c.text.includes(a)), a).toBe(true);
    for (const re of FIELDS) expect(hit.some((c) => re.test(c.text)), String(re)).toBe(true);
  });

  it('a C17→C0-0A CR names apps/phlebo_app/tool/ci and the three job ids', () => {
    const hit = owned(/^To owner:\s*C0-0A\b/m, /apps\/phlebo_app\/tool\/ci|tool\/ci\//);
    expect(hit.map((c) => c.f), 'no C17→C0-0A CI wiring CR').not.toEqual([]);
    for (const j of ['c17-no-bad-cert-callback', 'c17-db-forensics', 'c17-release-binary-scan']) expect(hit.some((c) => c.text.includes(j)), j).toBe(true);
    for (const re of FIELDS) expect(hit.some((c) => re.test(c.text)), String(re)).toBe(true);
  });

  it('the CRs hold no secret-looking value (synthetic data only)', () => {
    for (const c of crs.filter((x) => /^From chunk:\s*C17\b/m.test(x.text))) expect(c.text, c.f).not.toMatch(/AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bpassword\s*[:=]\s*\S+/i);
  });
});
