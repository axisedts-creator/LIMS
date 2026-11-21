// @vitest-environment jsdom
// T0D-OFFLINE-2 done_when 2, 3 and 7: the Offline panel (three tables whose headers show even when empty, Sync now, Retry, Discard with a typed
// reason, personal data masked until a row is opened), the conflict inbox (keep_server / apply_local / field merge, reason required, both versions
// side by side), the PIN change, and buttons disabled with a visible reason by permission.
// Contract (controller and snapshot: offline2.fixtures.tsx):
//   @/core/offline/ui/OfflinePanel  exports OfflinePanel() (no props; reads the controller from the provider). The route page renders it.
//   h1 containing "Offline". Button "Sync now". Three tables (role table or grid) named /pending/i, /needs attention/i, /conflicts/i, column headers EXACTLY:
//     Pending: Time, Type, Reference, Status    Needs attention: Time, Type, Reference, Reason, Action    Conflicts: Time, Type, Reference, Local, Server, Action
//   With no rows the headers still show and the table holds a message (text starting "No" or containing "Nothing").
//   Rows: the Type cell shows a words label (registration), never the raw op_type code. Reference shows a MASKED value (first letter of each word, then bullets)
//     when the operation carries personal data (patient name, phone); the name and phone appear NOWHERE in the page (text, title, aria, value) until the row
//     is opened with its button "Show details" (aria-expanded), which then reads "Hide details" and shows every field of the payload.
//   Needs attention row: buttons "Retry" and "Discard". Retry -> controller.retry(op_id). Discard opens a dialog named /discard/i with a textarea labelled "Reason"
//     and buttons "Discard operation" (disabled until the trimmed reason is not empty) and "Cancel"; confirm -> controller.discard(op_id, trimmed reason).
//   Conflicts row: button "Resolve" opens a dialog named /resolve/i: it calls controller.loadConflict(conflict_id); regions "Local version" and "Server version"
//     list the fields side by side; radio group "Resolution" with /keep server/i, /apply local/i, /merge/i; for merge one radio group per DIFFERING field
//     (named by the field, options /server/i and /local/i, default server); textarea "Reason"; button "Resolve conflict" disabled until the reason is not empty
//     (and at most 1000 characters) and while the connection is not online, with visible text saying so. Confirm -> controller.resolveConflict(id, { resolution, reason, merged_payload? })
//     (merged_payload ONLY for merge). { ok: true } closes the dialog; { ok: false, code: 'sync.entity_changed' } keeps it open, says the record changed on the server and reloads both versions.
//   Gating by permission: Sync now, Retry, Discard need sync.use; Resolve needs sync.conflict.resolve. Without it the button is disabled and its aria-describedby
//     points at visible text that contains "permission".
//   PIN section: fields "Current PIN", "New PIN", "Confirm new PIN", button "Change PIN"; online only (offline: disabled + visible reason), needs sync.use.
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { user } from '@/core/shell/__tests__/r04.harness';
import {
  attentionItem, conflictItem, fakeController, LOCAL_VERSION, op, PATIENT_NAME, PATIENT_PHONE, SERVER_VERSION, withProvider,
} from './offline2.fixtures';

const mount = async (c: ReturnType<typeof fakeController>) => {
  const { OfflinePanel } = await import('@/core/offline/ui/OfflinePanel');
  const { createElement } = await import('react');
  return render(await withProvider(c, createElement(OfflinePanel as never)));
};
const tableNamed = (name: RegExp) => (screen.queryByRole('grid', { name }) ?? screen.queryByRole('table', { name })) as HTMLElement;
const headers = (t: HTMLElement) => within(t).getAllByRole('columnheader').map((h) => h.textContent?.trim());
const rowWith = (t: HTMLElement, text: RegExp) => within(t).getAllByRole('row').find((r) => text.test(r.textContent ?? '')) as HTMLElement;
const pageHtml = () => document.body.innerHTML;

describe('layout: three tables, headers always visible', () => {
  it('the page title and the Sync now button', async () => {
    await mount(fakeController());
    expect(screen.getByRole('heading', { level: 1 }).textContent).toMatch(/offline/i);
    expect(screen.getByRole('button', { name: 'Sync now' })).toBeTruthy();
  });
  it('with nothing in any list the three headers still show, each table holds a message', async () => {
    await mount(fakeController());
    expect(headers(tableNamed(/pending/i))).toEqual(['Time', 'Type', 'Reference', 'Status']);
    expect(headers(tableNamed(/needs attention/i))).toEqual(['Time', 'Type', 'Reference', 'Reason', 'Action']);
    expect(headers(tableNamed(/conflicts/i))).toEqual(['Time', 'Type', 'Reference', 'Local', 'Server', 'Action']);
    for (const n of [/pending/i, /needs attention/i, /conflicts/i]) expect(within(tableNamed(n)).getByText(/^no |nothing/i)).toBeTruthy();
  });
  it('headers are the same with rows, and each table lists only its own rows', async () => {
    await mount(fakeController({ pending: [op(1), op(2)], attention: [attentionItem(3)], conflicts: [conflictItem(4)] }));
    expect(headers(tableNamed(/pending/i))).toEqual(['Time', 'Type', 'Reference', 'Status']);
    expect(within(tableNamed(/pending/i)).getAllByRole('button', { name: /show details/i })).toHaveLength(2);
    expect(within(tableNamed(/needs attention/i)).getAllByRole('button', { name: 'Retry' })).toHaveLength(1);
    expect(within(tableNamed(/conflicts/i)).getAllByRole('button', { name: 'Resolve' })).toHaveLength(1);
  });
  it('the Type cell is words, not the raw operation code', async () => {
    await mount(fakeController({ pending: [op(1)] }));
    const row = rowWith(tableNamed(/pending/i), /registration/i);
    expect(row).toBeTruthy();
    expect(row.textContent).not.toContain('registration.create_order');
  });
});

describe('Sync now', () => {
  it('online: one click calls syncNow once', async () => {
    const c = fakeController({ conn: 'online', pending: [op(1)] });
    await mount(c);
    await user().click(screen.getByRole('button', { name: 'Sync now' }));
    expect(c.syncNow).toHaveBeenCalledTimes(1);
  });
  it('offline: disabled, with the reason as visible text the button points at', async () => {
    const c = fakeController({ conn: 'offline', pending: [op(1)] });
    await mount(c);
    const b = screen.getByRole('button', { name: 'Sync now' }) as HTMLButtonElement;
    expect(b.disabled || b.getAttribute('aria-disabled') === 'true').toBe(true);
    const why = document.getElementById(b.getAttribute('aria-describedby') ?? '');
    expect(why?.textContent).toMatch(/offline|connect|connection/i);
    await user().click(b);
    expect(c.syncNow).not.toHaveBeenCalled();
  });
  it('while a batch is in flight it cannot be pressed again', async () => {
    const c = fakeController({ conn: 'syncing', pending: [op(1)] });
    await mount(c);
    const b = screen.getByRole('button', { name: /sync/i }) as HTMLButtonElement;
    expect(b.disabled || b.getAttribute('aria-disabled') === 'true' || b.getAttribute('aria-busy') === 'true').toBe(true);
  });
  it('without sync.use: disabled, the visible reason names the missing permission', async () => {
    const c = fakeController({ permissions: [], pending: [op(1)] });
    await mount(c);
    const b = screen.getByRole('button', { name: 'Sync now' }) as HTMLButtonElement;
    expect(b.disabled || b.getAttribute('aria-disabled') === 'true').toBe(true);
    expect(document.getElementById(b.getAttribute('aria-describedby') ?? '')?.textContent).toMatch(/permission/i);
    await user().click(b);
    expect(c.syncNow).not.toHaveBeenCalled();
  });
});

describe('personal data is masked until a row is opened (done_when 2)', () => {
  it('the name and the phone appear nowhere in the page for pending, attention and conflict rows', async () => {
    await mount(fakeController({ pending: [op(1)], attention: [attentionItem(2)], conflicts: [conflictItem(3)] }));
    const html = pageHtml();
    for (const secret of [PATIENT_NAME, 'Asha', 'Verma', PATIENT_PHONE]) expect(html, secret).not.toContain(secret);
    const ref = within(rowWith(tableNamed(/pending/i), /registration/i)).getAllByRole('cell')[2]!;
    expect(ref.textContent?.trim().length).toBeGreaterThan(0);
    expect(ref.textContent).toMatch(/[•*]/);
  });
  it('"Show details" reveals the fields, "Hide details" hides them again', async () => {
    await mount(fakeController({ pending: [op(1)] }));
    const u = user();
    const row = rowWith(tableNamed(/pending/i), /registration/i);
    const open = within(row).getByRole('button', { name: /show details/i });
    expect(open.getAttribute('aria-expanded')).toBe('false');
    await u.click(open);
    expect(screen.getByText(new RegExp(PATIENT_NAME))).toBeTruthy();
    expect(screen.getByText(new RegExp(PATIENT_PHONE))).toBeTruthy();
    const close = screen.getByRole('button', { name: /hide details/i });
    expect(close.getAttribute('aria-expanded')).toBe('true');
    await u.click(close);
    expect(pageHtml()).not.toContain(PATIENT_NAME);
    expect(pageHtml()).not.toContain(PATIENT_PHONE);
  });
  it('opening one row does not open another', async () => {
    await mount(fakeController({ pending: [op(1, { payload: { patient: { full_name: 'Asha Verma' } } }), op(2, { payload: { patient: { full_name: 'Ravi Kulkarni' } } })] }));
    await user().click(screen.getAllByRole('button', { name: /show details/i })[0]!);
    expect(pageHtml()).toContain('Asha Verma');
    expect(pageHtml()).not.toContain('Ravi Kulkarni');
  });
});

describe('Needs attention: Retry and Discard', () => {
  const mountOne = async (over: Parameters<typeof fakeController>[0] = {}) => {
    const c = fakeController({ attention: [attentionItem(5, 'sync.result_locked')], ...over });
    await mount(c);
    return { c, u: user(), row: () => rowWith(tableNamed(/needs attention/i), /registration/i) };
  };
  it('shows the reason in words', async () => {
    const { row } = await mountOne();
    expect(row().textContent).toMatch(/locked/i);
    expect(row().textContent).not.toContain('sync.result_locked');
  });
  it('Retry calls the controller with the op id', async () => {
    const { c, u, row } = await mountOne();
    await u.click(within(row()).getByRole('button', { name: 'Retry' }));
    expect(c.retry).toHaveBeenCalledWith(attentionItem(5).op_id);
  });
  it('Discard asks for a reason: the confirm button stays disabled for blank and whitespace', async () => {
    const { c, u, row } = await mountOne();
    await u.click(within(row()).getByRole('button', { name: 'Discard' }));
    const dialog = screen.getByRole('dialog', { name: /discard/i });
    const confirm = within(dialog).getByRole('button', { name: 'Discard operation' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    await u.type(within(dialog).getByLabelText('Reason'), '   ');
    expect(confirm.disabled).toBe(true);
    await u.click(confirm);
    expect(c.discard).not.toHaveBeenCalled();
  });
  it('a typed reason enables it; the call carries the op id and the trimmed reason; the dialog closes', async () => {
    const { c, u, row } = await mountOne();
    await u.click(within(row()).getByRole('button', { name: 'Discard' }));
    const dialog = screen.getByRole('dialog', { name: /discard/i });
    await u.type(within(dialog).getByLabelText('Reason'), '  Entered twice by mistake  ');
    await u.click(within(dialog).getByRole('button', { name: 'Discard operation' }));
    expect(c.discard).toHaveBeenCalledTimes(1);
    expect(c.discard).toHaveBeenCalledWith(attentionItem(5).op_id, 'Entered twice by mistake');
    expect(screen.queryByRole('dialog', { name: /discard/i })).toBeNull();
  });
  it('Cancel (and Escape) discard nothing', async () => {
    const { c, u, row } = await mountOne();
    await u.click(within(row()).getByRole('button', { name: 'Discard' }));
    await u.type(screen.getByLabelText('Reason'), 'x');
    await u.click(within(screen.getByRole('dialog', { name: /discard/i })).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: /discard/i })).toBeNull();
    await u.click(within(row()).getByRole('button', { name: 'Discard' }));
    await u.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: /discard/i })).toBeNull();
    expect(c.discard).not.toHaveBeenCalled();
  });
  it('a failed discard keeps the dialog open and says so', async () => {
    const { c, u, row } = await mountOne();
    c.discard.mockResolvedValueOnce({ ok: false });
    await u.click(within(row()).getByRole('button', { name: 'Discard' }));
    const dialog = screen.getByRole('dialog', { name: /discard/i });
    await u.type(within(dialog).getByLabelText('Reason'), 'because');
    await u.click(within(dialog).getByRole('button', { name: 'Discard operation' }));
    await waitFor(() => expect(within(screen.getByRole('dialog', { name: /discard/i })).getByRole('alert')).toBeTruthy());
  });
  it('without sync.use both buttons are disabled with a visible permission reason', async () => {
    const { c, u, row } = await mountOne({ permissions: [] });
    for (const name of ['Retry', 'Discard']) {
      const b = within(row()).getByRole('button', { name }) as HTMLButtonElement;
      expect(b.disabled || b.getAttribute('aria-disabled') === 'true', name).toBe(true);
      expect(document.getElementById(b.getAttribute('aria-describedby') ?? '')?.textContent, name).toMatch(/permission/i);
      await u.click(b);
    }
    expect(c.retry).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: /discard/i })).toBeNull();
  });
});

describe('conflict inbox (done_when 3)', () => {
  const CID = '0192f0d6-0000-7000-8000-00000000c777';
  const mountOne = async (over: Parameters<typeof fakeController>[0] = {}) => {
    const c = fakeController({ conflicts: [conflictItem(7, CID)], ...over });
    await mount(c);
    const u = user();
    const open = async () => {
      await u.click(within(rowWith(tableNamed(/conflicts/i), /registration/i)).getByRole('button', { name: 'Resolve' }));
      return await screen.findByRole('dialog', { name: /resolve/i });
    };
    return { c, u, open };
  };
  const confirmBtn = (d: HTMLElement) => within(d).getByRole('button', { name: 'Resolve conflict' }) as HTMLButtonElement;

  it('loads both versions and shows them side by side in two named regions', async () => {
    const { c, open } = await mountOne();
    const d = await open();
    expect(c.loadConflict).toHaveBeenCalledWith(CID);
    const local = within(d).getByRole('region', { name: 'Local version' });
    const server = within(d).getByRole('region', { name: 'Server version' });
    expect(local.textContent).toContain(LOCAL_VERSION.phone);
    expect(local.textContent).toContain('Pune');
    expect(server.textContent).toContain(SERVER_VERSION.phone);
    expect(server.textContent).toContain('Mumbai');
    expect(local.textContent).not.toContain(SERVER_VERSION.phone);
    expect(server.textContent).not.toContain(LOCAL_VERSION.phone);
  });
  it('keep server: needs a reason; the call has no merged_payload', async () => {
    const { c, u, open } = await mountOne();
    const d = await open();
    await u.click(within(d).getByRole('radio', { name: /keep server/i }));
    expect(confirmBtn(d).disabled).toBe(true);
    await u.type(within(d).getByLabelText('Reason'), 'Server copy is newer');
    expect(confirmBtn(d).disabled).toBe(false);
    await u.click(confirmBtn(d));
    expect(c.resolveConflict).toHaveBeenCalledTimes(1);
    const [id, body] = c.resolveConflict.mock.calls[0]!;
    expect(id).toBe(CID);
    expect(body.resolution).toBe('keep_server');
    expect(body.reason).toBe('Server copy is newer');
    expect('merged_payload' in body).toBe(false);
    expect(screen.queryByRole('dialog', { name: /resolve/i })).toBeNull();
  });
  it('apply local: same call shape with apply_local', async () => {
    const { c, u, open } = await mountOne();
    const d = await open();
    await u.click(within(d).getByRole('radio', { name: /apply local/i }));
    await u.type(within(d).getByLabelText('Reason'), 'Device has the new phone');
    await u.click(confirmBtn(d));
    const [, body] = c.resolveConflict.mock.calls[0]!;
    expect(body.resolution).toBe('apply_local');
    expect('merged_payload' in body).toBe(false);
  });
  it('no resolution chosen yet: the confirm button stays disabled even with a reason', async () => {
    const { u, open } = await mountOne();
    const d = await open();
    await u.type(within(d).getByLabelText('Reason'), 'some reason');
    expect(confirmBtn(d).disabled).toBe(true);
  });
  it('field merge: one choice per differing field only, default server; merged_payload is the server copy plus the chosen local fields', async () => {
    const { c, u, open } = await mountOne();
    const d = await open();
    await u.click(within(d).getByRole('radio', { name: /merge/i }));
    expect(within(d).queryByRole('radiogroup', { name: /full.?name/i })).toBeNull(); // identical in both versions: no choice
    const phone = within(d).getByRole('radiogroup', { name: /phone/i });
    const city = within(d).getByRole('radiogroup', { name: /city/i });
    expect((within(city).getByRole('radio', { name: /server/i }) as HTMLInputElement).checked).toBe(true);
    await u.click(within(phone).getByRole('radio', { name: /local/i }));
    await u.type(within(d).getByLabelText('Reason'), 'Phone from the device is newer');
    await u.click(confirmBtn(d));
    const [, body] = c.resolveConflict.mock.calls[0]!;
    expect(body.resolution).toBe('merge');
    expect(body.merged_payload).toEqual({ full_name: PATIENT_NAME, phone: LOCAL_VERSION.phone, city: SERVER_VERSION.city });
  });
  it('a reason of more than 1000 characters disables the button', async () => {
    const { open } = await mountOne();
    const d = await open();
    await user().click(within(d).getByRole('radio', { name: /keep server/i }));
    const reason = within(d).getByLabelText('Reason');
    fireEvent.change(reason, { target: { value: 'x'.repeat(1000) } });
    expect(confirmBtn(d).disabled).toBe(false);
    fireEvent.change(reason, { target: { value: 'x'.repeat(1001) } });
    expect(confirmBtn(d).disabled).toBe(true);
  });
  it('the call goes through the resolve operation only when online: offline the button is disabled with a visible reason', async () => {
    const { c, u, open } = await mountOne({ conn: 'offline' });
    const d = await open();
    await u.click(within(d).getByRole('radio', { name: /keep server/i }));
    await u.type(within(d).getByLabelText('Reason'), 'because');
    expect(confirmBtn(d).disabled).toBe(true);
    expect(d.textContent).toMatch(/online/i);
    await u.click(confirmBtn(d));
    expect(c.resolveConflict).not.toHaveBeenCalled();
  });
  it('when the server version cannot be loaded it says so and nothing can be confirmed', async () => {
    const { c, u, open } = await mountOne();
    c.loadConflict.mockResolvedValueOnce(null);
    const d = await open();
    expect(d.textContent).toMatch(/not available|unavailable|could not (be )?load/i);
    await u.type(within(d).getByLabelText('Reason'), 'because');
    expect(confirmBtn(d).disabled).toBe(true);
  });
  it('the server record changed meanwhile (sync.entity_changed): the dialog stays, says so and reloads both versions', async () => {
    const { c, u, open } = await mountOne();
    c.resolveConflict.mockResolvedValueOnce({ ok: false, code: 'sync.entity_changed' });
    const d = await open();
    await u.click(within(d).getByRole('radio', { name: /keep server/i }));
    await u.type(within(d).getByLabelText('Reason'), 'because');
    await u.click(confirmBtn(d));
    await waitFor(() => expect(within(screen.getByRole('dialog', { name: /resolve/i })).getByRole('alert').textContent).toMatch(/changed/i));
    expect(c.loadConflict).toHaveBeenCalledTimes(2);
  });
  it('any other failure keeps the dialog open with an alert and does not close it', async () => {
    const { c, u, open } = await mountOne();
    c.resolveConflict.mockResolvedValueOnce({ ok: false });
    const d = await open();
    await u.click(within(d).getByRole('radio', { name: /keep server/i }));
    await u.type(within(d).getByLabelText('Reason'), 'because');
    await u.click(confirmBtn(d));
    await waitFor(() => expect(within(screen.getByRole('dialog', { name: /resolve/i })).getByRole('alert')).toBeTruthy());
  });
  it('without sync.conflict.resolve the Resolve button is disabled with a visible permission reason and nothing loads', async () => {
    const { c } = await mountOne({ permissions: ['sync.use'] });
    const b = within(rowWith(tableNamed(/conflicts/i), /registration/i)).getByRole('button', { name: 'Resolve' }) as HTMLButtonElement;
    expect(b.disabled || b.getAttribute('aria-disabled') === 'true').toBe(true);
    expect(document.getElementById(b.getAttribute('aria-describedby') ?? '')?.textContent).toMatch(/permission/i);
    await user().click(b);
    expect(c.loadConflict).not.toHaveBeenCalled();
  });
});

describe('PIN change (done_when 4: the PIN can be changed online)', () => {
  const fill = async (u: ReturnType<typeof user>, a: string, b: string, c2: string) => {
    await u.type(screen.getByLabelText('Current PIN'), a);
    await u.type(screen.getByLabelText('New PIN'), b);
    await u.type(screen.getByLabelText('Confirm new PIN'), c2);
  };
  it('online: matching new PINs call changePin(old, new) and say it worked', async () => {
    const c = fakeController();
    await mount(c);
    const u = user();
    await fill(u, '481516', '2468', '2468');
    await u.click(screen.getByRole('button', { name: 'Change PIN' }));
    expect(c.changePin).toHaveBeenCalledWith('481516', '2468');
    await waitFor(() => expect(screen.getByText(/pin (was )?changed/i)).toBeTruthy());
  });
  it('different new PINs: error, nothing called', async () => {
    const c = fakeController();
    await mount(c);
    const u = user();
    await fill(u, '481516', '2468', '1357');
    await u.click(screen.getByRole('button', { name: 'Change PIN' }));
    expect(c.changePin).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toMatch(/match/i);
  });
  it('a wrong current PIN shows the attempts left', async () => {
    const c = fakeController();
    c.changePin.mockResolvedValueOnce({ ok: false, reason: 'wrong_pin', attemptsLeft: 8 });
    await mount(c);
    const u = user();
    await fill(u, '000000', '2468', '2468');
    await u.click(screen.getByRole('button', { name: 'Change PIN' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/8 attempts left/i));
  });
  it('offline: disabled with a visible reason; without sync.use: disabled with a permission reason', async () => {
    const c = fakeController({ conn: 'offline' });
    await mount(c);
    const b = screen.getByRole('button', { name: 'Change PIN' }) as HTMLButtonElement;
    expect(b.disabled || b.getAttribute('aria-disabled') === 'true').toBe(true);
    expect(document.getElementById(b.getAttribute('aria-describedby') ?? '')?.textContent).toMatch(/online/i);
    c.set({ conn: 'online', permissions: [] });
    const b2 = screen.getByRole('button', { name: 'Change PIN' }) as HTMLButtonElement;
    expect(b2.disabled || b2.getAttribute('aria-disabled') === 'true').toBe(true);
    expect(document.getElementById(b2.getAttribute('aria-describedby') ?? '')?.textContent).toMatch(/permission/i);
  });
});
