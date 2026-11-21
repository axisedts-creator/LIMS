// T0D-UIGUARD-2 (LD-436 R7, LD-438, LD-439): rule 7 added = no raw h1 to h4 and no raw ul or ol for page structure in a staff page or the feature components it imports.
// T0D-UIGUARD-1 (LD-353): every staff page keeps to the six template rules. Walks the nav manifest (core/nav/generated.ts) and the page sources under
// app/(staff); fails when a page (1) has no kit PageHeader, (2) hand builds a filter row, (3) declares font-weight 600/700 or a px control height in its
// own CSS, (4) shows a raw error page for a failed read, (5) hides its table header when empty, (6) draws a chart without ChartCard, (7) writes a raw h1 to h4, ul or ol.
// Pages that cannot follow a rule are listed by route in uiguard1.exceptions.ts (and in notes/T0D-UIGUARD-1-exceptions.md). Run: UIGUARD_REPORT=1 for the full list.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { navEntries } from '@/core/nav/generated';
import { EXCEPTIONS as CORE_EXCEPTIONS } from './uiguard1.exceptions';
import { AREAS, PINNED7, ROOT, RULES, RULE_TEXT, STAFF, analyse, routeMatches, staleExceptions, unexcused, walkPages, type GuardException, type Rule } from './uiguard1.helpers';

const featureModules = import.meta.glob<{ EXCEPTIONS: GuardException[] }>('/src/features/*/__tests__/uiguard1.exceptions.ts', { eager: true });
const EXCEPTIONS: GuardException[] = [...CORE_EXCEPTIONS, ...Object.values(featureModules).flatMap((m) => m.EXCEPTIONS ?? [])];

const pages = walkPages();
const { findings, sources } = analyse(pages);
const NOTES = join(ROOT, 'notes', 'T0D-UIGUARD-1-exceptions.md');

const excused = (route: string, rule: Rule) => EXCEPTIONS.some((e) => e.rule === rule && routeMatches(e.route, route));
const offenders = (rule: Rule) => unexcused(findings, EXCEPTIONS, rule);

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

describe('uiguard1: the seven rules, per staff page', () => {
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
    const REAL = /pinned|rs-c2\.static|registration entry form|QueueBoard|print stationery|label sheet|catch-all|legacy baseline LD-43[46], fix in T0D-UIGUARD-1-[A-Z]+|owned by T0D-[A-Z0-9-]+/i;
    const bad = EXCEPTIONS.filter((e) => !REAL.test(e.reason));
    expect(bad.map((e) => `${e.route} rule ${e.rule}: ${e.reason}`)).toEqual([]);
  });

  it('a pinned page is excepted only for a rule it really breaks (no stale entry)', () => {
    const stale = staleExceptions(findings, EXCEPTIONS);
    expect(stale.map((e) => `${e.route} rule ${e.rule}`)).toEqual([]);
  });

  // T0D-UIGUARD-2 (3) and (5): LD-434 method for rule 7 = one entry per route, reason 'legacy baseline LD-436, fix in T0D-UIGUARD-1-<AREA>' with AREA one of the 18 of LD-439 (c).
  // Pinned rule 7 entries are only for app/(auth), app/(platform), features/platform and features/admin/auth; the admin screens are legacy (ADMIN), never pinned (LD-439 (d)).
  const rule7 = EXCEPTIONS.filter((e) => e.rule === 7);
  it('rule 7 entries: one per route (no wildcard), reason is the LD-436 legacy baseline of a known area, a print layout, or pinned for platform/auth only', () => {
    const LEGACY = new RegExp(`^legacy baseline LD-436, fix in T0D-UIGUARD-1-(${AREAS.join('|')})\\b`);
    const PIN = /^pinned\b.*(app\/\(auth\)|app\/\(platform\)|features\/platform|features\/admin\/auth)/i;
    const dupes = rule7.filter((e, i) => rule7.findIndex((o) => o.route === e.route) !== i).map((e) => e.route);
    expect(dupes, 'two rule 7 entries for one route').toEqual([]);
    expect(rule7.filter((e) => e.route.endsWith('/*')).map((e) => e.route), 'rule 7 has no wildcard entry').toEqual([]);
    const bad = rule7.filter((e) => !(LEGACY.test(e.reason) || /^print layout\b/i.test(e.reason) || /^catch-all placeholder\b/i.test(e.reason) || PIN.test(e.reason)));
    expect(bad.map((e) => `${e.route}: ${e.reason}`)).toEqual([]);
  });
  it('rule 7: a finding inside a pinned path (app/(auth), app/(platform), features/platform, features/admin/auth) is excused only by a pinned entry, never by a legacy one', () => {
    const inPinned = [...findings.entries()].filter(([, by]) => (by.get(7) ?? []).some((ev) => PINNED7.test('/src/' + (/ in (\S+)/.exec(ev)?.[1] ?? '')))).map(([route]) => route);
    for (const route of inPinned) expect(rule7.some((e) => routeMatches(e.route, route) && /^pinned\b/i.test(e.reason)), `${route}: pinned file, needs a pinned rule 7 entry`).toBe(true);
  });
  it('rule 7: an /admin route is legacy (ADMIN), never pinned (LD-439 d)', () => {
    expect(rule7.filter((e) => e.route.startsWith('/admin') && /pinned/i.test(e.reason)).map((e) => e.route)).toEqual([]);
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
