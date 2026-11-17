#!/usr/bin/env node
// T0D-BUNDLE-1 (LD-310 / LD-312; founder 2026-11-17 04:54 NPT "easy to load on low end PCs, no lag").
// Usage: node scripts/bundle-budget.mjs <buildDir> [--budget <file>]   (budget defaults to scripts/bundle-budget.json)
// Sums gzip KB of first-load JS / CSS per route from <buildDir>/build-manifest.json and prints a table.
// Exit 0 = within budget, 1 = over budget, 2 = usage / config / missing build file.
// [CONV] App Router (turbopack) lists a page's own client chunks only in server/app/<route>_client-reference-manifest.js
// (entryJSFiles / entryCSSFiles); when that file exists its chunks are added to the route, otherwise build-manifest alone counts.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { gzipSync } from 'node:zlib';

const KB = 1024;
const LIMITS = ['first_load_js_kb', 'route_extra_js_kb', 'css_kb', 'requests'];

class UsageError extends Error {}
const fail = (msg) => { throw new UsageError(msg); };

function readJson(file, what) {
  if (!existsSync(file)) fail(`${what} not found: ${file}`);
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch (e) { fail(`${what} is not valid JSON: ${file} (${e.message})`); }
}

function loadBudget(file) {
  const b = readJson(file, 'budget file');
  for (const k of LIMITS) if (typeof b[k] !== 'number' || !(b[k] >= 0)) fail(`budget ${k} must be a non-negative number`);
  if (!Array.isArray(b.entry_routes) || b.entry_routes.length === 0) fail('budget entry_routes must be a non-empty array');
  const overrides = b.overrides ?? {};
  if (typeof overrides !== 'object' || Array.isArray(overrides)) fail('budget overrides must be an object');
  for (const [route, o] of Object.entries(overrides)) {
    // Honest-number rule: an override is the current value with a dated TODO so it can only go down.
    if (!/\d{4}-\d{2}-\d{2}/.test(String(o?.todo ?? ''))) fail(`override for ${route} needs a todo with a date YYYY-MM-DD`);
    for (const k of LIMITS) if (k in o && (typeof o[k] !== 'number' || !(o[k] >= 0))) fail(`override ${route}.${k} must be a number`);
  }
  return { ...b, overrides };
}

function clientManifestChunks(buildDir, route) {
  const f = join(buildDir, 'server', 'app', `${route}_client-reference-manifest.js`);
  if (!existsSync(f)) return { js: [], css: [] };
  const sandbox = {}; sandbox.globalThis = sandbox;
  try { runInNewContext(readFileSync(f, 'utf8'), sandbox, { timeout: 5000 }); } catch (e) { fail(`cannot read ${f}: ${e.message}`); }
  const js = new Set(); const css = new Set();
  for (const m of Object.values(sandbox.__RSC_MANIFEST ?? {})) {
    for (const list of Object.values(m?.entryJSFiles ?? {})) for (const p of list) js.add(p);
    for (const list of Object.values(m?.entryCSSFiles ?? {})) for (const c of list) if (!c.inlined) css.add(c.path);
  }
  return { js: [...js], css: [...css] };
}

function main(argv) {
  const args = [...argv]; let budgetPath = null; const pos = [];
  while (args.length) {
    const a = args.shift();
    if (a === '--budget') { budgetPath = args.shift() ?? fail('--budget needs a file'); } else pos.push(a);
  }
  if (pos.length !== 1) fail('usage: node scripts/bundle-budget.mjs <buildDir> [--budget <file>]');
  const buildDir = resolve(pos[0]);
  if (!existsSync(buildDir) || !statSync(buildDir).isDirectory()) fail(`build directory not found: ${buildDir} (run next build first)`);
  const budget = loadBudget(resolve(budgetPath ?? join(dirname(fileURLToPath(import.meta.url)), 'bundle-budget.json')));
  const manifest = readJson(join(buildDir, 'build-manifest.json'), 'build manifest');
  const params = manifest.pagesChunkGroupBootstrapParams ?? {};
  const root = [...(manifest.polyfillFiles ?? []), ...(manifest.rootMainFiles ?? [])];

  const gzCache = new Map();
  const gzKb = (p) => {
    if (!gzCache.has(p)) {
      const f = join(buildDir, p);
      if (!existsSync(f)) fail(`chunk listed in the manifest is missing on disk: ${p}`);
      gzCache.set(p, gzipSync(readFileSync(f)).length / KB);
    }
    return gzCache.get(p);
  };

  const routes = Object.keys(params).sort();
  for (const e of budget.entry_routes) if (!(e in params)) fail(`entry route ${e} is not in the build manifest`);
  const files = new Map();
  for (const r of routes) {
    const extra = clientManifestChunks(buildDir, r);
    files.set(r, [...new Set([...root, ...(params[r].otherChunks ?? []), ...extra.js, ...extra.css])]);
  }
  const entryUnion = new Set(budget.entry_routes.flatMap((e) => files.get(e)));

  const sum = (list) => list.reduce((s, p) => s + gzKb(p), 0);
  let over = false;
  const lines = [];
  for (const r of routes) {
    const lim = { ...budget, ...(budget.overrides[r] ?? {}) };
    const all = files.get(r);
    const js = all.filter((p) => p.endsWith('.js'));
    const isEntry = budget.entry_routes.includes(r);
    const jsKb = sum(js);
    const extraKb = sum(js.filter((p) => !entryUnion.has(p)));
    const cssKb = sum(all.filter((p) => p.endsWith('.css')));
    const reqs = all.length;
    const bad = [];
    if (isEntry && jsKb > lim.first_load_js_kb) bad.push(`js>${lim.first_load_js_kb}`);
    if (!isEntry && extraKb > lim.route_extra_js_kb) bad.push(`extra>${lim.route_extra_js_kb}`);
    if (cssKb > lim.css_kb) bad.push(`css>${lim.css_kb}`);
    if (reqs > lim.requests) bad.push(`req>${lim.requests}`);
    if (bad.length) over = true;
    lines.push(`${bad.length ? 'OVER' : 'ok  '}  ${jsKb.toFixed(1).padStart(7)} KB js  ${extraKb.toFixed(1).padStart(6)} KB extra  ${cssKb.toFixed(1).padStart(5)} KB css  ${String(reqs).padStart(3)} req  ${isEntry ? '[entry] ' : ''}${r}${bad.length ? `  (${bad.join(', ')})` : ''}`);
  }
  console.log('status   first-load   extra-vs-entry   css   requests   route');
  for (const l of lines) console.log(l);
  console.log(over ? `FAIL: over budget (${budget.first_load_js_kb} KB entry / ${budget.route_extra_js_kb} KB extra / ${budget.css_kb} KB css / ${budget.requests} req)` : 'PASS: all routes within budget');
  return over ? 1 : 0;
}

try { process.exitCode = main(process.argv.slice(2)); } catch (e) {
  console.error(`bundle-budget: ${e instanceof UsageError ? e.message : `unexpected error: ${e?.message ?? e}`}`);
  process.exitCode = 2;
}
