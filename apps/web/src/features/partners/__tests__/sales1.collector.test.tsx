// @vitest-environment jsdom
// T0D-SALES-1 done_when (3) — home collection: Allow Collection and Allow Pickup (ElabAssist Collection Boy) for a collector, additive, other fields unchanged.
// There is NO collector form in LIMS today: the collectors (phlebotomists) are listed on /homecollection/devices (DevicesView, props unchanged). Tester pick, flagged to the lead:
//   - each device row gets a row action "Collector settings" (DataTable rowActions menu, next to "Wipe on next connection"), offered only with homecollection.settings.manage
//     (updateCollectorFlags permission), for every row whatever its status;
//   - it opens a dialog "Collector settings" for that phlebotomist with two checkboxes "Allow Collection" and "Allow Pickup" (both checked: the API default is true and there is no read
//     operation for the stored flags, so the dialog shows the default) and the buttons "Save" and "Cancel"; Save is disabled until a box was changed;
//   - Save PATCHes /v1/homecollection/phlebotomists/{membership_id} with ONLY the boxes that were changed (the operation changes only the flags sent; sending the untouched one could re-enable a collector
//     someone switched off elsewhere), no If-Match (two booleans, last write wins), then closes, shows a toast and refreshes;
//   - the existing seven columns and the wipe flow are unchanged.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '@lims/ui/components/Toast';
import { render } from '@testing-library/react';
import { D1, D2, WIPE_REASONS, U } from '@/features/homecollection/__tests__/hc-t20.helpers';
import { API, TM, api, norm, prob, quiet, rowOf } from './sales1.harness';

beforeAll(() => api.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => { API.reset(); TM.refresh.mockReset(); });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const SETTINGS = ['homecollection.settings.manage'];
const view = async (permissions: string[]) => {
  const { DevicesView } = (await import('@/features/homecollection/components/DevicesView')) as { DevicesView: (p: any) => any };
  return render(<ToastProvider><DevicesView devices={[D1, D2] as never} codes={{ wipe_reasons: WIPE_REASONS }} minAppVersion="1.10.0" permissions={permissions} /></ToastProvider>);
};
const rowFor = (who: string) => rowOf(who);
const openSettings = async (user: ReturnType<typeof userEvent.setup>, who = 'Test Phlebo 01') => {
  await user.click(within(rowFor(who)).getByRole('button', { name: /row actions/i }));
  await user.click(await screen.findByRole('menuitem', { name: /collector settings/i }));
  return screen.findByRole('dialog');
};
const flags = () => API.find('PATCH', /\/phlebotomists\/[^/]+$/);
const box = (dlg: HTMLElement, label: RegExp) => within(dlg).getByRole('checkbox', { name: label }) as HTMLInputElement;

describe('Collector settings on the Phlebotomy phones screen', () => {
  it('the row menu offers "Collector settings" with homecollection.settings.manage, and not without it (the wipe item is unaffected)', async () => {
    await view(['homecollection.device.manage']);
    const user = userEvent.setup();
    await user.click(within(rowFor('Test Phlebo 01')).getByRole('button', { name: /row actions/i }));
    expect(await screen.findByRole('menuitem', { name: /wipe on next connection/i })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: /collector settings/i })).toBeNull();
  });

  it('with the permission the dialog shows the two checkboxes, both checked, Save disabled until a change', async () => {
    await view(SETTINGS);
    const user = userEvent.setup();
    const dlg = await openSettings(user);
    expect(norm(dlg.textContent)).toContain('Test Phlebo 01');
    expect(box(dlg, /^allow collection/i).checked).toBe(true);
    expect(box(dlg, /^allow pickup/i).checked).toBe(true);
    const saveBtn = within(dlg).getByRole('button', { name: /^save/i });
    expect((saveBtn as HTMLButtonElement).disabled || saveBtn.getAttribute('aria-disabled') === 'true').toBe(true);
    await user.click(box(dlg, /^allow pickup/i));
    expect((saveBtn as HTMLButtonElement).disabled || saveBtn.getAttribute('aria-disabled') === 'true').toBe(false);
  });

  it('switching Allow Pickup off PATCHes {allow_pickup:false} for that membership only; no If-Match; closes and refreshes', async () => {
    await view(SETTINGS);
    const user = userEvent.setup();
    const dlg = await openSettings(user);
    await user.click(box(dlg, /^allow pickup/i));
    await user.click(within(dlg).getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(flags()).toHaveLength(1));
    expect(flags()[0]!.path.endsWith(`/phlebotomists/${U(5001)}`)).toBe(true);
    expect(flags()[0]!.json).toEqual({ allow_pickup: false });
    expect(flags()[0]!.headers.get('if-match')).toBeNull();
    await waitFor(() => expect(TM.refresh.mock.calls.length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('both boxes changed -> both keys; a box toggled twice (back to its start) is not sent and Save is disabled again', async () => {
    await view(SETTINGS);
    const user = userEvent.setup();
    let dlg = await openSettings(user, 'Test Phlebo 02');
    await user.click(box(dlg, /^allow collection/i));
    await user.click(box(dlg, /^allow pickup/i));
    await user.click(box(dlg, /^allow pickup/i));
    await user.click(within(dlg).getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(flags()).toHaveLength(1));
    expect(flags()[0]!.json).toEqual({ allow_collection: false });
    expect(flags()[0]!.path.endsWith(`/phlebotomists/${U(5002)}`)).toBe(true);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    dlg = await openSettings(user, 'Test Phlebo 01');
    await user.click(box(dlg, /^allow collection/i));
    await user.click(box(dlg, /^allow pickup/i));
    await user.click(within(dlg).getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(flags()).toHaveLength(2));
    expect(flags()[1]!.json).toEqual({ allow_collection: false, allow_pickup: false });
  });

  it('a refused save (404 not_found) shows a plain sentence in the dialog, keeps it open, no refresh; double click sends one request', async () => {
    API.fail = prob(404, 'common.not_found');
    API.writeDelayMs = 60;
    await view(SETTINGS);
    const user = userEvent.setup();
    const dlg = await openSettings(user);
    await user.click(box(dlg, /^allow collection/i));
    await user.dblClick(within(dlg).getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(within(dlg).getAllByRole('alert').length).toBeGreaterThan(0));
    await quiet(120);
    expect(flags()).toHaveLength(1);
    expect(norm(document.body.textContent)).not.toMatch(/common\.not_found|urn:lims/);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(TM.refresh.mock.calls.length).toBe(0);
  });

  it('Cancel sends nothing; the table keeps its seven columns (the other fields are unchanged)', async () => {
    await view(SETTINGS);
    const user = userEvent.setup();
    const dlg = await openSettings(user);
    await user.click(box(dlg, /^allow pickup/i));
    await user.click(within(dlg).getByRole('button', { name: /^cancel/i }));
    await quiet(30);
    expect(API.writes()).toEqual([]);
    const heads = screen.getAllByRole('columnheader').map((h) => norm(h.textContent));
    expect(heads).toEqual(expect.arrayContaining(['Phlebotomist', 'Model', 'App version', 'Status', 'Last seen', 'Last upload', 'Last route download']));
    expect(heads.filter((h) => /allow/i.test(h)), 'no new flag columns: the flags are only in the dialog').toEqual([]);
  });
});
