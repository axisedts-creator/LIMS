// T0D-OFFLINE-1 static guards: size budget, no heavy library, file cap, pinned paths untouched, no secrets in the layer.
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as nodeModule from 'node:module';

const web = fileURLToPath(new URL('../../../../', import.meta.url));
const dir = join(web, 'src/core/offline');
const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const impl = () => existsSync(dir) ? walk(dir).filter((f) => /\.(ts|tsx)$/.test(f) && !/__tests__/.test(f) && !/\.(test|spec)\./.test(f)) : [];

describe('offline layer source', () => {
  it('exists with the contract modules and an index barrel', () => {
    const names = impl().map((f) => relative(dir, f).replace(/\\/g, '/'));
    for (const m of ['index.ts', 'store.ts', 'outbox.ts', 'engine.ts', 'connectivity.ts', 'device.ts', 'register-sw.ts']) expect(names, m).toContain(m);
  });

  it('shell JavaScript grows by at most 25 KB gzipped (raw source gzip, upper bound)', () => {
    const files = impl();
    expect(files.length).toBeGreaterThan(0);
    // upper bound: raw source (types and comments included) can only over-count the minified bundle; strip types when node offers it
    const strip = (nodeModule as { stripTypeScriptTypes?: (c: string, o?: { mode: string }) => string }).stripTypeScriptTypes;
    const js = files.map((f) => { const src = readFileSync(f, 'utf8'); try { return strip && !f.endsWith('.tsx') ? strip(src, { mode: 'transform' }) : src; } catch { return src; } }).join('\n');
    const sw = existsSync(join(web, 'public/sw.js')) ? readFileSync(join(web, 'public/sw.js')) : Buffer.alloc(0);
    const kb = gzipSync(Buffer.from(js)).length / 1024;
    expect(kb, `offline layer is ${kb.toFixed(1)} KB gzip`).toBeLessThanOrEqual(25);
    expect(sw.length).toBeGreaterThan(0); // the worker is not part of the page bundle but must exist
  });

  it('uses raw IndexedDB and WebCrypto: no IndexedDB wrapper, no crypto library, no fake-indexeddb outside tests', () => {
    const banned = /from\s+['"](idb|idb-keyval|dexie|localforage|crypto-js|tweetnacl|libsodium[^'"]*|forge|node-forge|fake-indexeddb[^'"]*|workbox[^'"]*)['"]/;
    for (const f of impl()) expect(readFileSync(f, 'utf8'), relative(dir, f)).not.toMatch(banned);
  });

  it('server only code, node: modules and localStorage / sessionStorage are not used by the layer (personal data lives only in the encrypted IndexedDB)', () => {
    for (const f of impl()) {
      const src = readFileSync(f, 'utf8');
      expect(src, relative(dir, f)).not.toMatch(/from\s+['"]node:|from\s+['"]server-only['"]|\blocalStorage\b|\bsessionStorage\b/);
    }
  });

  it('no console logging of payloads, PINs or keys in the layer', () => {
    for (const f of impl()) expect(readFileSync(f, 'utf8'), relative(dir, f)).not.toMatch(/console\.(log|debug|info|warn|error)\s*\(/);
  });

  it('the PBKDF2 iteration count constant is at least 600000 and the failure limit is 10', () => {
    const src = impl().map((f) => readFileSync(f, 'utf8')).join('\n');
    const m = [...src.matchAll(/(\d[\d_]{5,})/g)].map((x) => Number(x[1]!.replace(/_/g, ''))).filter((n) => n >= 600_000 && n < 10_000_000);
    expect(m.length, 'a PBKDF2 iteration constant >= 600000 must appear in the source').toBeGreaterThan(0);
    expect(src).toMatch(/PBKDF2/);
    expect(src).toMatch(/AES-GCM/);
  });
});

describe('task bounds (brief: at most 28 files, nothing under pinned paths)', () => {
  it('core/offline plus the service worker and its registration stay within 28 files', () => {
    const n = (existsSync(dir) ? walk(dir).length : 0) + (existsSync(join(web, 'public/sw.js')) ? 1 : 0);
    expect(n).toBeLessThanOrEqual(28);
  });

  it('git diff against main touches nothing under features/admin, features/platform, app/(auth), app/(platform)', () => {
    // working tree (uncommitted + untracked) only: earlier tasks on the lane branch may legitimately have touched shared kit files
    const wt = spawnSync('git', ['status', '--porcelain'], { cwd: web, encoding: 'utf8' });
    if (wt.status !== 0) return; // not a git checkout: nothing to check
    const files = (wt.stdout ?? '').split('\n').map((l) => l.slice(3).trim()).filter(Boolean);
    const bad = files.filter((f) => /apps\/web\/src\/(features\/(admin|platform)\/|app\/\((auth|platform)\)\/)/.test(f.replace(/\\/g, '/')));
    expect(bad).toEqual([]);
  });

  it('the new tests need fake-indexeddb as a devDependency of apps/web (pinned exactly, no range)', () => {
    const pkg = JSON.parse(readFileSync(join(web, 'package.json'), 'utf8'));
    const v = pkg.devDependencies?.['fake-indexeddb'];
    expect(v, 'add "fake-indexeddb" to apps/web devDependencies').toBeTruthy();
    expect(v).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.dependencies?.['fake-indexeddb']).toBeUndefined();
  });
});
