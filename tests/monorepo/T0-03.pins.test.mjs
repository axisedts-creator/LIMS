// T0-03: pin all [PIN-C0] versions; fill the CV §15.1 dependencies table (table path per LD-04; titles saying §2.3 = that table).
// Run: node --test tests/monorepo/T0-03.pins.test.mjs
// Sources: spec/program/02-CONVENTIONS.md §15.1 (exact versions, lockfiles, table columns),
//          §15.2 (licences), §15.3 (banned deps); spec/chunks/C0-foundation-contracts/02-TRD.md §2.1-2.3.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const p = (...s) => join(ROOT, ...s);
const read = (f) => readFileSync(f, 'utf8');
// LD-04 (2026-11-07) T0-03 option B: the CV §15.1 table lives here, not in spec/ (read-only); 02-TRD §2.3 is not edited.
const TRD = p('db', 'meta', 'decisions', 'T0-03-dependencies.md');

// ---------- helpers ----------
const EXACT_NPM = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const EXACT_ANY = /^v?\d+(\.\d+)+([-+][0-9A-Za-z.-]+)?$/; // tools / fonts / SDKs
const RANGE_CHARS = /[\^~><*|]|\bx\b|latest|\|\||\s-\s/i;

const ALLOWED = ['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD', 'Zlib',
  'Unicode-DFS', 'Unicode-3.0', 'OFL-1.1',
  // LD-15 (2026-11-07) T0-03: pgTAP (test-only) and lru-cache (dev-only) are permissive SPDX ids.
  'PostgreSQL', 'BlueOak-1.0.0'];
const REVIEW = ['MPL-2.0', 'EPL-2.0', 'LGPL', 'CC-BY'];
const BANNED_LICENCE = /(?<!L)GPL|AGPL|SSPL|BUSL|\bFSL\b|Commons[ -]Clause|non-?commercial|source-available|UNLICENSED|UNLICENSE[D]?\b|proprietary/i;

// 15.3 banned packages (npm + pub). Scoped @supabase/* is only banned in browser bundles.
const BANNED_PKGS = ['pdf-lib', 'sqlcipher_flutter_libs', 'bikram-sambat', 'bullmq', 'bull',
  'electric-sql', '@electric-sql/client', 'electricsql', 'powersync', '@powersync/web',
  '@powersync/common', 'powersync_core', 'powersync_flutter_libs', 'electricsql_dart',
  '@sentry/node', '@sentry/browser', '@sentry/react', '@sentry/nextjs', 'sentry_flutter',
  'posthog-js', 'posthog-node', 'mixpanel-browser', '@segment/analytics-next',
  'firebase_crashlytics', 'firebase_analytics', 'google_analytics', '@vercel/analytics',
  '@mirthconnect/client'];
const BROWSER_BANNED = ['@supabase/supabase-js', '@supabase/ssr'];
const BROWSER_PKG_DIRS = ['apps/web', 'apps/portal', 'apps/partner', 'packages/ui'];

// 04-pinned (02-TRD §2.1 / CV §2.2) — a row or dependency with this name must carry exactly this version.
const PINNED_04 = {
  'graphile-worker': '0.18.0',
  'fastify-openapi-glue': '4.12.0',
  'openapi-typescript': '7.13.0',
  'openapi-fetch': '0.17.0',
  'msw': '3.0.3',
  '@remotemerge/nepali-date-converter': '1.2.7',
  'nepali_utils': '3.0.8',
  'nepali_date_picker': '8.0.0',
  'drift': '2.35.3',
  'write-excel-file': '4.1.1',
  'read-excel-file': '9.3.14',
  '@cantoo/pdf-lib': '2.11.1',
  '@pdfme/pdf-lib': '6.2.8',
};

// One required row per 02-TRD §2.2 item (+ CV [PIN-C0] items outside that table).
// `re` is matched case-insensitively against the table "Name" cell.
const REQUIRED_ROWS = [
  ['pnpm', /\bpnpm\b/], ['TypeScript', /\btypescript\b/], ['Fastify', /^`?fastify`?(\s|$)/],
  ['Next.js', /\bnext(\.js)?\b/], ['React', /^`?react`?(\s|$)/], ['pg', /^`?pg`?(\s|$)/],
  ['jose', /\bjose\b/], ['ajv', /\bajv\b/], ['pino', /^`?pino`?(\s|$)/], ['prom-client', /prom-client/],
  ['ioredis', /ioredis/], ['Turborepo', /\bturbo(repo)?\b/], ['Vitest', /vitest/],
  ['Playwright', /playwright/], ['axe-core', /axe-core/], ['react-aria-components', /react-aria-components/],
  ['@tanstack/react-table', /@tanstack\/react-table/], ['react-hook-form', /react-hook-form/],
  ['Lucide', /lucide/], ['Noto Sans', /noto sans(?! (devanagari|mono))/],
  ['Noto Sans Devanagari', /noto sans devanagari/], ['Noto Sans Mono', /noto sans mono/],
  ['json-schema-to-typescript', /json-schema-to-typescript/], ['Flutter SDK', /flutter(\s+sdk)?$|^`?flutter`?\b(?!_)/],
  ['Dart SDK', /\bdart(\s+sdk)?\b/], ['flutter_riverpod', /flutter_riverpod/],
  ['mobile_scanner', /mobile_scanner/], ['Atlas or sqitch (SP-5)', /\batlas\b|sqitch/],
  ['pgTAP', /pgtap/], ['gitleaks', /gitleaks/], ['osv-scanner', /osv-scanner/], ['trivy', /trivy/],
  ['Mailpit', /mailpit/], ['write-excel-file', /write-excel-file/], ['read-excel-file', /read-excel-file/],
  ['flutter_secure_storage', /flutter_secure_storage/], ['staticcheck', /staticcheck/],
  ['k6-class load tool', /\bk6\b|load tool/], ['decimal library', /decimal|big\.js|bignumber/],
  ['HTML sanitiser', /sanitis|sanitiz|dompurify/], ['SMTP client', /smtp|nodemailer/],
];

function section(md, startRe, endRe) {
  const s = md.search(startRe);
  assert.ok(s >= 0, `section not found: ${startRe}`);
  const rest = md.slice(s + 1);
  const e = rest.search(endRe);
  return md.slice(s, e < 0 ? undefined : s + 1 + e);
}

function loadTable() {
  assert.ok(existsSync(TRD), 'db/meta/decisions/T0-03-dependencies.md must exist (LD-04)');
  const sec = read(TRD); // whole file: the table is the only table in it
  const lines = sec.split(/\r?\n/).filter((l) => l.trim().startsWith('|'));
  assert.ok(lines.length >= 3, 'dependencies file must contain a markdown table (header, separator, rows)');
  const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  const header = cells(lines[0]).map((h) => h.toLowerCase());
  const rows = lines.slice(2).map(cells);
  return { header, rows, sec };
}

const clean = (s) => s.replace(/`/g, '').replace(/\*\*/g, '').trim();

function walk(dir, pred, out = []) {
  if (!existsSync(dir)) return out;
  for (const n of readdirSync(dir)) {
    if (n === 'node_modules' || n === '.git' || n === 'dist' || n === 'build' || n === '.dart_tool') continue;
    const f = join(dir, n);
    const st = statSync(f);
    if (st.isDirectory()) walk(f, pred, out);
    else if (pred(n, f)) out.push(f);
  }
  return out;
}

const workspacePkgJsons = () =>
  [p('package.json'), ...walk(ROOT, (n) => n === 'package.json').filter((f) => f !== p('package.json'))
    .filter((f) => !/[\\/](spec|\.orchestra|supabase|tests)[\\/]/.test(f.slice(ROOT.length)))];

const depGroups = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
function allNpmDeps() {
  const out = [];
  for (const f of workspacePkgJsons()) {
    const j = JSON.parse(read(f));
    for (const g of depGroups) for (const [name, ver] of Object.entries(j[g] ?? {})) out.push({ f, g, name, ver });
  }
  return out;
}

function pubspecDeps(f) {
  // tiny parser: top-level sections dependencies/dev_dependencies/dependency_overrides, "name: value" at indent 2
  const out = [];
  let sect = null;
  for (const raw of read(f).split(/\r?\n/)) {
    if (/^\s*#/.test(raw) || !raw.trim()) continue;
    const top = raw.match(/^([a-z_]+):\s*(.*)$/);
    if (top) { sect = top[1]; continue; }
    const m = raw.match(/^  ([A-Za-z0-9_]+):\s*(.*)$/);
    if (m && ['dependencies', 'dev_dependencies', 'dependency_overrides'].includes(sect))
      out.push({ f, name: m[1], ver: m[2].replace(/\s+#.*$/, '').trim() });
  }
  return out;
}

function installedPkg(name) {
  // resolve from root, then every workspace package's node_modules (pnpm symlinks direct deps there)
  const roots = [ROOT, ...workspacePkgJsons().map(dirname)];
  for (const r of roots) {
    const f = join(r, 'node_modules', ...name.split('/'), 'package.json');
    if (existsSync(f)) return JSON.parse(read(f));
  }
  return null;
}

function checkLicenceCell(cell, label) {
  assert.ok(cell && !/^(—|-|n\/a|tbd|todo)?$/i.test(cell), `${label}: licence missing`);
  assert.ok(!BANNED_LICENCE.test(cell), `${label}: banned licence "${cell}" (CV §15.2)`);
  const hasAllowed = ALLOWED.some((l) => cell.includes(l));
  const hasReview = REVIEW.some((l) => cell.includes(l));
  assert.ok(hasAllowed || hasReview, `${label}: licence "${cell}" is not an allowed/review SPDX id (CV §15.2)`);
  if (!hasAllowed && hasReview)
    assert.match(cell, /review/i, `${label}: review-required licence "${cell}" must note C0+founder review`);
}

// ---------- §2.3 table ----------
test('02-TRD §2.3 has the CV §15.1 columns and no template placeholder row', () => {
  const { header, rows, sec } = loadTable();
  assert.deepEqual(header.slice(0, 6),
    ['name', 'exact version', 'licence', 'purpose', 'last release (evidence)', 'alternatives considered']);
  assert.ok(rows.length > 0, 'table has rows');
  assert.ok(!/one row per §2\.2 item/.test(sec), 'placeholder row "(one row per §2.2 item…)" must be removed');
  for (const r of rows) assert.equal(r.length, header.length, `row has ${header.length} cells: ${r.join(' | ')}`);
});

test('02-TRD §2.3 has one row for every §2.2 / [PIN-C0] item', () => {
  const { rows } = loadTable();
  const names = rows.map((r) => clean(r[0]).toLowerCase());
  const missing = REQUIRED_ROWS.filter(([, re]) => !names.some((n) => re.test(n))).map(([l]) => l);
  assert.deepEqual(missing, [], `missing rows: ${missing.join(', ')}`);
  assert.equal(new Set(names).size, names.length, 'no duplicate rows');
});

test('02-TRD §2.3 every row: exact version, allowed licence, dated release evidence, alternatives, no placeholder', () => {
  const { rows } = loadTable();
  const today = new Date().toISOString().slice(0, 10);
  const errs = [];
  for (const r of rows) {
    const [name, ver, lic, purpose, rel, alt] = r.map(clean);
    const L = `row "${name}"`;
    try {
      assert.ok(name, `${L}: empty name`);
      assert.ok(!RANGE_CHARS.test(ver), `${L}: version "${ver}" is a range/tag`);
      assert.match(ver, EXACT_ANY, `${L}: version "${ver}" is not an exact version`);
      checkLicenceCell(lic, L);
      assert.ok(purpose.length >= 3, `${L}: purpose empty`);
      const d = rel.match(/\b(\d{4}-\d{2}-\d{2})\b/);
      assert.ok(d, `${L}: last-release evidence needs an ISO date (YYYY-MM-DD), got "${rel}"`);
      assert.ok(!Number.isNaN(Date.parse(d[1])), `${L}: invalid date ${d[1]}`);
      assert.ok(d[1] <= today, `${L}: last release ${d[1]} is in the future`);
      assert.ok(alt.length >= 2 && !/^(tbd|todo)$/i.test(alt), `${L}: alternatives considered empty`);
      for (const c of [name, ver, lic, purpose, rel, alt]) assert.ok(!/\b(TBD|TODO|FIXME)\b|\?\?/.test(c), `${L}: placeholder text`);
    } catch (e) { errs.push(e.message); }
  }
  assert.deepEqual(errs, []);
});

// LD-05 (2026-11-07) T0D-12 T0-03: pins from CR-C0-0D-001 (.orchestra/cr/T0D-12*.md) are recorded in the same table.
const T0D12_PINS = {
  'react-aria-components': '1.22.1', 'react': '19.3.1', 'react-dom': '19.3.1',
  '@fontsource/noto-sans': '5.3.0', '@fontsource/noto-sans-devanagari': '5.3.0', '@fontsource/noto-sans-mono': '5.3.0',
  '@testing-library/react': '16.3.3', '@testing-library/user-event': '14.6.8',
  '@types/react': '19.3.0', '@types/react-dom': '19.3.0', 'axe-core': '4.14.0', 'jsdom': '31.0.0',
  'typescript': '7.0.2', 'vitest': '5.1.0',
  // LD-13 (2026-11-07) T0-03: pins from CR-C0-0D-002 (T0D-01) and CR-C0-0D-003 (T0D-14).
  'fastify': '5.12.8', 'fastify-openapi-glue': '4.12.0', '@fastify/ajv-compiler': '4.0.7', 'yaml': '2.8.1',
  '@types/node': '26.6.6', 'next': '16.4.5', 'server-only': '0.0.1', '@playwright/test': '1.65.0',
};
test('dependencies table (LD-05/LD-13): T0D-12, T0D-01, T0D-14 pins are recorded with the exact CR versions', () => {
  const { rows } = loadTable();
  const byName = new Map(rows.map((r) => [clean(r[0]).toLowerCase(), clean(r[1])]));
  const errs = [];
  for (const [n, v] of Object.entries(T0D12_PINS)) {
    // fonts may be listed as "Noto Sans" etc. or by package name; accept either
    const alias = { '@fontsource/noto-sans': 'noto sans', '@fontsource/noto-sans-devanagari': 'noto sans devanagari',
      '@fontsource/noto-sans-mono': 'noto sans mono' }[n];
    const got = byName.get(n) ?? (alias && byName.get(alias));
    if (got === undefined) errs.push(`${n}: no row`);
    else if (got !== v) errs.push(`${n}: table ${got} != CR ${v}`);
  }
  assert.deepEqual(errs, []);
});

test('02-TRD §2.3 versions of 04-pinned items match 02-TRD §2.1 exactly', () => {
  const { rows } = loadTable();
  for (const r of rows) {
    const n = clean(r[0]);
    if (PINNED_04[n]) assert.equal(clean(r[1]), PINNED_04[n], `${n} is pinned by 04`);
  }
});

test('02-TRD §2.3 matches installed packages (version + licence) for every row that is an installed npm dependency', () => {
  const { rows } = loadTable();
  const declared = new Set(allNpmDeps().map((d) => d.name));
  const errs = [];
  let checked = 0;
  for (const r of rows) {
    const name = clean(r[0]);
    if (!declared.has(name)) continue;
    const inst = installedPkg(name);
    if (!inst) { errs.push(`${name}: declared but not installed (run pnpm install)`); continue; }
    checked++;
    if (inst.version !== clean(r[1])) errs.push(`${name}: table ${clean(r[1])} != installed ${inst.version}`);
    const lic = typeof inst.license === 'string' ? inst.license : inst.license?.type;
    if (!lic) errs.push(`${name}: installed package has no licence field`);
    else if (!clean(r[2]).includes(lic.replace(/[()]/g, '').split(/ (?:OR|AND) /)[0]))
      errs.push(`${name}: table licence "${clean(r[2])}" does not mention installed "${lic}"`);
  }
  assert.ok(checked >= 1, 'at least one declared npm dependency has a table row');
  assert.deepEqual(errs, []);
});

// ---------- package.json / .nvmrc / engines ----------
test('every npm dependency in every workspace package.json is an exact version (no ^ ~ ranges, no tags)', () => {
  const bad = allNpmDeps().filter((d) => !/^workspace:/.test(d.ver) && !EXACT_NPM.test(d.ver));
  assert.deepEqual(bad.map((d) => `${d.f.slice(ROOT.length)} ${d.g} ${d.name}@${d.ver}`), []);
});

test('every external npm dependency has a row in the §2.3 table', () => {
  const { rows } = loadTable();
  const names = new Set(rows.map((r) => clean(r[0])));
  const missing = [...new Set(allNpmDeps().filter((d) => !d.ver.startsWith('workspace:') && !d.name.startsWith('@lims/')).map((d) => d.name))]
    .filter((n) => !names.has(n));
  assert.deepEqual(missing, [], `deps without a §2.3 row (CV §15.1): ${missing.join(', ')}`);
});

test('dependencies that 04 pins carry exactly the 04 version wherever they appear', () => {
  const bad = allNpmDeps().filter((d) => PINNED_04[d.name] && d.ver !== PINNED_04[d.name]);
  assert.deepEqual(bad.map((d) => `${d.name}@${d.ver}`), []);
});

test('root package.json: packageManager pnpm@exact, engines.node exact and equal to .nvmrc (26.x LTS patch)', () => {
  const j = JSON.parse(read(p('package.json')));
  assert.match(j.packageManager, /^pnpm@\d+\.\d+\.\d+$/);
  assert.match(j.engines?.node ?? '', /^\d+\.\d+\.\d+$/, 'engines.node must be an exact patch, not a range');
  assert.ok(existsSync(p('.nvmrc')), '.nvmrc exists');
  const nvm = read(p('.nvmrc')).trim().replace(/^v/, '');
  assert.match(nvm, /^26\.\d+\.\d+$/, '.nvmrc must be an exact 26.x.y patch (CV §1.1)');
  assert.equal(j.engines.node, nvm);
  const lock = read(p('pnpm-lock.yaml'));
  assert.ok(lock.includes(`specifier: ${j.packageManager.split('@')[1]}`), 'lockfile records the pinned pnpm version');
});

test('TypeScript and Turborepo are pinned exactly at the root and recorded in the table', () => {
  const j = JSON.parse(read(p('package.json')));
  for (const n of ['typescript', 'turbo']) {
    const v = { ...j.devDependencies, ...j.dependencies }[n];
    assert.match(v ?? '', EXACT_NPM, `${n} pinned exactly`);
  }
});

test('Node base image / CI image references are never :latest and carry a digest when present', () => {
  const files = [...walk(ROOT, (n, f) => /(^|\.)Dockerfile|docker-compose.*\.ya?ml$|\.github[\\/]workflows[\\/].*\.ya?ml$/.test(f.slice(ROOT.length)) && !/[\\/](spec|\.orchestra)[\\/]/.test(f))];
  for (const f of files) {
    for (const l of read(f).split(/\r?\n/)) {
      const m = l.match(/^\s*(?:FROM|image:)\s+(\S+)/i);
      if (!m) continue;
      assert.ok(!/:latest$|^[^:@]+$/.test(m[1]), `${f.slice(ROOT.length)}: ${m[1]} is unpinned (REQ-SEC-129)`);
      assert.ok(/@sha256:[0-9a-f]{64}/.test(m[1]) || /\$\{?[A-Z_]+/.test(m[1]) || /^[a-z0-9_-]+$/.test(m[1]) === false,
        `${f.slice(ROOT.length)}: ${m[1]} must be pinned by digest`);
    }
  }
});

// ---------- lockfiles ----------
// LD-13 (2026-11-07) T0-03: services/* and apps/* are workspace members so their pins land in pnpm-lock.yaml.
test('pnpm-workspace.yaml lists services/* and apps/* (LD-13)', () => {
  const ws = read(p('pnpm-workspace.yaml'));
  for (const g of ['services/*', 'apps/*']) {
    assert.ok(ws.split(/\r?\n/).some((l) => l.replace(/['"\s]/g, '') === '-' + g), g + ' missing from packages:');
  }
});

// LD-15 (2026-11-07) T0-03: pubspec.lock needs a human-run `flutter pub get` when flutter is not installed.
const HAS_FLUTTER = spawnSync('flutter', ['--version'], { shell: true, stdio: 'ignore' }).status === 0;
test('pubspec.lock exists (REQ-SEC-129; CV §15.1)', { skip: HAS_FLUTTER ? false : 'needs flutter pub get (human)' }, () => {
  assert.ok(existsSync(p('pubspec.lock')), 'pubspec.lock');
});

test('lockfiles committed: pnpm-lock.yaml exists; lockfiles are not git-ignored', () => {
  assert.ok(existsSync(p('pnpm-lock.yaml')), 'pnpm-lock.yaml');
  const gi = existsSync(p('.gitignore')) ? read(p('.gitignore')) : '';
  assert.ok(!/^\s*(pnpm-lock\.yaml|pubspec\.lock)\s*$/m.test(gi), 'lockfiles must not be git-ignored');
});

test('every declared npm dependency is recorded in pnpm-lock.yaml with the same exact specifier', () => {
  const lock = read(p('pnpm-lock.yaml'));
  const errs = [];
  for (const d of allNpmDeps().filter((x) => !x.ver.startsWith('workspace:'))) {
    const re = new RegExp(`^\\s+'?${d.name.replace(/[/.@-]/g, '\\$&')}'?:\\s*\\n\\s+specifier: ${d.ver.replace(/\./g, '\\.')}\\s*$`, 'm');
    if (!re.test(lock)) errs.push(`${d.name}@${d.ver} not in pnpm-lock.yaml importers`);
  }
  assert.deepEqual(errs, []);
});

// ---------- Dart / Flutter ----------
test('root pubspec.yaml pins exact Dart SDK (and Flutter SDK when declared), no caret range', () => {
  const y = read(p('pubspec.yaml'));
  const sdk = y.match(/^\s+sdk:\s*['"]?([^'"\s#]+)/m)?.[1];
  assert.match(sdk ?? '', /^\d+\.\d+\.\d+$/, `environment.sdk must be an exact Dart version, got "${sdk}" (CV §1.1 [PIN-C0])`);
  const fl = y.match(/^\s+flutter:\s*['"]?([^'"\s#]+)/m)?.[1];
  assert.match(fl ?? '', /^\d+\.\d+\.\d+$/, `environment.flutter must be an exact Flutter version, got "${fl}"`);
});

test('every pubspec.yaml dependency is an exact version (no ^ ranges, no any); package pubspecs use the pinned SDK', () => {
  const rootY = read(p('pubspec.yaml'));
  const rootSdk = rootY.match(/^\s+sdk:\s*['"]?([^'"\s#]+)/m)?.[1];
  const files = walk(ROOT, (n, f) => n === 'pubspec.yaml' && !/[\\/](spec|\.orchestra)[\\/]/.test(f.slice(ROOT.length)));
  assert.ok(files.length >= 1);
  const errs = [];
  for (const f of files) {
    for (const d of pubspecDeps(f)) {
      if (d.ver === '' || /^(sdk:|path:|git:)/.test(d.ver)) continue; // nested block / sdk / path deps
      if (!/^['"]?\d+\.\d+\.\d+(\+[\w.]+|-[\w.]+)?['"]?$/.test(d.ver)) errs.push(`${f.slice(ROOT.length)} ${d.name}: ${d.ver}`);
      if (PINNED_04[d.name] && d.ver.replace(/['"]/g, '') !== PINNED_04[d.name]) errs.push(`${d.name} must be ${PINNED_04[d.name]}`);
    }
    if (f !== p('pubspec.yaml')) {
      const s = read(f).match(/^\s+sdk:\s*['"]?([^'"\s#]+)/m)?.[1];
      if (s && s !== rootSdk) errs.push(`${f.slice(ROOT.length)}: sdk "${s}" differs from root pin "${rootSdk}"`);
    }
  }
  assert.deepEqual(errs, []);
});

// ---------- banned list (CI gate 13, CV §15.3) ----------
function lockedNpmNames() {
  const names = new Set();
  for (const l of read(p('pnpm-lock.yaml')).split(/\r?\n/)) {
    const m = l.match(/^ {2}'?((?:@[^/@\s']+\/)?[^@\s'/]+)@\d/);
    if (m) names.add(m[1]);
  }
  return names;
}

// CV §15.3 (02-CONVENTIONS.md:1195): `bikram-sambat` "may appear only as a test oracle, never imported by app code".
// Exemption: devDependencies of packages/test-fixtures only (cross-library B.S. golden-table oracle, T0A-06).
const isOracleUse = (d) => d.name === 'bikram-sambat' && d.g === 'devDependencies' &&
  d.f.replace(/\\/g, '/').endsWith('/packages/test-fixtures/package.json');

test('banned list: no banned package in any package.json (direct) — CV §15.3', () => {
  const hit = allNpmDeps().filter((d) => BANNED_PKGS.includes(d.name) && !isOracleUse(d));
  assert.deepEqual(hit.map((d) => `${d.f.slice(ROOT.length)}: ${d.name}`), []);
});

test('banned list: no banned package anywhere in pnpm-lock.yaml (transitive) — CV §15.3', () => {
  const names = lockedNpmNames();
  assert.ok(names.size > 0, 'lockfile parser found package entries');
  const oracle = allNpmDeps().some(isOracleUse);
  assert.deepEqual(BANNED_PKGS.filter((b) => names.has(b) && !(b === 'bikram-sambat' && oracle)), []);
});

test('banned list: bikram-sambat test oracle is never a runtime dependency or imported by non-test source', () => {
  const bad = allNpmDeps().filter((d) => d.name === 'bikram-sambat' && !isOracleUse(d));
  assert.deepEqual(bad.map((d) => `${d.f.slice(ROOT.length)} ${d.g}`), []);
  const src = [...walk(p('apps'), (n) => /\.(ts|tsx|mjs|js|dart)$/.test(n)), ...walk(p('packages'), (n) => /\.(ts|tsx|mjs|js|dart)$/.test(n))]
    .filter((f) => !/[\\/](__tests__|tests?|node_modules)[\\/]|\.(test|spec)\.|_test\.dart$/.test(f.slice(ROOT.length)) &&
      !/[\\/]packages[\\/]test-fixtures[\\/]/.test(f))
    .filter((f) => /['"]bikram-sambat['"]/.test(read(f)));
  assert.deepEqual(src.map((f) => f.slice(ROOT.length)), []);
});

test('banned list: @supabase/supabase-js and @supabase/ssr not in browser-bundle packages (web, portal, partner, ui)', () => {
  const hit = allNpmDeps().filter((d) => BROWSER_BANNED.includes(d.name) &&
    BROWSER_PKG_DIRS.some((b) => d.f.replace(/\\/g, '/').includes(`/${b}/`)));
  assert.deepEqual(hit.map((d) => `${d.f.slice(ROOT.length)}: ${d.name}`), []);
});

test('banned list: no banned pub package in any pubspec.yaml or pubspec.lock', () => {
  const files = [...walk(ROOT, (n, f) => (n === 'pubspec.yaml' || n === 'pubspec.lock') && !/[\\/](spec|\.orchestra)[\\/]/.test(f.slice(ROOT.length)))];
  const bad = [];
  for (const f of files) {
    const txt = read(f);
    for (const b of BANNED_PKGS) if (new RegExp(`^\\s*"?${b}"?:`, 'm').test(txt)) bad.push(`${f.slice(ROOT.length)}: ${b}`);
  }
  assert.deepEqual(bad, []);
});

test('banned list: no Postgres ENUM in migrations/db sources (gate 13 covers ENUM types)', () => {
  const files = walk(p('db'), (n) => /\.sql$/.test(n)).concat(walk(p('supabase'), (n) => /\.sql$/.test(n)));
  const bad = files.filter((f) => /\bCREATE\s+TYPE\s+[\w."]+\s+AS\s+ENUM\b/i.test(read(f)));
  assert.deepEqual(bad.map((f) => f.slice(ROOT.length)), []);
});

test('banned-list matcher self-check: scoped @cantoo/pdf-lib is not mistaken for upstream pdf-lib', () => {
  const sample = "  '@cantoo/pdf-lib@2.11.1':\n  pdf-lib@1.17.1:\n";
  const names = new Set();
  for (const l of sample.split('\n')) { const m = l.match(/^ {2}'?((?:@[^/@\s']+\/)?[^@\s'/]+)@\d/); if (m) names.add(m[1]); }
  assert.ok(names.has('pdf-lib') && names.has('@cantoo/pdf-lib'));
  assert.ok(BANNED_PKGS.includes('pdf-lib') && !BANNED_PKGS.includes('@cantoo/pdf-lib'));
});

// ---------- licence check on installed tree ----------
test('licence check: every installed package in the lockfile tree has an allowed licence (CV §15.2)', () => {
  const pnpmDir = p('node_modules', '.pnpm');
  assert.ok(existsSync(pnpmDir), 'run pnpm install first (node_modules/.pnpm missing)');
  const bad = [];
  let n = 0;
  for (const entry of readdirSync(pnpmDir)) {
    if (entry === 'node_modules' || entry.startsWith('.') || entry.startsWith('lock')) continue;
    const m = entry.match(/^((?:@[^+]+\+)?[^@]+)@/);
    if (!m) continue;
    const name = m[1].replace('+', '/');
    const f = join(pnpmDir, entry, 'node_modules', ...name.split('/'), 'package.json');
    if (!existsSync(f)) continue;
    const j = JSON.parse(read(f));
    n++;
    let lic = typeof j.license === 'string' ? j.license : j.license?.type ?? (j.licenses ?? []).map((x) => x.type).join(' OR ');
    if (!lic) { bad.push(`${name}: no licence field`); continue; }
    if (BANNED_LICENCE.test(lic)) { bad.push(`${name}: ${lic}`); continue; }
    if (!ALLOWED.concat(REVIEW).some((l) => lic.includes(l)) && !/\bSEE LICEN[SC]E\b/i.test(lic)) bad.push(`${name}: ${lic}`);
  }
  assert.ok(n > 0, 'inspected at least one installed package');
  // pnpm's own @pnpm/exe.* platform binaries are tooling (packageManagerDependencies), not shipped code
  assert.deepEqual(bad.filter((b) => !b.startsWith('@pnpm/')), []);
});

test('licence-cell checker self-check: GPL/AGPL/LGPL/unlicensed/review handling', () => {
  assert.throws(() => checkLicenceCell('GPL-3.0-only', 'x'));
  assert.throws(() => checkLicenceCell('AGPL-3.0', 'x'));
  assert.throws(() => checkLicenceCell('SSPL-1.0', 'x'));
  assert.throws(() => checkLicenceCell('UNLICENSED', 'x'));
  assert.throws(() => checkLicenceCell('MPL-2.0', 'x'), /review/);
  assert.throws(() => checkLicenceCell('', 'x'));
  checkLicenceCell('MIT', 'x');
  checkLicenceCell('MPL-2.0 (C0+founder review: dynamic use only)', 'x');
  checkLicenceCell('MIT OR Apache-2.0', 'x');
});
