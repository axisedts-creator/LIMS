// WEB-T01 (C7): nav manifest, route segment, loading/error, help files. Done when: build-nav passes.
// Spec: C7 04-UI-UX §1 (nav table), §header (every page has loading/error + help file), C0 04-UI-UX §3 (manifest + build rules),
// C0 04-UI-UX §7 (HelpPanel shape; loading.tsx/error.tsx per segment). Run: node --test (node strips TS types natively).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';

const WEB = join(import.meta.dirname, '..', '..', '..', '..'); // apps/web
const FEATURE = join(WEB, 'src', 'features', 'instruments');
const SEGMENT = join(WEB, 'src', 'app', '(staff)', 'instruments');
const ROUTES_YAML = join(WEB, '..', '..', 'contracts', 'routes.yaml');
const routes = (parse(readFileSync(ROUTES_YAML, 'utf8')) as { routes: { id: string; origin: string; path: string; permission?: string }[] }).routes;

// 04-UI-UX §1, verbatim. `dir` = route directory under app/(staff)/instruments.
const EXPECTED = [
  { id: 'instruments.agents', routeId: 'staff.instruments.agents', permission: 'instruments.agent.read', order: 10, chord: 'g a', dir: 'agents' },
  { id: 'instruments.instruments', routeId: 'staff.instruments.instruments', permission: 'instruments.instrument.read', order: 20, chord: 'g i', dir: 'instruments' },
  { id: 'instruments.messages', routeId: 'staff.instruments.messages', permission: 'instruments.message.read', order: 30, chord: 'g m', dir: 'messages' },
  { id: 'instruments.settings', routeId: 'staff.instruments.settings', permission: 'instruments.instrument.read', order: 90, chord: undefined, dir: 'settings' },
] as const;

async function loadManifest() {
  const file = join(FEATURE, 'nav.manifest.ts');
  assert.ok(existsSync(file), `missing ${file}`);
  return (await import(pathToFileURL(file).href)) as { navManifest: { module: string; entries: Record<string, unknown>[] } };
}

test('nav.manifest: module=instruments with the four §1 entries, verbatim ids/routes/permissions/order/chords', async () => {
  const { navManifest } = await loadManifest();
  assert.equal(navManifest.module, 'instruments');
  assert.equal(navManifest.entries.length, EXPECTED.length, 'exactly the four §1 entries (detail routes are not nav entries)');
  for (const x of EXPECTED) {
    const e = navManifest.entries.find((n) => n.id === x.id);
    assert.ok(e, `entry ${x.id}`);
    assert.equal(e.routeId, x.routeId);
    assert.equal(e.permission, x.permission);
    assert.equal(e.group, 'instruments');
    assert.equal(e.order, x.order);
    assert.equal(e.chord, x.chord);
    assert.ok(typeof e.label === 'string' && e.label.length > 0, `${x.id}: label (message key) present`);
  }
});

test('nav.manifest: every entry resolves to a non-parameterised staff_web route with the same permission', async () => {
  const { navManifest } = await loadManifest();
  for (const e of navManifest.entries) {
    const r = routes.find((x) => x.id === e.routeId);
    assert.ok(r, `${String(e.routeId)} in routes.yaml`);
    assert.equal(r.origin, 'staff_web');
    assert.equal(r.permission, e.permission, `${String(e.id)} permission must equal the route's`);
    assert.ok(!r.path.includes('{'), `${String(e.id)}: detail pages are not nav entries`);
  }
});

test('build-nav CLI passes (done_when) and emits the instruments entries with their routes.yaml paths', () => {
  const r = spawnSync(process.execPath, ['src/core/nav/build-nav.ts'], { cwd: WEB, encoding: 'utf8' });
  assert.equal(r.status, 0, `build-nav failed:\n${r.stderr}${r.stdout}`);
  const generated = readFileSync(join(WEB, 'src', 'core', 'nav', 'generated.ts'), 'utf8');
  for (const x of EXPECTED) {
    assert.ok(generated.includes(`"${x.id}"`), `generated.ts contains ${x.id}`);
    const path = routes.find((q) => q.id === x.routeId)!.path;
    assert.ok(generated.includes(`"${path}"`), `generated.ts contains path ${path}`);
  }
});

test('build-nav rejects a drifted manifest (permission differs from route) — guards the done_when check itself', async () => {
  const { buildNav } = await import(pathToFileURL(join(WEB, 'src', 'core', 'nav', 'build-nav.ts')).href);
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'webt01-'));
  mkdirSync(join(dir, 'instruments'));
  writeFileSync(join(dir, 'instruments', 'nav.manifest.ts'), readFileSync(join(FEATURE, 'nav.manifest.ts'), 'utf8').replaceAll('instruments.message.read', 'instruments.bogus.read'));
  const { errors } = await buildNav(dir, readFileSync(ROUTES_YAML, 'utf8'));
  assert.ok(errors.some((m: string) => /permission/.test(m)), `expected permission error, got ${JSON.stringify(errors)}`);
});

function nearest(dir: string, file: string): string | undefined {
  for (const p of [join(SEGMENT, dir, file), join(SEGMENT, file)]) if (existsSync(p)) return p;
  return undefined;
}

for (const x of EXPECTED) {
  test(`route segment ${x.dir}: loading.tsx and error.tsx exist (own dir or segment root), default-exported`, () => {
    assert.ok(existsSync(SEGMENT) && statSync(SEGMENT).isDirectory(), 'app/(staff)/instruments exists');
    const loading = nearest(x.dir, 'loading.tsx');
    const error = nearest(x.dir, 'error.tsx');
    assert.ok(loading, `loading.tsx for /instruments/${x.dir}`);
    assert.ok(error, `error.tsx for /instruments/${x.dir}`);
    assert.match(readFileSync(loading, 'utf8'), /export\s+default\b/);
    assert.match(readFileSync(error, 'utf8'), /export\s+default\b/);
  });
}

test('error.tsx is a client component (Next requirement) and does not render raw error message/stack (security: no leak)', () => {
  const files = EXPECTED.map((x) => nearest(x.dir, 'error.tsx')).filter((f): f is string => !!f);
  assert.ok(files.length > 0, 'at least one error.tsx');
  for (const f of new Set(files)) {
    const src = readFileSync(f, 'utf8');
    assert.match(src, /^\s*(\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*['"]use client['"]/, `${f}: 'use client' must be the first statement`);
    assert.doesNotMatch(src, /\berror\.(message|stack)\b/, `${f}: must show a reference (digest), never error.message/stack`);
  }
});

const HELP_KEYS = EXPECTED.map((x) => x.id); // PageHeader.helpKey = nav id (04-UI-UX SCR-01: helpKey `instruments.agents`)

for (const key of HELP_KEYS) {
  test(`help/${key}.ts: HelpPanel shape { title, sections[{heading,body}], shortcuts?, links? }`, async () => {
    const file = join(FEATURE, 'help', `${key}.ts`);
    assert.ok(existsSync(file), `missing ${file}`);
    const mod = (await import(pathToFileURL(file).href)) as Record<string, any>;
    const h = mod.default ?? Object.values(mod)[0];
    assert.ok(h && typeof h === 'object', 'exports the help object (default or sole named export)');
    assert.ok(typeof h.title === 'string' && h.title.trim(), 'title');
    assert.ok(Array.isArray(h.sections) && h.sections.length > 0, 'sections non-empty');
    for (const s of h.sections) {
      assert.ok(typeof s.heading === 'string' && s.heading.trim(), 'section.heading');
      assert.ok(typeof s.body === 'string' && s.body.trim(), 'section.body');
    }
    for (const s of h.shortcuts ?? []) assert.ok(s.keys && s.action, 'shortcut {keys, action}');
    for (const l of h.links ?? []) {
      assert.ok(routes.some((r) => r.id === l.routeId), `link routeId ${l.routeId} exists in routes.yaml`);
      assert.ok(typeof l.label === 'string' && l.label.trim(), 'link.label');
    }
  });
}

test('every PageHeader helpKey used under app/(staff)/instruments has a help file (production-build rule, C0 §7)', () => {
  const used = new Set<string>();
  const walk = (d: string) => {
    for (const n of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, n.name);
      if (n.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(n.name)) for (const m of readFileSync(p, 'utf8').matchAll(/helpKey\s*[=:]\s*\{?\s*['"]([^'"]+)['"]/g)) used.add(m[1]!);
    }
  };
  assert.ok(existsSync(SEGMENT), 'route segment exists');
  walk(SEGMENT);
  for (const k of used) assert.ok(existsSync(join(FEATURE, 'help', `${k}.ts`)), `help file for helpKey ${k}`);
});
