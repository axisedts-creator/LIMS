// T0A-13: chunk-supplied CI jobs (08 A13 P-14, A16.2) wired into .github/workflows/pr.yml (+ release.yml for release-only ids).
// Spec oracle: the "CI jobs for C0-0A" tables of C3 (CR-C3-009), C4, C7 (CR-C7-013), C8 (CR-C8-015), C17 02-TRDs.
// Run: node --test tools/lint/tests/ci-chunk-jobs.test.mjs
//
// Per job this proves: it exists once; trigger paths = spec table (set equality); runner OS; the exact spec command
// (script path + args, working dir); every command step is gated on the ci-plan result (a job that always reports but
// skips its steps when no trigger path changed); no bypass; dry-run via tools/lint/ci-plan.ts selects it for each
// in-scope path and NOT for look-alike paths; release-only jobs trigger only on tags / manual dispatch.
// Contract reuse: ci-plan.ts `--files <f> [--job <id>]` as fixed in T0A-10 (stdout `run=true|false`).
// Test-side choice (spec fixes the toolchain, not the step): the Go jobs provision Go from apps/bridge-agent/go.mod
// with actions/setup-go before their command (CR-C7-013 / C7 02-TRD s2.1: "pinned identically in go.mod and the CI image").
// Not tested: that the chunk scripts exist (chunk-owned, land with C3/C4/C7/C8/C17), real GitHub execution.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const P = (p) => join(root, p);
const tmp = mkdtempSync(join(tmpdir(), 'ci-chunk-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

// ---------- spec oracle ----------
const LINUX = 'ubuntu';
const SPEC = {
  'c3-wording-commission': { cr: 'CR-C3-009', os: LINUX,
    triggers: ['services/api/src/modules/catalog/**', 'services/worker/src/jobs/catalog/**', 'apps/web/src/features/catalog/**', 'apps/web/src/app/(staff)/catalog/**', 'docs/manual/catalog/**'],
    cmd: /^bash services\/api\/src\/modules\/catalog\/__tests__\/ci\/wording-grep\.sh\s*$/m,
    in: ['services/api/src/modules/catalog/a.ts', 'services/worker/src/jobs/catalog/xlsx/templates/t.ts', 'apps/web/src/features/catalog/a.tsx', 'apps/web/src/app/(staff)/catalog/page.tsx', 'docs/manual/catalog/a.md'],
    out: ['services/api/src/modules/catalogue/a.ts', 'services/api/src/modules/billing/a.ts', 'apps/web/src/features/catalogs/a.tsx', 'docs/manual/catalog.md'] },
  'c04-copy-scan': { cr: 'P-14 (C4)', os: LINUX,
    triggers: ['apps/web/src/features/{frontdesk,billing}/**', 'services/renderer/templates/billing/**', 'docs/manual/{frontdesk,billing}/**'],
    cmd: /^node apps\/web\/src\/features\/billing\/__tests__\/copy-scan\.mjs\s*$/m,
    in: ['apps/web/src/features/frontdesk/a.tsx', 'apps/web/src/features/billing/b.tsx', 'services/renderer/templates/billing/r.html', 'docs/manual/frontdesk/a.md', 'docs/manual/billing/a.md'],
    out: ['apps/web/src/features/billingx/a.tsx', 'apps/web/src/features/analytics/a.tsx', 'services/renderer/templates/analytics/r.html', 'docs/manual/analytics/a.md'] },
  'c8-no-commission': { cr: 'CR-C8-015', os: LINUX,
    triggers: ['services/api/src/modules/analytics/**', 'services/worker/src/jobs/analytics/**', 'apps/web/src/features/analytics/**', 'apps/web/src/app/(staff)/analytics/**', 'docs/manual/analytics/**', 'services/renderer/templates/analytics/**'],
    cmd: /^bash services\/api\/src\/modules\/analytics\/__tests__\/ci\/no-commission\.sh\s*$/m,
    in: ['services/api/src/modules/analytics/a.ts', 'services/worker/src/jobs/analytics/a.ts', 'apps/web/src/features/analytics/a.tsx', 'apps/web/src/app/(staff)/analytics/page.tsx', 'docs/manual/analytics/a.md', 'services/renderer/templates/analytics/r.html'],
    out: ['services/api/src/modules/analytics-x/a.ts', 'services/api/src/modules/catalog/a.ts', 'apps/web/src/features/billing/a.tsx'] },
  'c7-go-build': { cr: 'CR-C7-013', os: LINUX, go: true,
    triggers: ['apps/bridge-agent/**'],
    cmd: /^bash apps\/bridge-agent\/build\/ci\.sh build\s*$/m,
    in: ['apps/bridge-agent/cmd/agent/main.go'], out: ['apps/bridge-agent-x/main.go', 'apps/web/a.ts'] },
  'c7-go-windows': { cr: 'CR-C7-013', os: 'windows-2022', go: true,
    triggers: ['apps/bridge-agent/**'],
    cmd: /^(?:\.\/|\.\\|& )?apps[\\/]bridge-agent[\\/]build[\\/]ci-windows\.ps1\s*$/m,
    in: ['apps/bridge-agent/internal/secrets/dpapi_windows.go'], out: ['apps/bridge-agent-x/a.go', 'apps/phlebo_app/a.dart'] },
  'c7-go-sessions': { cr: 'CR-C7-013', os: LINUX, go: true,
    triggers: ['apps/bridge-agent/**'],
    cmd: /^bash apps\/bridge-agent\/build\/ci\.sh sessions\s*$/m,
    in: ['apps/bridge-agent/internal/sim/s.go'], out: ['apps/bridge-agent-x/a.go'] },
  'c7-go-insecure-tls-gate': { cr: 'CR-C7-013', os: LINUX,
    triggers: ['apps/bridge-agent/**'],
    cmd: /^bash apps\/bridge-agent\/build\/ci\.sh tls-gate\s*$/m,
    in: ['apps/bridge-agent/internal/tls/t.go'], out: ['apps/bridge-agent-x/a.go'] },
  'c7-fixture-copy-check': { cr: 'CR-C7-013', os: LINUX,
    triggers: ['apps/bridge-agent/testdata/config/**', 'services/api/src/modules/instruments/__tests__/fixtures/config/**'],
    cmd: /^bash services\/api\/src\/modules\/instruments\/__tests__\/ci\/fixture-copy-check\.sh\s*$/m,
    in: ['apps/bridge-agent/testdata/config/a.json', 'services/api/src/modules/instruments/__tests__/fixtures/config/a.json'],
    out: ['apps/bridge-agent/testdata/other/a.json', 'apps/bridge-agent/cmd/main.go', 'services/api/src/modules/instruments/__tests__/fixtures/hl7/a.hl7'] },
  'c7-driver-registry-check': { cr: 'CR-C7-013', os: LINUX,
    triggers: ['services/api/src/modules/instruments/drivers/**', 'db/migrations/**'],
    cmd: /^node services\/api\/src\/modules\/instruments\/__tests__\/ci\/driver-registry-check\.ts\s*$/m,
    in: ['services/api/src/modules/instruments/drivers/x/index.ts', 'db/migrations/0003_drivers.sql'],
    out: ['services/api/src/modules/instruments/registry.ts', 'db/policies/core.sql', 'db/tests/a.sql'] },
  'c7-synthetic-data-scan': { cr: 'CR-C7-013', os: LINUX,
    triggers: ['apps/bridge-agent/testdata/**', 'services/api/src/modules/instruments/drivers/**/testdata/**'],
    cmd: /^node services\/api\/src\/modules\/instruments\/__tests__\/ci\/synthetic-scan\.ts\s*$/m,
    in: ['apps/bridge-agent/testdata/config/a.json', 'apps/bridge-agent/testdata/hl7/m.hl7', 'services/api/src/modules/instruments/drivers/mindray/testdata/m.hl7'],
    out: ['apps/bridge-agent/internal/a.go', 'services/api/src/modules/instruments/drivers/mindray/index.ts'] },
  'c17-no-bad-cert-callback': { cr: 'P-14 (C17)', os: LINUX,
    triggers: ['apps/phlebo_app/**'],
    cmd: /^bash apps\/phlebo_app\/tool\/ci\/grep_forbidden\.sh\s*$|^cd apps\/phlebo_app && bash tool\/ci\/grep_forbidden\.sh\s*$/m,
    in: ['apps/phlebo_app/lib/main.dart', 'apps/phlebo_app/pubspec.yaml', 'apps/phlebo_app/lib/core/db/store.dart'], out: ['apps/phlebo_app_x/a.dart', 'apps/web/a.ts'] },
  'c17-db-forensics': { cr: 'P-14 (C17)', os: LINUX,
    triggers: ['apps/phlebo_app/lib/core/db/**'],
    cmd: /cd apps\/phlebo_app && flutter test integration_test\/db_forensics_test\.dart/,
    in: ['apps/phlebo_app/lib/core/db/store.dart', 'apps/phlebo_app/lib/core/db/sub/k.dart'],
    out: ['apps/phlebo_app/lib/main.dart', 'apps/phlebo_app/lib/core/dbx/a.dart', 'apps/phlebo_app/lib/core/database.dart'] },
};
const IDS = Object.keys(SPEC);
const ALL_CHUNK_IDS = [...IDS, 'identity-service-key-grep', 'identity-no-dead-letter-sql'];

// ---------- helpers ----------
const read = (p) => {
  assert.ok(existsSync(P(p)), `${p} must exist`);
  return readFileSync(P(p), 'utf8').replace(/\r\n/g, '\n');
};
function jobsOf(text) {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^jobs:\s*(#.*)?$/.test(l));
  assert.ok(start >= 0, 'workflow needs a top-level `jobs:`');
  const jobs = {};
  const dup = [];
  let cur = null;
  for (const l of lines.slice(start + 1)) {
    if (/^\S/.test(l) && !/^#/.test(l)) break;
    const m = /^  (?:"([\w-]+)"|'([\w-]+)'|([\w-]+)):\s*(#.*)?$/.exec(l);
    if (m) { cur = m[1] ?? m[2] ?? m[3]; if (cur in jobs) dup.push(cur); jobs[cur] = []; continue; }
    if (cur) jobs[cur].push(l);
  }
  return { dup, jobs: Object.fromEntries(Object.entries(jobs).map(([k, v]) => [k, v.join('\n')])) };
}
const wfFiles = () => (existsSync(P('.github/workflows')) ? readdirSync(P('.github/workflows')).filter((f) => /\.ya?ml$/.test(f)) : []);
const pr = () => jobsOf(read('.github/workflows/pr.yml'));
const prJob = (id) => {
  const b = pr().jobs[id];
  assert.ok(b !== undefined, `pr.yml has no job ${id}`);
  return b;
};
// steps = chunks starting at a 6-space "- " line
function stepsOf(block) {
  const out = [];
  let cur = null;
  for (const l of block.split('\n')) {
    if (/^      - /.test(l)) { cur = [l]; out.push(cur); } else if (cur && /^        /.test(l)) cur.push(l);
    else if (/^    \S/.test(l)) cur = null;
  }
  return out.map((s) => s.join('\n'));
}
const stepName = (s) => (/^\s*-?\s*name:\s*(.+)$/m.exec(s) ?? [])[1] ?? '';
const noNames = (s) => s.replace(/^\s*(-\s*)?name:.*$/gm, '');
// command lines only: drop `run:`/`script:` keys and indentation so spec commands can be anchored
const cmdLines = (s) => noNames(s).replace(/^\s*(?:-\s*)?(?:run|script):[ 	]*/gm, '').replace(/^[ 	]+/gm, '');
const triggerPaths = (block) => {
  const m = /^\s+TRIGGER_PATHS:\s*(["']?)(.*)\1\s*$/m.exec(block);
  return m ? m[2].split(/\s+/).filter(Boolean) : null;
};
let n = 0;
function planJob(id, files) {
  const f = join(tmp, `f-${n++}.txt`);
  writeFileSync(f, files.join('\n') + '\n');
  assert.ok(existsSync(P('tools/lint/ci-plan.ts')), 'tools/lint/ci-plan.ts must exist');
  const r = spawnSync(process.execPath, [P('tools/lint/ci-plan.ts'), '--files', f, '--job', id], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  return r.stdout.trim();
}
function planAll(files) {
  const f = join(tmp, `f-${n++}.txt`);
  writeFileSync(f, files.join('\n') + '\n');
  const r = spawnSync(process.execPath, [P('tools/lint/ci-plan.ts'), '--files', f], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  return JSON.parse(r.stdout);
}

// ---------- per-job wiring ----------
for (const id of IDS) {
  const s = SPEC[id];
  test(`${id} (${s.cr}): defined exactly once across all workflows, in pr.yml`, () => {
    const seen = [];
    for (const f of wfFiles()) {
      const { dup, jobs } = jobsOf(read(`.github/workflows/${f}`));
      assert.deepEqual(dup, [], `${f}: duplicate job ids`);
      if (id in jobs) seen.push(f);
    }
    assert.deepEqual(seen, ['pr.yml'], `${id} must be defined once, in pr.yml`);
  });

  test(`${id}: TRIGGER_PATHS equal the chunk TRD table (no wider, no narrower)`, () => {
    const got = triggerPaths(prJob(id));
    assert.ok(got, `${id} needs a job-level TRIGGER_PATHS (conditional job)`);
    assert.deepEqual([...got].sort(), [...s.triggers].sort());
  });

  test(`${id}: runner OS ${s.os === LINUX ? 'Linux (ubuntu)' : s.os}`, () => {
    const runs = (/^\s+runs-on:\s*(.+)$/m.exec(prJob(id)) ?? [])[1] ?? '';
    if (s.os === LINUX) assert.match(runs, /^ubuntu-(24\.04|latest)$/, `${id} runs-on: ${runs}`);
    else assert.equal(runs.trim(), s.os, `${id} runs-on: ${runs}`);
  });

  test(`${id}: runs the spec command`, () => {
    assert.match(cmdLines(prJob(id)), s.cmd, `${id}: spec command not found as a run line`);
  });

  test(`${id}: plan step uses ci-plan.ts --job and every later step is gated on it`, () => {
    const steps = stepsOf(prJob(id));
    const planIdx = steps.findIndex((st) => /id:\s*plan\b/.test(st));
    assert.ok(planIdx >= 0, `${id}: needs a step with id: plan`);
    assert.match(steps[planIdx], /tools\/lint\/ci-plan\.ts[^\n]*--job "\$GITHUB_JOB"/, 'plan step must call ci-plan.ts --job "$GITHUB_JOB"');
    const later = steps.slice(planIdx + 1);
    assert.ok(later.length > 0, `${id}: no command step after plan`);
    for (const st of later) {
      assert.match(st, /^\s*(?:-\s*)?if:\s*steps\.plan\.outputs\.run == 'true'\s*$/m, `${id}: ungated step "${stepName(st)}"`);
    }
  });

  test(`${id}: cannot be bypassed (no continue-on-error, || true, set +e, failure()/always() overrides)`, () => {
    const b = prJob(id);
    assert.doesNotMatch(b, /continue-on-error/);
    assert.doesNotMatch(b, /\|\|\s*(true|exit 0|:)\b/);
    assert.doesNotMatch(b, /set \+e/);
    assert.doesNotMatch(b, /if:\s*(?:\$\{\{\s*)?(always|failure|cancelled|success)\(\)/);
    assert.match(b, /timeout-minutes:\s*\d+/, 'job needs a timeout');
  });

  test(`${id}: dry-run selects it for every in-scope path`, () => {
    for (const f of s.in) assert.equal(planJob(id, [f]), 'run=true', `${f} must run ${id}`);
    assert.equal(planJob(id, ['README.md', ...s.in]), 'run=true', 'one in-scope file among others must run the job');
  });

  test(`${id}: dry-run skips look-alike and unrelated paths`, () => {
    for (const f of [...s.out, 'README.md']) assert.equal(planJob(id, [f]), 'run=false', `${f} must NOT run ${id}`);
    assert.equal(planJob(id, []), 'run=false', 'empty PR must not run the job');
    assert.equal(planJob(id, [`./${s.in[0]}`]), 'run=true', './ prefix must not hide a gated path');
    assert.equal(planJob(id, [`apps/../${s.in[0]}`]), 'run=true', '.. in a path must not hide a gated path');
  });
}

// ---------- CR-C7-013 specifics ----------
test('CR-C7-013: Windows job runs ci-windows.ps1 under PowerShell, on a Windows Server 2022 hosted runner', () => {
  const b = prJob('c7-go-windows');
  assert.match(b, /runs-on:\s*windows-2022\s*$/m);
  const step = stepsOf(b).find((st) => /ci-windows\.ps1/.test(noNames(st)));
  assert.ok(step, 'a step must run ci-windows.ps1');
  assert.match(step, /^\s+shell:\s*(pwsh|powershell)\s*$/m, 'a .ps1 script needs shell: pwsh|powershell, not the job default bash');
});

test('CR-C7-013: exactly one Windows job in pr.yml; every other job is Linux', () => {
  const runs = Object.entries(pr().jobs).map(([id, b]) => [id, (/^\s+runs-on:\s*(.+)$/m.exec(b) ?? [])[1] ?? '']);
  assert.deepEqual(runs.filter(([, r]) => /windows/i.test(r)).map(([id]) => id), ['c7-go-windows']);
  for (const [id, r] of runs) if (id !== 'c7-go-windows') assert.match(r, /ubuntu/i, `${id}: ${r}`);
});

for (const id of IDS.filter((i) => SPEC[i].go)) {
  test(`CR-C7-013: ${id} provisions the pinned Go toolchain (setup-go from apps/bridge-agent/go.mod) before the command`, () => {
    const steps = stepsOf(prJob(id));
    const setup = steps.findIndex((st) => /uses:\s*actions\/setup-go@\S+/.test(st));
    assert.ok(setup >= 0, `${id}: no actions/setup-go step; Go >= 1.26 is not on the hosted image`);
    assert.match(steps[setup], /go-version-file:\s*["']?apps\/bridge-agent\/go\.mod["']?/, 'Go version must come from go.mod (single pin)');
    const cmd = steps.findIndex((st) => SPEC[id].cmd.test(cmdLines(st)));
    assert.ok(cmd > setup, `${id}: setup-go must come before the command step`);
  });
}

test('CR-C7-013: c7-go-insecure-tls-gate is a grep gate and needs no Go toolchain step', () => {
  assert.doesNotMatch(prJob('c7-go-insecure-tls-gate'), /setup-go/);
});

// ---------- C17 specifics ----------
test('c17-db-forensics: KVM + emulator runner are gated, emulator action pinned, test runs from apps/phlebo_app', () => {
  const steps = stepsOf(prJob('c17-db-forensics'));
  const emu = steps.find((st) => /android-emulator-runner@\S+/.test(st));
  assert.ok(emu, 'reactivecircus/android-emulator-runner step required');
  assert.match(emu, /uses:\s*reactivecircus\/android-emulator-runner@v\d/, 'pinned to a version tag');
  assert.match(emu, /script:.*cd apps\/phlebo_app && flutter test integration_test\/db_forensics_test\.dart/);
  const kvm = steps.find((st) => /kvm/i.test(noNames(st)));
  assert.ok(kvm, 'emulator on a Linux hosted runner needs the KVM enable step');
  assert.ok(steps.indexOf(kvm) < steps.indexOf(emu), 'KVM before emulator');
});

test('c17-db-forensics: provisions Flutter SDK (gated, version from packages/ui-flutter/pubspec.yaml) before the emulator step', () => {
  const steps = stepsOf(prJob('c17-db-forensics'));
  const setup = steps.findIndex((st) => /uses:\s*subosito\/flutter-action@\S+/.test(st));
  assert.ok(setup >= 0, 'no flutter-action step; Flutter is not on the hosted image');
  assert.match(steps[setup], /^\s*-?\s*if:\s*steps\.plan\.outputs\.run == 'true'/m, 'Flutter setup must be gated on the plan step');
  assert.match(steps[setup], /flutter-version-file:\s*["']?packages\/ui-flutter\/pubspec\.yaml["']?/, 'Flutter version from the C0 pin (single pin)');
  const emu = steps.findIndex((st) => /android-emulator-runner@\S+/.test(st));
  assert.ok(setup < emu, 'Flutter setup must come before the emulator step');
});

// ---------- release-only jobs ----------
test('c17-release-binary-scan: only on phlebo-v* tags, runs scan_apk.sh, never in pr.yml', () => {
  assert.ok(!('c17-release-binary-scan' in pr().jobs), 'release-only job must not be a PR job');
  const t = read('.github/workflows/release.yml');
  const on = /^on:\s*\n((?:[ \t]+.*\n|\n)*)/m.exec(t);
  assert.ok(on, 'release.yml needs an on: block');
  assert.match(on[1], /push:\s*\n\s+tags:\s*\[?\s*['"]?phlebo-v\*['"]?/, 'tag filter phlebo-v*');
  assert.doesNotMatch(on[1], /pull_request|branches:|schedule:/, 'release.yml must not run on PRs/branches');
  const b = jobsOf(t).jobs['c17-release-binary-scan'];
  assert.ok(b, 'release.yml must define c17-release-binary-scan');
  assert.match(b, /^\s+if:.*phlebo-v/m, 'job guarded to phlebo-v* refs (a workflow_dispatch must not scan/release the wrong thing)');
  assert.match(noNames(b), /^\s+run:\s*(bash )?apps\/phlebo_app\/tool\/ci\/scan_apk\.sh\s*$|cd apps\/phlebo_app && bash tool\/ci\/scan_apk\.sh/m);
});

test('c7-go-release-tag-check: release workflow only, checks the .exe, never in pr.yml', () => {
  assert.ok(!('c7-go-release-tag-check' in pr().jobs), '"release workflow only" (CR-C7-013): not a PR job');
  const owners = wfFiles().filter((f) => 'c7-go-release-tag-check' in jobsOf(read(`.github/workflows/${f}`)).jobs);
  assert.deepEqual(owners, ['release.yml']);
  const b = jobsOf(read('.github/workflows/release.yml')).jobs['c7-go-release-tag-check'];
  assert.match(noNames(b), /^\s+run:\s*bash apps\/bridge-agent\/build\/ci\.sh release-tag-check \S+\.exe\s*$/m, 'ci.sh release-tag-check <agent.exe>');
  assert.doesNotMatch(b, /continue-on-error|\|\|\s*true/);
});

test('SEC: release.yml is read-only, secret-free and its checkout does not persist credentials', () => {
  const t = read('.github/workflows/release.yml');
  assert.match(t, /^permissions:\s*\n\s+contents:\s*read\s*$/m);
  assert.doesNotMatch(t, /write-all|:\s*write\b/);
  assert.doesNotMatch(t, /pull_request_target/);
  assert.deepEqual([...t.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((m) => m[1]).filter((x) => x !== 'GITHUB_TOKEN'), []);
  for (const m of t.matchAll(/uses:\s*actions\/checkout@\S+\s*\n((?:\s+with:\s*\n(?:\s{8,}.*\n)*)?)/g)) {
    assert.match(m[1], /persist-credentials:\s*false/, 'checkout must not persist the token');
  }
});

// ---------- cross-job: one PR per CR, no cross-talk ----------
test('dry-run per CR: a PR touching only one chunk plans only that chunk\'s jobs', () => {
  const chunkOnly = (files) => planAll(files).filter((j) => ALL_CHUNK_IDS.includes(j));
  assert.deepEqual(chunkOnly(['apps/bridge-agent/cmd/agent/main.go']), ['c7-go-build', 'c7-go-insecure-tls-gate', 'c7-go-sessions', 'c7-go-windows'].concat(['identity-service-key-grep']).sort());
  assert.deepEqual(chunkOnly(['apps/phlebo_app/lib/main.dart']), ['c17-no-bad-cert-callback', 'identity-service-key-grep']);
  assert.deepEqual(chunkOnly(['apps/phlebo_app/lib/core/db/s.dart']), ['c17-db-forensics', 'c17-no-bad-cert-callback', 'identity-service-key-grep']);
  assert.deepEqual(chunkOnly(['docs/manual/billing/a.md']), ['c04-copy-scan']);
  assert.deepEqual(chunkOnly(['docs/manual/analytics/a.md']), ['c8-no-commission']);
  assert.deepEqual(chunkOnly(['docs/manual/catalog/a.md']), ['c3-wording-commission']);
  assert.deepEqual(chunkOnly(['README.md']), []);
});

test('dry-run: a C7 driver migration PR plans only the registry check among C7 jobs', () => {
  const c7 = planAll(['db/migrations/0009_g_drivers.sql']).filter((j) => j.startsWith('c7-'));
  assert.deepEqual(c7, ['c7-driver-registry-check']);
});

test('dry-run: synthetic-data scan and fixture-copy check both fire on shared config fixtures', () => {
  const c7 = planAll(['apps/bridge-agent/testdata/config/a.json']).filter((j) => j.startsWith('c7-'));
  assert.deepEqual(c7, ['c7-fixture-copy-check', 'c7-go-build', 'c7-go-insecure-tls-gate', 'c7-go-sessions', 'c7-go-windows', 'c7-synthetic-data-scan']);
});

// ---------- required checks (15.3) ----------
test('branch protection: every PR chunk job is a required check; release-only ids are not (they never report on a PR)', () => {
  assert.ok(existsSync(P('.github/branch-protection.json')), '.github/branch-protection.json must exist');
  const ctx = JSON.parse(read('.github/branch-protection.json')).required_status_checks.contexts;
  for (const id of IDS) assert.ok(ctx.includes(id), `required checks must include ${id}`);
  for (const id of ['c7-go-release-tag-check', 'c17-release-binary-scan']) assert.ok(!ctx.includes(id), `${id} must not be a required PR check`);
});
