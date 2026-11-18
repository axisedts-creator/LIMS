// @vitest-environment jsdom
// C12.T-20 — S18 Settings (04-UI-UX §3 S18; TRD #26, #27; AC-22.2 UI hides). LD-140 (2026-11-13): kit only, per-section Save, ONE primary button per page.
// Pinned seams: t20.harness.tsx header (PUT /settings with If-Match "<version>", no Idempotency-Key required, percent shown / basis points sent).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http } from 'msw';
import { ToastProvider } from '@lims/ui/components/Toast';
import { expectErrorState } from '@/__tests__/uiset1.helpers';
import { ORIGIN, PERM_MANAGE, PERM_NONE, PERM_READ, api, db, hit, hits, problem, resetDb, resetHits, router, settings, state } from './t20.harness';

vi.mock('next/navigation', async () => (await import('./t20.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t20.harness')).sessionMock);

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { resetHits(); resetDb(); Object.values(router).forEach((f) => f.mockReset()); state.permissions = PERM_MANAGE; state.path = '/inventory/settings'; });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const mount = async () => {
  const mod = await import('../../../app/(staff)/inventory/settings/page');
  return render(<ToastProvider>{await mod.default({ searchParams: Promise.resolve({}) } as never)}</ToastProvider>);
};
const tf = (name: RegExp) => screen.getByRole('textbox', { name });
const sw = (name: RegExp) => screen.getByRole('switch', { name });
const puts = () => hit('PUT', /^\/v1\/inventory\/settings$/);
// LD-353 template 4: the four sections are tabs and only the selected tab is drawn; a field is queried after its tab is opened.
const openTab = (name: string) => userEvent.click(screen.getByRole('tab', { name }));
const save = () => userEvent.click(screen.getByRole('button', { name: /^save/i }));
const replaceText = async (el: HTMLElement, v: string) => { await userEvent.clear(el); await userEvent.type(el, v); };

describe('S18 form (manager)', () => {
  it('shows every spec field with its current value (bp shown as percent)', async () => {
    await mount();
    await screen.findByRole('switch', { name: /automatic consumption/i });
    expect((sw(/automatic consumption/i) as HTMLInputElement).checked).toBe(true);
    expect((sw(/analyser-day rules need activity/i) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(/default consumption store/i)).toBeTruthy();
    await openTab('Purchasing');
    expect((sw(/vat included in cost/i) as HTMLInputElement).checked).toBe(true);
    expect((sw(/allow approving own po/i) as HTMLInputElement).checked).toBe(false);
    expect((sw(/allow receipts without po/i) as HTMLInputElement).checked).toBe(true);
    expect((tf(/over-receipt tolerance/i) as HTMLInputElement).value).toBe('2.5');
    await openTab('Alerts and counts');
    expect((tf(/expiry alert days/i) as HTMLInputElement).value).toBe('30');
    expect((sw(/lock store during count/i) as HTMLInputElement).checked).toBe(false);
    expect((tf(/reconciliation alert/i) as HTMLInputElement).value).toBe('2');
    expect((tf(/back-dating limit/i) as HTMLInputElement).value).toBe('7');
  });

  it('five number-pattern fields, each ≤ 40 chars, showing the stored patterns; help text for VAT (B7) is present', async () => {
    await mount();
    await screen.findByRole('switch', { name: /automatic consumption/i });
    await openTab('Purchasing');
    expect(screen.getByText('Turn off if your lab can claim purchase VAT back (ask your auditor).', { exact: false })).toBeTruthy();
    await openTab('Document numbers');
    for (const v of ['PO-{fy}-{seq:5}', 'GRN-{fy}-{seq:5}', 'TRF-{fy}-{seq:5}', 'CNT-{fy}-{seq:5}', 'DOC-{fy}-{seq:5}']) {
      const el = screen.getByDisplayValue(v) as HTMLInputElement;
      expect(el.maxLength).toBe(40);
    }
    expect(screen.getAllByRole('textbox', { name: /pattern/i }).length).toBe(5);
  });

  it('Save sends ONE PUT with If-Match "<version>", the full SettingsUpdate (no `version`/`id`), percent -> basis points, untouched fields unchanged', async () => {
    await mount();
    await screen.findByRole('switch', { name: /automatic consumption/i });
    await openTab('Alerts and counts');
    await replaceText(tf(/expiry alert days/i), '45');
    await openTab('Purchasing');
    await replaceText(tf(/over-receipt tolerance/i), '3');
    await userEvent.click(sw(/allow approving own po/i));
    await save();
    await waitFor(() => expect(puts().length).toBe(1));
    const p = puts()[0]!;
    expect(p.headers.get('if-match')).toBe('"4"');
    expect(p.json).toEqual({
      consumption_enabled_at: '2026-11-01T04:30:00.000Z', vat_in_cost: true, po_self_approval_allowed: true, grn_without_po_allowed: true, over_receipt_tolerance_bp: 300, expiry_alert_days: 45,
      default_consumption_store_id: db.settings.default_consumption_store_id, count_locks_store: false, per_day_requires_activity: true, reconciliation_gap_alert_bp: 200, backdate_max_days: 7,
      po_no_pattern: 'PO-{fy}-{seq:5}', grn_no_pattern: 'GRN-{fy}-{seq:5}', transfer_no_pattern: 'TRF-{fy}-{seq:5}', count_no_pattern: 'CNT-{fy}-{seq:5}', doc_no_pattern: 'DOC-{fy}-{seq:5}',
    });
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
  });

  it('a server 400 at /consumption_enabled_at (start < now − 1 h) is shown next to the field, the form keeps the user input', async () => {
    api.use(http.put(`${ORIGIN}/v1/inventory/settings`, () => problem('common.validation_failed', 400, { errors: [{ path: '/consumption_enabled_at', code: 'too_old', message: 'Start time cannot be more than 1 hour in the past.' }] })));
    await mount();
    await screen.findByRole('switch', { name: /automatic consumption/i });
    await openTab('Alerts and counts');
    await replaceText(tf(/expiry alert days/i), '60');
    await save();
    expect(await screen.findAllByText(/start time cannot be more than 1 hour in the past/i)).not.toHaveLength(0);
    await openTab('Alerts and counts'); // the typed value is kept (it stays in state whichever tab is shown)
    expect((tf(/expiry alert days/i) as HTMLInputElement).value).toBe('60');
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it('409 version_conflict shows a danger Banner with request_id and does not refresh as if saved', async () => {
    api.use(http.put(`${ORIGIN}/v1/inventory/settings`, () => problem('common.version_conflict', 409)));
    await mount();
    await screen.findByRole('switch', { name: /automatic consumption/i });
    await openTab('Alerts and counts');
    await replaceText(tf(/back-dating limit/i), '10');
    await save();
    expect(await screen.findByText(/req-syn-0001/)).toBeTruthy();
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it('client-side ranges: expiry alert days 0 / 366 and back-dating 32 are not sent', async () => {
    await mount();
    await screen.findByRole('switch', { name: /automatic consumption/i });
    await openTab('Alerts and counts');
    await replaceText(tf(/expiry alert days/i), '366');
    await save();
    await openTab('Alerts and counts');
    await replaceText(tf(/expiry alert days/i), '30');
    await replaceText(tf(/back-dating limit/i), '32');
    await save();
    await openTab('Alerts and counts');
    await replaceText(tf(/back-dating limit/i), '7');
    await openTab('Purchasing');
    await replaceText(tf(/over-receipt tolerance/i), '51');
    await save();
    expect(puts().length).toBe(0);
  });

  it('exactly ONE primary button (Save)', async () => {
    await mount();
    await screen.findByRole('switch', { name: /automatic consumption/i });
    expect(document.querySelectorAll('button.lims-btn-primary').length).toBe(1);
  });
});

describe('AC-22.2 UI hides + access', () => {
  it('without inventory.master.manage the page is a read-only description list: no Save, no switches, no inputs, no PUT', async () => {
    state.permissions = PERM_READ;
    await mount();
    await screen.findByText(/expiry alert days/i);
    expect(screen.queryByRole('button', { name: /save/i })).toBeNull();
    expect(screen.queryAllByRole('switch').length).toBe(0);
    expect(screen.queryAllByRole('textbox').length).toBe(0);
    expect(document.querySelector('dl')).toBeTruthy();
    expect(puts().length).toBe(0);
  });
  it('no inventory.item.read: permission-denied and no API call', async () => {
    state.permissions = PERM_NONE;
    await mount();
    expect(screen.getByTestId('permission-denied')).toBeTruthy();
    expect(hits.length).toBe(0);
  });
  it('API 403 on GET /settings -> permission-denied; 500 -> ErrorState in the page (title kept, reference, Retry; LD-353 rule 6)', async () => {
    api.use(http.get(`${ORIGIN}/v1/inventory/settings`, () => problem('auth.forbidden', 403)));
    await mount();
    expect(await screen.findByTestId('permission-denied')).toBeTruthy();
    cleanup();
    api.use(http.get(`${ORIGIN}/v1/inventory/settings`, () => problem('common.internal', 500)));
    const { container } = await mount();
    expectErrorState(container, '/inventory/settings');
    expect(screen.queryByRole('button', { name: /^save/i })).toBeNull();
  });
  it('settings fixture sanity: automatic consumption off renders an unchecked switch', async () => {
    db.settings = settings({ consumption_enabled_at: undefined });
    await mount();
    expect((await screen.findByRole('switch', { name: /automatic consumption/i }) as HTMLInputElement).checked).toBe(false);
  });
});
