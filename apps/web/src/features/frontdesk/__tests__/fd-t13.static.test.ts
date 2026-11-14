// FD-T13 static guards (node env): route files, boundaries, privacy, copy, keyboard rules. 04-UI-UX §1 (every page has loading.tsx + error.tsx; no PHI in browser storage; copy rules; reserved keys).
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/
const route = join(web, 'src', 'app', '(staff)', 'frontdesk', 'registrations', 'new');
const feat = join(web, 'src', 'features', 'frontdesk');
const walk = (d: string): string[] => (existsSync(d) ? readdirSync(d).flatMap((n) => { const p = join(d, n); return n === '__tests__' || n === 'node_modules' ? [] : statSync(p).isDirectory() ? walk(p) : [p]; }) : []);
const code = () => [...walk(route), ...walk(feat)].filter((f) => /\.(tsx?|mjs)$/.test(f) && !/nav\.manifest/.test(f));

describe('FD-T13 route files (04-UI-UX §3; 02-CV §2.4)', () => {
  it('page.tsx, loading.tsx, error.tsx exist', () => {
    for (const f of ['page.tsx', 'loading.tsx', 'error.tsx']) expect(existsSync(join(route, f)), f).toBe(true);
  });
  it('page.tsx is a server component with a default export and never calls fetch() directly (BFF through features/frontdesk/server)', () => {
    const src = readFileSync(join(route, 'page.tsx'), 'utf8');
    expect(src).toMatch(/export default/);
    expect(src).not.toMatch(/^['"]use client['"]/m);
    expect(src).not.toMatch(/\bfetch\(/);
    expect(src).toMatch(/RegistrationForm/);
  });
  it('error.tsx is a client boundary that shows only the digest, never message/stack', () => {
    const src = readFileSync(join(route, 'error.tsx'), 'utf8');
    expect(src).toMatch(/^['"]use client['"]/m);
    expect(src).toMatch(/digest/);
    expect(src).not.toMatch(/error\.message|error\.stack/);
  });
  it('loading.tsx renders a kit LoadingSkeleton', () => {
    expect(readFileSync(join(route, 'loading.tsx'), 'utf8')).toMatch(/LoadingSkeleton/);
  });
  it('the form component + server files exist', () => {
    expect(existsSync(join(feat, 'components', 'RegistrationForm.tsx'))).toBe(true);
    expect(walk(join(feat, 'server')).length).toBeGreaterThan(0);
  });
});

describe('FD-T13 privacy, security, copy (04-UI-UX §1)', () => {
  it('no localStorage/sessionStorage/document.cookie/indexedDB in registration UI code (drafts live in memory only)', () => {
    const files = code();
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(readFileSync(f, 'utf8'), f).not.toMatch(/localStorage|sessionStorage|document\.cookie|indexedDB/);
  });
  it('no Supabase client, no public env, no Storage URLs in the browser (04 S4; 08 A13 P-2)', () => {
    for (const f of code()) expect(readFileSync(f, 'utf8'), f).not.toMatch(/@supabase|NEXT_PUBLIC_|createClient\(|\/storage\/v1\//);
  });
  it('server files import server-only; client components never import them directly without a "use server" action file', () => {
    for (const f of walk(join(feat, 'server')).filter((x) => /\.server\.tsx?$/.test(x))) expect(readFileSync(f, 'utf8'), f).toMatch(/import ['"]server-only['"]/);
    for (const f of walk(join(feat, 'server')).filter((x) => /actions\.ts$/.test(x))) expect(readFileSync(f, 'utf8'), f).toMatch(/^['"]use server['"]/m);
  });
  it('copy rules: never "IRD approved/certified", "approved by IRD", "commission"', () => {
    for (const f of code()) expect(readFileSync(f, 'utf8'), f).not.toMatch(/IRD[ -]approved|IRD certified|approved by IRD|commission/i);
  });
  it('reserved browser keys (F5, Ctrl+R/W/T/P) are never bound (04-UI-UX §1)', () => {
    for (const f of code()) {
      const s = readFileSync(f, 'utf8');
      expect(s, f).not.toMatch(/['"]F5['"]/);
      expect(s, f).not.toMatch(/ctrlKey[^;\n]{0,60}['"](r|w|t|p)['"]/i);
      expect(s, f).not.toMatch(/['"]Ctrl\+(R|W|T|P)['"]/);
    }
  });
  it('no window.print() on the page itself: printing goes through PrintFrame so the print count is recorded first', () => {
    for (const f of code()) if (!/PrintFrame/.test(readFileSync(f, 'utf8'))) expect(readFileSync(f, 'utf8'), f).not.toMatch(/window\.print\(/);
  });
  it('no money floats: paisa integers only (no parseFloat/Number(...)*100 on amounts)', () => {
    for (const f of code()) expect(readFileSync(f, 'utf8'), f).not.toMatch(/parseFloat\(|\*\s*100\b.*(amount|price|net)/i);
  });
});
