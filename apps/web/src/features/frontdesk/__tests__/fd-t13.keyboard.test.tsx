// @vitest-environment jsdom
// FD-T13 — keyboard-only acceptance script (04-UI-UX §3.7; US-FD-03.6 ≤ 12 keystroke groups, no mouse) + shortcut table §3.5 + reserved browser keys §1.
// Contract + MSW: see fd-t13.harness.tsx.
import { describe, expect, it } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PATH, handlers, HttpResponse, INVOICE, MONEY, UNIT, delay, fp, of, quoteFor, renderForm, result, setup } from './fd-t13.harness';

setup();
const patientSearch = () => screen.getByRole('combobox', { name: /search (patient|name)/i });
const testSearch = () => screen.getByRole('combobox', { name: /search test/i });
const T = 4000;

describe('§3.7 keyboard-only script: returning patient, 3 items, cash', () => {
  it('F2 mobile Enter · F4 CBC Enter · LIPID Enter · TSH Enter · F8 · Ctrl+Enter · print — ≤ 12 groups, zero pointer events', async () => {
    const user = userEvent.setup({ delay: null });
    await renderForm();
    const pointer: string[] = [];
    for (const t of ['click', 'mousedown', 'pointerdown']) document.addEventListener(t, () => pointer.push(t), true);
    let groups = 0;
    const group = async (keys: string) => { groups++; await user.keyboard(keys); };

    expect(document.activeElement).toBe(patientSearch()); // blank form: focus on patient search (03-APP-FLOW §6)

    await group('{F2}');
    await group('9841000001');
    await screen.findByRole('option', { name: /Synthetic Patient One/ }, { timeout: T });
    await group('{Enter}'); // first result is the active option: Enter selects (no arrow key)
    await screen.findByText(/P-000123/, undefined, { timeout: T });

    for (const [code, name] of [['CBC', /Complete blood count/], ['LIPID', /Lipid profile/], ['TSH', /Thyroid/]] as const) {
      if (code === 'CBC') await group('{F4}');
      await user.keyboard(code); // typing the query is part of the same group as its Enter in the spec's count
      await screen.findByRole('option', { name }, { timeout: T });
      await group('{Enter}'); // adds and keeps focus in search, search text cleared
      expect(document.activeElement).toBe(testSearch());
    }
    // the search field was cleared after each add: each q is exactly what was typed (no "CBCLIPID")
    expect(of('GET', PATH.orderables).map((c) => new URL(`http://x${c.path}${c.search}`).searchParams.get('q')).filter((q, i, a) => a.indexOf(q) === i)).toEqual(expect.arrayContaining(['CBC', 'LIPID', 'TSH']));
    expect(of('GET', PATH.orderables).every((c) => /^(C|CB|CBC|L|LI|LIP|LIPI|LIPID|T|TS|TSH)$/.test(new URL(`http://x${c.path}${c.search}`).searchParams.get('q') ?? ''))).toBe(true);

    // Register is enabled only once the LAST quote (3 items) returned
    await waitFor(() => expect(of('POST', PATH.quote).at(-1)?.body.items).toHaveLength(3), { timeout: T });
    await screen.findByText(MONEY(UNIT * 3), undefined, { timeout: T });

    await group('{F8}');
    const amount = document.activeElement as HTMLInputElement;
    expect(amount.tagName).toBe('INPUT');
    expect(amount.value.replace(/,/g, '')).toBe('339.00'); // prefilled = Net

    await group('{Control>}{Enter}{/Control}');
    await waitFor(() => expect(of('POST', PATH.register)).toHaveLength(1), { timeout: T });
    const reg = of('POST', PATH.register)[0]!;
    expect(reg.body).toMatchObject({ patient: { patient_id: expect.any(String) }, visit_type: 'opd', billing_mode: 'cash', payments: [{ method_code: 'cash', amount_received_paisa: UNIT * 3 }] });
    expect(reg.body.items.map((i: any) => i.orderable_id)).toHaveLength(3);
    expect(reg.body.quote_fingerprint).toBe(fp(of('POST', PATH.quote).at(-1)!.body.items)); // the LATEST quote's fingerprint (harness fp = sha256 of the quoted items)
    expect(reg.headers.get('idempotency-key')).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(JSON.stringify(reg.body)).not.toMatch(/Synthetic Patient One|98xxxxxx42/); // ids only, no PHI echoed back

    // success panel -> invoice auto-print (cash): "print dialog Enter" is the browser's; our side is the B3 call that records print_count
    await screen.findByText(/R-2083-000042/, undefined, { timeout: T });
    await waitFor(() => expect(of('POST', PATH.print)).toHaveLength(1), { timeout: T });
    expect(of('POST', PATH.print)[0]!.path).toContain(INVOICE);
    expect(of('POST', PATH.print)[0]!.body).toMatchObject({ reason_code: 'first_print' });
    await screen.findByText(/Printed \(original\)/i, undefined, { timeout: T });

    await group('{Enter}'); // print dialog confirmation (the 9th group)
    expect(groups).toBeLessThanOrEqual(12);
    expect(pointer).toEqual([]);
  });
});

describe('§3.5 shortcuts', () => {
  it('Ctrl+Shift+N after success resets everything and focuses patient search', async () => {
    const user = userEvent.setup({ delay: null });
    await renderForm();
    await user.keyboard('{F2}9841000001');
    await user.keyboard('{Enter}');
    await user.keyboard('{F4}CBC');
    await screen.findByRole('option', { name: /Complete blood count/ }, { timeout: T });
    await user.keyboard('{Enter}');
    await screen.findByText(MONEY(UNIT), undefined, { timeout: T });
    await user.keyboard('{Control>}{Enter}{/Control}');
    await screen.findByText(/R-2083-000042/, undefined, { timeout: T });
    await user.keyboard('{Control>}{Shift>}n{/Shift}{/Control}');
    await waitFor(() => expect(document.activeElement).toBe(patientSearch()));
    expect(screen.queryByText(/R-2083-000042/)).toBeNull();
    expect(screen.queryByText(/Synthetic Patient One/)).toBeNull();
    expect(screen.queryByText(/Complete blood count/)).toBeNull();
  });

  it('Alt+O / Alt+I switch OPD/IPD; Alt+C toggles cash/credit (credit party field appears only for credit)', async () => {
    const user = userEvent.setup({ delay: null });
    await renderForm();
    const checked = (name: string) => (screen.getByRole('radio', { name }) as HTMLInputElement).checked;
    expect(checked('OPD')).toBe(true);
    expect(checked('Cash')).toBe(true);
    await user.keyboard('{Alt>}i{/Alt}');
    expect(checked('IPD')).toBe(true);
    await user.keyboard('{Alt>}o{/Alt}');
    expect(checked('OPD')).toBe(true);
    expect(screen.queryByRole('combobox', { name: /credit party/i })).toBeNull();
    await user.keyboard('{Alt>}c{/Alt}');
    expect(checked('Credit')).toBe(true);
    expect(screen.getByRole('combobox', { name: /credit party/i })).toBeTruthy();
    await user.keyboard('{Alt>}c{/Alt}');
    expect(checked('Cash')).toBe(true);
  });

  it('F3 focuses the referrer (default chip "Self"); F6 opens the discount dialog, Esc closes it and focus returns', async () => {
    const user = userEvent.setup({ delay: null });
    await renderForm();
    expect(screen.getByText(/^Self$/)).toBeTruthy();
    await user.keyboard('{F3}');
    expect(document.activeElement).toBe(screen.getByRole('combobox', { name: /referrer/i }));
    await user.keyboard('{F2}9841000001');
    await user.keyboard('{Enter}');
    await user.keyboard('{F4}CBC');
    await screen.findByRole('option', { name: /Complete blood count/ }, { timeout: T });
    await user.keyboard('{Enter}');
    const before = document.activeElement;
    await user.keyboard('{F6}');
    const dlg = await screen.findByRole('dialog', { name: /discount/i });
    for (const n of [/line/i, /bill/i, /amount/i, /percent/i]) expect(within(dlg).getByRole('radio', { name: n })).toBeTruthy();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /discount/i })).toBeNull());
    expect(document.activeElement).toBe(before);
  });

  it('F2 refocuses the patient search; Del removes and U toggles urgent on the focused item row; Alt+R makes the whole order urgent', async () => {
    const user = userEvent.setup({ delay: null });
    await renderForm();
    await user.keyboard('{F2}9841000001');
    await user.keyboard('{Enter}');
    await user.keyboard('{F4}CBC');
    await screen.findByRole('option', { name: /Complete blood count/ }, { timeout: T });
    await user.keyboard('{Enter}');
    await user.keyboard('TSH');
    await screen.findByRole('option', { name: /Thyroid/ }, { timeout: T });
    await user.keyboard('{Enter}');
    const table = await screen.findByRole('table', { name: /tests|selected/i });
    const row = () => within(table).getByRole('row', { name: /CBC/ });
    act(() => row().focus());
    await user.keyboard('u');
    await waitFor(() => expect(of('POST', PATH.quote).at(-1)!.body.items.find((i: any) => i.orderable_id.endsWith('011'))?.priority).toBe('urgent'), { timeout: T });
    await user.keyboard('{Delete}');
    await waitFor(() => expect(of('POST', PATH.quote).at(-1)!.body.items).toHaveLength(1), { timeout: T });
    expect(within(table).queryByRole('row', { name: /CBC/ })).toBeNull();
    await user.keyboard('{Alt>}r{/Alt}');
    await waitFor(() => {
      const b = of('POST', PATH.quote).at(-1)!.body;
      expect(b.priority === 'urgent' || b.items.every((i: any) => i.priority === 'urgent')).toBe(true);
    }, { timeout: T });
  });

  it('"?" opens the shortcut dialog listing every §3.5 key; typing "?" inside a text field does not', async () => {
    const user = userEvent.setup({ delay: null });
    await renderForm();
    await user.keyboard('?');
    // focus is in the patient search (a text field): the '?' is text, not a shortcut
    expect(screen.queryByRole('dialog', { name: /keyboard shortcuts/i })).toBeNull();
    (document.activeElement as HTMLElement).blur();
    await user.keyboard('?');
    const dlg = await screen.findByRole('dialog', { name: /keyboard shortcuts/i });
    const keys = within(dlg).getAllByText((_, el) => el?.tagName === 'KBD').map((k) => k.textContent!.replace(/\s/g, ''));
    for (const k of ['F2', 'Alt+N', 'F3', 'Alt+D', 'F4', 'Del', 'U', 'Alt+R', 'Alt+O', 'Alt+I', 'Alt+C', 'F6', 'Alt+A', 'F8', 'Alt+P', 'Alt+U', 'Ctrl+Enter', 'Ctrl+Shift+N', 'Alt+L', 'Esc', '?']) {
      expect(keys.some((x) => x.includes(k)), `shortcut ${k} listed`).toBe(true);
    }
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /keyboard shortcuts/i })).toBeNull());
  });

  it('Register button shows its shortcut hint (Button.shortcut) and the registration shortcuts never hijack F5 / Ctrl+R / Ctrl+W / Ctrl+T / Ctrl+P', async () => {
    await renderForm();
    expect(screen.getByRole('button', { name: /register & print/i }).textContent).toMatch(/Ctrl\+Enter/i);
    for (const init of [{ key: 'F5' }, { key: 'r', ctrlKey: true }, { key: 'w', ctrlKey: true }, { key: 't', ctrlKey: true }, { key: 'p', ctrlKey: true }]) {
      const ev = new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true });
      document.body.dispatchEvent(ev);
      expect(ev.defaultPrevented, JSON.stringify(init)).toBe(false);
    }
  });

  it('Ctrl+Enter while the quote is in flight does not submit; double Ctrl+Enter sends exactly one F9', async () => {
    const user = userEvent.setup({ delay: null });
    await renderForm();
    await user.keyboard('{F2}9841000001');
    await user.keyboard('{Enter}');
    await user.keyboard('{F4}CBC');
    await screen.findByRole('option', { name: /Complete blood count/ }, { timeout: T });
    handlers.quote = async (b: any) => { await delay(700); return HttpResponse.json(quoteFor(b)); };
    await user.keyboard('{Enter}');
    await user.keyboard('{Control>}{Enter}{/Control}'); // quote pending
    await new Promise((r) => setTimeout(r, 500));
    expect(of('POST', PATH.register)).toHaveLength(0);
    await screen.findByText(MONEY(UNIT), undefined, { timeout: T });
    handlers.register = async () => { await delay(400); return HttpResponse.json(result(), { status: 201 }); };
    await user.keyboard('{Control>}{Enter}{Enter}{/Control}');
    await new Promise((r) => setTimeout(r, 900));
    expect(of('POST', PATH.register)).toHaveLength(1);
  });
});
