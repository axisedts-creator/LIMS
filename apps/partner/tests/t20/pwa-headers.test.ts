// C13.T20 — US-16.2 / 02-TRD §3.7 / REQ-SEC-088–092 / ST14: manifest, no-store on every authenticated response, CSP headers, offline page, logout purge.
// Browser automation is not installed in this repo; headers() of next.config.ts is resolved the way Next resolves it (path-to-regexp over each rule's `source`).
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import config from '../../next.config';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const require_ = createRequire(import.meta.url);

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const n of readdirSync(dir)) { const p = join(dir, n); statSync(p).isDirectory() ? walk(p, out) : out.push(p); }
  return out;
}

describe('manifest.webmanifest (02-TRD §2 tree)', () => {
  const file = join(ROOT, 'public/manifest.webmanifest');
  it('exists and is valid JSON with name "Partner portal", display standalone, start_url "/"', () => {
    expect(existsSync(file), 'apps/partner/public/manifest.webmanifest must exist').toBe(true);
    const m = JSON.parse(readFileSync(file, 'utf8'));
    expect(m.name).toBe('Partner portal');
    expect(m.display).toBe('standalone');
    expect(m.start_url).toBe('/');
  });
  it('icons are bundled (local files that exist; 192 and 512 present); no remote URLs anywhere', () => {
    const raw = readFileSync(file, 'utf8');
    expect(raw).not.toMatch(/https?:\/\//);
    const m = JSON.parse(raw);
    expect(Array.isArray(m.icons)).toBe(true);
    const sizes = m.icons.map((i: { sizes: string }) => i.sizes);
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');
    for (const i of m.icons) { expect(i.src).toMatch(/^\//); expect(existsSync(join(ROOT, 'public', i.src)), i.src).toBe(true); }
  });
});

describe('next.config.ts headers()', () => {
  type Rule = { source: string; headers: { key: string; value: string }[]; has?: unknown; missing?: unknown };
  const rulesP = async (): Promise<Rule[]> => { expect(typeof config.headers, 'next.config.ts must export headers()').toBe('function'); return (await config.headers!()) as Rule[]; };
  const match = (source: string, path: string) => {
    const mod = require_('next/dist/compiled/path-to-regexp') as { pathToRegexp: (s: string) => RegExp };
    return mod.pathToRegexp(source).test(path);
  };
  async function headersFor(path: string) {
    const out: Record<string, string[]> = {};
    for (const r of await rulesP()) if (match(r.source, path)) for (const h of r.headers) (out[h.key.toLowerCase()] ??= []).push(h.value);
    return out;
  }
  // Every authenticated page + BFF route in the app tree (partner routes: PH/PM/PO/PR/PS/PK/PU/PA/PX screens and BFF).
  const AUTHENTICATED = ['/', '/orders', '/orders/o-1', '/reports', '/reports/r-1', '/reports/r-1/slip', '/reports/r-1/slip/s-1/file', '/manifests', '/manifests/m-1', '/manifests/m-1/print', '/statements', '/statements/2026-11', '/pickups', '/pickups/new', '/price-list', '/referrers', '/users', '/account', '/auth/login', '/auth/mfa', '/auth/logout', '/auth/session-expired', '/api/bff/orders', '/api/bff/reports/r-1/download'];

  it('Cache-Control: no-store and Pragma: no-cache on every authenticated page and BFF response', async () => {
    for (const p of AUTHENTICATED) {
      const h = await headersFor(p);
      expect(h['cache-control']?.join(',') ?? '', p).toMatch(/no-store/i);
      expect(h['pragma']?.join(',') ?? '', p).toMatch(/no-cache/i);
    }
  });

  it('no static CSP in headers(): the CSP is per-request (nonce) and set by src/middleware.ts (REQ-SEC-088–092, 02-TRD §3.6)', async () => {
    for (const p of ['/', '/orders/o-1', '/auth/login']) {
      const h = await headersFor(p);
      expect(h['content-security-policy'] ?? [], p).toEqual([]);
      expect(h['content-security-policy-report-only'] ?? [], p).toEqual([]);
    }
  });

  it('keeps poweredByHeader off and no remote image hosts', () => {
    expect(config.poweredByHeader).toBe(false);
    expect(config.images?.remotePatterns ?? []).toEqual([]);
  });
});

describe('offline page, registration, logout purge (static source scan of src/)', () => {
  const src = walk(join(ROOT, 'src')).filter((f) => /\.(tsx?|jsx?)$/.test(f));
  const all = () => src.map((f) => ({ f, t: readFileSync(f, 'utf8') }));
  it('an /offline page exists under src/app', () => {
    expect(src.some((f) => /[\\/]offline[\\/]page\.tsx$/.test(f)), 'src/app/**/offline/page.tsx').toBe(true);
  });
  it('the manifest is linked and the service worker is registered at /sw.js with scope /', () => {
    expect(all().some(({ t }) => t.includes('manifest.webmanifest')), 'manifest linked').toBe(true);
    expect(all().some(({ t }) => /serviceWorker\s*\.\s*register\(\s*['"]\/sw\.js['"]/.test(t)), "serviceWorker.register('/sw.js')").toBe(true);
  });
  it('logout purges caches (caches.keys → delete) and clears sessionStorage (02-TRD §3.7, ST14)', () => {
    const hit = all().filter(({ t }) => /caches\s*\.\s*keys\(\)/.test(t) && /caches\s*\.\s*delete\(/.test(t));
    expect(hit.length, 'a module calling caches.keys() and caches.delete()').toBeGreaterThan(0);
    expect(hit.some(({ t }) => /sessionStorage\s*\.\s*clear\(\)/.test(t))).toBe(true);
  });
  it('localStorage is used only for lims.partner.density (non-PHI)', () => {
    for (const { f, t } of all()) for (const m of t.matchAll(/localStorage\s*\.\s*(?:get|set|remove)Item\(\s*([^,)]+)/g)) expect(m[1].trim(), f).toMatch(/lims\.partner\.density/);
  });
});
