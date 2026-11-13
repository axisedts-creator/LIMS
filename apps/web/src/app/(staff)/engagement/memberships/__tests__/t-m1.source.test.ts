// T-M1 static checks on the W10 source (04-UI-UX §1/§2.4/§3 W10; 07-SECURITY card token = secret; LD-140 design rules; ownership = app/(staff)/engagement/memberships/**).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = (d: string): string[] => readdirSync(d).flatMap((n) => {
  const p = join(d, n);
  return n === '__tests__' ? [] : statSync(p).isDirectory() ? files(p) : [p];
});
const src = () => (existsSync(join(dir, 'page.tsx')) ? files(dir) : (() => { throw new Error('W10 source missing: memberships/page.tsx'); })()).filter((f) => /\.(tsx?|mjs|css)$/.test(f)).map((f) => ({ f, t: readFileSync(f, 'utf8') }));
const all = () => src().map((s) => s.t).join('\n');

describe('W10 source', () => {
  it('route and view exist: page.tsx + MembershipsView.tsx + actions.ts under (staff)/engagement/memberships', () => {
    for (const n of ['page.tsx', 'MembershipsView.tsx', 'actions.ts']) expect(existsSync(join(dir, n)), n).toBe(true);
  });
  it('every server action / BFF module is server-only or a use-server file (the JWT never reaches the browser)', () => {
    for (const { f, t } of src().filter(({ f }) => /actions?\.ts$|\.server\.ts$/.test(f))) expect(t, f).toMatch(/'use server'|import 'server-only'/);
  });
  it('no browser storage, no raw HTML injection, no console output (scanned values are never logged — 04-UI-UX §2.4)', () => {
    for (const { f, t } of src()) {
      expect(t, f).not.toMatch(/localStorage|sessionStorage|indexedDB/);
      expect(t, f).not.toMatch(/dangerouslySetInnerHTML|\.innerHTML\s*=/);
      expect(t, f).not.toMatch(/console\./);
    }
  });
  it('W10 scanner field: BarcodeInput from the kit with pattern /^[0-9A-Z]{26}$|^MB[0-9]{8}$/, minScanLength 10 and the label "Scan or type a membership card"', () => {
    const t = all();
    expect(t).toMatch(/BarcodeInput/);
    expect(t.replace(/\s+/g, '')).toContain('/^[0-9A-Z]{26}$|^MB[0-9]{8}$/');
    expect(t).toMatch(/minScanLength\s*=\s*\{\s*10\s*\}/);
    expect(t).toContain('Scan or type a membership card');
  });
  it('writes and lookups use the spec routes only (M1a/M1b, M2, M4, M5); no other mutation path; the card token never goes into a URL', () => {
    const t = all();
    for (const r of ['/v1/engagement/membership-plans', '/v1/engagement/memberships/lookup', '/v1/engagement/memberships']) expect(t, r).toContain(r);
    expect(t).not.toMatch(/\/v1\/engagement\/(bookings|queue|link-codes|settings|reminders)/);
    expect(t).not.toMatch(/memberships\/lookup\?|`[^`]*memberships[^`]*\$\{[^}]*(token|card)/i);
  });
  it('LD-140 design rules: kit components only, no hex colours, no pixel radii, no inline style objects; help key engagement.memberships (04-UI-UX §8)', () => {
    const t = all();
    expect(t).toMatch(/@lims\/ui/);
    for (const { f, t: x } of src()) {
      expect(x, f).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(x, f).not.toMatch(/style=\{\{/);
      expect(x, f).not.toMatch(/border-?[rR]adius\s*[:=]\s*['"`]?\d+px/);
    }
    expect(t).toMatch(/engagement\.memberships/);
  });
  it('the card token is never rendered as text: no JSX output of card_token / cardToken', () => {
    for (const { f, t } of src().filter(({ f }) => /\.tsx$/.test(f))) expect(t, f).not.toMatch(/>\s*\{[^}<>]*(card_token|cardToken)[^}<>]*\}\s*</);
  });
  it('permission gating uses the three spec permissions', () => {
    const t = all();
    for (const p of ['engagement.membership.read', 'engagement.membership.enrol', 'engagement.membership_plan.manage']) expect(t, p).toContain(p);
  });
});
