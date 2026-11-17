// BL-T20 static guards (node env): route files, loading/error boundaries, print template files, no browser storage, copy scan CI script.
// 04-UI-UX §1 (every page has loading.tsx + error.tsx; PHI never in browser storage), §8 (screens), TRD "CI jobs for C0-0A" c04-copy-scan.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/
const repo = join(web, '..', '..');
const app = join(web, 'src', 'app', '(staff)', 'billing');
const feat = join(web, 'src', 'features', 'billing');

// 04-UI-UX §8.1–§8.11 routes (billing/settings is the BL half of §8.11).
const PAGES = [
  'invoices', 'invoices/[invoice_id]', 'dues', 'daily-cash', 'credit-parties', 'credit-parties/[credit_party_id]',
  'registers', 'audit-trail', 'cbms', 'worklist', 'settings',
];
const walk = (d: string): string[] => (existsSync(d) ? readdirSync(d).flatMap((n) => { const p = join(d, n); return n === '__tests__' || n === 'node_modules' ? [] : statSync(p).isDirectory() ? walk(p) : [p]; }) : []);

describe('BL-T20 routes (04-UI-UX §8)', () => {
  it.each(PAGES)('billing/%s/page.tsx exists', (p) => {
    expect(existsSync(join(app, ...p.split('/'), 'page.tsx'))).toBe(true);
  });

  it('segment loading.tsx and error.tsx exist (02-CV §2.4); error boundary never prints raw message or stack', () => {
    expect(existsSync(join(app, 'loading.tsx'))).toBe(true);
    const err = join(app, 'error.tsx');
    expect(existsSync(err)).toBe(true);
    const src = readFileSync(err, 'utf8');
    expect(src).toMatch(/^['"]use client['"]/m);
    expect(src).not.toMatch(/error\.message|error\.stack/);
    expect(src).toMatch(/digest/);
  });

  it('every billing page is a server component (no "use client") and pulls data via .server functions', () => {
    for (const p of PAGES) {
      const f = join(app, ...p.split('/'), 'page.tsx');
      if (!existsSync(f)) continue;
      const src = readFileSync(f, 'utf8');
      expect(src, p).not.toMatch(/^['"]use client['"]/m);
      expect(src, p).not.toMatch(/\bfetch\(/); // BFF only through features/billing/server/*.server.ts (02-CONVENTIONS §2.4)
    }
  });
});

describe('BL-T20 print templates (04-UI-UX §8.3)', () => {
  it.each(['InvoicePrintView', 'CreditNotePrintView', 'ReceiptPrintView'])('features/billing/components/print/%s.tsx exists and uses PrintFrame', (n) => {
    const f = join(feat, 'components', 'print', `${n}.tsx`);
    expect(existsSync(f)).toBe(true);
    expect(readFileSync(f, 'utf8')).toMatch(/PrintFrame/);
  });
});

describe('BL-T20 privacy + copy', () => {
  it('no localStorage/sessionStorage/document.cookie in billing UI code (PHI never in browser storage; 04-UI-UX §1)', () => {
    const files = [...walk(feat), ...walk(app)].filter((f) => /\.(tsx?|mjs)$/.test(f));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(readFileSync(f, 'utf8'), f).not.toMatch(/localStorage|sessionStorage|document\.cookie/);
  });

  it('c04-copy-scan: `node copy-scan.mjs` exits 0 on the shipped tree (no "IRD approved", "commission", …)', () => {
    const r = spawnSync(process.execPath, [join(feat, '__tests__', 'copy-scan.mjs')], { cwd: repo, encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });
});
