// C5.T-20 static checks on the grid sources (done_when: "uses UI kit EditableGrid and TimeSeriesChart"; 07-SECURITY S-14; REQ-SEC-068 JWT stays on the server).
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../components/grid/', import.meta.url));
const files = () => (existsSync(dir) ? readdirSync(dir).filter((f) => /\.tsx?$/.test(f)) : []);
const all = () => files().map((f) => readFileSync(dir + f, 'utf8')).join('\n');

describe('C5.T-20 grid sources', () => {
  it('ResultGrid.tsx exists and is a client component', () => {
    expect(existsSync(dir + 'ResultGrid.tsx')).toBe(true);
    expect(readFileSync(dir + 'ResultGrid.tsx', 'utf8').trimStart().startsWith("'use client'")).toBe(true);
  });
  it('uses the UI kit EditableGrid, TimeSeriesChart and KeyboardShortcutsDialog (no re-implementation)', () => {
    const src = all();
    expect(src).toMatch(/from '@lims\/ui\/components\/EditableGrid'/);
    expect(src).toMatch(/from '@lims\/ui\/components\/TimeSeriesChart'/);
    expect(src).toMatch(/from '@lims\/ui\/components\/KeyboardShortcutsDialog'/);
    expect(src).toMatch(/<EditableGrid\b/);
    expect(src).toMatch(/<TimeSeriesChart\b/);
  });
  it('no raw HTML injection, no direct fetch, no API origin / token in client code (calls go through server actions)', () => {
    const src = all();
    expect(src).not.toMatch(/dangerouslySetInnerHTML|innerHTML\s*=/);
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).not.toMatch(/LIMS_ORIGIN|Authorization|localStorage|sessionStorage/);
    expect(src).not.toMatch(/from '[^']*\.server'/);
  });
  it('LD-25 is cited in code (comment) where the downtime fields live', () => {
    expect(all()).toMatch(/LD-25/);
  });
});
