// C13 T01: partner app scaffold. Spec: 02-TRD §3.6 (layout), §3.7 (PWA rules), 07-SECURITY (REQ-SEC-088..092, SEC-129 exact pins).
// done_when: "partner app renders a placeholder" — asserted structurally (no install/render needed): package, next.config.ts, a root layout + page.
// Run: node --test tests/scaffold.test.ts (node strips TS types natively), cwd apps/partner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const APP = join(import.meta.dirname, '..');
const read = (rel: string) => readFileSync(join(APP, rel), 'utf8');
const pkg = () => JSON.parse(read('package.json'));
const portal = JSON.parse(readFileSync(join(APP, '..', 'portal', 'package.json'), 'utf8'));

test('package.json: @lims/partner, private ESM, dev/build/typecheck scripts', () => {
  const p = pkg();
  assert.equal(p.name, '@lims/partner');
  assert.equal(p.private, true);
  assert.equal(p.type, 'module');
  for (const s of ['dev', 'build', 'typecheck']) assert.equal(typeof p.scripts?.[s], 'string', `script ${s}`);
  assert.match(p.scripts.build, /next build/);
});

test('package.json: every dependency is an exact pin or workspace:* (REQ-SEC-129), and next/react match the other Next app', () => {
  const p = pkg();
  for (const group of ['dependencies', 'devDependencies']) {
    for (const [name, v] of Object.entries<string>(p[group] ?? {})) {
      assert.ok(v === 'workspace:*' || /^\d+\.\d+\.\d+$/.test(v), `${group}.${name} = ${v} must be an exact version`);
    }
  }
  for (const d of ['next', 'react', 'react-dom']) assert.equal(p.dependencies?.[d], portal.dependencies[d], `${d} version equals apps/portal`);
  assert.equal(p.dependencies?.['@lims/ui'], 'workspace:*');
  assert.equal(p.dependencies?.['server-only'] !== undefined, true, 'server-only guard available for src/core/session.ts');
});

test('package.json: no install/lifecycle scripts that run code on install', () => {
  const s = pkg().scripts ?? {};
  for (const k of ['preinstall', 'install', 'postinstall', 'prepare']) assert.equal(s[k], undefined, k);
});

test('next.config.ts: standalone output, no X-Powered-By, no remote image hosts (TRD §3.6)', async () => {
  assert.ok(existsSync(join(APP, 'next.config.ts')), 'next.config.ts missing');
  const mod = await import(pathToFileURL(join(APP, 'next.config.ts')).href);
  const cfg = mod.default;
  assert.ok(cfg && typeof cfg === 'object', 'default export is the config object');
  assert.equal(cfg.output, 'standalone');
  assert.equal(cfg.poweredByHeader, false);
  const remote = cfg.images?.remotePatterns ?? [];
  assert.deepEqual(remote, [], 'no images from remote hosts');
  assert.ok(!cfg.images?.domains?.length, 'no images.domains');
});

test('placeholder: root layout and home page exist; page has a default export (PH-1 owns the content, TRD §3.6)', () => {
  for (const f of ['src/app/layout.tsx', 'src/app/(app)/page.tsx']) assert.ok(existsSync(join(APP, f)), `${f} missing`);
  const page = read('src/app/(app)/page.tsx');
  assert.match(page, /export\s+default\s+(async\s+)?function|export\s+default\s+/, 'page default export');
  const layout = read('src/app/layout.tsx');
  assert.match(layout, /export\s+default/, 'layout default export');
  assert.match(layout, /<html[\s>]/);
  assert.match(layout, /<body[\s>]/);
});

test('security: scaffold has no dangerouslySetInnerHTML, no localStorage/sessionStorage use, no eval, no hard-coded secret/URL (REQ-SEC-088, TRD §3.7)', () => {
  const files = ['src/app/layout.tsx', 'src/app/(app)/page.tsx', 'next.config.ts'];
  for (const f of files) {
    const t = read(f);
    assert.doesNotMatch(t, /dangerouslySetInnerHTML/, `${f}`);
    assert.doesNotMatch(t, /\b(localStorage|sessionStorage)\b/, `${f}`);
    assert.doesNotMatch(t, /\beval\s*\(|new Function\s*\(/, `${f}`);
    assert.doesNotMatch(t, /BEGIN [A-Z ]*PRIVATE KEY|https?:\/\/(?!localhost|127\.0\.0\.1)[a-z0-9.-]+\.[a-z]{2,}/i, `${f}: no secret or external URL`);
  }
});

test('security: placeholder never reads the BFF key or any LIMS_* secret into client-rendered code (no NEXT_PUBLIC_ secrets)', () => {
  for (const f of ['src/app/layout.tsx', 'src/app/(app)/page.tsx']) {
    const t = read(f);
    assert.doesNotMatch(t, /LIMS_PARTNER_BFF_KEY_FILE|NEXT_PUBLIC_[A-Z_]*(KEY|SECRET|TOKEN)/, f);
  }
  assert.doesNotMatch(read('next.config.ts'), /LIMS_PARTNER_BFF_KEY_FILE|NEXT_PUBLIC_[A-Z_]*(KEY|SECRET|TOKEN)/);
});
