// C14.T20 — structure / security of the SR-03/SR-04 route files and the feature's component sources (07-SECURITY REQ 088/089: block text as text nodes only, no
// dangerouslySetInnerHTML; REQ 098: no PHI in URLs; C0 server-only rule). Paths: app/(staff)/smartreport/library/{page.tsx,[library_version_id]/page.tsx}, features/smartreport/**.
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const app = fileURLToPath(new URL('../../../app/(staff)/smartreport/', import.meta.url));
const feat = fileURLToPath(new URL('../', import.meta.url));
const ROUTES = ['library/page.tsx', 'library/[library_version_id]/page.tsx'];
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? (n === '__tests__' ? [] : walk(p)) : [p]; });
const sources = () => walk(feat).filter((p) => /\.(ts|tsx)$/.test(p));

describe('route files', () => {
  it.each(ROUTES)('%s exists, is a server component (no "use client") with a default export', (f) => {
    expect(existsSync(join(app, f))).toBe(true);
    const s = readFileSync(join(app, f), 'utf8');
    expect(s).not.toMatch(/['"]use client['"]/);
    expect(strip(s)).toMatch(/export default/);
  });
});

describe('feature sources (features/smartreport/**, tests excluded)', () => {
  it('there is feature code (not everything inlined in the routes)', () => { expect(sources().length).toBeGreaterThan(0); });

  it('no raw HTML injection, no browser storage, no hand-built bearer header, no eval', () => {
    expect(sources().length + ROUTES.filter((r) => existsSync(join(app, r))).length).toBeGreaterThan(0);
    for (const p of [...sources(), ...ROUTES.map((r) => join(app, r)).filter(existsSync)]) {
      const s = strip(readFileSync(p, 'utf8'));
      expect(s, p).not.toMatch(/dangerouslySetInnerHTML|\binnerHTML\b|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function\(/);
      expect(s, p).not.toMatch(/localStorage|sessionStorage|document\.cookie/);
      expect(s, p).not.toMatch(/Bearer /);
    }
  });

  it('server-side data code imports server-only (token and fetch stay on the server)', () => {
    const serverFiles = sources().filter((p) => /[\\/]server[\\/]/.test(p) && /server-fetch|serverFetch|getAccessToken/.test(readFileSync(p, 'utf8')));
    expect(serverFiles.length).toBeGreaterThan(0);
    for (const p of serverFiles) expect(readFileSync(p, 'utf8'), p).toMatch(/import ['"]server-only['"]/);
  });

  it('client components never import server-fetch / session internals', () => {
    expect(sources().some((p) => /^\s*['"]use client['"]/.test(strip(readFileSync(p, 'utf8')).trimStart()))).toBe(true);
    for (const p of sources()) {
      const s = readFileSync(p, 'utf8');
      if (!/^\s*['"]use client['"]/.test(strip(s).trimStart())) continue;
      expect(s, p).not.toMatch(/core\/api\/server-fetch|core\/session\/server/);
    }
  });

  it('no hex / rgb colours (kit tokens only) and no hard-coded wording of the placeholder allow-list drifting from the API (names appear only as {name} literals or in one table)', () => {
    expect(sources().some((x) => x.endsWith('.tsx'))).toBe(true);
    for (const p of sources().filter((x) => x.endsWith('.tsx'))) expect(strip(readFileSync(p, 'utf8')), p).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(/);
  });

  it('the follow-up banner text is verbatim from 04-UI-UX (conflict-of-interest wording)', () => {
    const all = sources().map((p) => readFileSync(p, 'utf8')).join('\n');
    expect(all).toContain('Follow-up suggestions are shown to patients. Keep them conservative; they must be justified by a finding. Prices and booking links are never shown.');
  });
});
