// FD-T14 static guards (node env): route files, loading/error/not-found boundaries, server-component discipline, no browser storage / HTML injection, copy rules.
// 04-UI-UX §1 (every page has loading.tsx + error.tsx; PHI never in browser storage/titles; copy rules), 07-SECURITY REQ-SEC-088/098, 03-APP-FLOW §4.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/
const app = join(web, 'src', 'app', '(staff)', 'frontdesk');
const feat = join(web, 'src', 'features', 'frontdesk');
const PAGES = ['orders/[order_id]', 'patients/[patient_id]', 'worklist', 'discount-approvals'];
const COMPONENTS = ['OrderView', 'PatientView', 'FrontdeskWorklist', 'DiscountApprovalsInbox'];
const walk = (d: string): string[] => (existsSync(d) ? readdirSync(d).flatMap((n) => { const p = join(d, n); return n === '__tests__' || n === 'node_modules' ? [] : statSync(p).isDirectory() ? walk(p) : [p]; }) : []);
const own = () => [...walk(feat), ...PAGES.flatMap((p) => walk(join(app, ...p.split('/'))))].filter((f) => /\.(tsx?|mjs)$/.test(f));

describe('FD-T14 routes (04-UI-UX §4–§7)', () => {
  it.each(PAGES)('frontdesk/%s/page.tsx exists', (p) => {
    expect(existsSync(join(app, ...p.split('/'), 'page.tsx'))).toBe(true);
  });

  it.each(COMPONENTS)('features/frontdesk/components/%s.tsx exists', (c) => {
    expect(existsSync(join(feat, 'components', `${c}.tsx`))).toBe(true);
  });

  it.each(PAGES)('%s has loading.tsx (skeleton) and error.tsx (client boundary, no raw message/stack, shows digest) — 02-CV §2.4', (p) => {
    const d = join(app, ...p.split('/'));
    const own = (n: string) => existsSync(join(d, n)) || existsSync(join(app, n)); // a segment-level boundary at frontdesk/ also counts
    expect(own('loading.tsx')).toBe(true);
    expect(own('error.tsx')).toBe(true);
    const errFile = existsSync(join(d, 'error.tsx')) ? join(d, 'error.tsx') : join(app, 'error.tsx');
    if (existsSync(errFile)) {
      const src = readFileSync(errFile, 'utf8');
      expect(src).toMatch(/^['"]use client['"]/m);
      expect(src).not.toMatch(/error\.message|error\.stack/);
      expect(src).toMatch(/digest/);
    }
  });

  it('order page has not-found.tsx with "Order not found"; patient page has not-found.tsx (03-APP-FLOW §4: 404 states)', () => {
    const o = join(app, 'orders', '[order_id]', 'not-found.tsx');
    expect(existsSync(o)).toBe(true);
    expect(readFileSync(o, 'utf8')).toMatch(/Order not found/);
    expect(existsSync(join(app, 'patients', '[patient_id]', 'not-found.tsx'))).toBe(true);
  });

  it('pages are server components that read data through features/frontdesk/server/*.server.ts (BFF only, 02-CONVENTIONS §2.4) and pass session permissions down', () => {
    for (const p of PAGES) {
      const f = join(app, ...p.split('/'), 'page.tsx');
      if (!existsSync(f)) continue;
      const src = readFileSync(f, 'utf8');
      expect(src, p).not.toMatch(/^['"]use client['"]/m);
      expect(src, p).not.toMatch(/\bfetch\(/);
      expect(src, p).toMatch(/features\/frontdesk\/server\//);
      expect(src, p).toMatch(/getShellSession/);
    }
    expect(existsSync(join(feat, 'server'))).toBe(true);
  });

  it('write calls are server actions in features/frontdesk/server/actions.ts (mutations carry Idempotency-Key + If-Match from the client component)', () => {
    const f = join(feat, 'server', 'actions.ts');
    expect(existsSync(f)).toBe(true);
    const src = readFileSync(f, 'utf8');
    expect(src).toMatch(/^['"]use server['"]/m);
    for (const n of ['cancel', 'resolve', 'approve', 'reject']) expect(src.toLowerCase()).toContain(n);
  });
});

describe('FD-T14 privacy + safety (REQ-SEC-088, REQ-SEC-098, 04-UI-UX §1)', () => {
  it('no localStorage/sessionStorage/indexedDB/document.cookie in the code of these screens (PHI never in browser storage)', () => {
    const files = own();
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(readFileSync(f, 'utf8'), f).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
  });

  it('no dangerouslySetInnerHTML / innerHTML / eval in these screens (React text nodes only)', () => {
    const files = own();
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(readFileSync(f, 'utf8'), f).not.toMatch(/dangerouslySetInnerHTML|\.innerHTML\s*=|\beval\(|new Function\(/);
  });

  it('no PHI in page titles or URLs: pages do not build metadata/redirects from patient name/phone, and links use ids only', () => {
    for (const p of PAGES) {
      const f = join(app, ...p.split('/'), 'page.tsx');
      if (!existsSync(f)) continue;
      const src = readFileSync(f, 'utf8');
      expect(src, p).not.toMatch(/generateMetadata[\s\S]{0,400}(full_name|phone|email|patient_display)/);
    }
    for (const f of own().filter((x) => x.endsWith('.tsx'))) {
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/href=\{?[`'"][^`'"]*\$\{[^}]*(full_name|phone|email)/);
    }
  });

  it('no Storage URL reaches the browser: TRF preview goes through the BFF content route only', () => {
    for (const f of own()) expect(readFileSync(f, 'utf8'), f).not.toMatch(/supabase|createSignedUrl|storage\.googleapis|\.s3\.amazonaws/i);
  });

  it('copy rules (US-BL-16 CI scan, 04-UI-UX §1): never "IRD approved/certified", "approved by IRD", "commission"; uses of these in the shipped tree = failure; scan set must not be empty', () => {
    const files = own();
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(readFileSync(f, 'utf8'), f).not.toMatch(/IRD[ -]approved|IRD certified|approved by IRD|commission/i);
  });

  it('every message is English UI copy with no raw error codes hard-wired into rendered strings (codes are mapped to text)', () => {
    const files = own().filter((f) => f.endsWith('.tsx') && f.includes('components'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      // a literal like >frontdesk.order_not_editable< or "auth.mfa_required" inside JSX text would leak codes to users
      expect(src, f).not.toMatch(/>\s*(frontdesk|billing|auth|common)\.[a-z_]+\s*</);
    }
  });
});
