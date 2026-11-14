// T0A-10: CI workflows (all gates). Spec: 02-TRD s15.1 (pr.yml), s15.2 (nightly.yml), s15.3 (branch protection),
// 08 A25 D-208 (supabase-pin), 08 A13 P-14 / A16.2 (chunk-supplied jobs). Security: 07-SECURITY s1 (REQ-SEC-128/129), CI row.
// Run: node --test tools/lint/tests/ci-workflows.test.mjs
//
// No YAML parser is installed, so workflows are read as text: `jobs:` at col 0, job ids at 2-space indent.
//
// Contracts that the spec does not fix (test-side choices, same style as T0A-02):
//  1. .github/workflows/pr.yml has one job per id in BASE_JOBS + CHUNK_JOBS. Release-only ids (RELEASE_ONLY_JOBS,
//     "release workflow only" / tag `phlebo-v*`) may live in any .github/workflows/*.yml.
//  2. node tools/lint/ci-plan.ts --files <file> [--workflow .github/workflows/pr.yml]
//       --files: newline-separated changed paths (like check-paths). stdout: JSON array of job ids (sorted) that a
//       pull_request with those changes runs. This is the "workflow dry-run on fixture PRs". Exit 0 ok; != 0 on bad usage
//       or unreadable input (fail closed). It must read the triggers from the workflow, not keep a second copy
//       (checked by the drift test: all-paths plan == every pr.yml job id except RELEASE_ONLY_JOBS).
//  3. node tools/lint/check-supabase-pin.ts --compose <compose.yaml> --lock <UPSTREAM.lock>
//       Image refs are tokens `<repo>@sha256:<64 hex>` in both files. Every image in the lock must appear in compose
//       with the same digest; compose naming a lock image by tag/other digest fails. Exit 0 equal; 1 differ (message
//       names the image); other nonzero = bad usage / unreadable file (fail closed).
//  4. .github/branch-protection.json (GitHub API body shape): required_status_checks.contexts == all pr.yml job ids;
//     required_pull_request_reviews.require_code_owner_reviews == true; repository.allow_squash_merge true,
//     allow_merge_commit false, allow_rebase_merge false (squash only, 15.3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const P = (p) => join(root, p);
const tmp = mkdtempSync(join(tmpdir(), 'ci-wf-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

// ---------- spec tables (independent oracle) ----------
const ALWAYS = ['paths', 'typecheck', 'lint', 'unit', 'contracts', 'codegen-fresh', 'secrets'];
const SVC = ['services/**', 'db/**', 'packages/**'];
// job -> trigger globs (TRD 15.1 "Runs" column; chunk jobs from the chunk TRD tables)
const TRIGGERS = {
  integration: SVC,
  'phi-log-scan': SVC,
  oasdiff: ['contracts/openapi/**'],
  migrations: ['db/**'],
  isolation: ['db/**', 'services/**', 'contracts/**'],
  deps: ['pnpm-lock.yaml', '**/package.json', 'pnpm-workspace.yaml'],
  images: ['**/Dockerfile', '**/Dockerfile.*'],
  'bsdate-golden': ['packages/shared-ts/**', 'packages/shared-dart/**', 'packages/test-fixtures/bsdate/**'],
  ui: ['packages/ui/**', 'apps/web/**'],
  'supabase-pin': ['tools/devstack/**', 'infra/compose/supabase/upstream/UPSTREAM.lock'],
  'identity-service-key-grep': ['services/**', 'apps/**', 'packages/**'],
  'identity-no-dead-letter-sql': ['services/api/src/modules/identity/**'],
  'c3-wording-commission': ['services/api/src/modules/catalog/**', 'services/worker/src/jobs/catalog/**', 'apps/web/src/features/catalog/**', 'apps/web/src/app/(staff)/catalog/**', 'docs/manual/catalog/**'],
  'c04-copy-scan': ['apps/web/src/features/{frontdesk,billing}/**', 'services/renderer/templates/billing/**', 'docs/manual/{frontdesk,billing}/**'],
  'c8-no-commission': ['services/api/src/modules/analytics/**', 'services/worker/src/jobs/analytics/**', 'apps/web/src/features/analytics/**', 'apps/web/src/app/(staff)/analytics/**', 'docs/manual/analytics/**', 'services/renderer/templates/analytics/**'],
  'c7-go-build': ['apps/bridge-agent/**'],
  'c7-go-windows': ['apps/bridge-agent/**'],
  'c7-go-sessions': ['apps/bridge-agent/**'],
  'c7-go-insecure-tls-gate': ['apps/bridge-agent/**'],
  'c7-fixture-copy-check': ['apps/bridge-agent/testdata/config/**', 'services/api/src/modules/instruments/__tests__/fixtures/config/**'],
  'c7-driver-registry-check': ['services/api/src/modules/instruments/drivers/**', 'db/migrations/**'],
  'c7-synthetic-data-scan': ['apps/bridge-agent/testdata/**', 'services/api/src/modules/instruments/drivers/**/testdata/**'],
  'c17-no-bad-cert-callback': ['apps/phlebo_app/**'],
  'c17-db-forensics': ['apps/phlebo_app/lib/core/db/**'],
};
const RELEASE_ONLY_JOBS = ['c7-go-release-tag-check', 'c17-release-binary-scan'];
const BASE_JOBS = [...ALWAYS, 'integration', 'oasdiff', 'migrations', 'isolation', 'deps', 'images', 'bsdate-golden', 'phi-log-scan', 'ui', 'supabase-pin'];
const CHUNK_JOBS = [
  'identity-service-key-grep', 'identity-no-dead-letter-sql', 'c3-wording-commission', 'c04-copy-scan', 'c8-no-commission',
  'c7-go-build', 'c7-go-windows', 'c7-go-sessions', 'c7-go-insecure-tls-gate', 'c7-fixture-copy-check',
  'c7-driver-registry-check', 'c7-synthetic-data-scan', 'c17-no-bad-cert-callback', 'c17-db-forensics',
];
// substrings (case-insensitive) each job's block must contain
const CMDS = {
  paths: ['tools/lint/check-paths.ts', '--branch', 'HEAD_REF'],
  typecheck: ['turbo run typecheck', 'dart analyze', 'go vet'],
  lint: ['eslint', 'prettier', 'flutter analyze', 'gofmt -l', 'staticcheck'],
  unit: ['test:unit', '--filter'],
  integration: ['dev:up --ci', 'test:integration'],
  contracts: ['@lims/contracts', 'lint-openapi.ts', 'check-access-actions.ts', 'check-port-consumers.ts', 'gen-permissions'],
  oasdiff: ['oasdiff breaking', '--fail-on ERR', 'cr-approved-breaking', '1.35'],
  'codegen-fresh': ['pnpm codegen', 'git diff --exit-code'],
  migrations: ['check-migrations.ts', 'check-registry', 'check-fk-dag'],
  isolation: ['db/tests', 'probe-manifest.json'],
  secrets: ['gitleaks detect', '--redact'],
  deps: ['osv-scanner', 'pnpm audit --audit-level critical'],
  images: ['trivy image'],
  'phi-log-scan': ['integration'],
  ui: ['axe'],
  'supabase-pin': ['check-supabase-pin', 'tools/devstack/compose.yaml', 'UPSTREAM.lock'],
  'identity-service-key-grep': ['service-key-grep.mjs'],
  'identity-no-dead-letter-sql': ['no-foreign-schema-sql', 'no-dead-letter-sql.fixture.json'],
  'c3-wording-commission': ['wording-grep.sh'],
  'c04-copy-scan': ['copy-scan.mjs'],
  'c8-no-commission': ['no-commission.sh'],
  'c7-go-build': ['ci.sh build'],
  'c7-go-windows': ['ci-windows.ps1'],
  'c7-go-sessions': ['ci.sh sessions'],
  'c7-go-insecure-tls-gate': ['ci.sh tls-gate'],
  'c7-go-release-tag-check': ['release-tag-check'],
  'c7-fixture-copy-check': ['fixture-copy-check.sh'],
  'c7-driver-registry-check': ['driver-registry-check.ts'],
  'c7-synthetic-data-scan': ['synthetic-scan.ts'],
  'c17-no-bad-cert-callback': ['grep_forbidden.sh'],
  'c17-db-forensics': ['db_forensics_test.dart'],
  'c17-release-binary-scan': ['scan_apk.sh'],
};

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
  let cur = null;
  for (const l of lines.slice(start + 1)) {
    if (/^\S/.test(l) && !/^#/.test(l)) break; // next top-level key
    const m = /^  (?:"([\w-]+)"|'([\w-]+)'|([\w-]+)):\s*(#.*)?$/.exec(l);
    if (m) { cur = m[1] ?? m[2] ?? m[3]; jobs[cur] = []; continue; }
    if (cur) jobs[cur].push(l);
  }
  return Object.fromEntries(Object.entries(jobs).map(([k, v]) => [k, v.join('\n')]));
}
const wfFiles = () => (existsSync(P('.github/workflows')) ? readdirSync(P('.github/workflows')).filter((f) => /\.ya?ml$/.test(f)) : []);
const allJobIds = () => wfFiles().flatMap((f) => Object.keys(jobsOf(read(`.github/workflows/${f}`))));
function globRe(g) {
  let re = '', i = 0;
  while (i < g.length) {
    const c = g[i];
    if (g.startsWith('**/', i)) { re += '(?:.*/)?'; i += 3; }
    else if (g.startsWith('**', i)) { re += '.*'; i += 2; }
    else if (c === '*') { re += '[^/]*'; i++; }
    else if (c === '{') { const j = g.indexOf('}', i); re += '(?:' + g.slice(i + 1, j).split(',').map((s) => s.replace(/[.+^$()|[\]\\]/g, '\\$&')).join('|') + ')'; i = j + 1; }
    else { re += c.replace(/[.+^$()|[\]\\?]/g, '\\$&'); i++; }
  }
  return new RegExp('^' + re + '$');
}
function expectedPlan(files) {
  const out = new Set(ALWAYS);
  for (const [job, globs] of Object.entries(TRIGGERS)) {
    if (files.some((f) => globs.some((g) => globRe(g).test(f)))) out.add(job);
  }
  return [...out].sort();
}
let n = 0;
function node(script, args) {
  assert.ok(existsSync(P(script)), `${script} must exist`);
  const r = spawnSync(process.execPath, [P(script), ...args], { cwd: root, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}`, stdout: r.stdout };
}
function plan(files, extra = []) {
  const f = join(tmp, `files-${n++}.txt`);
  writeFileSync(f, files.join('\n') + '\n');
  return node('tools/lint/ci-plan.ts', ['--files', f, ...extra]);
}
const has = (block, s) => block.toLowerCase().includes(s.toLowerCase());

// ---------- pr.yml: structure and every job ----------
test('pr.yml triggers on pull_request to main only (15.1)', () => {
  const t = read('.github/workflows/pr.yml');
  const on = /^on:\s*\n((?:[ \t]+.*\n|\n)*)/m.exec(t);
  assert.ok(on, 'pr.yml needs a top-level `on:` block');
  assert.match(on[1], /pull_request:/);
  assert.match(on[1], /main/);
  assert.doesNotMatch(on[1], /\bpush:|schedule:/, 'pr.yml must not run on push/schedule');
});

test('pr.yml has every base job of TRD 15.1 and every P-14 chunk-supplied job', () => {
  const jobs = Object.keys(jobsOf(read('.github/workflows/pr.yml')));
  for (const id of [...BASE_JOBS, ...CHUNK_JOBS]) assert.ok(jobs.includes(id), `pr.yml missing job ${id}`);
});

test('release-only chunk jobs exist in some workflow (c7-go-release-tag-check, c17-release-binary-scan)', () => {
  const ids = allJobIds();
  for (const id of RELEASE_ONLY_JOBS) assert.ok(ids.includes(id), `no workflow defines job ${id}`);
});

for (const [id, subs] of Object.entries(CMDS)) {
  test(`job ${id} runs its spec command(s)`, () => {
    const jobs = {};
    for (const f of wfFiles()) Object.assign(jobs, jobsOf(read(`.github/workflows/${f}`)));
    assert.ok(jobs[id], `job ${id} not found in any workflow`);
    for (const s of subs) assert.ok(has(jobs[id], s), `job ${id} must contain "${s}"`);
  });
}

test('runner OS: c7-go-windows runs on Windows, every other pr.yml job on Linux (CR-C7-013)', () => {
  const jobs = jobsOf(read('.github/workflows/pr.yml'));
  const runs = (b) => (/^\s+runs-on:\s*(.+)$/m.exec(b) ?? [])[1] ?? '';
  assert.match(runs(jobs['c7-go-windows'] ?? ''), /windows/i, 'c7-go-windows needs a windows runner');
  for (const [id, b] of Object.entries(jobs)) {
    if (id === 'c7-go-windows') continue;
    assert.match(runs(b), /ubuntu/i, `${id} must run on ubuntu`);
  }
});

test('gates cannot be bypassed inside pr.yml (no continue-on-error / `|| true`)', () => {
  const t = read('.github/workflows/pr.yml');
  assert.doesNotMatch(t, /continue-on-error:\s*true/);
  assert.doesNotMatch(t, /\|\|\s*true\b/);
  assert.doesNotMatch(t, /\|\|\s*exit 0\b/);
});

// ---------- pr.yml: security (CI / supply chain row, REQ-SEC-128/129) ----------
test('SEC: workflows never use pull_request_target or workflow_run on untrusted code', () => {
  assert.ok(wfFiles().includes('pr.yml') && wfFiles().includes('nightly.yml'), 'pr.yml and nightly.yml must exist');
  for (const f of wfFiles()) assert.doesNotMatch(read(`.github/workflows/${f}`), /pull_request_target/, f);
});

test('SEC: pr.yml token is read-only', () => {
  const t = read('.github/workflows/pr.yml');
  assert.match(t, /^permissions:\s*\n\s+contents:\s*read\s*$/m, 'top-level permissions: contents: read');
  assert.doesNotMatch(t, /write-all|:\s*write\b/, 'no write permission in pr.yml');
});

test('SEC: untrusted PR fields reach scripts only via env, never interpolated into run:', () => {
  const t = read('.github/workflows/pr.yml');
  const bad = /\$\{\{\s*github\.(head_ref|event\.pull_request\.(title|body|head\.ref|head\.label)|event\.head_commit\.message)/;
  for (const line of t.split('\n')) {
    if (bad.test(line)) assert.match(line, /^\s+[A-Za-z_][A-Za-z0-9_]*:\s*\$\{\{/, `untrusted expression outside an env assignment: ${line.trim()}`);
  }
  const paths = jobsOf(t).paths ?? '';
  assert.match(paths, /HEAD_REF:\s*\$\{\{\s*github\.head_ref\s*\}\}/, 'paths job passes the branch as env HEAD_REF');
  assert.match(paths, /"\$HEAD_REF"|\$HEAD_REF/, 'paths job reads $HEAD_REF');
});

test('SEC: actions are pinned (no @main/@master/@latest, no unversioned uses:)', () => {
  assert.ok(wfFiles().includes('pr.yml') && wfFiles().includes('nightly.yml'), 'pr.yml and nightly.yml must exist');
  for (const f of wfFiles()) {
    for (const m of read(`.github/workflows/${f}`).matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)) {
      const ref = m[1];
      if (ref.startsWith('./')) continue;
      assert.match(ref, /@[^\s@]+$/, `${f}: unpinned action ${ref}`);
      assert.doesNotMatch(ref, /@(main|master|latest|HEAD)$/i, `${f}: floating action ref ${ref}`);
    }
  }
});

test('SEC: pr.yml uses no repository secrets (fork PRs, REQ-SEC-128)', () => {
  const t = read('.github/workflows/pr.yml');
  const bad = [...t.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((m) => m[1]).filter((s) => s !== 'GITHUB_TOKEN');
  assert.deepEqual(bad, []);
});

// ---------- nightly.yml (15.2, gate 16) ----------
test('nightly.yml: schedule + manual only, never on pull_request', () => {
  const t = read('.github/workflows/nightly.yml');
  assert.match(t, /schedule:\s*\n\s*-\s*cron:/);
  assert.match(t, /workflow_dispatch:/);
  assert.doesNotMatch(t, /pull_request/);
});

test('nightly.yml runs the 15.2 sequence', () => {
  const t = read('.github/workflows/nightly.yml').toLowerCase();
  for (const s of ['dev:up --ci', 'migrat', 'seed', 'test:smoke', 'e2e', 'isolation', '10x', 'load'])
    assert.ok(t.includes(s), `nightly.yml must mention "${s}"`);
  const order = ['dev:up --ci', 'test:smoke', 'isolation'].map((s) => t.indexOf(s));
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'dev:up, then smoke, then isolation');
});

test('nightly.yml opens an issue labelled `nightly` on failure and has least-privilege perms', () => {
  const t = read('.github/workflows/nightly.yml');
  assert.match(t, /if:\s*(?:\$\{\{\s*)?failure\(\)/, 'failure() step');
  assert.match(t, /nightly/);
  assert.match(t, /(gh issue create|create-issue)[\s\S]*nightly|nightly[\s\S]*(gh issue create|create-issue)/i);
  assert.match(t, /issues:\s*write/);
  assert.doesNotMatch(t, /write-all|contents:\s*write/);
});

// ---------- 15.3 branch protection ----------
test('branch protection: required checks = every pr.yml job; code-owner review; squash only', () => {
  assert.ok(existsSync(P('.github/branch-protection.json')), '.github/branch-protection.json must exist');
  const bp = JSON.parse(read('.github/branch-protection.json'));
  const ids = Object.keys(jobsOf(read('.github/workflows/pr.yml'))).sort();
  assert.deepEqual([...bp.required_status_checks.contexts].sort(), ids);
  assert.equal(bp.required_pull_request_reviews.require_code_owner_reviews, true);
  assert.equal(bp.repository.allow_squash_merge, true);
  assert.equal(bp.repository.allow_merge_commit, false);
  assert.equal(bp.repository.allow_rebase_merge, false);
});

// ---------- dry-run on fixture PRs ----------
const FIXTURE_PRS = {
  'docs only': ['README.md'],
  'no files': [],
  'openapi spec': ['contracts/openapi/core.yaml'],
  'migration': ['db/migrations/0001_init.sql'],
  'core service': ['services/api/src/core/boot.ts'],
  'shared-ts': ['packages/shared-ts/src/bsdate.ts'],
  'ui package': ['packages/ui/src/button.tsx'],
  'lockfile': ['pnpm-lock.yaml'],
  'dockerfile': ['services/api/Dockerfile'],
  'devstack compose': ['tools/devstack/compose.yaml'],
  'upstream lock': ['infra/compose/supabase/upstream/UPSTREAM.lock'],
  'web app': ['apps/web/src/app/page.tsx'],
  'bridge agent': ['apps/bridge-agent/cmd/agent/main.go'],
  'bridge fixtures': ['apps/bridge-agent/testdata/config/a.json'],
  'phlebo db': ['apps/phlebo_app/lib/core/db/store.dart'],
  'phlebo other': ['apps/phlebo_app/lib/main.dart'],
  'analytics': ['services/api/src/modules/analytics/a.ts'],
  'billing copy': ['apps/web/src/features/billing/a.tsx'],
  'frontdesk docs': ['docs/manual/frontdesk/a.md'],
  'catalog route': ['apps/web/src/app/(staff)/catalog/page.tsx'],
  'identity': ['services/api/src/modules/identity/a.ts'],
  'instrument drivers': ['services/api/src/modules/instruments/drivers/x/testdata/a.json'],
  'multi-file': ['README.md', 'db/migrations/0002.sql', 'apps/web/src/app/page.tsx'],
};
for (const [name, files] of Object.entries(FIXTURE_PRS)) {
  test(`dry-run: fixture PR "${name}" selects exactly the spec'd jobs`, () => {
    const r = plan(files);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(JSON.parse(r.stdout), expectedPlan(files));
  });
}

test('dry-run: a docs-only PR skips every conditional job', () => {
  const r = plan(['README.md']);
  assert.deepEqual(JSON.parse(r.stdout), [...ALWAYS].sort());
});

test('dry-run drift guard: touching every trigger path plans every pr.yml job (except release-only)', () => {
  const touch = ['contracts/openapi/a.yaml', 'db/migrations/a.sql', 'pnpm-lock.yaml', 'services/api/Dockerfile', 'packages/shared-ts/a.ts',
    'packages/ui/a.tsx', 'tools/devstack/compose.yaml', 'apps/web/src/features/billing/a.ts', 'apps/web/src/app/(staff)/catalog/a.tsx',
    'services/api/src/modules/analytics/a.ts', 'services/api/src/modules/identity/a.ts', 'apps/bridge-agent/testdata/config/a.json',
    'apps/phlebo_app/lib/core/db/a.dart', 'services/api/src/modules/instruments/drivers/x/a.ts'];
  const r = plan(touch);
  assert.equal(r.code, 0, r.out);
  const want = Object.keys(jobsOf(read('.github/workflows/pr.yml'))).filter((j) => !RELEASE_ONLY_JOBS.includes(j)).sort();
  assert.deepEqual(JSON.parse(r.stdout), want);
});

test('dry-run fails closed: missing --files, unreadable file, unknown flag', () => {
  assert.notEqual(node('tools/lint/ci-plan.ts', []).code, 0);
  assert.notEqual(node('tools/lint/ci-plan.ts', ['--files', join(tmp, 'nope.txt')]).code, 0);
  const f = join(tmp, 'ok.txt');
  writeFileSync(f, 'README.md\n');
  assert.notEqual(node('tools/lint/ci-plan.ts', ['--files', f, '--bogus']).code, 0);
});

test('SEC dry-run: path tricks do not hide a gated path (../ and ./ prefixes)', () => {
  const r = plan(['./db/migrations/a.sql', 'services/../db/migrations/b.sql']);
  assert.equal(r.code, 0, r.out);
  assert.ok(JSON.parse(r.stdout).includes('migrations'), 'db/ change via ./ or .. must still trigger migrations');
});

// ---------- supabase-pin (D-208) ----------
const D1 = 'a'.repeat(64), D2 = 'b'.repeat(64), D3 = 'c'.repeat(64);
function pin(composeText, lockText) {
  const c = join(tmp, `compose-${n}.yaml`), l = join(tmp, `lock-${n++}`);
  if (composeText !== null) writeFileSync(c, composeText);
  if (lockText !== null) writeFileSync(l, lockText);
  return node('tools/lint/check-supabase-pin.ts', ['--compose', c, '--lock', l]);
}
const compose = (...imgs) => 'services:\n' + imgs.map((i, k) => `  s${k}:\n    image: ${i}\n`).join('');
const lock = (...imgs) => '# synthetic lock\n' + imgs.map((i) => `${i}\n`).join('');

test('supabase-pin: equal digests pass', () => {
  const r = pin(compose(`supabase/postgres@sha256:${D1}`, `supabase/gotrue@sha256:${D2}`), lock(`supabase/postgres@sha256:${D1}`, `supabase/gotrue@sha256:${D2}`));
  assert.equal(r.code, 0, r.out);
});
test('supabase-pin: differing digest fails and names the image', () => {
  const r = pin(compose(`supabase/postgres@sha256:${D1}`), lock(`supabase/postgres@sha256:${D2}`));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /supabase\/postgres/);
});
test('supabase-pin: compose using a tag instead of the pinned digest fails', () => {
  const r = pin(compose('supabase/postgres:17.6.1.136'), lock(`supabase/postgres@sha256:${D1}`));
  assert.equal(r.code, 1, r.out);
});
test('supabase-pin: lock image missing from compose fails', () => {
  const r = pin(compose(`supabase/postgres@sha256:${D1}`), lock(`supabase/postgres@sha256:${D1}`, `supabase/gotrue@sha256:${D3}`));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /supabase\/gotrue/);
});
test('supabase-pin: unrelated compose images are not compared', () => {
  const r = pin(compose(`supabase/postgres@sha256:${D1}`, 'redis:7'), lock(`supabase/postgres@sha256:${D1}`));
  assert.equal(r.code, 0, r.out);
});
test('supabase-pin: a lock with no digests fails closed (never vacuously passes)', () => {
  const r = pin(compose(`supabase/postgres@sha256:${D1}`), lock('# nothing here'));
  assert.notEqual(r.code, 0, r.out);
});
test('supabase-pin: unreadable compose/lock is a usage error, not a pass', () => {
  assert.notEqual(pin(null, lock(`supabase/postgres@sha256:${D1}`)).code, 0);
  assert.notEqual(pin(compose(`supabase/postgres@sha256:${D1}`), null).code, 0);
});
// review round 1, item 4: a canonical `repo:tag@sha256:<d>` ref must match the same lock line (tag stripped on both sides).
test('supabase-pin: tagged+digest ref in compose equals identical tagged+digest lock line', () => {
  const ref = `supabase/postgres:17.6.1.136@sha256:${D1}`;
  const r = pin(compose(ref), lock(ref));
  assert.equal(r.code, 0, r.out);
});
test('supabase-pin: tagged+digest lock line vs compose with another digest still fails', () => {
  const r = pin(compose(`supabase/postgres:17.6.1.136@sha256:${D2}`), lock(`supabase/postgres:17.6.1.136@sha256:${D1}`));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /supabase\/postgres/);
});
test('supabase-pin: lock with the same repo as tagged and untagged refs and different digests fails closed', () => {
  const r = pin(compose(`supabase/postgres@sha256:${D1}`), lock(`supabase/postgres:17.6.1.136@sha256:${D1}`, `supabase/postgres@sha256:${D2}`));
  assert.notEqual(r.code, 0, r.out);
});

// ---------- review round 1: gate completeness (02-TRD 15.1, CV 12 rows 6, 9, 12, 13; C17 02-TRD row) ----------
const prJobs = () => jobsOf(read('.github/workflows/pr.yml'));

test('oasdiff (gate 6): deleted and renamed spec files are diffed too, not only modified (--diff-filter=MDR)', () => {
  const b = prJobs().oasdiff ?? '';
  assert.match(b, /--diff-filter=MDR/, 'oasdiff must list M, D and R spec files');
  assert.doesNotMatch(b, /--diff-filter=M\b(?!D)/, 'M-only filter lets a deleted openapi file pass without cr-approved-breaking');
});

test('migrations (gate 9): upgrade apply, policy diff vs db/policies, and PR-body checklist check are present', () => {
  const b = prJobs().migrations ?? '';
  assert.ok(has(b, 'db/policies'), 'migrations must diff policies against db/policies');
  assert.match(b, /upgrade/i, 'migrations must apply the upgrade on the previous release');
  assert.match(b, /PR_BODY:\s*\$\{\{\s*github\.event\.pull_request\.body\s*\}\}/, 'checklist check reads the PR body through env');
  assert.match(b, /checklist/i, 'migrations must check the manual checklist is in the PR body (B10)');
});

test('deps (gates 12/13): licence allowlist, banned-dependency list and audit triage file are checked by a tools/lint script', () => {
  const b = prJobs().deps ?? '';
  assert.match(b, /tools\/lint\/[\w./-]+/, 'deps must call a tools/lint script for the lockfile checks');
  assert.ok(has(b, 'licen'), 'deps must check the licence allowlist (CV 15.2)');
  assert.ok(has(b, 'banned'), 'deps must check the banned list (CV 15.3)');
  assert.ok(has(b, 'triage'), 'deps must check the pnpm audit triage file (15.1)');
  assert.doesNotMatch(b.replace(/name:.*/g, ''), /pnpm audit --audit-level critical\s*$/m, 'bare pnpm audit is not the triage check');
});

test('c17-db-forensics: an Android emulator is booted before the integration test (C17 02-TRD row)', () => {
  const b = prJobs()['c17-db-forensics'] ?? '';
  const noNames = b.replace(/^\s*(-\s*)?name:.*$/gm, '');
  assert.match(noNames, /android-emulator-runner|avdmanager|emulator\s+-avd/i, 'job needs an emulator step, not only a name mentioning it');
  assert.ok(noNames.search(/android-emulator-runner|avdmanager|emulator\s+-avd/i) <= noNames.search(/flutter test/i), 'emulator must start before flutter test (runner action wraps it)');
});

test('supabase-pin: repo devstack compose (when present) matches the C1 lock (when present)', (t) => {
  if (!existsSync(P('tools/devstack/compose.yaml')) || !existsSync(P('infra/compose/supabase/upstream/UPSTREAM.lock'))) return t.skip('devstack/UPSTREAM.lock land with T0B/C1');
  const r = node('tools/lint/check-supabase-pin.ts', ['--compose', P('tools/devstack/compose.yaml'), '--lock', P('infra/compose/supabase/upstream/UPSTREAM.lock')]);
  assert.equal(r.code, 0, r.out);
});
