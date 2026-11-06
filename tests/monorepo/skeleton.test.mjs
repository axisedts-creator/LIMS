// T0A-01 / AC-0A-1.4: monorepo skeleton (02-TRD §1.1). Run: node --test tests/monorepo/skeleton.test.mjs
// Structural checks need no deps. The build smoke needs pnpm on PATH + the package registry (nothing else).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const p = (f) => root + f;
const text = (f) => { assert.ok(existsSync(p(f)), `${f} must exist`); return readFileSync(p(f), 'utf8'); };
const json = (f) => { try { return JSON.parse(text(f)); } catch (e) { assert.fail(`${f} must be valid JSON: ${e.message}`); } };
const EXACT = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

test('root config files exist', () => {
  for (const f of ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'tsconfig.base.json', 'turbo.json',
    '.nvmrc', '.prettierrc', '.gitleaks.toml', '.gitignore', 'pubspec.yaml', 'analysis_options.yaml']) {
    assert.ok(existsSync(p(f)), `${f} must exist`);
  }
  assert.ok(existsSync(p('.eslintrc.cjs')) || existsSync(p('eslint.config.js')), '.eslintrc.cjs or eslint.config.js must exist');
});

test('root package.json: private, pinned pnpm + node, build/typecheck scripts', () => {
  const pkg = json('package.json');
  assert.equal(pkg.private, true, 'root must be private');
  assert.match(pkg.packageManager ?? '', /^pnpm@\d+\.\d+\.\d+(\+sha\d+\.[0-9a-f]+)?$/, 'packageManager must be pnpm@x.y.z exact');
  assert.match(pkg.engines?.node ?? '', EXACT, 'engines.node must be an exact version');
  const nvmrc = text('.nvmrc').trim().replace(/^v/, '');
  assert.equal(nvmrc, pkg.engines.node, '.nvmrc must equal engines.node');
  assert.match(nvmrc, /^26\./, 'Node 26.x per 02-TRD §2.1');
  assert.ok(pkg.scripts?.build, 'scripts.build required (pnpm -w build)');
  assert.match(pkg.scripts.build, /turbo/, 'build runs through turbo');
  assert.ok(pkg.scripts?.typecheck, 'scripts.typecheck required (CI gate, 02-TRD §15)');
  assert.ok(!('workspaces' in pkg), 'pnpm uses pnpm-workspace.yaml, not package.json workspaces');
});

test('pnpm-workspace.yaml lists packages/*', () => {
  assert.match(text('pnpm-workspace.yaml'), /^\s*-\s*['"]?packages\/\*['"]?\s*$/m);
});

test('turbo.json defines build (deps first, outputs declared) and typecheck', () => {
  const tasks = json('turbo.json').tasks ?? {};
  assert.ok(tasks.build, 'tasks.build required');
  assert.ok(tasks.build.dependsOn?.includes('^build'), 'build dependsOn ^build');
  assert.ok(Array.isArray(tasks.build.outputs), 'build outputs declared (cache + no-stray-file check)');
  assert.ok(tasks.typecheck, 'tasks.typecheck required');
});

test('tsconfig.base.json is strict', () => {
  assert.equal((json('tsconfig.base.json').compilerOptions ?? {}).strict, true);
});

test('Dart workspace root + shared-dart package', () => {
  assert.match(text('pubspec.yaml'), /^workspace:/m, 'root pubspec.yaml declares a Dart workspace');
  assert.match(text('pubspec.yaml'), /packages\/shared-dart/);
  assert.match(text('packages/shared-dart/pubspec.yaml'), /^name:\s*lims_shared\s*$/m);
});

for (const [dir, name] of [['shared-ts', '@lims/shared-ts'], ['test-fixtures', '@lims/test-fixtures']]) {
  test(`packages/${dir}/package.json is a valid private workspace package`, () => {
    const pkg = json(`packages/${dir}/package.json`);
    assert.equal(pkg.name, name);
    assert.equal(pkg.private, true, '@lims/* never publishable (dependency-confusion guard, 07 CI/supply chain)');
    assert.match(pkg.version ?? '', EXACT);
    assert.ok(pkg.scripts?.build, 'scripts.build so `pnpm -w build` covers it');
    assert.ok(pkg.scripts?.typecheck, 'scripts.typecheck');
    for (const h of ['preinstall', 'install', 'postinstall', 'prepare']) {
      assert.ok(!pkg.scripts?.[h], `no ${h} lifecycle script (offline/supply-chain)`);
    }
    for (const sect of ['dependencies', 'devDependencies', 'peerDependencies']) {
      for (const [dep, v] of Object.entries(pkg[sect] ?? {})) {
        if (v.startsWith('workspace:')) continue;
        assert.match(v, EXACT, `${dep} in ${sect} must be an exact version (REQ-SEC-129), got ${v}`);
      }
    }
  });
}

test('root dependencies are exact versions', () => {
  const pkg = json('package.json');
  for (const sect of ['dependencies', 'devDependencies']) {
    for (const [dep, v] of Object.entries(pkg[sect] ?? {})) assert.match(v, EXACT, `${dep} must be exact, got ${v}`);
  }
});

test('lockfile is committed and not gitignored', () => {
  assert.match(text('pnpm-lock.yaml'), /^lockfileVersion:/m);
  assert.ok(!/^pnpm-lock\.yaml$/m.test(text('.gitignore')), 'pnpm-lock.yaml must not be ignored');
  const r = spawnSync('git', ['ls-files', '--error-unmatch', 'pnpm-lock.yaml'], { cwd: root });
  assert.equal(r.status, 0, 'pnpm-lock.yaml must be tracked by git (REQ-SEC-129)');
});

// AC-0A-1.4: fresh install + root build succeed; no tracked file changes and no stray untracked file appears.
test('build smoke: pnpm install --frozen-lockfile && pnpm -w build leaves tree clean', { timeout: 600_000 }, () => {
  const sh = process.platform === 'win32';
  const run = (args) => spawnSync('pnpm', args, { cwd: root, shell: sh, encoding: 'utf8', env: { ...process.env, CI: '1' } });
  assert.equal(run(['--version']).status, 0, 'pnpm must be on PATH (corepack enable)');
  const status = () => spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).stdout;
  const before = status();
  for (const args of [['install', '--frozen-lockfile'], ['-w', 'build']]) {
    const r = run(args);
    assert.equal(r.status, 0, `pnpm ${args.join(' ')} failed:\n${(r.stdout + r.stderr).slice(-2000)}`);
  }
  assert.equal(status(), before, 'build must not modify or create non-ignored files (generated files match committed)');
});
