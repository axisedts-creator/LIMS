// T0A-10 review r2 item 1: fixture-root tests for tools/lint/check-deps.ts (CI `deps` job, 02-TRD §15.1 gates 12/13).
// Each test builds a temp root and runs `node tools/lint/check-deps.ts --triage … [--audit …] --root <tmp>`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'check-deps.ts');
const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

function put(root, rel, content) {
  const f = join(root, rel);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, typeof content === 'string' ? content : JSON.stringify(content));
}

// opts: pkgs [{name, version?, license}], manifests {relPath: pkgJson}, pubspec string, triage obj, audit obj|undefined, noPnpm, args
function run(opts = {}) {
  const root = mkdtempSync(join(tmpdir(), 'check-deps-'));
  try {
    if (!opts.noPnpm) {
      for (const p of opts.pkgs ?? [{ name: 'left-pad', license: 'MIT' }]) {
        const dirName = `${p.name.replace('/', '+')}@${p.version ?? '1.0.0'}`;
        put(root, `node_modules/.pnpm/${dirName}/node_modules/${p.name}/package.json`, { name: p.name, version: p.version ?? '1.0.0', license: p.license });
      }
    }
    put(root, 'package.json', { name: 'root', private: true });
    for (const [rel, j] of Object.entries(opts.manifests ?? {})) put(root, rel, j);
    if (opts.pubspec) put(root, 'pubspec.lock', opts.pubspec);
    put(root, '.tmp/triage.json', opts.triage ?? { advisories: [], licenceReviews: [] });
    const args = ['--triage', join(root, '.tmp/triage.json'), '--root', root];
    if (opts.audit !== undefined) { put(root, '.tmp/audit.json', opts.audit); args.push('--audit', join(root, '.tmp/audit.json')); }
    const r = spawnSync(process.execPath, [SCRIPT, ...(opts.args ?? args)], { encoding: 'utf8' });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const crit = (id, extra = {}) => ({ advisories: { [id]: { id: Number(id), severity: 'critical', module_name: 'evil', ...extra } } });
const triaged = (id, until) => ({ advisories: [{ id: String(id), reason: 'no reachable path', until }], licenceReviews: [] });

// (a) allowed
test('(a) allowed licence + clean audit: exit 0', () => {
  const r = run({ audit: { advisories: {} } });
  assert.equal(r.status, 0, r.out);
});
test('(a) SPDX "(MIT OR GPL-3.0)": exit 0', () => {
  const r = run({ pkgs: [{ name: 'dual', license: '(MIT OR GPL-3.0)' }] });
  assert.equal(r.status, 0, r.out);
});

// (b) licences needing review
test('(b) GPL-3.0 without licenceReviews: exit 1', () => {
  const r = run({ pkgs: [{ name: 'gplpkg', license: 'GPL-3.0' }] });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /gplpkg/);
});
test('(b) MPL-2.0 without licenceReviews: exit 1', () => {
  const r = run({ pkgs: [{ name: 'mplpkg', license: 'MPL-2.0' }] });
  assert.equal(r.status, 1, r.out);
});
test('(b) MPL-2.0 with {name, approval}: exit 0', () => {
  const r = run({
    pkgs: [{ name: 'mplpkg', license: 'MPL-2.0' }],
    triage: { advisories: [], licenceReviews: [{ name: 'mplpkg', licence: 'MPL-2.0', approval: 'C0+founder 2026-11-07' }] },
  });
  assert.equal(r.status, 0, r.out);
});
test('(b) licenceReviews entry without approval does not clear it: exit 1', () => {
  const r = run({
    pkgs: [{ name: 'mplpkg', license: 'MPL-2.0' }],
    triage: { advisories: [], licenceReviews: [{ name: 'mplpkg', licence: 'MPL-2.0' }] },
  });
  assert.equal(r.status, 1, r.out);
});

// (c) banned packages installed
for (const name of ['pdf-lib', 'bullmq', '@powersync/x']) {
  test(`(c) installed ${name}: exit 1`, () => {
    const r = run({ pkgs: [{ name, license: 'MIT' }] });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /banned/);
  });
}
test('(c) pubspec.lock sqlcipher_flutter_libs: exit 1', () => {
  const r = run({ pubspec: 'packages:\n  sqlcipher_flutter_libs:\n    dependency: transitive\n    version: "0.6.0"\n' });
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /sqlcipher_flutter_libs/);
});

// (d) bikram-sambat only as test oracle
test('(d) bikram-sambat in dependencies: exit 1', () => {
  const r = run({ manifests: { 'packages/x/package.json': { name: 'x', dependencies: { 'bikram-sambat': '1.0.0' } } } });
  assert.equal(r.status, 1, r.out);
});
test('(d) bikram-sambat in devDependencies: exit 0', () => {
  const r = run({ manifests: { 'packages/x/package.json': { name: 'x', devDependencies: { 'bikram-sambat': '1.0.0' } } } });
  assert.equal(r.status, 0, r.out);
});

// (e) supabase-js not in staff web
test('(e) @supabase/supabase-js in apps/web dependencies: exit 1', () => {
  const r = run({ manifests: { 'apps/web/package.json': { name: 'web', dependencies: { '@supabase/supabase-js': '2.0.0' } } } });
  assert.equal(r.status, 1, r.out);
});
test('(e) @supabase/supabase-js in services/api: exit 0', () => {
  const r = run({ manifests: { 'services/api/package.json': { name: 'api', dependencies: { '@supabase/supabase-js': '2.0.0' } } } });
  assert.equal(r.status, 0, r.out);
});

// (f) pnpm audit triage
test('(f) critical advisory untriaged: exit 1', () => {
  const r = run({ audit: crit('1234') });
  assert.equal(r.status, 1, r.out);
});
test('(f) critical advisory triaged with past until: exit 1', () => {
  const r = run({ audit: crit('1234'), triage: triaged('1234', day(-2)) });
  assert.equal(r.status, 1, r.out);
});
test('(f) critical advisory triaged with future until: exit 0', () => {
  const r = run({ audit: crit('1234'), triage: triaged('1234', day(30)) });
  assert.equal(r.status, 0, r.out);
});
test('(f) high-only advisory: exit 0', () => {
  const r = run({ audit: { advisories: { 9: { id: 9, severity: 'high', module_name: 'm' } } } });
  assert.equal(r.status, 0, r.out);
});

// (g) fail closed
test('(g) audit JSON without advisories: exit 2', () => {
  const r = run({ audit: { error: 'audit failed' } });
  assert.equal(r.status, 2, r.out);
});
test('(g) missing node_modules/.pnpm: exit 2', () => {
  const r = run({ noPnpm: true });
  assert.equal(r.status, 2, r.out);
});
test('(g) unknown argument: exit 2', () => {
  const r = run({ args: ['--bogus', 'x'] });
  assert.equal(r.status, 2, r.out);
});
