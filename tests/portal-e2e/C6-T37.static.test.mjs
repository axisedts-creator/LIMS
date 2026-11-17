// C6-T37 apps/portal app-link files + fallback pages (no browser). 01-PRD IS-24; 02-TRD §3.5; 03-APP-FLOW app-route fallbacks; 04-UI-UX §"App fallbacks"; 08 A13 D-38; review fix #31.
// Complements C6-T30.static.test.mjs (which only checks the well-known files exist and parse). Run: node --test tests/portal-e2e/C6-T37.static.test.mjs   Synthetic data only.
// Association files are client-supplied content inputs (store ids / fingerprints, founder decision 2026-11-06): with no entries the files must still be valid, and every entry that IS present
// must be well-formed and must cover BOTH the patient app (/app) and the phlebotomy app (/phlebo).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PORTAL = join(ROOT, 'apps', 'portal');
const SRC = join(PORTAL, 'src');
const WK = join(PORTAL, 'public', '.well-known');
const read = (...p) => readFileSync(join(PORTAL, ...p), 'utf8');
const walk = (d) => (existsSync(d) ? readdirSync(d).flatMap((n) => { const f = join(d, n); return statSync(f).isDirectory() ? walk(f) : [f]; }) : []);
const json = (n) => JSON.parse(readFileSync(join(WK, n), 'utf8'));

const REPORT_TEXT = 'Open the link the lab sent you to view this report.';
const APP_TEXT = 'Open the app to continue.';

test('assetlinks.json: JSON array of Digital Asset Links statements; android_app targets carry package_name + SHA-256 fingerprints (colon-hex)', () => {
  const a = json('assetlinks.json');
  assert.ok(Array.isArray(a), 'assetlinks.json must be a JSON array');
  for (const s of a) {
    assert.ok(Array.isArray(s.relation) && s.relation.includes('delegate_permission/common.handle_all_urls'), 'relation handle_all_urls');
    assert.equal(s.target?.namespace, 'android_app');
    assert.match(s.target?.package_name ?? '', /^[A-Za-z][\w]*(\.[A-Za-z][\w]*)+$/, 'package_name');
    assert.ok(Array.isArray(s.target?.sha256_cert_fingerprints) && s.target.sha256_cert_fingerprints.length > 0);
    for (const fp of s.target.sha256_cert_fingerprints) assert.match(fp, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/, 'SHA-256 cert fingerprint');
  }
});

test('apple-app-site-association: applinks.details[] entries have appIDs (TEAMID.bundle) and components/paths for BOTH /app/* and /phlebo/* (D-38); webcredentials.apps[] are appIDs', () => {
  const j = json('apple-app-site-association');
  assert.equal(typeof j, 'object'); assert.ok(j && !Array.isArray(j));
  assert.ok(Array.isArray(j.applinks?.details), 'applinks.details array');
  const appId = /^[A-Z0-9]{10}\.[A-Za-z][\w.-]*$/;
  const covers = (d, prefix) => JSON.stringify([d.components ?? [], d.paths ?? []]).includes(prefix);
  for (const d of j.applinks.details) {
    const ids = d.appIDs ?? (d.appID ? [d.appID] : []);
    assert.ok(ids.length > 0, 'appIDs'); for (const i of ids) assert.match(i, appId);
    assert.ok(covers(d, '/app'), 'entry must cover /app/*'); assert.ok(covers(d, '/phlebo'), 'entry must cover /phlebo/*');
  }
  for (const i of j.webcredentials?.apps ?? []) assert.match(i, appId);
});

test('both association files are free of PHI/secrets: no token-like path, no e-mail, no phone, no URL with credentials', () => {
  for (const n of ['assetlinks.json', 'apple-app-site-association']) {
    const raw = readFileSync(join(WK, n), 'utf8');
    assert.doesNotMatch(raw, /[\w.+-]+@[\w-]+\.[\w.]+/); assert.doesNotMatch(raw, /\+\d{8,}/); assert.doesNotMatch(raw, /\/(r|v)\/[A-Za-z0-9_-]{16,}/); assert.doesNotMatch(raw, /https?:\/\/[^/\s"]*:[^/\s"]*@/);
  }
});

test('/.well-known/apple-app-site-association is served as application/json (extensionless file; iOS requires it) and assetlinks.json is not rewritten into an HTML page', () => {
  const cfg = read('next.config.mjs');
  assert.match(cfg, /\/\.well-known\/apple-app-site-association/);
  assert.match(cfg, /application\/json/);
  const mw = read('src', 'middleware.ts');
  assert.doesNotMatch(mw, /\.well-known[^\n]*(redirect|rewrite)/i, 'the association files must not be redirected or rewritten by the edge');
});

test('/app/reports/{report_id}: data-free page "Open the link the lab sent you to view this report." (portal.report_link_required, review fix #31)', () => {
  const f = join(SRC, 'app', 'app', 'reports', '[report_id]', 'page.tsx');
  assert.ok(existsSync(f), 'page missing'); const s = readFileSync(f, 'utf8');
  assert.ok(s.includes(REPORT_TEXT)); assert.ok(s.includes('portal.report_link_required'), 'route fallback id named in the file');
  assertDataFree(s, f);
});

test('/app/* (e.g. /app/payments/{payment_request_id}/done) and /phlebo/*: data-free "Open the app to continue." fallback (portal.app_fallback, D-38)', () => {
  const f = join(SRC, 'app', 'app', '[...slug]', 'page.tsx');
  assert.ok(existsSync(f), 'app catch-all missing'); const s = readFileSync(f, 'utf8');
  assert.ok(s.includes(APP_TEXT)); assert.ok(s.includes('portal.app_fallback')); assertDataFree(s, f);
  // /phlebo/* is a separate URL prefix: either its own catch-all page, or an edge/config rewrite onto the /app fallback.
  const own = join(SRC, 'app', 'phlebo', '[...slug]', 'page.tsx');
  if (existsSync(own)) { const p = readFileSync(own, 'utf8'); assert.ok(p.includes(APP_TEXT), '/phlebo fallback text'); assertDataFree(p, own); return; }
  const cfg = read('next.config.mjs') + '\n' + read('src', 'middleware.ts');
  assert.match(cfg, /phlebo/, '/phlebo/* has neither src/app/phlebo/[...slug]/page.tsx nor a rewrite onto the /app fallback');
  assert.match(cfg, /rewrite/i);
});

test('fallback pages call no API and read no request data (no fetch, no server/api import, no cookies/headers, no params, no client JS)', () => {
  const pages = walk(join(SRC, 'app', 'app')).concat(walk(join(SRC, 'app', 'phlebo'))).filter((f) => /\.(tsx|ts)$/.test(f));
  assert.ok(pages.length >= 2);
  for (const f of pages) assertDataFree(readFileSync(f, 'utf8'), f);
});

function assertDataFree(s, f) {
  const code = s.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(code, /\bfetch\s*\(/, `${f}: fetch`);
  assert.doesNotMatch(code, /server\/(api|session)|from ['"]server-only['"]/, `${f}: API/session client`);
  assert.doesNotMatch(code, /\b(cookies|headers)\s*\(/, `${f}: request data`);
  assert.doesNotMatch(code, /^\s*['"]use client['"]/m, `${f}: client component`);
  assert.doesNotMatch(code, /\bparams\b|searchParams/, `${f}: must not render URL data (report id / slug) — no data, no echo`);
  assert.doesNotMatch(code, /dangerouslySetInnerHTML/, `${f}: raw HTML`);
}
