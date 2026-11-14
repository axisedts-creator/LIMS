// @vitest-environment jsdom
// C10.T-20 — culture page, tab "Isolates & AST" (isolate half only; the AST grid is T-21): isolate list, add / identify / describe / withdraw
// (04-UI-UX §3.3; 03-APP-FLOW §4.5; AC-05.1 … AC-05.5 (UI side); S-05 strict body; D-62). LD-140: kit only; status = tone + icon + word.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { http, HttpResponse } from 'msw';
import { ToastProvider } from '@lims/ui/components/Toast';
import { ID, ORIGIN, PERM_READ, PERM_WORK, api, dialog, hit, incubating, isolate, lastHit, pick, plate, problem, resetHits, router, rowAction, state } from './t20.harness';

vi.mock('next/navigation', async () => (await import('./t20.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t20.harness')).sessionMock);

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { resetHits(); router.refresh.mockReset(); state.permissions = PERM_WORK; });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const mount = async (c: Record<string, unknown> = incubating(), permissions = PERM_WORK) => {
  const { CultureScreen } = await import('../components/culture/CultureScreen');
  const r = render(<ToastProvider><CultureScreen culture={c as never} patient={{ name: 'Synthetic Patient One' }} specimen={null} permissions={permissions} /></ToastProvider>);
  await userEvent.click(screen.getByRole('tab', { name: /^isolates & ast/i }));
  return r;
};
const btn = (n: RegExp) => screen.queryAllByRole('button', { name: n })[0];
const text = () => document.body.textContent ?? '';
const two = (over: Record<string, unknown> = {}) => incubating({ isolates: [isolate(1, { id: ID(301) }), isolate(2, { id: ID(302), organism_source: 'instrument', quantity_text: '+', is_reportable: false })], ...over });
const comboPick = async (d: HTMLElement, query: string, option: RegExp) => {
  const box = within(d).getByRole('combobox', { name: /organism/i });
  await userEvent.clear(box);
  await userEvent.type(box, query);
  await userEvent.click(await screen.findByRole('option', { name: option }));
};
const orgGets = () => hit('GET', /\/coded-sets\/organisms$/);

describe('isolate list (04-UI-UX §3.3)', () => {
  it('columns Isolate no., Organism, Source, Quantity, Reportable, Status; values per row', async () => {
    await mount(two());
    const t = await screen.findByRole('grid', { name: /isolates/i });
    expect(within(t).getAllByRole('columnheader').map((h) => h.textContent?.trim()).filter(Boolean)).toEqual(expect.arrayContaining(['Isolate no.', 'Organism', 'Source', 'Quantity', 'Reportable', 'Status']));
    const rows = within(t).getAllByRole('row').slice(1);
    expect(rows[0]!.textContent).toMatch(/1.*Synthetic organism.*Manual.*\+\+.*Yes.*Identified/);
    expect(rows[1]!.textContent).toMatch(/2.*Synthetic organism.*Instrument.*\+.*No.*Identified/);
  });
  it('AC-05.5: two isolates of the same organism are two rows (no merge by organism); the numbers are the server\'s isolate_seq', async () => {
    await mount(two({ isolates: [isolate(3, { id: ID(303) }), isolate(7, { id: ID(307) })] }));
    const t = await screen.findByRole('grid', { name: /isolates/i });
    const rows = within(t).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    const col = within(t).getAllByRole('columnheader').findIndex((h) => /^isolate no\.?$/i.test(h.textContent?.trim() ?? ''));
    expect(col).toBeGreaterThanOrEqual(0);
    expect(rows.map((r) => Array.from(r.querySelectorAll('[role="gridcell"],[role="rowheader"]'))[col]!.textContent?.trim())).toEqual(expect.arrayContaining(['3', '7']));
  });
  it('a pending isolate reads "Not identified"; statuses show word + tone + icon (§9)', async () => {
    await mount(incubating({ isolates: [isolate(1, { id: ID(301), status: 'pending_id', organism_code: undefined, organism_display: undefined, organism_source: undefined }), isolate(2, { id: ID(302) }), isolate(3, { id: ID(303), status: 'withdrawn', is_reportable: false, withdraw_reason_code: 'synthetic_contaminant' })] }));
    const t = await screen.findByRole('grid', { name: /isolates/i });
    const chip = (label: string) => within(t).getAllByText(label).map((e) => e.closest('[data-tone]')).find(Boolean) as HTMLElement;
    expect(within(t).getAllByText('Not identified').length).toBeGreaterThanOrEqual(2); // organism cell + status chip
    for (const [label, tone] of [['Not identified', 'neutral'], ['Identified', 'success'], ['Withdrawn', 'neutral']] as const) {
      expect(chip(label), label).toBeTruthy();
      expect(chip(label).getAttribute('data-tone')).toBe(tone);
      expect(chip(label).querySelector('svg,[data-icon],[aria-hidden=true]'), `${label} icon`).toBeTruthy();
    }
  });
  it('single selection: clicking a row selects it (aria-selected) and only one row at a time', async () => {
    await mount(two());
    const t = await screen.findByRole('grid', { name: /isolates/i });
    const rows = () => within(t).getAllByRole('row').slice(1);
    await userEvent.click(rows()[0]!);
    await userEvent.click(rows()[1]!);
    expect(rows().filter((r) => r.getAttribute('aria-selected') === 'true')).toHaveLength(1);
    expect(rows()[1]!.getAttribute('aria-selected')).toBe('true');
  });
  it('organism names are text nodes (REQ-SEC-088)', async () => {
    await mount(incubating({ isolates: [isolate(1, { organism_display: '<b>bold</b><img src=x onerror="window.__x=1">' })] }));
    await screen.findByRole('grid', { name: /isolates/i });
    expect(document.querySelector('img[onerror]')).toBeNull();
    expect(document.querySelector('b')).toBeNull();
  });
  it('row menu: Identify, Edit description, Choose AST panel, Withdraw — and nothing for a withdrawn isolate', async () => {
    await mount(incubating({ isolates: [isolate(1, { id: ID(301) }), isolate(2, { id: ID(302), status: 'withdrawn', is_reportable: false })] }));
    await screen.findByRole('grid', { name: /isolates/i });
    const rows = screen.getAllByRole('row').filter((r) => /Identified|Withdrawn/.test(r.textContent ?? ''));
    const menuOf = async (row: HTMLElement) => { const b = within(row).getAllByRole('button'); await userEvent.click(b[b.length - 1]!); return screen.findAllByRole('menuitem'); };
    const first = await menuOf(rows.find((r) => /Identified/.test(r.textContent!))!);
    expect(first.map((m) => m.textContent?.trim())).toEqual(expect.arrayContaining(['Identify', 'Edit description', 'Choose AST panel', 'Withdraw']));
    await userEvent.keyboard('{Escape}');
    const wd = rows.find((r) => /Withdrawn/.test(r.textContent!))!;
    const b = within(wd).queryAllByRole('button');
    if (b.length) {
      await userEvent.click(b[b.length - 1]!);
      const items = screen.queryAllByRole('menuitem').map((m) => m.textContent?.trim());
      expect(items).not.toEqual(expect.arrayContaining(['Identify']));
      expect(items).not.toEqual(expect.arrayContaining(['Withdraw']));
    }
  });
  it('final_submitted / cancelled and read-only users: no Add isolate and no row actions that write', async () => {
    for (const [status, perms] of [['final_submitted', PERM_WORK], ['cancelled', PERM_WORK], ['incubating', PERM_READ]] as const) {
      cleanup();
      await mount(two({ status }), [...perms]);
      expect(btn(/^add isolate$/i), `${status}/${perms.length}`).toBeUndefined();
      const row = screen.getAllByRole('row').find((r) => /Identified/.test(r.textContent ?? ''))!;
      const b = within(row).queryAllByRole('button');
      if (b.length) { await userEvent.click(b[b.length - 1]!); expect(screen.queryAllByRole('menuitem', { name: /^(identify|withdraw|edit description)$/i })).toHaveLength(0); await userEvent.keyboard('{Escape}'); }
    }
  });
});

describe('add isolate (AC-05.1, AC-05.2; 04-UI-UX §3.3)', () => {
  const open = async (c: Record<string, unknown> = incubating({ plates: [plate(1), plate(2)] })) => {
    await mount(c);
    await userEvent.click(btn(/^add isolate$/i)!);
    return dialog(/add isolate/i);
  };
  it('fields: Organism combobox, Plate, Colony description (≤500), Quantity (≤80), Reportable checkbox checked by default', async () => {
    const d = await open();
    expect(within(d).getByRole('combobox', { name: /organism/i })).toBeTruthy();
    expect(within(d).getByRole('button', { name: /^plate/i })).toBeTruthy();
    expect((within(d).getByRole('textbox', { name: /colony description/i }) as HTMLTextAreaElement).maxLength).toBe(500);
    expect((within(d).getByRole('textbox', { name: /quantity/i }) as HTMLInputElement).maxLength).toBe(80);
    expect((within(d).getByRole('checkbox', { name: /reportable/i }) as HTMLInputElement).checked).toBe(true);
  });
  it('the organism search starts at 2 characters (minChars) and asks the BFF with q; options read "{display} · {group}"', async () => {
    const d = await open();
    const box = within(d).getByRole('combobox', { name: /organism/i });
    await userEvent.type(box, 's');
    await new Promise((r) => setTimeout(r, 500));
    expect(orgGets()).toHaveLength(0);
    await userEvent.type(box, 'y');
    await waitFor(() => expect(orgGets().length).toBeGreaterThan(0));
    expect(new URLSearchParams(orgGets().at(-1)!.search).get('q')).toBe('sy');
    const opts = (await screen.findAllByRole('option')).map((o) => o.textContent ?? '');
    expect(opts.some((o) => /^Synthetic organism · .+/.test(o))).toBe(true);
  });
  it('POST /isolates with Idempotency-Key and only plate_id, colony_description, quantity_text, organism_code — never isolate_seq / status / tenant (S-05); the number comes from the server (AC-05.1)', async () => {
    const d = await open();
    await comboPick(d, 'sy', /^Synthetic organism ·/);
    await pick(d, /^plate/i, /1/);
    await userEvent.type(within(d).getByRole('textbox', { name: /colony description/i }), 'Synthetic colony');
    await userEvent.type(within(d).getByRole('textbox', { name: /quantity/i }), '++');
    await userEvent.click(within(d).getByRole('button', { name: /^(save|add isolate)$/i }));
    const h = await lastHit('POST', /\/isolates$/);
    expect(h.path).toBe(`/v1/micro/cultures/${ID(1)}/isolates`);
    expect(h.headers.get('idempotency-key')).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(h.json).toEqual({ organism_code: 'synthetic_org', plate_id: ID(101), colony_description: 'Synthetic colony', quantity_text: '++' });
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
    expect(hit('POST', /\/describe$/)).toHaveLength(0); // reportable stayed checked
  });
  it('organism is optional: an isolate can be added unidentified (pending_id) with no organism_code', async () => {
    const d = await open();
    await userEvent.click(within(d).getByRole('button', { name: /^(save|add isolate)$/i }));
    const h = await lastHit('POST', /\/isolates$/);
    expect('organism_code' in h.json).toBe(false);
  });
  it('un-ticking Reportable: the create body has no is_reportable; a follow-up describe call (If-Match = new isolate version) sets it false', async () => {
    api.use(http.post(`${ORIGIN}/v1/micro/cultures/:id/isolates`, () => HttpResponse.json(isolate(4, { id: ID(304), version: 2, status: 'pending_id' }))));
    const d = await open();
    await userEvent.click(within(d).getByRole('checkbox', { name: /reportable/i }));
    await userEvent.click(within(d).getByRole('button', { name: /^(save|add isolate)$/i }));
    const created = await lastHit('POST', /\/isolates$/);
    expect('is_reportable' in created.json).toBe(false);
    const h = await lastHit('POST', /\/isolates\/[^/]+\/describe$/);
    expect(h.path).toBe(`/v1/micro/isolates/${ID(304)}/describe`);
    expect(h.headers.get('if-match')).toBe('"2"');
    expect(h.json).toEqual({ is_reportable: false });
  });
  it('text typed in the organism box that is not chosen from the list is never sent as a code (AC-05.2)', async () => {
    const d = await open();
    await userEvent.type(within(d).getByRole('combobox', { name: /organism/i }), 'free typed organism');
    await userEvent.keyboard('{Escape}'); // close popup so the dialog content is reachable
    await userEvent.click(within(d).getByRole('button', { name: /^(save|add isolate)$/i }));
    const h = await lastHit('POST', /\/isolates$/);
    expect('organism_code' in h.json).toBe(false);
  });
  it('422 micro.organism_code_unknown -> "Choose an organism from the list. Ask your lab manager to add new organisms."', async () => {
    api.use(http.post(`${ORIGIN}/v1/micro/cultures/:id/isolates`, () => problem('micro.organism_code_unknown', 422)));
    const d = await open();
    await comboPick(d, 'sy', /^Synthetic organism ·/);
    await userEvent.click(within(d).getByRole('button', { name: /^(save|add isolate)$/i }));
    expect(await screen.findByText(/Choose an organism from the list\. Ask your lab manager to add new organisms\./)).toBeTruthy();
    expect(screen.getByRole('dialog', { name: /add isolate/i })).toBeTruthy();
  });
  it('409 report_final_locked and culture_invalid_transition use the §10 copy', async () => {
    api.use(http.post(`${ORIGIN}/v1/micro/cultures/:id/isolates`, () => problem('micro.report_final_locked', 409)));
    const d = await open();
    await userEvent.click(within(d).getByRole('button', { name: /^(save|add isolate)$/i }));
    expect(await screen.findByText('The final report has been sent. Reopen the culture to make changes.')).toBeTruthy();
  });
});

describe('identify / re-identify (AC-05.2, AC-05.3)', () => {
  const identify = async (row: RegExp) => { await rowAction(row, /^identify$/i); return dialog(/identify/i); };
  it('POST /identify with If-Match = the isolate version and only organism_code; an identified isolate can be re-identified, prefilled with the current organism', async () => {
    await mount(incubating({ isolates: [isolate(1, { id: ID(301), version: 3 })] }));
    await screen.findByRole('grid', { name: /isolates/i });
    const d = await identify(/Identified/);
    expect((within(d).getByRole('combobox', { name: /organism/i }) as HTMLInputElement).value).toMatch(/Synthetic organism/);
    await comboPick(d, 'two', /Synthetic organism two/);
    await userEvent.click(within(d).getByRole('button', { name: /^(save|identify)$/i }));
    const h = await lastHit('POST', /\/identify$/);
    expect(h.path).toBe(`/v1/micro/isolates/${ID(301)}/identify`);
    expect(h.headers.get('if-match')).toBe('"3"');
    expect(h.json).toEqual({ organism_code: 'synthetic_org_two' });
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
  });
  it('an organism is required here: Save without one sends nothing', async () => {
    await mount(incubating({ isolates: [isolate(1, { id: ID(301), status: 'pending_id', organism_code: undefined, organism_display: undefined })] }));
    await screen.findByRole('grid', { name: /isolates/i });
    const d = await identify(/Not identified/);
    await userEvent.click(within(d).getByRole('button', { name: /^(save|identify)$/i }));
    expect(hit('POST', /\/identify$/)).toHaveLength(0);
  });
  it('422 micro.organism_code_unknown on identify shows the unknown-organism copy', async () => {
    api.use(http.post(`${ORIGIN}/v1/micro/isolates/:id/identify`, () => problem('micro.organism_code_unknown', 422)));
    await mount(incubating({ isolates: [isolate(1, { id: ID(301) })] }));
    await screen.findByRole('grid', { name: /isolates/i });
    const d = await identify(/Identified/);
    await comboPick(d, 'two', /Synthetic organism two/);
    await userEvent.click(within(d).getByRole('button', { name: /^(save|identify)$/i }));
    expect(await screen.findByText(/Choose an organism from the list\./)).toBeTruthy();
  });
  it('409 micro.isolate_invalid_transition -> "This isolate can\'t be changed that way."; 409 common.version_conflict -> kit default', async () => {
    api.use(http.post(`${ORIGIN}/v1/micro/isolates/:id/identify`, () => problem('micro.isolate_invalid_transition', 409)));
    await mount(incubating({ isolates: [isolate(1, { id: ID(301) })] }));
    await screen.findByRole('grid', { name: /isolates/i });
    let d = await identify(/Identified/);
    await comboPick(d, 'two', /Synthetic organism two/);
    await userEvent.click(within(d).getByRole('button', { name: /^(save|identify)$/i }));
    expect(await screen.findByText("This isolate can't be changed that way.")).toBeTruthy();
    api.use(http.post(`${ORIGIN}/v1/micro/isolates/:id/identify`, () => problem('common.version_conflict', 409)));
    d = await dialog(/identify/i);
    await userEvent.click(within(d).getByRole('button', { name: /^(save|identify)$/i }));
    expect(await screen.findByText(/someone else changed this\. reload and try again\./i)).toBeTruthy();
  });
});

describe('edit description', () => {
  it('POST /describe with If-Match and only the declared fields', async () => {
    await mount(incubating({ plates: [plate(1)], isolates: [isolate(1, { id: ID(301), version: 2, colony_description: 'old colony' })] }));
    await screen.findByRole('grid', { name: /isolates/i });
    await rowAction(/Identified/, /^edit description$/i);
    const d = await dialog(/description|edit isolate/i);
    const colony = within(d).getByRole('textbox', { name: /colony description/i }) as HTMLTextAreaElement;
    expect(colony.value).toBe('old colony');
    await userEvent.clear(colony);
    await userEvent.type(colony, 'new colony');
    await userEvent.click(within(d).getByRole('button', { name: /^save$/i }));
    const h = await lastHit('POST', /\/describe$/);
    expect(h.headers.get('if-match')).toBe('"2"');
    expect(Object.keys(h.json).every((k) => ['colony_description', 'quantity_text', 'is_reportable', 'plate_id'].includes(k))).toBe(true);
    expect(h.json.colony_description).toBe('new colony');
  });
});

describe('withdraw (AC-05.4; 04-UI-UX §3.3)', () => {
  const open = async (c: Record<string, unknown> = incubating({ isolates: [isolate(1, { id: ID(301), version: 4 }), isolate(2, { id: ID(302) })] })) => {
    await mount(c);
    await screen.findByRole('grid', { name: /isolates/i });
    await rowAction(/^1\b.*Identified|Identified/, /^withdraw$/i);
    return screen.findByRole('dialog');
  };
  it('danger ConfirmDialog titled "Withdraw isolate {n}?" with a coded reason (required) and optional comment ≤500', async () => {
    const d = await open();
    expect(within(d).getByRole('heading', { name: /^Withdraw isolate \d+\?$/ })).toBeTruthy();
    expect(within(d).getByRole('button', { name: /reason/i })).toBeTruthy();
    const comment = within(d).getByRole('textbox') as HTMLInputElement;
    expect(comment.maxLength).toBe(500);
    expect(comment.required).toBe(false);
    expect(d.querySelector('button.lims-btn-danger, [data-variant=danger]')).toBeTruthy();
  });
  it('confirming without a reason sends nothing', async () => {
    const d = await open();
    await userEvent.click(within(d).getByRole('button', { name: /^withdraw$/i }));
    expect(hit('POST', /\/withdraw$/)).toHaveLength(0);
  });
  it('POST /withdraw with If-Match = isolate version, reason_code (+ comment); culture refreshed', async () => {
    const d = await open();
    await pick(d, /reason/i, /^synthetic contaminant$/i);
    await userEvent.type(within(d).getByRole('textbox'), 'Synthetic comment');
    await userEvent.click(within(d).getByRole('button', { name: /^withdraw$/i }));
    const h = await lastHit('POST', /\/withdraw$/);
    expect(h.path).toMatch(/^\/v1\/micro\/isolates\/[0-9a-f-]+\/withdraw$/);
    expect(h.headers.get('if-match')).toMatch(/^"\d+"$/);
    expect(h.json).toEqual({ reason_code: 'synthetic_contaminant', comment: 'Synthetic comment' });
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
  });
  it('the reasons offered are the coded set micro.isolate_withdraw_reasons only', async () => {
    const d = await open();
    await userEvent.click(within(d).getByRole('button', { name: /reason/i }));
    expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['Synthetic contaminant', 'Synthetic duplicate']);
  });
  it('409 micro.isolate_invalid_transition / report_final_locked show the §10 copy and keep the dialog', async () => {
    api.use(http.post(`${ORIGIN}/v1/micro/isolates/:id/withdraw`, () => problem('micro.report_final_locked', 409)));
    const d = await open();
    await pick(d, /reason/i, /^synthetic duplicate$/i);
    await userEvent.click(within(d).getByRole('button', { name: /^withdraw$/i }));
    expect(await screen.findByText('The final report has been sent. Reopen the culture to make changes.')).toBeTruthy();
  });
});

describe('accessibility (axe)', () => {
  const run = async (el: HTMLElement) => (await axe.run(el, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } })).violations.map((v) => `${v.id}: ${v.help}`);
  it('isolate list in all three statuses', async () => {
    await mount(incubating({ isolates: [isolate(1, { id: ID(301) }), isolate(2, { id: ID(302), status: 'pending_id', organism_code: undefined, organism_display: undefined }), isolate(3, { id: ID(303), status: 'withdrawn' })] }));
    await screen.findByRole('grid', { name: /isolates/i });
    expect(await run(document.body)).toEqual([]);
  });
  it('add isolate dialog', async () => {
    await mount();
    await userEvent.click(btn(/^add isolate$/i)!);
    expect(await run(await dialog(/add isolate/i))).toEqual([]);
  });
});
