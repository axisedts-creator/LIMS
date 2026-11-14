// @vitest-environment jsdom
// C10.T-22 — "Reopen for amendment" (04-UI-UX §3.4 last paragraph; 03-APP-FLOW §4.6; AC-11.1, AC-11.4, AC-11.6 UI side; 07-SECURITY S-30; 08 A17 D-62).
// Real server actions + MSW (C10 M17 reopenCulture, C5 listLabCodedSet). Seam: CultureScreen + ConfirmDialog(requireReason) — see t22.harness.tsx. LD-140: kit only.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { http, HttpResponse } from 'msw';
import { ToastProvider } from '@lims/ui/components/Toast';
import { LAB_REASONS, ORIGIN, PERM_READ, PERM_WORK, SYSTEM_CODES, amending, api, dialog, finalCulture, growth, headerBtn, hit, optionNames, pick, problem, resetHits, router, state, useReports } from './t22.harness';

vi.mock('next/navigation', async () => (await import('./t22.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t22.harness')).sessionMock);

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { resetHits(); router.refresh.mockReset(); state.permissions = PERM_WORK; useReports(); });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const mount = async (c: Record<string, unknown> = finalCulture(), permissions = PERM_WORK) => {
  const { CultureScreen } = await import('../components/culture/CultureScreen');
  return render(<ToastProvider><CultureScreen culture={c as never} patient={{ name: 'Synthetic Patient One' }} specimen={null} permissions={permissions} /></ToastProvider>);
};
const open = async (c: Record<string, unknown> = finalCulture()) => {
  await mount(c);
  await userEvent.click(headerBtn(/^reopen for amendment$/i));
  return dialog(/^reopen for amendment$/i);
};
const reasonBtn = (d: HTMLElement) => within(d).getByRole('button', { name: /reason/i });
const confirm = (d: HTMLElement) => userEvent.click(within(d).getByRole('button', { name: /^reopen$/i }));
const posts = () => hit('POST', /\/reopen$/);
const lastPost = async () => { await waitFor(() => expect(posts().length).toBeGreaterThan(0)); return posts().at(-1)!; };

describe('where the button shows (03-APP-FLOW §4.2)', () => {
  it('final_submitted + micro.culture.work: "Reopen for amendment" is enabled and is the one primary action', async () => {
    await mount();
    const b = headerBtn(/^reopen for amendment$/i) as HTMLButtonElement;
    expect(b.disabled).toBe(false);
    expect(b.className).toContain('lims-btn-primary');
    expect(document.querySelectorAll('button.lims-btn-primary')).toHaveLength(1);
  });
  it.each([['awaiting_setup'], ['incubating'], ['growth_detected'], ['amending'], ['cancelled']])('status %s: no Reopen button', async (status) => {
    await mount(growth({ status }));
    expect(screen.queryByRole('button', { name: /^reopen for amendment$/i })).toBeNull();
  });
  it('without micro.culture.work: no Reopen button', async () => {
    await mount(finalCulture(), PERM_READ);
    expect(screen.queryByRole('button', { name: /^reopen for amendment$/i })).toBeNull();
  });
  it('final_submitted offers neither "Preliminary report" nor "Final report" (nothing to compose on a sent final)', async () => {
    await mount();
    expect(screen.queryByRole('button', { name: /^(preliminary|final) report$/i })).toBeNull();
  });
});

describe('the dialog (AC-11.1; D-62; S-30)', () => {
  it('is a ConfirmDialog "Reopen for amendment" with a required Reason select, optional Details (max 500) and buttons "Reopen" + "Cancel"', async () => {
    const d = await open();
    expect(reasonBtn(d)).toBeTruthy();
    const details = within(d).getByRole('textbox', { name: /details/i }) as HTMLInputElement;
    expect(details.maxLength).toBe(500);
    expect(details.required).toBe(false);
    expect(within(d).getByRole('button', { name: /^reopen$/i })).toBeTruthy();
    expect(within(d).getByRole('button', { name: /^cancel$/i })).toBeTruthy();
  });
  it('the reasons come from C5 (global + tenant) and NEVER include module_phase_progression, module_preliminary_update or supplementary_report', async () => {
    const d = await open();
    const names = await optionNames(reasonBtn(d));
    expect(names).toEqual(['Synthetic transcription error', 'Synthetic new information']);
    for (const bad of ['Preliminary to final', 'Updated preliminary', 'Supplementary report', 'Synthetic retired reason']) expect(names, bad).not.toContain(bad);
    expect(hit('GET', LAB_REASONS).length).toBeGreaterThanOrEqual(1);
  });
  it('a system code that a tampered / stale BFF answer still contained cannot be sent: the dialog only submits codes it listed', async () => {
    const d = await open();
    await pick(d, /reason/i, /synthetic new information/i);
    await confirm(d);
    const h = await lastPost();
    for (const c of SYSTEM_CODES) expect(h.json.amendment_reason_code).not.toBe(c);
  });
  it('Cancel closes it without any request', async () => {
    const d = await open();
    await userEvent.click(within(d).getByRole('button', { name: /^cancel$/i }));
    expect(screen.queryByRole('dialog', { name: /reopen for amendment/i })).toBeNull();
    expect(posts()).toHaveLength(0);
  });
  it('no reason chosen (AC-11.4 on the client): no request, the dialog stays open and the Reason field is marked invalid', async () => {
    const d = await open();
    await confirm(d);
    expect(posts()).toHaveLength(0);
    expect(screen.getByRole('dialog', { name: /reopen for amendment/i })).toBeTruthy();
    expect(d.querySelector('[data-invalid]')).not.toBeNull();
    expect(d.querySelector('.lims-error')?.textContent ?? '').toMatch(/reason/i);
  });
  it('the reason list failing to load leaves an empty select; Reopen then sends nothing', async () => {
    api.use(http.get(`${ORIGIN}/v1/lab/coded-sets/amendment_reasons`, () => problem('common.internal', 500)));
    const d = await open();
    await confirm(d);
    expect(posts()).toHaveLength(0);
    expect(screen.getByRole('dialog', { name: /reopen for amendment/i })).toBeTruthy();
  });
  it('is accessible (axe)', async () => {
    const d = await open();
    const v = (await axe.run(d, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } })).violations.map((x) => `${x.id}: ${x.help}`);
    expect(v).toEqual([]);
  });
});

describe('submitting (M17 reopenCulture; S-05 strict body)', () => {
  it('POST /reopen with If-Match "<culture.version>" and exactly { amendment_reason_code, amendment_reason_text }; dialog closes; page refreshed', async () => {
    const d = await open(finalCulture({ version: 9 }));
    await pick(d, /reason/i, /synthetic transcription error/i);
    await userEvent.type(within(d).getByRole('textbox', { name: /details/i }), 'Synthetic wrong isolate number');
    await confirm(d);
    const h = await lastPost();
    expect(h.path).toMatch(/\/v1\/micro\/cultures\/[^/]+\/reopen$/);
    expect(h.headers.get('if-match')).toBe('"9"');
    expect(Object.keys(h.json).sort()).toEqual(['amendment_reason_code', 'amendment_reason_text']);
    expect(h.json.amendment_reason_code).toBe('syn_transcription_error');
    expect(h.json.amendment_reason_text).toBe('Synthetic wrong isolate number');
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
    expect(screen.queryByRole('dialog', { name: /reopen for amendment/i })).toBeNull();
  });
  it('without Details the body is only { amendment_reason_code } (no empty text)', async () => {
    const d = await open();
    await pick(d, /reason/i, /synthetic new information/i);
    await confirm(d);
    expect(Object.keys((await lastPost()).json)).toEqual(['amendment_reason_code']);
  });
  it('a double click sends one request', async () => {
    api.use(http.post(`${ORIGIN}/v1/micro/cultures/:id/reopen`, async () => { await new Promise((r) => setTimeout(r, 150)); return HttpResponse.json(amending()); }));
    const d = await open();
    await pick(d, /reason/i, /synthetic new information/i);
    await userEvent.dblClick(within(d).getByRole('button', { name: /^reopen$/i }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 300));
    expect(posts()).toHaveLength(1);
  });
});

describe('errors (04-UI-UX §10): dialog stays open, the choice is kept, no raw code', () => {
  const cases: [string, number, RegExp][] = [
    ['micro.amendment_reason_required', 422, /choose a reason for the amendment\./i],
    ['micro.culture_invalid_transition', 409, /this culture has changed\. reload to see its current state\./i],
    ['common.version_conflict', 409, /someone else changed this\. reload and try again\./i],
    ['common.internal', 500, /something went wrong/i],
  ];
  it.each(cases)('%s (%i)', async (c, status, copy) => {
    api.use(http.post(`${ORIGIN}/v1/micro/cultures/:id/reopen`, () => problem(c, status)));
    const d = await open();
    await pick(d, /reason/i, /synthetic new information/i);
    await confirm(d);
    await waitFor(() => expect(within(screen.getByRole('dialog', { name: /reopen for amendment/i })).getByText(copy)).toBeTruthy());
    expect(document.body.textContent).not.toContain(c);
    expect(reasonBtn(screen.getByRole('dialog', { name: /reopen for amendment/i })).textContent).toMatch(/synthetic new information/i);
    expect(router.refresh).not.toHaveBeenCalled();
  });
  it('a conflict offers Reload, which refreshes the page', async () => {
    api.use(http.post(`${ORIGIN}/v1/micro/cultures/:id/reopen`, () => problem('micro.culture_invalid_transition', 409)));
    const d = await open();
    await pick(d, /reason/i, /synthetic new information/i);
    await confirm(d);
    await userEvent.click(await within(screen.getByRole('dialog', { name: /reopen for amendment/i })).findByRole('button', { name: /^reload$/i }));
    expect(router.refresh).toHaveBeenCalled();
  });
});

describe('after reopening (AC-11.1/11.6): amending shows the amendment banner and offers a final but no preliminary', () => {
  it('amending: banner with the reason text, "Final report" yes, "Preliminary report" no (C7 forbids amending -> preliminary)', async () => {
    await mount(amending());
    expect(document.body.textContent).toMatch(/amendment in progress/i);
    expect(document.body.textContent).toContain('Synthetic wrong isolate number');
    expect(screen.queryAllByRole('button', { name: /^final report$/i }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /^preliminary report$/i })).toBeNull();
  });
});
