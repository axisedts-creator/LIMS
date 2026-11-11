// Organ-group tiles (02-TRD §4.3; AC-04.4). Pure.
import type { BandStatus } from './band.js';

export interface PanelItem { resultId: string; analyteId: string; groupCode: string; analyteSortOrder: number; status: BandStatus }
export interface PanelGroup { groupCode: string; displayEn: string; displayNe?: string; sortOrder: number; isShown: boolean }
export interface Panel { panelCode: string; displayName: string; status: BandStatus; resultIds: string[] }

const SEVERITY: Readonly<Record<BandStatus, number>> = { in_range: 0, borderline: 1, out_of_range: 2, critical: 3 };
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function buildPanels(i: { items: readonly PanelItem[]; groups: readonly PanelGroup[]; language: 'en' | 'ne' }): Panel[] {
  const shown = new Map<string, PanelGroup>();
  for (const g of i.groups) if (g.isShown) shown.set(g.groupCode, g);
  const byGroup = new Map<string, PanelItem[]>();
  for (const it of i.items) {
    if (!shown.has(it.groupCode)) continue;
    const l = byGroup.get(it.groupCode);
    if (l) l.push(it); else byGroup.set(it.groupCode, [it]);
  }
  return [...byGroup.entries()]
    .map(([code, members]) => {
      const g = shown.get(code) as PanelGroup;
      const ordered = [...members].sort((a, b) => a.analyteSortOrder - b.analyteSortOrder || cmp(a.resultId, b.resultId));
      const status = members.reduce<BandStatus>((w, m) => (SEVERITY[m.status] > SEVERITY[w] ? m.status : w), 'in_range');
      const displayName = i.language === 'ne' ? (g.displayNe || g.displayEn) : g.displayEn;
      return { g, panel: { panelCode: code, displayName, status, resultIds: ordered.map((m) => m.resultId) } };
    })
    .sort((a, b) => a.g.sortOrder - b.g.sortOrder || cmp(a.panel.panelCode, b.panel.panelCode))
    .map((x) => x.panel);
}
