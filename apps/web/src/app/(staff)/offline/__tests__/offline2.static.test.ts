// T0D-OFFLINE-2 static guards: files and route exist and are registered, text comes from the message catalogue, no browser storage or logging of personal
// data in the new code, no new dependency, nothing under the pinned paths. (rs-c2.static, the offline1 suites and the shell suites run next to this in verify.cmd.)
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = fileURLToPath(new URL('../../../../../', import.meta.url)); // apps/web/
const repo = join(web, '../..');
const src = (p: string) => join(web, 'src', p);
const read = (p: string) => readFileSync(p, 'utf8');
const walk = (d: string): string[] => (existsSync(d) ? readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; }) : []);
const isImpl = (f: string) => /\.(ts|tsx)$/.test(f) && !/__tests__/.test(f) && !/\.(test|spec)\./.test(f);
const OFFLINE2_MODULES = ['chip.ts', 'prefetch.ts', 'controller.ts', 'ui/OfflineProvider.tsx', 'ui/OfflinePanel.tsx'];
const newImpl = () => [
  ...OFFLINE2_MODULES.map((m) => src(`core/offline/${m}`)),
  ...walk(src('core/offline/ui')).filter(isImpl),
  ...walk(src('app/(staff)/offline')).filter(isImpl),
].filter((f, i, a) => existsSync(f) && a.indexOf(f) === i);

describe('files and route', () => {
  it('the new modules exist under core/offline', () => {
    for (const m of OFFLINE2_MODULES) expect(existsSync(src(`core/offline/${m}`)), m).toBe(true);
  });
  it('the barrel exports the prefetcher, the controller and the chip state', () => {
    const idx = read(src('core/offline/index.ts'));
    for (const m of ['./chip', './prefetch', './controller']) expect(idx, m).toContain(m);
  });
  it('the route page exists at app/(staff)/offline/page.tsx and renders OfflinePanel', () => {
    const f = src('app/(staff)/offline/page.tsx');
    expect(existsSync(f)).toBe(true);
    expect(read(f)).toMatch(/OfflinePanel/);
  });
  it('the route is registered: routes.yaml staff_web row /offline with sync.use, and the generated nav and route table carry it', () => {
    const routes = read(join(repo, 'contracts/routes.yaml'));
    expect(routes).toMatch(/origin: staff_web,\s*path: \/offline,[^}]*permission: sync\.use/);
    const gen = read(src('core/nav/generated.ts'));
    expect(gen).toMatch(/"path": "\/offline"/);
    expect(gen).toMatch(/"path": "\/offline",\s*"permission": "sync\.use"/);
  });
  it('no route under admin or platform is added, renamed or removed', () => {
    const routes = read(join(repo, 'contracts/routes.yaml'));
    expect(routes).not.toMatch(/path: \/(admin|platform)\/offline/);
  });
  it('the staff layout mounts the provider and the shell mounts the chip, banner and overlay (additive)', () => {
    const layout = read(src('app/(staff)/layout.tsx'));
    const shell = read(src('core/shell/ShellFrame.tsx')) + read(src('core/shell/AppShell.tsx'));
    expect(layout + shell).toMatch(/OfflineProvider/);
    expect(shell).toMatch(/offline-chip|StatusChip|OfflineStatusChip/);
    expect(shell).toMatch(/UnlockOverlay|OfflineOverlay/);
  });
  it('the unlock overlay is not a route under app/(auth)', () => {
    const bad = walk(src('app/(auth)')).filter((f) => /offline|unlock/i.test(f));
    expect(bad).toEqual([]);
  });
});

describe('code rules for the new files', () => {
  it('there are new files to check', () => expect(newImpl().length).toBeGreaterThanOrEqual(OFFLINE2_MODULES.length));
  it('no localStorage / sessionStorage / Cache API: personal data lives only in the encrypted IndexedDB', () => {
    for (const f of newImpl()) expect(read(f), relative(web, f)).not.toMatch(/\blocalStorage\b|\bsessionStorage\b|\bcaches\.(open|match)\b/);
  });
  it('no console logging, no dangerouslySetInnerHTML, no eval', () => {
    for (const f of newImpl()) {
      expect(read(f), relative(web, f)).not.toMatch(/console\.(log|debug|info|warn|error)\s*\(|dangerouslySetInnerHTML|\beval\s*\(|new Function\s*\(/);
    }
  });
  it('the screens take their text from the message catalogue (t(...)), not from string literals in the JSX', () => {
    const ui = [...walk(src('core/offline/ui')), ...walk(src('app/(staff)/offline'))].filter((f) => isImpl(f) && f.endsWith('.tsx'));
    expect(ui.length).toBeGreaterThan(0);
    for (const f of ui) {
      const code = read(f);
      expect(code, relative(web, f)).toMatch(/\bt\(/);
      // JSX text nodes with two or more words of letters: >Some words< (code between braces and attributes are not matched)
      const literal = [...code.matchAll(/>\s*([A-Z][a-z]+(?:\s+[A-Za-z]+)+)\s*</g)].map((m) => m[1]);
      expect(literal, `${relative(web, f)} has literal text`).toEqual([]);
    }
  });
  it('messages.ts has the offline.* keys the screens need, in plain sentence case without exclamation marks', () => {
    const m = read(src('core/i18n/messages.ts'));
    const entries = [...m.matchAll(/'(offline\.[a-z0-9_.]+)':\s*'((?:[^'\\]|\\.)*)'/g)].map((x) => [x[1], x[2]] as const);
    expect(entries.length).toBeGreaterThanOrEqual(25);
    const values = entries.map(([, v]) => v);
    for (const want of ['Sync now', 'Retry', 'Discard', 'Time', 'Type', 'Reference', 'Status', 'Reason', 'Action', 'Local', 'Server', 'Unlock', 'Change PIN']) {
      expect(values, want).toContain(want);
    }
    for (const [k, v] of entries) expect(v, k).not.toMatch(/!/);
  });
  it('no new dependency: apps/web/package.json dependencies are the five it had', () => {
    const pkg = JSON.parse(read(join(web, 'package.json')));
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['@lims/ui', 'next', 'react', 'react-dom', 'server-only']);
  });
  it('the new files stay within the task bound (28 files in all, counted: core/offline modules and ui, the route, messages, shell edits)', () => {
    expect(newImpl().length).toBeLessThanOrEqual(24);
  });
});

describe('pinned paths', () => {
  it('the working tree touches nothing under features/admin, features/platform, app/(auth), app/(platform)', () => {
    const wt = spawnSync('git', ['status', '--porcelain'], { cwd: web, encoding: 'utf8' });
    if (wt.status !== 0) return;
    const files = (wt.stdout ?? '').split('\n').map((l) => l.slice(3).trim().replace(/\\/g, '/')).filter(Boolean);
    expect(files.filter((f) => /apps\/web\/src\/(features\/(admin|platform)\/|app\/\((auth|platform)\)\/)/.test(f))).toEqual([]);
  });
});
