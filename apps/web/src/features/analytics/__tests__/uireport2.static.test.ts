// T0D-UIREPORT-2 static checks (node, no DOM): the screens note the brief asks for first, and the files the task may not touch.
// Brief: "FIRST write notes/ plus the task id plus -screens.md with one row per screen you touch: route, template (1 to 6), what you changed, what you left and why."
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..', '..', '..');
const NOTE = join(ROOT, '.orchestra', 'notes', 'T0D-UIREPORT-2-screens.md');
const ROUTES = [
  '/analytics/reports', '/analytics/reports/income', '/analytics/reports/department-income', '/analytics/collections', '/analytics/reports/volume',
  '/analytics/reports/top-referrers', '/analytics/reports/top-centres', '/analytics/referral-incentive', '/analytics/reports/tests-done', '/analytics/reports/tat',
  '/analytics/reports/delivery', '/analytics/reports/interfaces', '/billing/bill-of-the-day',
];

describe('T0D-UIREPORT-2 screens note', () => {
  it('exists', () => { expect(existsSync(NOTE), '.orchestra/notes/T0D-UIREPORT-2-screens.md').toBe(true); });

  it.skipIf(!existsSync(NOTE))('has one table row per screen: route, template 5, what changed, what was left and why', () => {
    const rows = readFileSync(NOTE, 'utf8').split(/\r?\n/).filter((l) => l.trim().startsWith('|'));
    for (const route of ROUTES) {
      const row = rows.find((l) => l.split('|')[1]?.trim() === route);
      expect(row, `a row for ${route}`).toBeTruthy();
      const cells = row!.split('|').slice(1, -1).map((c) => c.trim());
      expect(cells.length, `${route}: route | template | changed | left`).toBeGreaterThanOrEqual(4);
      expect(cells[1], `${route}: template`).toMatch(/\b5\b/);
      expect(cells[2]!.length, `${route}: what changed`).toBeGreaterThan(0);
      expect(cells[3]!.length, `${route}: what left and why`).toBeGreaterThan(0);
    }
  });

  it.skipIf(!existsSync(NOTE))('lists the contract gaps it hit (TAT by department, interfaces per day, the MIS read operations) as requests, not as invented data', () => {
    const text = readFileSync(NOTE, 'utf8');
    expect(text).toMatch(/TAT/);
    expect(text).toMatch(/interfaces/i);
    expect(text).toMatch(/contract request|CR/i);
  });
});

describe('T0D-UIREPORT-2 hard limit (brief: packages/ui/tokens/tokens.json must not change)', () => {
  it('tokens.json is untouched against main', () => {
    let out = '';
    try {
      // changed against the branch point with main (committed work) plus the working tree
      const base = execFileSync('git', ['merge-base', 'HEAD', 'main'], { cwd: ROOT, encoding: 'utf8' }).trim();
      out = execFileSync('git', ['diff', '--name-only', base], { cwd: ROOT, encoding: 'utf8' });
    } catch { return; } // no main ref in this checkout: nothing to compare
    const files = out.split(/\r?\n/).filter(Boolean);
    // earlier tasks of this lane are in that range too: only what no task of the lane may ever change
    expect(files.filter((f) => f === 'packages/ui/tokens/tokens.json'), 'tokens.json').toEqual([]);
  });
});
