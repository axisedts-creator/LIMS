// @vitest-environment jsdom
// T0D-UIGUARD-1-OFFLINE (tester-owned). LD-353 rules 1 and 4, LD-436 look (list screen: Worklist mock), LD-438, LD-439 a (rule 7 on every file of the area).
// /offline = app/(staff)/offline/page.tsx -> core/offline/ui/OfflinePanel.tsx (+ OfflineShell.tsx, OfflineParts.tsx). Display only: every control, label,
// permission gate and controller call stays as pinned by offline2/3/4 tests; fixtures come from offline2.fixtures.tsx (synthetic).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { rawStructureViolations } from '@/core/__tests__/uiguard1.helpers';
import { attentionItem, conflictItem, fakeController, op, withProvider } from './offline2.fixtures';

afterEach(cleanup);
const UI = (f: string) => readFileSync(join(process.cwd(), 'src/core/offline/ui', f), 'utf8'); // vitest root = apps/web
const mount = async (c: ReturnType<typeof fakeController> | null) => {
  const { OfflinePanel } = await import('@/core/offline/ui/OfflinePanel');
  const { createElement } = await import('react');
  return render(c ? await withProvider(c, createElement(OfflinePanel as never)) : createElement(OfflinePanel as never)); // no provider = no snapshot
};

describe('rule 1: the kit PageHeader', () => {
  it('OfflinePanel.tsx imports and renders <PageHeader from the kit', () => {
    const src = UI('OfflinePanel.tsx');
    expect(/<PageHeader\b/.test(src), 'OfflinePanel.tsx renders <PageHeader').toBe(true);
    expect(/import\s*\{[^}]*\bPageHeader\b[^}]*\}\s*from\s*'@lims\/ui\/components\/PageHeader'/.test(src), 'PageHeader value import').toBe(true);
  });
  it('one h1 "Offline" inside the page header; Sync now sits in its actions next to Help', async () => {
    await mount(fakeController());
    const h1s = screen.getAllByRole('heading', { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0]!.textContent).toMatch(/offline/i);
    const header = h1s[0]!.closest('.lims-page-header') as HTMLElement;
    expect(header, 'h1 is drawn by PageHeader (.lims-page-header)').toBeTruthy();
    const actions = header.querySelector('.lims-page-actions') as HTMLElement;
    expect(within(actions).getByRole('button', { name: 'Sync now' })).toBeTruthy();
    expect(within(actions).getByRole('button', { name: /help/i })).toBeTruthy();
  });
  it('the page header comes before every table', async () => {
    await mount(fakeController({ pending: [op(1)], attention: [attentionItem(2)], conflicts: [conflictItem(3)] }));
    const header = document.querySelector('.lims-page-header')!;
    for (const t of screen.getAllByRole('table')) expect(header.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('LD-436 look: each list is a Card with a title row, header always shown', () => {
  it('Pending, Needs attention, Conflicts and PIN are kit cards (h2 in .lims-card-head), no hand built section heading', async () => {
    await mount(fakeController());
    const titles = Array.from(document.querySelectorAll('.lims-card > .lims-card-head > h2.lims-card-title')).map((h) => h.textContent?.trim());
    for (const want of [/pending/i, /needs attention/i, /conflicts/i, /pin/i]) expect(titles.some((x) => want.test(x ?? '')), `card titled ${want}`).toBe(true);
    expect(document.querySelectorAll('.lims-offline-h2, .lims-offline-h3')).toHaveLength(0);
  });
  it('the tables are still named by their card title and keep their headers with no rows', async () => {
    await mount(fakeController());
    for (const [n, cols] of [[/pending/i, 4], [/needs attention/i, 5], [/conflicts/i, 6]] as const) {
      const t = screen.getByRole('table', { name: n });
      expect(within(t).getAllByRole('columnheader')).toHaveLength(cols);
      expect(within(t).getByText(/^no |nothing/i)).toBeTruthy();
    }
  });
});

describe('rule 4: a failed read shows NotAvailable or ErrorState, never a bare paragraph', () => {
  it('source draws NotAvailable or ErrorState for the missing-snapshot branch', () => {
    expect(/\b(NotAvailable|ErrorState)\b/.test(UI('OfflinePanel.tsx'))).toBe(true);
  });
  it('without a controller or snapshot: the page header keeps the h1, the calm kit state shows, no data tables', async () => {
    await mount(null);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toMatch(/offline/i);
    expect(screen.getByRole('heading', { level: 1 }).closest('.lims-page-header')).toBeTruthy();
    expect(document.querySelector('.lims-state'), 'kit state block (NotAvailable/ErrorState)').toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sync now' })).toBeNull();
    expect(screen.queryAllByRole('table')).toHaveLength(0);
  });
});

describe('rule 7 (LD-439 a): no raw h1 to h4, ul or ol in any file of the area', () => {
  for (const f of ['OfflinePanel.tsx', 'OfflineShell.tsx', 'OfflineParts.tsx']) {
    it(`${f} has none`, () => { expect(rawStructureViolations(UI(f))).toEqual([]); });
  }
});

describe('regression: display only', () => {
  it('Retry and Discard stay in the Needs attention row, Resolve in the Conflicts row, with the same names', async () => {
    await mount(fakeController({ attention: [attentionItem(3)], conflicts: [conflictItem(4)] }));
    const att = screen.getByRole('table', { name: /needs attention/i });
    expect(within(att).getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(within(att).getByRole('button', { name: 'Discard' })).toBeTruthy();
    expect(within(screen.getByRole('table', { name: /conflicts/i })).getByRole('button', { name: 'Resolve' })).toBeTruthy();
  });
});
