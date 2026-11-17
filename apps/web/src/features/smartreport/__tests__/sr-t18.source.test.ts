// C14.T18 — structure / security of the SR-01 route files (app/(staff)/smartreport/summaries/{page,loading,error}.tsx) and the feature sources
// (07-SECURITY: no raw HTML injection, no PHI in URLs or storage, token stays server side; 04-UI-UX: composed only from @lims/ui, no raw <table>).
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const app = fileURLToPath(new URL('../../../app/(staff)/smartreport/', import.meta.url));
const feat = fileURLToPath(new URL('../', import.meta.url));
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? (n === '__tests__' ? [] : walk(p)) : [p]; });
const sources = () => walk(feat).filter((p) => /\.(ts|tsx)$/.test(p));
const read = (f: string) => readFileSync(join(app, f), 'utf8');

describe('route files', () => {
  it('summaries/{page,loading,error}.tsx exist', () => {
    for (const f of ['page', 'loading', 'error']) expect(existsSync(join(app, 'summaries', `${f}.tsx`)), `${f}.tsx`).toBe(true);
  });

  it('page.tsx is a server component with a default export (no "use client")', () => {
    const s = read('summaries/page.tsx');
    expect(s).not.toMatch(/['"]use client['"]/);
    expect(strip(s)).toMatch(/export default/);
  });

  it('error.tsx is a client component (Next requirement) and loading.tsx is not', () => {
    expect(read('summaries/error.tsx')).toMatch(/['"]use client['"]/);
    expect(read('summaries/loading.tsx')).not.toMatch(/['"]use client['"]/);
  });
});

describe('SR-01 sources (features/smartreport/**, tests excluded)', () => {
  const files = () => [...sources(), ...['summaries/page.tsx', 'summaries/loading.tsx', 'summaries/error.tsx'].map((f) => join(app, f)).filter(existsSync)];

  it('the queue has a feature nav manifest', () => { expect(existsSync(join(feat, 'nav.manifest.ts'))).toBe(true); });

  it('no raw HTML injection, no browser storage, no hand-built bearer header, no eval', () => {
    expect(files().length).toBeGreaterThan(0);
    for (const p of files()) {
      const s = strip(readFileSync(p, 'utf8'));
      expect(s, p).not.toMatch(/dangerouslySetInnerHTML|\binnerHTML\b|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function\(/);
      expect(s, p).not.toMatch(/localStorage|sessionStorage|document\.cookie/);
      expect(s, p).not.toMatch(/Bearer /);
    }
  });

  it('the queue component uses the kit DataTable (no hand-rolled <table>) and the kit KeyboardShortcutsDialog', () => {
    const joined = sources().map((p) => strip(readFileSync(p, 'utf8'))).join('\n');
    expect(joined).toMatch(/@lims\/ui\/components\/DataTable/);
    expect(joined).toMatch(/@lims\/ui\/components\/KeyboardShortcutsDialog/);
    expect(joined).toMatch(/@lims\/ui\/components\/FilterBar/);
    for (const p of sources().filter((x) => /summar|queue/i.test(x) && x.endsWith('.tsx'))) expect(strip(readFileSync(p, 'utf8')), p).not.toMatch(/<table[\s>]/);
  });

  it('PHI (registration no., patient name) is never put into a URL: no template literal builds a href/push from those fields', () => {
    for (const p of sources().filter((x) => x.endsWith('.tsx') || x.endsWith('.ts'))) {
      const s = strip(readFileSync(p, 'utf8'));
      expect(s, p).not.toMatch(/(push|replace|href)[^\n;]*\$\{[^}]*(registration_no|patient_display_name)/);
    }
  });

  it('server-side data code imports server-only (token and fetch stay on the server) and the summaries read is server-only', () => {
    const serverFiles = sources().filter((p) => /[\\/]server[\\/]/.test(p) && /serverFetch|getAccessToken/.test(readFileSync(p, 'utf8')) && /smartreport\/summaries/.test(readFileSync(p, 'utf8')));
    expect(serverFiles.length).toBeGreaterThan(0);
    for (const p of serverFiles) expect(readFileSync(p, 'utf8'), p).toMatch(/import ['"]server-only['"]/);
    const clientQueue = sources().filter((x) => /summar|queue/i.test(x) && x.endsWith('.tsx') && /['"]use client['"]/.test(readFileSync(x, 'utf8')));
    expect(clientQueue.length).toBeGreaterThan(0); // the queue/filters/shortcuts are a client component
    for (const p of clientQueue) expect(strip(readFileSync(p, 'utf8')), p).not.toMatch(/serverFetch|server-fetch|\bfetch\(|\/v1\//);
  });
});
