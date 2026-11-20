// T0D-ELABMENU-1 (LD-340, founder 2026-11-17 20:37 NPT: keep the ElabAssist names and structure): the data of the ElabAssist sidebar, checked against the REAL generated manifest
// (run `pnpm --dir apps/web run build:nav` first; core/nav/generated.ts is gitignored).
// Contract of core/nav/elab-menu.ts: ELAB_GROUPS (order), ELAB_PLACE (entry id -> group, optional section, pos), fallbackGroup (manifest NavGroup -> elab group id).
// Presentation only: no route, permission or manifest change (AC-0D-7.1: the sidebar is a UI hint, the API enforces).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { navEntries } from '@/core/nav/generated';
import { ELAB_GROUPS, ELAB_PLACE, fallbackGroup } from '@/core/nav/elab-menu';
import { NAV_GROUPS } from '@/core/nav/types';
import { t } from '@/core/i18n/messages';

const ids = new Set(navEntries.map((e) => e.id));
const groupIds = ELAB_GROUPS.map((g) => g.id);
const src = readFileSync(join(import.meta.dirname, '..', 'elab-menu.ts'), 'utf8');

describe('ELAB_GROUPS: the ElabAssist order', () => {
  it('starts with Dashboard, Daily Work, Accounts, Reports, Administration, then the module groups', () => {
    expect(groupIds.slice(0, 5)).toEqual(['dashboard', 'daily_work', 'accounts', 'reports', 'administration']);
    expect(ELAB_GROUPS.slice(0, 5).map((g) => t(g.labelKey))).toEqual(['Dashboard', 'Daily Work', 'Accounts', 'Reports', 'Administration']);
    expect(groupIds.length).toBeGreaterThan(5);
    expect(new Set(groupIds).size, 'group ids are unique').toBe(groupIds.length);
  });

  it('every group has a translated label (no raw key shows in the sidebar)', () => {
    for (const g of ELAB_GROUPS) {
      expect(t(g.labelKey), g.id).not.toBe(g.labelKey);
      expect(t(g.labelKey).trim(), g.id).not.toBe('');
    }
  });

  it('only the Dashboard group is a plain link (direct); every other group is an accordion', () => {
    expect(ELAB_GROUPS.filter((g) => g.direct).map((g) => g.id)).toEqual(['dashboard']);
  });

  it('the Dashboard group holds exactly one entry: analytics.dashboard', () => {
    const inDash = [...ELAB_PLACE].filter(([, p]) => p.group === 'dashboard').map(([id]) => id);
    expect(inDash).toEqual(['analytics.dashboard']);
  });

  it('the module groups after Administration keep the module names of the 14 NavGroups', () => {
    const tail = ELAB_GROUPS.slice(5);
    for (const id of ['quality', 'inventory', 'partners', 'engagement', 'home_collection']) {
      const g = tail.find((x) => x.id === id);
      expect(g, id).toBeTruthy();
      expect(g!.labelKey).toBe(`core.nav.group.${id}`);
    }
  });
});

describe('ELAB_PLACE: placement of manifest entries', () => {
  it('every id in ELAB_PLACE exists in the generated manifest (no dead name, no typo)', () => {
    const dead = [...ELAB_PLACE.keys()].filter((id) => !ids.has(id));
    expect(dead).toEqual([]);
  });

  it('every placement names a group of ELAB_GROUPS', () => {
    for (const [id, p] of ELAB_PLACE) expect(groupIds, id).toContain(p.group);
  });

  it('positions are unique and in listing order, so the menu order is total', () => {
    const pos = [...ELAB_PLACE.values()].map((p) => p.pos);
    expect(new Set(pos).size).toBe(pos.length);
    expect(pos).toEqual([...pos].sort((a, b) => a - b));
  });

  it('an id is listed once in the slot table (a repeated id would silently move the entry)', () => {
    const body = src.slice(src.indexOf('const SLOTS'), src.indexOf('export interface ElabPlace'));
    const listed = [...body.matchAll(/'([a-z_]+\.[a-z_]+)'/g)].map((m) => m[1]!).filter((id) => !id.startsWith('core.'));
    const dup = listed.filter((id, i) => listed.indexOf(id) !== i);
    expect(dup).toEqual([]);
    expect(listed.length).toBe(ELAB_PLACE.size);
  });

  it('a section label is a translated key', () => {
    for (const [id, p] of ELAB_PLACE) if (p.section) expect(t(p.section), id).not.toBe(p.section);
  });

  it('the Administration group is sectioned like ElabAssist: User Management first, Audit last', () => {
    const secs: string[] = [];
    for (const p of [...ELAB_PLACE.values()].filter((x) => x.group === 'administration')) if (p.section && !secs.includes(p.section)) secs.push(p.section);
    expect(secs.map(t)).toEqual(['User Management', 'Ops Masters', 'Test Management', 'Accounting', 'Settings', 'Activity and audit']);
  });
});

describe('fallbackGroup: no screen can vanish', () => {
  it('maps every NavGroup of the manifest to a group of ELAB_GROUPS', () => {
    for (const g of NAV_GROUPS) expect(groupIds, g).toContain(fallbackGroup(g));
  });

  it('an unknown manifest group lands in "other" (More), never undefined', () => {
    expect(fallbackGroup('not_a_group')).toBe('other');
    expect(fallbackGroup('')).toBe('other');
    expect(groupIds).toContain('other');
  });

  it('every non-platform entry resolves to exactly one elab group', () => {
    for (const e of navEntries.filter((x) => x.group !== 'platform')) {
      const g = ELAB_PLACE.get(e.id)?.group ?? fallbackGroup(e.group);
      expect(groupIds, e.id).toContain(g);
    }
  });

  it('module groups keep their entries: a quality entry that is not listed stays under Quality', () => {
    expect(fallbackGroup('quality')).toBe('quality');
    expect(fallbackGroup('inventory')).toBe('inventory');
    expect(fallbackGroup('partners')).toBe('partners');
  });
});

describe('no route, permission or contract change (LD-340)', () => {
  it('elab-menu.ts holds no path and no permission code (presentation only)', () => {
    expect(src).not.toMatch(/['"]\/[a-z]/);
    expect(src).not.toMatch(/\.(read|create|update|manage|approve)['"]/);
  });
});
