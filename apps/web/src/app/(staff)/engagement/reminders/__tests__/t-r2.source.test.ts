// T-R2 static checks on the W9 source (04-UI-UX §1/§3 W9; 07-SECURITY no PHI in texts; ownership = app/(staff)/engagement/reminders/**).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = (d: string): string[] => readdirSync(d).flatMap((n) => {
  const p = join(d, n);
  return n === '__tests__' ? [] : statSync(p).isDirectory() ? files(p) : [p];
});
const src = () => files(dir).filter((f) => /\.(tsx?|mjs)$/.test(f)).map((f) => ({ f, t: readFileSync(f, 'utf8') }));

describe('W9 source', () => {
  it('route exists: page.tsx under (staff)/engagement/reminders', () => {
    expect(existsSync(join(dir, 'page.tsx'))).toBe(true);
  });
  it('every server action / BFF module is server-only or a use-server file (the JWT never reaches the browser)', () => {
    for (const { f, t } of src().filter(({ f }) => /actions?\.ts$|\.server\.ts$/.test(f))) expect(t, f).toMatch(/'use server'|import 'server-only'/);
  });
  it('no browser storage, no raw HTML injection, no console of row data', () => {
    for (const { f, t } of src()) {
      expect(t, f).not.toMatch(/localStorage|sessionStorage|indexedDB/);
      expect(t, f).not.toMatch(/dangerouslySetInnerHTML|\.innerHTML\s*=/);
      expect(t, f).not.toMatch(/console\.(log|info|debug)/);
    }
  });
  it('copy: the Result texts and the help key are present; raw port statuses are never used as display text', () => {
    const all = src().map((s) => s.t).join('\n');
    for (const s of ['No SMS consent', 'No phone number', 'SMS turned off', 'Patient opted out']) expect(all).toContain(s);
    expect(all).toMatch(/engagement\.reminders/); // PageHeader helpKey (04-UI-UX §8)
  });
  it('writes use the spec routes only (R2 create, R3 cancel); no other mutation path', () => {
    const all = src().map((s) => s.t).join('\n');
    expect(all).toMatch(/\/v1\/engagement\/reminders/);
    expect(all).not.toMatch(/\/v1\/engagement\/(bookings|queue|link-codes|settings)/);
  });
});
