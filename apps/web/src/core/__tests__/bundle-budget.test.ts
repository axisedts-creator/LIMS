// T0D-BUNDLE-1 (LD-310 / LD-312; founder 2026-11-17 04:54 NPT "easy to load on low end PCs, no lag";
// lead measurement 2026-11-17 05:20 NPT: 298 KB gzip first-load JS vs 170 KB budget).
// Contract pinned here (the writer implements apps/web/scripts/bundle-budget.mjs + bundle-budget.json to match):
//   node scripts/bundle-budget.mjs <buildDir> [--budget <file>]      (cwd = apps/web; budget defaults to scripts/bundle-budget.json)
//   <buildDir> = a Next build output dir (".next"). Read: <buildDir>/build-manifest.json
//       { polyfillFiles[], rootMainFiles[], pagesChunkGroupBootstrapParams: { "<route>": { otherChunks[] } } }
//     chunk paths are relative to <buildDir>. Route JS = unique(polyfillFiles + rootMainFiles + otherChunks[route]) ending .js.
//     First-load JS = sum of gzip bytes of those files. CSS = sum gzip of the .css files in otherChunks. Requests = files counted.
//   KB = 1024 bytes. Exit 0 = within budget, 1 = over budget, 2 = usage/config/missing-build error.
//   stdout = table, one line per route (line contains the route string); over-budget line contains "OVER", passing line "ok";
//   final summary line contains "PASS" or "FAIL".
//   Budget JSON (one file): { first_load_js_kb, route_extra_js_kb, css_kb, requests, entry_routes[], overrides{ route: {
//     first_load_js_kb?, route_extra_js_kb?, css_kb?, requests?, todo } } }.
//     entry_routes (sign-in, staff home) are held to first_load_js_kb. Every other route is held to route_extra_js_kb of JS that is
//     NOT in the union of the entry routes' files. css_kb and requests apply to every route. An override replaces the number for that
//     route only and needs a `todo` string that contains a date YYYY-MM-DD (honest current value, can only go down).
// Run: .orchestra/notes/T0D-BUNDLE-1-verify.cmd
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const web = resolve(fileURLToPath(new URL('../../../', import.meta.url))); // apps/web/
const script = join(web, 'scripts', 'bundle-budget.mjs');
const budgetFile = join(web, 'scripts', 'bundle-budget.json');
const KB = 1024;

// ---------- fixture helpers ----------
let seed = 12345;
/** Deterministic incompressible bytes: gzip size ~ raw size, so a chunk's gzip KB is predictable. */
function noise(bytes: number): Buffer {
  const b = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; b[i] = seed >>> 24; }
  return b;
}
const gz = (b: Buffer): number => gzipSync(b).length;

type Chunk = { path: string; data: Buffer };
function mkBuild(root: string, o: { polyfill?: Chunk[]; main?: Chunk[]; routes: Record<string, Chunk[]> }): string {
  const dir = mkdtempSync(join(root, 'next-'));
  const put = (c: Chunk) => { mkdirSync(join(dir, c.path, '..'), { recursive: true }); writeFileSync(join(dir, c.path), c.data); };
  (o.polyfill ?? []).forEach(put); (o.main ?? []).forEach(put);
  const params: Record<string, { otherChunks: string[] }> = {};
  for (const [route, chunks] of Object.entries(o.routes)) { chunks.forEach(put); params[route] = { otherChunks: chunks.map((c) => c.path) }; }
  writeFileSync(join(dir, 'build-manifest.json'), JSON.stringify({
    polyfillFiles: (o.polyfill ?? []).map((c) => c.path),
    rootMainFiles: (o.main ?? []).map((c) => c.path),
    pagesChunkGroupBootstrapParams: params,
  }));
  return dir;
}
const chunk = (path: string, kb: number): Chunk => ({ path, data: noise(kb * KB) });

function writeBudget(root: string, b: Record<string, unknown>): string {
  const f = join(root, `budget-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(f, JSON.stringify(b)); return f;
}
const baseBudget = {
  first_load_js_kb: 170, route_extra_js_kb: 60, css_kb: 40, requests: 25,
  entry_routes: ['/(auth)/auth/login/page', '/(staff)/[...slug]/page'], overrides: {},
};
function run(args: string[]) {
  const r = spawnSync(process.execPath, [script, ...args], { cwd: web, encoding: 'utf8', timeout: 30000 });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, stdout: r.stdout ?? '' };
}
const rowFor = (out: string, route: string): string => out.split(/\r?\n/).find((l) => l.includes(route)) ?? '';

let tmp = '';
beforeAll(() => { tmp = mkdtempSync(join(tmpdir(), 't0d-bundle-1-')); });
afterAll(() => { rmSync(tmp, { recursive: true, force: true }); });

// ---------- (1) the script exists and works from a build-dir argument ----------
describe('T0D-BUNDLE-1 (1) bundle-budget.mjs against fixture builds', () => {
  const LOGIN = '/(auth)/auth/login/page';
  const HOME = '/(staff)/[...slug]/page';

  it('script file exists', () => { expect(existsSync(script)).toBe(true); });

  it('within budget: exit 0, table lists each route, summary says PASS', () => {
    const shared = [chunk('static/chunks/a.js', 60), chunk('static/chunks/b.js', 40)];
    const dir = mkBuild(tmp, { polyfill: [chunk('static/chunks/poly.js', 10)], main: shared, routes: {
      [LOGIN]: [chunk('static/chunks/login.js', 20)], [HOME]: [chunk('static/chunks/home.js', 25)],
      '/(staff)/catalog/tests/page': [chunk('static/chunks/tests.js', 30)] } });
    const r = run([dir, '--budget', writeBudget(tmp, baseBudget)]);
    expect(r.code, r.out).toBe(0);
    for (const route of [LOGIN, HOME, '/(staff)/catalog/tests/page']) expect(rowFor(r.out, route), route).toMatch(/ok/);
    expect(r.out).toMatch(/PASS/);
    expect(r.out).not.toMatch(/OVER|FAIL/);
  });

  it('entry route over 170 KB gzip first-load JS: exit 1, that row says OVER, summary FAIL', () => {
    const dir = mkBuild(tmp, { main: [chunk('static/chunks/main.js', 120)], routes: {
      [LOGIN]: [chunk('static/chunks/login.js', 20)],
      [HOME]: [chunk('static/chunks/home.js', 70)] } }); // 190 KB
    const r = run([dir, '--budget', writeBudget(tmp, baseBudget)]);
    expect(r.code, r.out).toBe(1);
    expect(rowFor(r.out, HOME)).toMatch(/OVER/);
    expect(rowFor(r.out, LOGIN)).not.toMatch(/OVER/);
    expect(r.out).toMatch(/FAIL/);
  });

  it('boundary: exactly 170 KB passes, 171 KB fails (budget is "at most")', () => {
    // gzip of noise adds a few bytes of header, so trim the raw bytes until the real gzip length is just under kb*KB
    const target = (kb: number) => { const data = noise(kb * KB); let n = data.length; while (gz(data.subarray(0, n)) > kb * KB) n--; return data.subarray(0, n); };
    const mk = (kb: number) => mkBuild(tmp, { main: [{ path: 'static/chunks/m.js', data: target(kb) }], routes: { [LOGIN]: [], [HOME]: [] } });
    expect(run([mk(170), '--budget', writeBudget(tmp, baseBudget)]).code).toBe(0);
    expect(run([mk(171), '--budget', writeBudget(tmp, baseBudget)]).code).toBe(1);
  });

  it('non-entry route: held to 60 KB of EXTRA js (not in the entry routes), shared files do not count', () => {
    const main = [chunk('static/chunks/main.js', 100)];
    const ok = mkBuild(tmp, { main, routes: { [LOGIN]: [chunk('static/chunks/login.js', 10)], [HOME]: [chunk('static/chunks/home.js', 10)],
      '/(staff)/lab/page': [chunk('static/chunks/lab.js', 55)] } });
    expect(run([ok, '--budget', writeBudget(tmp, baseBudget)]).code).toBe(0); // 165 total but only 55 extra
    const bad = mkBuild(tmp, { main, routes: { [LOGIN]: [chunk('static/chunks/login.js', 10)], [HOME]: [chunk('static/chunks/home.js', 10)],
      '/(staff)/lab/page': [chunk('static/chunks/lab.js', 65)] } });
    const r = run([bad, '--budget', writeBudget(tmp, baseBudget)]);
    expect(r.code, r.out).toBe(1);
    expect(rowFor(r.out, '/(staff)/lab/page')).toMatch(/OVER/);
  });

  it('a chunk that is also used by an entry route is not "extra" for another route', () => {
    const sharedWithHome = chunk('static/chunks/shared-home.js', 50);
    const dir = mkBuild(tmp, { main: [chunk('static/chunks/main.js', 60)], routes: {
      [LOGIN]: [chunk('static/chunks/login.js', 5)], [HOME]: [sharedWithHome],
      '/(staff)/lab/page': [sharedWithHome, chunk('static/chunks/lab.js', 30)] } }); // extra = 30, not 80
    expect(run([dir, '--budget', writeBudget(tmp, baseBudget)]).code).toBe(0);
  });

  it('sizes are GZIP, not raw: 600 KB of zeros gzips to ~1 KB and passes', () => {
    const dir = mkBuild(tmp, { main: [{ path: 'static/chunks/zeros.js', data: Buffer.alloc(600 * KB) }], routes: { [LOGIN]: [], [HOME]: [] } });
    expect(run([dir, '--budget', writeBudget(tmp, baseBudget)]).code).toBe(0);
  });

  it('a chunk listed twice (root + route) is counted once', () => {
    const m = chunk('static/chunks/main.js', 100);
    const dir = mkBuild(tmp, { main: [m], routes: { [LOGIN]: [m, chunk('static/chunks/l.js', 5)], [HOME]: [m] } });
    expect(run([dir, '--budget', writeBudget(tmp, baseBudget)]).code).toBe(0); // 105, not 205
  });

  it('only .js counts as JavaScript; CSS over 40 KB gzip fails with that row OVER', () => {
    const dir = mkBuild(tmp, { main: [chunk('static/chunks/main.js', 20)], routes: {
      [LOGIN]: [chunk('static/chunks/login.css', 45)], [HOME]: [chunk('static/chunks/home.css', 10)] } });
    const r = run([dir, '--budget', writeBudget(tmp, baseBudget)]);
    expect(r.code, r.out).toBe(1);
    expect(rowFor(r.out, LOGIN)).toMatch(/OVER/);
    expect(rowFor(r.out, HOME)).not.toMatch(/OVER/);
  });

  it('more than 25 requests on a route fails (26), 25 passes', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => chunk(`static/chunks/c${i}.js`, 1));
    const mk = (n: number) => mkBuild(tmp, { routes: { [LOGIN]: many(n), [HOME]: [] } });
    expect(run([mk(25), '--budget', writeBudget(tmp, baseBudget)]).code).toBe(0);
    const r = run([mk(26), '--budget', writeBudget(tmp, baseBudget)]);
    expect(r.code, r.out).toBe(1);
    expect(rowFor(r.out, LOGIN)).toMatch(/OVER/);
  });

  it('override: raises one route only, needs a dated todo, other routes still fail', () => {
    const dir = mkBuild(tmp, { main: [chunk('static/chunks/main.js', 10)], routes: {
      [LOGIN]: [chunk('static/chunks/login.js', 10)], [HOME]: [chunk('static/chunks/home.js', 10)],
      '/(staff)/lab/page': [chunk('static/chunks/lab.js', 90)], '/(staff)/billing/page': [chunk('static/chunks/bill.js', 90)] } });
    const withTodo = writeBudget(tmp, { ...baseBudget, overrides: { '/(staff)/lab/page': { route_extra_js_kb: 100, todo: 'TODO 2026-11-17 split lab charts, lower this' } } });
    const r = run([dir, '--budget', withTodo]);
    expect(r.code, r.out).toBe(1); // billing still over
    expect(rowFor(r.out, '/(staff)/lab/page')).not.toMatch(/OVER/);
    expect(rowFor(r.out, '/(staff)/billing/page')).toMatch(/OVER/);
    const noDate = writeBudget(tmp, { ...baseBudget, overrides: { '/(staff)/lab/page': { route_extra_js_kb: 100, todo: 'later' } } });
    expect(run([dir, '--budget', noDate]).code).toBe(2); // honest-number rule: dated TODO is mandatory
    const noTodo = writeBudget(tmp, { ...baseBudget, overrides: { '/(staff)/lab/page': { route_extra_js_kb: 100 } } });
    expect(run([dir, '--budget', noTodo]).code).toBe(2);
  });

  it('bad input exits 2 with a message, not a stack trace or 0: no args, missing dir, no manifest, bad budget JSON', () => {
    const empty = mkdtempSync(join(tmp, 'empty-'));
    const badJson = join(tmp, 'bad.json'); writeFileSync(badJson, '{ not json');
    const good = mkBuild(tmp, { routes: { [LOGIN]: [], [HOME]: [] } });
    const cases = [
      run([]),
      run([join(tmp, 'does-not-exist'), '--budget', writeBudget(tmp, baseBudget)]),
      run([empty, '--budget', writeBudget(tmp, baseBudget)]),
      run([good, '--budget', badJson]),
      run([good, '--budget', join(tmp, 'missing-budget.json')]),
    ];
    for (const r of cases) { expect(r.code, r.out).toBe(2); expect(r.out.trim().length).toBeGreaterThan(0); expect(r.out).not.toMatch(/\n\s+at .*\(.*:\d+:\d+\)/); }
  });

  it('a manifest chunk missing on disk is an error (exit 2), never silently counted as 0 KB', () => {
    const dir = mkBuild(tmp, { main: [chunk('static/chunks/main.js', 10)], routes: { [LOGIN]: [chunk('static/chunks/login.js', 5)], [HOME]: [] } });
    rmSync(join(dir, 'static/chunks/login.js'));
    expect(run([dir, '--budget', writeBudget(tmp, baseBudget)]).code).toBe(2);
  });

  it('an entry route named in the budget but absent from the build is an error (exit 2), not a pass', () => {
    const dir = mkBuild(tmp, { routes: { [LOGIN]: [] } }); // HOME missing
    expect(run([dir, '--budget', writeBudget(tmp, baseBudget)]).code).toBe(2);
  });

  it('prints sizes in KB for each route (a number followed by KB on the route line)', () => {
    const dir = mkBuild(tmp, { main: [chunk('static/chunks/main.js', 12)], routes: { [LOGIN]: [], [HOME]: [] } });
    expect(rowFor(run([dir, '--budget', writeBudget(tmp, baseBudget)]).out, LOGIN)).toMatch(/\d+(\.\d+)?\s*KB/i);
  });
});

// ---------- (1)/(5) the budget file: one JSON file, the lead's proposed numbers, honest overrides ----------
describe('T0D-BUNDLE-1 (1)(5) bundle-budget.json', () => {
  const b = () => JSON.parse(readFileSync(budgetFile, 'utf8'));
  it('exists and holds the lead budgets: 170 / 60 / 40 / 25', () => {
    expect(existsSync(budgetFile)).toBe(true);
    expect(b()).toMatchObject({ first_load_js_kb: 170, route_extra_js_kb: 60, css_kb: 40, requests: 25 });
  });
  it('entry_routes include sign-in and at least one staff home route', () => {
    const e: string[] = b().entry_routes;
    expect(e).toContain('/(auth)/auth/login/page');
    expect(e.length).toBeGreaterThanOrEqual(2);
    expect(e.some((r) => r.startsWith('/(staff)/'))).toBe(true);
  });
  it('every override has a dated TODO (YYYY-MM-DD) and a number that is not below the default (it only raises)', () => {
    const j = b();
    for (const [route, o] of Object.entries<any>(j.overrides ?? {})) {
      expect(String(o.todo ?? ''), route).toMatch(/\d{4}-\d{2}-\d{2}/);
      for (const k of ['first_load_js_kb', 'route_extra_js_kb', 'css_kb', 'requests']) if (k in o) expect(o[k], `${route}.${k}`).toBeGreaterThan(j[k]);
    }
  });
});

// ---------- (5) part of the web verify set ----------
describe('T0D-BUNDLE-1 (5) wired into the web verify set', () => {
  it('apps/web/package.json has a script that runs the budget script against .next', () => {
    const scripts = JSON.parse(readFileSync(join(web, 'package.json'), 'utf8')).scripts as Record<string, string>;
    expect(Object.values(scripts).some((s) => /bundle-budget\.mjs/.test(s)), 'no package script calls scripts/bundle-budget.mjs').toBe(true);
  });
});

// ---------- (3)(4) code splitting guards (static, no build) ----------
const srcRoot = join(web, 'src');
function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n); const s = statSync(p);
    if (s.isDirectory()) { if (n === '__tests__' || n === 'node_modules' || n === 'tests') continue; walk(p, out); }
    else if (/\.(tsx?|mjs)$/.test(n) && !/\.(test|spec)\./.test(n)) out.push(p);
  }
  return out;
}
const rel = (p: string) => relative(web, p).split('\\').join('/');
const nonTest = walk(srcRoot);
const outOfScope = (f: string) => /^src\/features\/(admin|platform)\//.test(rel(f)); // LD-312 (4): untouched

describe('T0D-BUNDLE-1 (3)(4) dynamic imports and import hygiene', () => {
  it('at least one heavy, single-screen component under features/ (not admin/platform) is loaded with next/dynamic', () => {
    const hits = nonTest.filter((f) => /^src\/features\//.test(rel(f)) && !outOfScope(f) && /from\s+['"]next\/dynamic['"]/.test(readFileSync(f, 'utf8')));
    expect(hits.map(rel), 'no next/dynamic use in features/: code splitting not done').not.toHaveLength(0);
  });
  it('every dynamic() call has a light loading state (loading: option)', () => {
    const bad: string[] = [];
    for (const f of nonTest) {
      const src = readFileSync(f, 'utf8');
      if (!/from\s+['"]next\/dynamic['"]/.test(src)) continue;
      for (const m of src.matchAll(/\bdynamic\(\s*(?:\(\)\s*=>\s*)?import\(/g)) {
        const tail = src.slice(m.index!, m.index! + 600);
        const call = tail.split(/\n\s*\n|\);\s*\n/)[0] ?? tail;
        if (!/\bloading\s*:/.test(call) && !/ssr\s*:\s*false[\s\S]*loading|loading[\s\S]*ssr/.test(call)) bad.push(`${rel(f)}@${m.index}`);
      }
    }
    expect(bad).toEqual([]);
  });
  it('no whole-library icon imports: no `import * as X from` an icon package, no barrel import of an icon library', () => {
    const bad = nonTest.filter((f) => /import\s+\*\s+as\s+\w+\s+from\s+['"](lucide-react|@heroicons\/[^'"]+|react-icons(\/[^'"]*)?|@tabler\/icons-react|@phosphor-icons\/react)['"]/.test(readFileSync(f, 'utf8')));
    expect(bad.map(rel)).toEqual([]);
  });
  it('no polyfill packages in apps/web dependencies (Next ships its own)', () => {
    const p = JSON.parse(readFileSync(join(web, 'package.json'), 'utf8'));
    const deps = Object.keys({ ...p.dependencies });
    expect(deps.filter((d) => /polyfill|core-js|regenerator-runtime|whatwg-fetch|^babel-polyfill$/.test(d))).toEqual([]);
  });
  it('next.config does not weaken the build to hide size (no ignoreBuildErrors, no experimental disabling of minify)', () => {
    const cfg = readFileSync(join(web, 'next.config.mjs'), 'utf8');
    expect(cfg).not.toMatch(/ignoreBuildErrors|swcMinify\s*:\s*false|minimize\s*:\s*false/);
    expect(cfg).not.toMatch(/productionBrowserSourceMaps\s*:\s*true/); // source maps must not ship to the browser by default
  });
});
