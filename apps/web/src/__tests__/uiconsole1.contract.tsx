// T0D-UICONSOLE-1 shared CONSOLE contract (tester-owned, not a test file: it is imported by the three uiconsole1.*.test.tsx files, which register it per screen).
// LD-353 template 2 + done_when: each screen is PageHeader (h1 = the menu label) + ONE FilterBar + ONE StatTile row above a SplitConsole; the queue list at left starts with an
// age column; its header row stays when empty and the empty state sits INSIDE the list area; the detail at right shows the record, a History block and the sticky action bar;
// j / k move the focus over the queue items, Enter selects. Nothing is selected before the first click.
import { describe, expect, it } from 'vitest';
import userEvent from '@testing-library/user-event';
import { t } from '@/core/i18n/messages';
import { consoles, detailPane, filterBars, hasAge, historyOf, itemOf, items, listHeaders, listPane, norm, pickItem, selected, tileLabel, tileMap, tileRows, tiles, titles } from './uiconsole1.helpers';

export interface ConsoleSpec {
  /** describe() name: the route */
  route: string;
  /** i18n key of the menu label (LD-353 rule 8: the title equals it) */
  menuKey: string;
  /** exact header cells of the queue list, age first */
  headers: readonly string[];
  /** exact StatTile labels in order */
  tileLabels: readonly string[];
  /** the empty text of the existing EmptyState (kept verbatim) */
  emptyText: string;
  mount: (rows: readonly unknown[]) => Promise<{ container: HTMLElement }>;
  empty: readonly unknown[];
  /** a one-record set */
  one: readonly unknown[];
  oneId: string;
  /** a set of at least three records; `manyIds` = the ids in the order the items must appear */
  many: readonly unknown[];
  manyIds: readonly string[];
  tilesEmpty: Record<string, TileExpect>;
  tilesOne: Record<string, TileExpect>;
  tilesMany: Record<string, TileExpect>;
  /** text that must be in the detail after selecting that id (and NOT after selecting another) */
  marker: (id: string) => string;
}

const inOrder = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

export function consoleContract(s: ConsoleSpec) {
  describe(`${s.route} (template 2 CONSOLE)`, () => {
    it.each([['no rows', () => s.empty], ['one row', () => s.one]])('%s: h1 = the menu label, one FilterBar, one StatTile row, one console; filters and tiles sit above the list', async (_n, rows) => {
      const { container } = await s.mount(rows());
      expect(titles(container)).toEqual([t(s.menuKey)]);
      expect(filterBars(container)).toHaveLength(1);
      expect(tileRows(container)).toHaveLength(1);
      expect(tiles(container).map(tileLabel)).toEqual([...s.tileLabels]);
      expect(consoles(container)).toHaveLength(1);
      const c = consoles(container)[0]!;
      expect(c.contains(filterBars(container)[0]!), 'the FilterBar is above the console, not inside').toBe(false);
      expect(c.contains(tileRows(container)[0]!), 'the tiles are above the console, not inside').toBe(false);
      expect(inOrder(filterBars(container)[0]!, c)).toBe(true);
      expect(inOrder(tileRows(container)[0]!, c)).toBe(true);
      expect(listPane(container), 'queue list at left').toBeTruthy();
      expect(detailPane(container), 'detail at right').toBeTruthy();
    });

    it.each([['no rows', () => s.empty], ['one row', () => s.one]])('%s: the list header row is drawn and the age comes first', async (_n, rows) => {
      const { container } = await s.mount(rows());
      expect(listHeaders(container)).toEqual([...s.headers]);
      expect(listHeaders(container)[0]).toMatch(/^age/i);
    });

    it('no rows: the EmptyState is inside the list area (title kept), no item, tiles read zero and the oldest age is a dash', async () => {
      const { container } = await s.mount(s.empty);
      const empty = listPane(container)!.querySelector('.lims-state');
      expect(empty, 'EmptyState inside .lims-console-list').toBeTruthy();
      expect(norm(empty!.textContent)).toContain(s.emptyText);
      expect(items(container)).toHaveLength(0);
      expectTiles(tileMap(container), s.tilesEmpty);
    });

    it('one row: one item keyed by the record id, nothing selected yet, tiles counted from the rows', async () => {
      const { container } = await s.mount(s.one);
      expect(items(container)).toHaveLength(1);
      expect(itemOf(container, s.oneId)).toBeTruthy();
      expect(selected(container)).toHaveLength(0);
      expect(listPane(container)!.querySelector('.lims-state'), 'no empty state when there is a row').toBeNull();
      expectTiles(tileMap(container), s.tilesOne);
    });

    it('several rows: one item per record in the order given, tiles counted from all of them', async () => {
      const { container } = await s.mount(s.many);
      expect(items(container).map((i) => i.getAttribute('data-console-item'))).toEqual([...s.manyIds]);
      expectTiles(tileMap(container), s.tilesMany);
    });

    it('a click selects the record: aria-selected on the item, the detail shows it with a History block; another click moves the detail', async () => {
      const { container } = await s.mount(s.many);
      const [a, b] = s.manyIds as readonly [string, string];
      const d = pickItem(container, a);
      expect(selected(container).map((i) => i.getAttribute('data-console-item'))).toEqual([a]);
      expect(norm(d.textContent)).toContain(s.marker(a));
      expect(norm(d.textContent)).not.toContain(s.marker(b));
      expect(historyOf(d), 'a heading "History" inside the detail').toBeTruthy();
      pickItem(container, b);
      expect(selected(container).map((i) => i.getAttribute('data-console-item'))).toEqual([b]);
      expect(norm(detailPane(container)!.textContent)).toContain(s.marker(b));
      expect(norm(detailPane(container)!.textContent)).not.toContain(s.marker(a));
    });

    it('keyboard: j and k move the focus over the queue, Enter opens the focused record', async () => {
      const user = userEvent.setup();
      const { container } = await s.mount(s.many);
      const its = () => items(container);
      its()[0]!.focus();
      await user.keyboard('j');
      expect(document.activeElement).toBe(its()[1]);
      await user.keyboard('j');
      expect(document.activeElement).toBe(its()[2]);
      await user.keyboard('k');
      expect(document.activeElement).toBe(its()[1]);
      await user.keyboard('{Enter}');
      expect(selected(container).map((i) => i.getAttribute('data-console-item'))).toEqual([s.manyIds[1]]);
      expect(norm(detailPane(container)!.textContent)).toContain(s.marker(s.manyIds[1]!));
    });

    it('keyboard: j on the last item and k on the first item stay where they are', async () => {
      const user = userEvent.setup();
      const { container } = await s.mount(s.many);
      const its = items(container);
      its.at(-1)!.focus();
      await user.keyboard('j');
      expect(document.activeElement).toBe(its.at(-1));
      its[0]!.focus();
      await user.keyboard('k');
      expect(document.activeElement).toBe(its[0]);
    });
  });
}

/** A tile expectation is the exact text, or { ageMin }: any of the accepted age forms (hh:mm, `2d 2h`), or { dash } for no value. */
export type TileExpect = string | { ageMin: number };
export function expectTiles(actual: Record<string, string>, want: Record<string, TileExpect>) {
  expect(Object.keys(actual)).toEqual(Object.keys(want));
  for (const [label, w] of Object.entries(want)) {
    if (typeof w === 'string') expect(actual[label], `tile ${label}`).toBe(w);
    else expect(hasAge(actual[label]!, w.ageMin), `tile ${label} = "${actual[label]}" shows ${w.ageMin} minutes`).toBe(true);
  }
}
