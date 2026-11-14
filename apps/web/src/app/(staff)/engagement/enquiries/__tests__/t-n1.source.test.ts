// T-N1 static checks on the W11 source (04-UI-UX §1/§3 W11; 07-SECURITY §3 P3 free text; LD-140 design rules; ownership = app/(staff)/engagement/enquiries/**).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = (d: string): string[] => readdirSync(d).flatMap((n) => {
  const p = join(d, n);
  return n === '__tests__' ? [] : statSync(p).isDirectory() ? files(p) : [p];
});
const src = () => (existsSync(join(dir, 'page.tsx')) ? files(dir) : (() => { throw new Error('W11 source missing: enquiries/page.tsx'); })()).filter((f) => /\.(tsx?|mjs|css)$/.test(f)).map((f) => ({ f, t: readFileSync(f, 'utf8') }));
const all = () => src().map((s) => s.t).join('\n');

describe('W11 source', () => {
  it('route and views exist: page.tsx, [enquiry_id]/page.tsx, EnquiriesView.tsx, EnquiryThread.tsx, actions.ts', () => {
    for (const n of ['page.tsx', join('[enquiry_id]', 'page.tsx'), 'EnquiriesView.tsx', 'EnquiryThread.tsx', 'actions.ts']) expect(existsSync(join(dir, n)), n).toBe(true);
  });
  it('every server action / BFF module is server-only or a use-server file (the JWT never reaches the browser)', () => {
    for (const { f, t } of src().filter(({ f }) => /actions?\.ts$|\.server\.ts$/.test(f))) expect(t, f).toMatch(/'use server'|import 'server-only'/);
  });
  it('no browser storage, no raw HTML injection, no console output (enquiry text is P3)', () => {
    for (const { f, t } of src()) {
      expect(t, f).not.toMatch(/localStorage|sessionStorage|indexedDB/);
      expect(t, f).not.toMatch(/dangerouslySetInnerHTML|\.innerHTML\s*=/);
      expect(t, f).not.toMatch(/console\./);
    }
  });
  it('uses only the spec routes N1-N4 and the coded set; no other mutation path; text never in a URL', () => {
    const t = all();
    for (const r of ['/v1/engagement/enquiries', '/messages', '/close']) expect(t, r).toContain(r);
    expect(t).not.toMatch(/\/v1\/engagement\/(bookings|queue|link-codes|settings|reminders|memberships)/);
    expect(t).not.toMatch(/\/enquiries[^`'"]*\?[^`'"]*(message|body|subject)/i);
  });
  it('hotkeys of W11: Ctrl+Enter sends, Alt+X closes (04-UI-UX W11)', () => {
    const t = all();
    expect(t).toMatch(/ctrlKey|Control|mod\+enter/i);
    expect(t).toMatch(/altKey|alt\+x/i);
  });
  it('LD-140 design rules: kit components only, no hex colours, no pixel radii, no inline style objects; help key engagement.enquiries', () => {
    expect(all()).toMatch(/@lims\/ui/);
    for (const { f, t } of src()) {
      expect(t, f).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(t, f).not.toMatch(/style=\{\{/);
      expect(t, f).not.toMatch(/border-?[rR]adius\s*[:=]\s*['"`]?\d+px/);
    }
    expect(all()).toMatch(/engagement\.enquiries/);
  });
});
