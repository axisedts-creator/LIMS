// C14.T21 — structure / security of the SR-05, SR-06 route files and the review / wording / preview sources (07-SECURITY: block/term/preview text as text nodes only,
// no browser storage, no hand-built bearer header, token stays on the server; no PHI in URLs). Paths: app/(staff)/smartreport/{library/[library_version_id]/review,wording}/page.tsx, features/smartreport/**.
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const app = fileURLToPath(new URL('../../../app/(staff)/smartreport/', import.meta.url));
const feat = fileURLToPath(new URL('../', import.meta.url));
const ROUTES = ['library/[library_version_id]/review/page.tsx', 'wording/page.tsx'];
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? (n === '__tests__' ? [] : walk(p)) : [p]; });
const sources = () => walk(feat).filter((p) => /\.(ts|tsx)$/.test(p));
const isClient = (s: string) => /^\s*['"]use client['"]/.test(strip(s).trimStart());

describe('route files', () => {
  it.each(ROUTES)('%s exists, is a server component (no "use client") with a default export', (f) => {
    expect(existsSync(join(app, f))).toBe(true);
    const s = readFileSync(join(app, f), 'utf8');
    expect(s).not.toMatch(/['"]use client['"]/);
    expect(strip(s)).toMatch(/export default/);
  });
});

describe('feature sources', () => {
  it('review / wording / preview code exists in features/smartreport (not inlined in the routes)', () => {
    const all = sources().map((p) => readFileSync(p, 'utf8')).join('\n');
    expect(all).toMatch(/\/approve/);
    expect(all).toMatch(/\/return/);
    expect(all).toMatch(/\/preview/);
    expect(all).toMatch(/wording-deny-terms/);
  });

  it('no raw HTML injection, no browser storage, no hand-built bearer header, no eval (routes included)', () => {
    const files = [...sources(), ...ROUTES.map((r) => join(app, r)).filter(existsSync)];
    expect(files.length).toBeGreaterThan(0);
    for (const p of files) {
      const s = strip(readFileSync(p, 'utf8'));
      expect(s, p).not.toMatch(/dangerouslySetInnerHTML|\binnerHTML\b|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function\(/);
      expect(s, p).not.toMatch(/localStorage|sessionStorage|document\.cookie/);
      expect(s, p).not.toMatch(/Bearer /);
    }
  });

  it('client components never import server-fetch / session internals; the token never reaches the browser', () => {
    for (const p of sources()) {
      const s = readFileSync(p, 'utf8');
      if (!isClient(s)) continue;
      expect(s, p).not.toMatch(/core\/api\/server-fetch|core\/session\/server|getAccessToken|serverFetch/);
    }
  });

  it('the new mutating calls (approve, return, deny-term create/deactivate, preview) are made on the server only', () => {
    for (const p of sources()) {
      const s = strip(readFileSync(p, 'utf8'));
      if (!isClient(readFileSync(p, 'utf8'))) continue;
      expect(s, p).not.toMatch(/fetch\(\s*[`'"][^`'"]*\/v1\/smartreport/);
      expect(s, p).not.toMatch(/\/v1\/smartreport/);
    }
  });

  it('server actions for the new endpoints re-check their input (ids are UUID-shaped before they reach a URL)', () => {
    const actions = readFileSync(join(feat, 'server', 'actions.ts'), 'utf8');
    expect(actions).toMatch(/UUID_RE|isUuid|uuid/i);
    const all = sources().filter((p) => /[\\/]server[\\/]/.test(p)).map((p) => readFileSync(p, 'utf8')).join('\n');
    // an id or order id is never concatenated into a query string
    expect(strip(all)).not.toMatch(/\?[^`'"\n]*order_id=/);
  });

  it('no source logs request bodies, notes or comments', () => {
    for (const p of sources()) expect(strip(readFileSync(p, 'utf8')), p).not.toMatch(/console\.(log|info|debug)\([^)]*(body|note|comment|order_?id)/i);
  });
});
