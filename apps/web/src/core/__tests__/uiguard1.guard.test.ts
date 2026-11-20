// T0D-UIGUARD-1 (LD-353): every staff page keeps to the six template rules. Walks the nav manifest (core/nav/generated.ts) and the page sources under
// app/(staff); fails when a page (1) has no kit PageHeader, (2) hand builds a filter row, (3) declares font-weight 600/700 or a px control height in its
// own CSS, (4) shows a raw error page for a failed read, (5) hides its table header when empty, (6) draws a chart without ChartCard.
// Pages that cannot follow a rule are listed by route in uiguard1.exceptions.ts (and in notes/T0D-UIGUARD-1-exceptions.md). Run: UIGUARD_REPORT=1 for the full list.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { navEntries } from '@/core/nav/generated';
import { EXCEPTIONS as CORE_EXCEPTIONS } from './uiguard1.exceptions';
import { ROOT,RULES, RULE_TEXT, STAFF, analyse, routeMatches, walkPages, type GuardException, type Rule } from './uiguard1.helpers';

const featureModules = import.meta.glob<{ EXCEPTIONS: GuardException[] }>('/src/features/*/__tests__/uiguard1.exceptions.ts', { eager: true });
const EXCEPTIONS: GuardException[] = [...CORE_EXCEPTIONS, ...Object.values(featureModules).flatMap((m) => m.EXCEPTIONS ?? [])];

const pages = walkPages();
const { findings, sources } = analyse(pages);
const NOTES = join(ROOT, 'notes', 'T0D-UIGUARD-1-exceptions.md');

const excused = (route: string, rule: Rule) => EXCEPTIONS.some((e) => e.rule === rule && routeMatches(e.route, route));
const offenders = (rule: Rule) =>
  [...findings.entries()]
    .filter(([route, byRule]) => byRule.has(rule) && !excused(route, rule))
    .map(([route, byRule]) => `${route}  ->  ${byRule.get(rule)!.slice(0, 3).join(' | ')}`)
    .sort();

describe('uiguard1: the walk covers the staff app', () => {
  it('finds the staff pages and the nav manifest', () => {
    expect(pages.length).toBeGreaterThan(100);
    expect(navEntries.length).toBeGreaterThan(100);
    expect(existsSync(STAFF)).toBe(true);
  });

  it('every nav entry opens a page file or the placeholder catch-all (nothing is skipped by the walk)', () => {
    const routes = new Set(sources.keys());
    const dynamic = [...routes].filter((r) => r.includes('['));
    const missing = navEntries.filter((e) => {
      if (e.path.startsWith('/platform')) return false; // lives in app/(platform): pinned, not walked here
      const hit = routes.has(e.path) || dynamic.some((d) => new RegExp('^' + d.replace(/\[[^\]]+\]/g, '[^/]+') + '$').test(e.path));
      return !hit && !routes.has('/[...slug]');
    });
    expect(missing.map((e) => e.path)).toEqual([]);
  });

  it('a nav entry that has no page of its own is a placeholder screen: it must be an exception or get a page (rule 1)', () => {
    const own = [...sources.keys()].filter((r) => !r.includes('[...'));
    const matchesOwn = (path: string) => own.some((r) => r === path || (r.includes('[') && new RegExp('^' + r.replace(/\[[^\]]+\]/g, '[^/]+') + '$').test(path)));
    const placeholders = navEntries.filter((e) => !e.path.startsWith('/platform') && !matchesOwn(e.path)).map((e) => e.path);
    const open = placeholders.filter((p) => !EXCEPTIONS.some((e) => e.rule === 1 && routeMatches(e.route, p)));
    expect(open, 'nav entries served by the catch-all placeholder (h1 only, no PageHeader)').toEqual([]);
  });
});

describe('uiguard1: the six rules, per staff page', () => {
  for (const rule of RULES) {
    it(`rule ${rule}: every page ${RULE_TEXT[rule]}`, () => {
      const bad = offenders(rule);
      if (process.env['UIGUARD_REPORT']) console.log(`RULE ${rule}: ${bad.length}\n${bad.join('\n')}`);
      expect(bad, `rule ${rule} (${RULE_TEXT[rule]}): ${bad.length} page(s)`).toEqual([]);
    });
  }
});

describe('uiguard1: the exceptions list is honest', () => {
  it('every exception names a rule, a route that exists and a reason of at least 20 characters', () => {
    const known = [...sources.keys()];
    const bad = EXCEPTIONS.filter(
      (e) => !RULES.includes(e.rule) || e.reason.trim().length < 20 || !(known.some((r) => routeMatches(e.route, r)) || e.route.startsWith('/platform') || navEntries.some((n) => routeMatches(e.route, n.path))),
    );
    expect(bad.map((e) => `${e.route} rule ${e.rule}`)).toEqual([]);
  });

  it('only a real obstacle may be excepted: pinned admin/platform page, entry form, QueueBoard display, print stationery, a pending catch-all, a dated legacy baseline (LD-434) or a file owned by an open T0D task', () => {
    const REAL = /pinned|rs-c2\.static|registration entry form|QueueBoard|print stationery|label sheet|catch-all|legacy baseline LD-434, fix in T0D-UIGUARD-1-[A-Z]+|owned by T0D-[A-Z0-9-]+/i;
    const bad = EXCEPTIONS.filter((e) => !REAL.test(e.reason));
    expect(bad.map((e) => `${e.route} rule ${e.rule}: ${e.reason}`)).toEqual([]);
  });

  it('a pinned page is excepted only for a rule it really breaks (no stale entry)', () => {
    const stale = EXCEPTIONS.filter((e) => {
      const hits = [...findings.entries()].filter(([route, by]) => routeMatches(e.route, route) && by.has(e.rule));
      return hits.length === 0;
    });
    expect(stale.map((e) => `${e.route} rule ${e.rule}`)).toEqual([]);
  });

  it('notes/T0D-UIGUARD-1-screens.md exists with one row per screen touched (route, template, changed, left and why)', () => {
    const f = join(ROOT, 'notes', 'T0D-UIGUARD-1-screens.md');
    expect(existsSync(f), 'notes/T0D-UIGUARD-1-screens.md must exist').toBe(true);
    expect(readFileSync(f, 'utf8')).toMatch(/route/i);
  });

  it('notes/T0D-UIGUARD-1-exceptions.md lists every exception on one line: the route and "rule N"', () => {
    expect(existsSync(NOTES), 'notes/T0D-UIGUARD-1-exceptions.md must exist').toBe(true);
    const lines = readFileSync(NOTES, 'utf8').split(/\r?\n/);
    const missing = EXCEPTIONS.filter((e) => !lines.some((l) => l.includes(e.route) && new RegExp(`\\brule ${e.rule}\\b`, 'i').test(l)));
    expect(missing.map((e) => `${e.route} rule ${e.rule}`)).toEqual([]);
  });
});
