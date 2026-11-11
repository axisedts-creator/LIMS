// C14 T05 — domain/groups.ts, organ-group tiles (02-TRD §4.3; AC-04.4).
// API pinned by these tests (spec gives no names):
//   buildPanels({ items, groups, language }) -> { panelCode, displayName, status, resultIds }[]
//     item  = { resultId, analyteId, groupCode, analyteSortOrder, status: 'in_range'|'borderline'|'out_of_range'|'critical' }
//     group = { groupCode, displayEn, displayNe?, sortOrder, isShown }   (score_weight is irrelevant to tiles)
//     language 'en' | 'ne'.
//   Tile only for isShown groups with >= 1 item; status = worst member; order = group sortOrder then groupCode;
//   resultIds order = analyteSortOrder then resultId. Items of hidden/unknown groups get no tile.
import { describe, expect, it } from 'vitest';
import { buildPanels } from '../groups.js';

type St = 'in_range' | 'borderline' | 'out_of_range' | 'critical';
const it_ = (resultId: string, groupCode: string, status: St, analyteSortOrder = 10) =>
  ({ resultId, analyteId: `A-${resultId}`, groupCode, analyteSortOrder, status });
const grp = (groupCode: string, sortOrder: number, o: Record<string, unknown> = {}) =>
  ({ groupCode, displayEn: `${groupCode} EN`, sortOrder, isShown: true, ...o });
const panels = (items: unknown[], groups: unknown[], language: 'en' | 'ne' = 'en') =>
  buildPanels({ items, groups, language } as never) as { panelCode: string; displayName: string; status: string; resultIds: string[] }[];

describe('tile status = worst member (§4.3)', () => {
  it.each<[St[], St]>([
    [['in_range', 'in_range'], 'in_range'],
    [['in_range', 'borderline'], 'borderline'],
    [['borderline', 'out_of_range', 'in_range'], 'out_of_range'],
    [['out_of_range', 'critical', 'borderline'], 'critical'],
  ])('%j -> %s', (statuses, expected) => {
    const items = statuses.map((s, i) => it_(`r${i}`, 'liver', s));
    expect(panels(items, [grp('liver', 1)])[0]?.status).toBe(expected);
  });
});

describe('which groups get a tile', () => {
  it('AC-04.4: is_shown=false group gets no tile; its items do not leak into other tiles', () => {
    const items = [it_('r1', 'liver', 'in_range'), it_('r2', 'iron', 'critical')];
    const out = panels(items, [grp('liver', 1), grp('iron', 2, { isShown: false })]);
    expect(out.map((p) => p.panelCode)).toEqual(['liver']);
    expect(out[0]?.status).toBe('in_range');
    expect(out[0]?.resultIds).toEqual(['r1']);
  });

  it('shown group with no members gets no tile (no "No Data" padding)', () => {
    const out = panels([it_('r1', 'liver', 'in_range')], [grp('liver', 1), grp('kidney', 2)]);
    expect(out.map((p) => p.panelCode)).toEqual(['liver']);
  });

  it('items whose group has no settings row get no tile', () => {
    expect(panels([it_('r1', 'mystery', 'critical')], [grp('liver', 1)])).toEqual([]);
  });

  it('no items -> no tiles', () => {
    expect(panels([], [grp('liver', 1)])).toEqual([]);
  });
});

describe('ordering (§4.3)', () => {
  it('panels by group sortOrder, then groupCode', () => {
    const items = ['c', 'b', 'a', 'z'].map((c, i) => it_(`r${i}`, c, 'in_range'));
    const groups = [grp('c', 1), grp('b', 5), grp('a', 5), grp('z', 0)];
    expect(panels(items, groups).map((p) => p.panelCode)).toEqual(['z', 'c', 'a', 'b']);
  });

  it('resultIds by analyteSortOrder, then resultId', () => {
    const items = [it_('r9', 'liver', 'in_range', 1), it_('r2', 'liver', 'in_range', 5), it_('r1', 'liver', 'in_range', 5)];
    expect(panels(items, [grp('liver', 1)])[0]?.resultIds).toEqual(['r9', 'r1', 'r2']);
  });

  it('is independent of input order', () => {
    const items = [it_('r1', 'a', 'in_range'), it_('r2', 'b', 'critical'), it_('r3', 'a', 'borderline')];
    const groups = [grp('a', 1), grp('b', 2)];
    expect(panels([...items].reverse(), [...groups].reverse())).toEqual(panels(items, groups));
  });
});

describe('displayName by library language (CR-C14-001)', () => {
  const groups = [grp('liver', 1, { displayEn: 'Liver', displayNe: 'कलेजो' })];
  const items = [it_('r1', 'liver', 'in_range')];
  it('en -> display_en', () => {
    expect(panels(items, groups, 'en')[0]?.displayName).toBe('Liver');
  });
  it('ne -> display_ne', () => {
    expect(panels(items, groups, 'ne')[0]?.displayName).toBe('कलेजो');
  });
  it('ne with no display_ne falls back to display_en (never blank)', () => {
    expect(panels(items, [grp('liver', 1, { displayEn: 'Liver' })], 'ne')[0]?.displayName).toBe('Liver');
  });
});

describe('purity', () => {
  it('does not mutate inputs', () => {
    const items = [it_('r2', 'b', 'critical'), it_('r1', 'a', 'in_range')];
    const groups = [grp('b', 2), grp('a', 1)];
    const before = JSON.stringify({ items, groups });
    buildPanels({ items, groups, language: 'en' } as never);
    expect(JSON.stringify({ items, groups })).toBe(before);
  });
});
