// @vitest-environment jsdom
// C16.T-B6 — W5 Bookable catalogue (04-UI-UX §3 W5; TRD S12–S14). Done_when W5 only: US-EN-26.x (catalogue sync) is T-B1's, not asserted here.
// Table: Code · Name · Kind · Types (Centre/Home) · Indicative price (MoneyText, "—" if none) · Synced at · Active (Switch, inline save).
// [Add test or package] → Combobox over C3 catalog search (via BFF) → booking-type checkboxes → save (S13). [Refresh from catalogue] (S14) → toast "Refresh started".
// Contract: see t-b6.harness.tsx header (ASSUMED).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as H from './t-b6.harness';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }), usePathname: () => '/engagement/bookable-items', useSearchParams: () => new URLSearchParams() }));
vi.mock('server-only', () => ({}));
afterEach(cleanup);

const grid = () => screen.getByRole('grid', { name: /bookable|catalogue/i });
const row = (re: RegExp) => { const r = H.rowOf(grid(), re); if (!r) throw new Error(`no row ${re}`); return r; };

describe('W5 table', () => {
  it('columns: Code, Name, Kind, Types, Indicative price, Synced at, Active', async () => {
    await H.showCatalogue();
    const heads = within(grid()).getAllByRole('columnheader').map((h) => H.norm(h.textContent)).filter(Boolean);
    for (const c of [/^code/i, /^name/i, /^kind/i, /^types/i, /indicative price/i, /synced at/i, /^active/i]) expect(heads.some((h) => c.test(h)), String(c)).toBe(true);
  });

  it('rows show code, name, kind, booking types, price; a missing price is "—"', async () => {
    await H.showCatalogue();
    const cbc = H.norm(row(/CBC/).textContent);
    expect(cbc).toContain('Synthetic CBC');
    expect(cbc).toMatch(/test/i);
    expect(cbc).toMatch(/centre/i);
    expect(cbc).toMatch(/home/i);
    expect(cbc).toMatch(/350/);
    expect(H.norm(row(/LIPID/).textContent)).toMatch(/panel/i);
    expect(H.norm(row(/HBA1C/).textContent)).toContain('—');
  });

  it('Active is a Switch per row, reflecting is_active', async () => {
    await H.showCatalogue();
    const sw = (re: RegExp) => within(row(re)).getByRole('switch') as HTMLInputElement;
    expect(sw(/CBC/).checked).toBe(true);
    expect(sw(/HBA1C/).checked).toBe(false);
  });

  it('toggling Active saves inline: setActive(item, next) with the row (version for If-Match)', async () => {
    const { actions } = await H.showCatalogue();
    await userEvent.setup().click(within(row(/CBC/)).getByRole('switch'));
    await waitFor(() => expect(actions.setActive).toHaveBeenCalledTimes(1));
    expect(H.id(201)).toBe((actions.setActive.mock.calls[0]![0] as any).orderable_id);
    expect(actions.setActive.mock.calls[0]![1]).toBe(false);
  });

  it('a failed inline save puts the Switch back and shows an alert', async () => {
    const actions = H.catalogueActions({ setActive: vi.fn(async () => { throw Object.assign(new Error('common.version_conflict'), { problem: { code: 'common.version_conflict' } }); }) });
    await H.showCatalogue(actions);
    await userEvent.setup().click(within(row(/CBC/)).getByRole('switch'));
    await waitFor(() => expect((within(row(/CBC/)).getByRole('switch') as HTMLInputElement).checked).toBe(true));
    expect(screen.getAllByRole('alert').length + (H.pageText().match(/couldn.t|could not|failed|changed/i) ? 1 : 0)).toBeGreaterThan(0);
  });
});

describe('W5 add and refresh', () => {
  it('[Add test or package] searches the C3 catalogue via actions.searchCatalog, then saves with the chosen booking types', async () => {
    const { actions } = await H.showCatalogue();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /add test or package/i }));
    const d = await screen.findByRole('dialog');
    await user.type(within(d).getByRole('combobox'), 'TSH');
    await waitFor(() => expect(actions.searchCatalog).toHaveBeenCalled());
    await user.click(await screen.findByRole('option', { name: /Synthetic TSH/ }));
    await user.click(within(d).getByRole('checkbox', { name: /centre/i }));
    await user.click(within(d).getByRole('button', { name: /^(save|add)/i }));
    await waitFor(() => expect(actions.add).toHaveBeenCalledTimes(1));
    expect(actions.add.mock.calls[0]![0]).toMatchObject({ orderable_id: H.id(210), orderable_kind: 'test', booking_kinds: ['centre_visit'] });
  });

  it('saving without any booking type is refused (S13 requires ≥ 1)', async () => {
    const { actions } = await H.showCatalogue();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /add test or package/i }));
    const d = await screen.findByRole('dialog');
    await user.type(within(d).getByRole('combobox'), 'TSH');
    await user.click(await screen.findByRole('option', { name: /Synthetic TSH/ }));
    await user.click(within(d).getByRole('button', { name: /^(save|add)/i }));
    expect(actions.add).not.toHaveBeenCalled();
  });

  it('[Refresh from catalogue] calls refresh() and toasts "Refresh started"', async () => {
    const { actions } = await H.showCatalogue();
    await userEvent.setup().click(screen.getByRole('button', { name: /refresh from catalogue/i }));
    await waitFor(() => expect(actions.refresh).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(H.pageText()).toContain('Refresh started'));
  });

  it('exactly one primary button on the page (LD-140)', async () => {
    await H.showCatalogue();
    expect(document.querySelectorAll('.lims-btn-primary')).toHaveLength(1); // "Add test or package"; Refresh is secondary
  });
});

describe('accessibility (axe)', () => {
  it('page is clean', async () => { await H.showCatalogue(); await H.axeClean(); });
  it('add dialog is clean', async () => {
    await H.showCatalogue();
    await userEvent.setup().click(screen.getByRole('button', { name: /add test or package/i }));
    await screen.findByRole('dialog');
    await H.axeClean();
  });
});
