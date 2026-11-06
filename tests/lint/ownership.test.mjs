// T0-02: tools/lint/ownership.yaml — every CM §3 / 02-TRD §1.1 path maps to exactly one owner.
// Run: node --test tests/lint/ownership.test.mjs
// File format the implementation must follow (no YAML lib in repo, so this test parses a small subset):
//   rules:
//     - pattern: "services/api/src/modules/billing/**"   # glob, repo-relative, leading "/" optional
//       owner: C4                                        # C<n> | C0-0A..C0-0D | DOC-OWNER
// Glob: `**` any depth, `*` within one segment, `{a,b}` alternation, `<m>` one segment, trailing "/" = "/**".
// Resolution: most specific matching rule wins (longest literal prefix, then longest pattern);
// two matching rules of equal specificity with different owners = ambiguous = failure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const file = fileURLToPath(new URL('../../tools/lint/ownership.yaml', import.meta.url));

function load() {
  assert.ok(existsSync(file), 'tools/lint/ownership.yaml must exist');
  const rules = [];
  let cur = null;
  const unq = (s) => s.replace(/\s+#.*$/, '').trim().replace(/^(["'])(.*)\1$/, '$2');
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    let line = raw;
    if (/^\s*#/.test(line) || !line.trim()) continue;
    if (/^\s*-\s/.test(line)) {
      cur = {};
      rules.push(cur);
      line = line.replace(/^(\s*)-\s/, '$1  ');
    }
    const m = line.match(/^\s*(pattern|owner)\s*:\s*(.+)$/);
    if (m && cur) cur[m[1]] = unq(m[2]);
  }
  return rules;
}

function toRegex(pat) {
  let p = pat.replace(/^\//, '');
  if (p.endsWith('/')) p += '**';
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*' && p[i + 1] === '*') {
      if (p[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '{') { re += '(?:'; }
    else if (c === '}') re += ')';
    else if (c === ',' && /\{[^}]*$/.test(p.slice(0, i))) re += '|';
    else if (c === '<') { const j = p.indexOf('>', i); re += '[^/]+'; i = j < 0 ? p.length : j; }
    else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}
const specificity = (pat) => {
  const p = pat.replace(/^\//, '');
  const k = p.search(/[*?{<]/);
  return [k < 0 ? p.length + 1000 : k, p.length];
};

// Returns { owner } or { none } or { ambiguous: [...] }.
function resolve(rules, path) {
  const hits = rules.filter((r) => toRegex(r.pattern).test(path));
  if (!hits.length) return { none: true };
  const key = (r) => specificity(r.pattern);
  const best = hits.reduce((a, r) => {
    const [x, y] = key(r), [bx, by] = key(a[0]);
    return x > bx || (x === bx && y > by) ? [r] : x === bx && y === by ? [...a, r] : a;
  }, [hits[0]]);
  const owners = [...new Set(best.map((r) => r.owner))];
  return owners.length === 1 ? { owner: owners[0] } : { ambiguous: best };
}
const ownerOf = (rules, path) => {
  const r = resolve(rules, path);
  assert.ok(!r.none, `GAP: no owner for ${path}`);
  assert.ok(!r.ambiguous, `OVERLAP: ${path} claimed by ${r.ambiguous?.map((x) => `${x.owner}:${x.pattern}`).join(', ')}`);
  return r.owner;
};

// Module -> owner (CM §3 module table). web/feature-only modules (admin, platform) included.
const MODULES = {
  identity: 'C2', admin: 'C2', platform: 'C2', catalog: 'C3', frontdesk: 'C4', billing: 'C4', lab: 'C5',
  reporting: 'C6', instruments: 'C7', analytics: 'C8', quality: 'C9', micro: 'C10', anatomic: 'C11',
  inventory: 'C12', partners: 'C13', smartreport: 'C14', payments: 'C15', engagement: 'C16', homecollection: 'C17',
};
// Per-module path templates: [prefix, suffix, modules that have no such path].
const apiMod = Object.entries(MODULES).filter(([m]) => !['admin', 'platform'].includes(m))
  .map(([m, o]) => [`services/api/src/modules/${m}/index.ts`, o]);
const workerMod = Object.entries(MODULES).filter(([m]) => !['admin', 'platform'].includes(m))
  .map(([m, o]) => [`services/worker/src/jobs/${m}/job.ts`, o]);
const webStaff = Object.entries(MODULES).filter(([m]) => m !== 'platform')
  .map(([m, o]) => [`apps/web/src/app/(staff)/${m}/page.tsx`, o]);
const webFeat = Object.entries(MODULES).map(([m, o]) => [`apps/web/src/features/${m}/x.ts`, o]);
const webE2e = Object.entries(MODULES).map(([m, o]) => [`apps/web/tests/e2e/${m}/x.spec.ts`, o]);
const manual = Object.entries(MODULES).map(([m, o]) => [`docs/manual/${m}/index.md`, o]);

const same = (owner, paths) => paths.map((p) => [p, owner]);
const REFERENCE = [
  // 0A (TRD §1.1)
  ...same('C0-0A', [
    '.github/CODEOWNERS', '.github/workflows/pr.yml', '.github/workflows/deploy-staging.yml', '.github/PULL_REQUEST_TEMPLATE.md',
    'package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'tsconfig.base.json', 'turbo.json', '.eslintrc.cjs',
    'eslint.config.js', '.prettierrc', '.nvmrc', '.gitignore', '.gitleaks.toml', 'pubspec.yaml', 'analysis_options.yaml',
    'packages/shared-ts/src/uuidv7/index.ts', 'packages/shared-ts/package.json', 'packages/shared-dart/lib/src/bsdate/x.dart',
    'packages/test-fixtures/a/b.json', 'tools/devstack/up.sh', 'tools/lint/ownership.yaml', 'tools/lint/check-paths.ts',
  ]),
  // 0B
  ...same('C0-0B', [
    'db/bootstrap/00.sql', 'db/migrations/0001_init.sql', 'db/policies/core.sql', 'db/seeds/dev.sql', 'db/tests/rls.sql',
    'db/meta/tables.yaml', 'db/meta/index-exceptions.yaml', 'db/meta/definer-inventory.yaml', 'db/tools/gen.ts',
  ]),
  // 0C
  ...same('C0-0C', [
    'contracts/openapi/lab.yaml', 'contracts/openapi/_common.yaml', 'contracts/events/order.created.schema.json',
    'contracts/ports/RenderPort.ts', 'contracts/ports/BillingCommandPort.ts', 'contracts/render/report.schema.json',
    'contracts/errors.yaml', 'contracts/routes.yaml', 'contracts/permissions.yaml', 'tools/codegen/gen.ts',
    'packages/api-client-ts/src/index.ts', 'packages/api-client-dart/lib/x.dart', 'packages/fakes/src/stubs/x.ts',
    'packages/fakes/contract-tests/x.ts',
  ]),
  // 0D
  ...same('C0-0D', [
    'services/api/src/core/module.ts', 'services/api/src/core/ports/phase-stubs.ts', 'services/api/src/core/storage/s3.ts',
    'services/api/src/main.ts', 'services/api/package.json', 'services/api/tsconfig.json', 'services/api/Dockerfile',
    'services/worker/src/core/boot.ts', 'services/worker/src/main.ts', 'services/worker/package.json',
    'services/worker/tsconfig.json', 'services/worker/Dockerfile',
    'apps/web/src/core/shell/x.tsx', 'apps/web/src/middleware.ts', 'apps/web/src/app/layout.tsx',
    'apps/web/src/app/(staff)/layout.tsx', 'apps/web/package.json', 'apps/web/tsconfig.json', 'apps/web/next.config.mjs',
    'apps/web/next.config.js', 'apps/web/Dockerfile', 'packages/ui/src/Button.tsx', 'packages/ui-flutter/lib/x.dart',
  ]),
  // Not C0 (TRD §1.2 / CM §3)
  ...same('C2', ['apps/web/src/app/(auth)/layout.tsx', 'apps/web/src/app/(auth)/login/page.tsx',
    'apps/web/src/app/(platform)/layout.tsx', 'apps/web/src/app/(platform)/tenants/page.tsx']),
  ...same('C16', ['apps/web/src/app/(display)/layout.tsx', 'apps/web/src/app/(display)/queue-display/page.tsx']),
  ...same('C1', ['infra/edge/public-routes.yaml', 'infra/edge/egress-allowlist.yaml', 'infra/THIRD-PARTY-OPS.md', 'infra/providers/x/y.tf']),
  ...same('C6', ['services/renderer/src/main.ts', 'services/renderer/templates/reports/a.html', 'apps/portal/app/page.tsx']),
  ...same('C14', ['services/renderer/templates/smart/a.html']),
  ...same('C4', ['services/renderer/templates/billing/a.html']),
  ...same('C8', ['services/renderer/templates/analytics/a.html']),
  ...same('C13', ['apps/partner/src/x.ts']),
  ...same('C16', ['apps/patient_app/lib/main.dart']),
  ...same('C17', ['apps/phlebo_app/lib/main.dart']),
  ...same('C7', ['apps/bridge-agent/main.go']),
  ...same('C18', ['tools/migration/run.ts']),
  ...apiMod, ...workerMod, ...webStaff, ...webFeat, ...webE2e, ...manual,
];

test('file parses into rules with pattern + owner', () => {
  const rules = load();
  assert.ok(rules.length >= 20, `expected many rules, got ${rules.length}`);
  for (const r of rules) {
    assert.ok(r.pattern && r.owner, `rule needs pattern and owner: ${JSON.stringify(r)}`);
    assert.match(r.owner, /^(C\d{1,2}|C0-0[A-D]|DOC-OWNER)$/, `bad owner token ${r.owner}`);
  }
});

test('no duplicate patterns (same pattern twice = overlap)', () => {
  const seen = new Map();
  for (const r of load()) {
    const k = r.pattern.replace(/^\//, '');
    assert.ok(!seen.has(k), `duplicate pattern ${k} (${seen.get(k)} and ${r.owner})`);
    seen.set(k, r.owner);
  }
});

test('no catch-all rule that would mask gaps', () => {
  for (const r of load()) {
    assert.doesNotMatch(r.pattern.replace(/^\//, ''), /^(\*\*?|\*\*\/\*|\*\*\/\*\*)$/, `catch-all pattern ${r.pattern}`);
  }
});

test('no gaps and no overlaps: every reference path has exactly one owner', () => {
  const rules = load();
  const problems = [];
  for (const [p] of REFERENCE) {
    const r = resolve(rules, p);
    if (r.none) problems.push(`GAP ${p}`);
    else if (r.ambiguous) problems.push(`OVERLAP ${p}: ${r.ambiguous.map((x) => `${x.owner}:${x.pattern}`).join(' | ')}`);
  }
  assert.deepEqual(problems, []);
});

test('every reference path maps to the owner named in CM §3 / TRD §1.1', () => {
  const rules = load();
  const wrong = [];
  for (const [p, want] of REFERENCE) {
    const r = resolve(rules, p);
    if (r.owner && r.owner !== want) wrong.push(`${p}: got ${r.owner}, want ${want}`);
  }
  assert.deepEqual(wrong, []);
});

test('docs/program and docs/chunks share one doc owner, distinct from any build chunk', () => {
  const rules = load();
  const a = ownerOf(rules, 'docs/program/00-README.md');
  const b = ownerOf(rules, 'docs/chunks/C5-lab-workflow/01-PRD.md');
  assert.equal(a, b);
  assert.ok(!/^C\d/.test(a), `doc owner must not be a build chunk, got ${a}`);
});

// AC-0A-1.1 / 1.2: gate 1 decision from the ownership data only.
const branchOwner = (b) => {
  const m = b.match(/^c(\d{2})(?:-0([a-d]))?\//i);
  assert.ok(m, `bad branch ${b}`);
  return m[2] ? `C0-0${m[2].toUpperCase()}` : `C${Number(m[1])}`;
};
const gate1 = (rules, branch, paths) =>
  paths.map((p) => ({ p, owner: ownerOf(rules, p) })).filter((x) => x.owner !== branchOwner(branch));

test('AC-0A-1.1: c05/x touching billing is rejected and the owner named is C4', () => {
  const bad = gate1(load(), 'c05/x', ['services/api/src/modules/billing/index.ts']);
  assert.deepEqual(bad, [{ p: 'services/api/src/modules/billing/index.ts', owner: 'C4' }]);
});

test('AC-0A-1.2: c05/x touching only modules/lab/** passes', () => {
  const bad = gate1(load(), 'c05/x', ['services/api/src/modules/lab/a.ts', 'services/api/src/modules/lab/deep/b.ts']);
  assert.deepEqual(bad, []);
});

test('security: feature chunk cannot own C0 zones (db, contracts, core, packages, .github)', () => {
  const rules = load();
  for (const p of ['db/migrations/x.sql', 'contracts/errors.yaml', 'services/api/src/core/x.ts',
    'packages/shared-ts/src/x.ts', '.github/workflows/pr.yml', 'tools/lint/check-paths.ts']) {
    assert.match(ownerOf(rules, p), /^C0-0[A-D]$/, `${p} must be C0-owned`);
  }
});

test('matcher self-check (guards against a broken test glob)', () => {
  assert.ok(toRegex('a/**').test('a/b/c'));
  assert.ok(toRegex('a/**/c').test('a/c'));
  assert.ok(!toRegex('a/*').test('a/b/c'));
  assert.ok(toRegex('x/{p,q}.json').test('x/q.json'));
  assert.ok(toRegex('x/next.config.*').test('x/next.config.mjs'));
  assert.ok(toRegex('m/<m>/i.ts').test('m/lab/i.ts'));
  assert.ok(!toRegex('m/<m>/i.ts').test('m/lab/z/i.ts'));
  assert.ok(toRegex('apps/web/src/app/(auth)/**').test('apps/web/src/app/(auth)/l/p.tsx'));
});
