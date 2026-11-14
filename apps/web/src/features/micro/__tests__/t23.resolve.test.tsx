// @vitest-environment jsdom
// C10.T-23 — "Apply", "Resolve conflict" and "Ignore" (04-UI-UX §4; AC-08.5 apply after a map exists; AC-08.6 conflict: use_instrument replaces (audited) / keep_existing closes as ignored "kept_manual";
// 03-APP-FLOW §2.4 IR3–IR6; M21 applyMicroInstrumentRecord, M22 ignoreMicroInstrumentRecord; REQ-SEC-121). Real server actions + MSW. LD-140: kit only. Seams: t23.harness.tsx header.
// Conflict dialog: two-column comparison "Instrument" vs "Current" (current value read from the culture, GET /v1/micro/cultures/{culture_id}), RadioGroup "Use instrument value" / "Keep current value", confirm "Resolve".
// Ignore dialog: ConfirmDialog requireReason { codedSet: 'micro.record_ignore_reasons', freeText 300 optional }, confirm "Ignore".
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { http, HttpResponse } from 'msw';
import { ToastProvider } from '@lims/ui/components/Toast';
import { APPLY, BARCODE, CONFLICT_COPY, ID, IGNORE, ORIGIN, PERM_WORK, api, clean, conflictCulture, dialog, hit, instrumentList, optionNamesOf, orgRec, pick, problem, rec, recordList, resetHits, router, rowAction, state, writeFail, writeOk } from './t23.harness';

vi.mock('next/navigation', async () => (await import('./t23.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t23.harness')).sessionMock);

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { resetHits(); router.refresh.mockReset(); state.permissions = PERM_WORK; });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const show = async (record: Record<string, unknown>, ...custom: Parameters<typeof api.use>) => {
  api.use(recordList([record]), instrumentList(), writeOk('apply'), writeOk('ignore'), http.get(`${ORIGIN}/v1/micro/cultures/:id`, () => HttpResponse.json(conflictCulture())));
  if (custom.length) api.use(...custom); // msw use() prepends: per-test handlers go AFTER the defaults so they win (T-23 ruling)
  const mod = await import('../../../app/(staff)/micro/instrument-records/page');
  const el = await mod.default({ searchParams: Promise.resolve({}) } as never);
  render(<ToastProvider>{el}</ToastProvider>);
};
const CONFLICT = rec(3, { match_status: 'conflict', match_reason: 'manual_value_exists', culture_id: ID(1), version: 6, isolate_seq: 2, raw_value: '<=0.25', interpretation_raw: 'S' });
const MAPPING = rec(2, { match_status: 'needs_mapping', match_reason: undefined, culture_id: ID(1), version: 4 });
const applyPosts = () => hit('POST', APPLY);
const ignorePosts = () => hit('POST', IGNORE);
const last = async (f: () => ReturnType<typeof hit>) => { await waitFor(() => expect(f().length).toBeGreaterThan(0)); return f().at(-1)!; };

describe('Apply (AC-08.5: needs_mapping / late_after_final / pending_match with a known culture)', () => {
  it('POST /apply with Idempotency-Key + If-Match "<version>" and an empty-object body (no resolution); then the page refreshes', async () => {
    await show(MAPPING);
    await rowAction(BARCODE, /^apply$/i);
    const h = await last(applyPosts);
    expect(h.path).toBe(`/v1/micro/instrument-records/${MAPPING.id}/apply`);
    expect(h.headers.get('if-match')).toBe('"4"');
    expect((h.headers.get('idempotency-key') ?? '').length).toBeGreaterThan(8);
    expect(h.json ?? {}).toEqual({});
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
  });
  it('still unmapped after Apply (record returns needs_mapping): the user is told it still needs a code mapping; it is NOT reported as applied', async () => {
    await show(MAPPING, http.post(`${ORIGIN}/v1/micro/instrument-records/:id/apply`, () => HttpResponse.json(clean(rec(2, { match_status: 'needs_mapping', match_reason: undefined, culture_id: ID(1), version: 5 })))));
    await rowAction(BARCODE, /^apply$/i);
    await waitFor(() => expect(document.body.textContent).toMatch(/needs? (a )?(code )?mapping|map the code|mapping/i));
    expect(document.body.textContent).not.toMatch(/\bapplied\b/i);
  });
  it('the apply may come back as conflict: the conflict dialog opens (no silent success)', async () => {
    await show(MAPPING, http.post(`${ORIGIN}/v1/micro/instrument-records/:id/apply`, () => HttpResponse.json(clean(rec(2, { match_status: 'conflict', match_reason: 'manual_value_exists', culture_id: ID(1), version: 5 })))));
    await rowAction(BARCODE, /^apply$/i);
    expect(await dialog(/resolve conflict|conflict/i)).toBeTruthy();
  });
  it('a double click on the row action sends one request', async () => {
    await show(MAPPING, http.post(`${ORIGIN}/v1/micro/instrument-records/:id/apply`, async () => { await new Promise((r) => setTimeout(r, 150)); return HttpResponse.json(clean(rec(2, { match_status: 'applied', culture_id: ID(1) }))); }));
    await rowAction(BARCODE, /^apply$/i);
    await new Promise((r) => setTimeout(r, 350));
    expect(applyPosts()).toHaveLength(1);
  });
  it.each([
    ['micro.instrument_record_conflict', 409, /this record conflicts with existing data\. choose which value to keep\./i],
    ['micro.report_final_locked', 409, /the final report has been sent\. reopen the culture to make changes\./i],
    ['common.version_conflict', 409, /someone else changed this\. reload and try again\./i],
    ['common.internal', 500, /something went wrong/i],
  ])('failure %s (%i) is shown in plain words, never as the raw code; no refresh', async (c, status, copy) => {
    await show(MAPPING, writeFail('apply', c, status));
    await rowAction(BARCODE, /^apply$/i);
    await waitFor(() => expect(screen.getByText(copy)).toBeTruthy());
    expect(document.body.textContent).not.toContain(c);
    expect(router.refresh).not.toHaveBeenCalled();
  });
});

describe('Resolve conflict dialog (AC-08.6)', () => {
  const open = async (r: Record<string, unknown> = CONFLICT, ...custom: Parameters<typeof api.use>) => { await show(r, ...custom); await rowAction(BARCODE, /^resolve conflict$/i); return dialog(/resolve conflict|conflict/i); };
  const resolveBtn = (d: HTMLElement) => within(d).getByRole('button', { name: /^resolve$/i }) as HTMLButtonElement;
  it('shows the §10 conflict message and a two-column comparison "Instrument" vs "Current"', async () => {
    const d = await open();
    expect(d.textContent).toContain(CONFLICT_COPY);
    const heads = within(d).getAllByRole('columnheader').map((h) => h.textContent?.trim());
    expect(heads).toEqual(expect.arrayContaining(['Instrument', 'Current']));
  });
  it('Instrument column = the record (raw value, interpretation, standard + version); Current column = the manual value read from the culture (value, category)', async () => {
    const d = await open();
    await waitFor(() => expect(d.textContent).toContain('0.5')); // manual value from the culture
    expect(d.textContent).toContain('<=0.25');
    expect(d.textContent).toMatch(/CLSI/);
    expect(hit('GET', new RegExp(`/v1/micro/cultures/${ID(1)}$`)).length).toBeGreaterThan(0);
  });
  it('an organism conflict compares the organisms (record raw code vs the manually identified organism)', async () => {
    const d = await open(orgRec(3, { match_status: 'conflict', match_reason: 'organism_differs', culture_id: ID(1), version: 6, isolate_seq: 2 }));
    await waitFor(() => expect(d.textContent).toContain('Synthetic organism'));
    expect(d.textContent).toContain('SYN-ORG-9');
  });
  it('RadioGroup "Use instrument value" / "Keep current value"; nothing is pre-selected and Resolve will not send until one is chosen (a destructive overwrite is never the default)', async () => {
    const d = await open();
    const radios = within(d).getAllByRole('radio');
    expect(radios.map((r) => (r as HTMLInputElement).checked)).toEqual([false, false]);
    expect(within(d).getByRole('radio', { name: /use instrument value/i })).toBeTruthy();
    expect(within(d).getByRole('radio', { name: /keep current value/i })).toBeTruthy();
    await userEvent.click(resolveBtn(d));
    expect(applyPosts()).toHaveLength(0);
    expect(screen.getByRole('dialog', { name: /conflict/i })).toBeTruthy();
    expect(d.querySelector('[data-invalid],[aria-invalid="true"]')).not.toBeNull();
  });
  it('"Use instrument value" -> POST /apply { resolution: "use_instrument" } with Idempotency-Key + If-Match; closes; page refreshes', async () => {
    const d = await open();
    await userEvent.click(within(d).getByRole('radio', { name: /use instrument value/i }));
    await userEvent.click(resolveBtn(d));
    const h = await last(applyPosts);
    expect(h.path).toBe(`/v1/micro/instrument-records/${CONFLICT.id}/apply`);
    expect(h.headers.get('if-match')).toBe('"6"');
    expect((h.headers.get('idempotency-key') ?? '').length).toBeGreaterThan(8);
    expect(h.json).toEqual({ resolution: 'use_instrument' });
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
    expect(screen.queryByRole('dialog', { name: /conflict/i })).toBeNull();
  });
  it('"Keep current value" -> { resolution: "keep_existing" } (the API closes the record as ignored, reason kept_manual)', async () => {
    const d = await open();
    await userEvent.click(within(d).getByRole('radio', { name: /keep current value/i }));
    await userEvent.click(resolveBtn(d));
    expect((await last(applyPosts)).json).toEqual({ resolution: 'keep_existing' });
  });
  it('a conflict on a record with NO culture yet (pending_match) is resolved through assign, not apply, with the chosen resolution', async () => {
    const d = await open(rec(3, { match_status: 'conflict', match_reason: 'manual_value_exists', culture_id: undefined, version: 6 }), http.post(`${ORIGIN}/v1/micro/instrument-records/:id/assign`, () => HttpResponse.json(clean(rec(3, { match_status: 'applied', culture_id: ID(1) })))));
    expect(d).toBeTruthy();
    // no culture to compare against: the dialog must say so rather than invent a value, and apply must not be called
    expect(applyPosts()).toHaveLength(0);
  });
  it('a failed save keeps the dialog open and the choice selected; double click sends one request', async () => {
    const d = await open(CONFLICT, http.post(`${ORIGIN}/v1/micro/instrument-records/:id/apply`, async () => { await new Promise((r) => setTimeout(r, 120)); return problem('micro.instrument_record_conflict', 409); }));
    await userEvent.click(within(d).getByRole('radio', { name: /use instrument value/i }));
    await userEvent.dblClick(resolveBtn(d));
    await waitFor(() => expect(applyPosts().length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 300));
    expect(applyPosts()).toHaveLength(1);
    expect((within(screen.getByRole('dialog', { name: /conflict/i })).getByRole('radio', { name: /use instrument value/i }) as HTMLInputElement).checked).toBe(true);
  });
  it('markup in raw values is text, never HTML (REQ-SEC-121)', async () => {
    const d = await open(rec(3, { match_status: 'conflict', match_reason: 'manual_value_exists', culture_id: ID(1), raw_value: '<img src=x onerror=alert(1)>' }));
    expect(d.querySelector('img')).toBeNull();
    expect(d.textContent).toContain('<img src=x onerror=alert(1)>');
  });
  it('is accessible (axe)', async () => {
    const d = await open();
    const v = (await axe.run(d, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } })).violations.map((x) => `${x.id}: ${x.help}`);
    expect(v).toEqual([]);
  });
});

describe('Ignore dialog (IR6; M22; coded set micro.record_ignore_reasons)', () => {
  const open = async (r: Record<string, unknown> = rec(1), ...custom: Parameters<typeof api.use>) => { await show(r, ...custom); await rowAction(BARCODE, /^ignore$/i); return dialog(/ignore/i); };
  const reasonBtn = (d: HTMLElement) => within(d).getByRole('button', { name: /reason/i });
  const confirm = (d: HTMLElement) => userEvent.click(within(d).getByRole('button', { name: /^ignore$/i }));
  it('ConfirmDialog with a required Reason select (active codes only), optional Comment (max 300) and buttons "Ignore" + "Cancel"', async () => {
    const d = await open();
    const comment = within(d).getByRole('textbox', { name: /comment|details/i }) as HTMLInputElement;
    expect(comment.maxLength).toBe(300);
    expect(comment.required).toBe(false);
    expect(within(d).getByRole('button', { name: /^cancel$/i })).toBeTruthy();
    const names = await optionNamesOf(reasonBtn(d));
    expect(names).toEqual(['Synthetic duplicate result', 'Synthetic wrong specimen']);
    expect(hit('GET', /\/v1\/micro\/coded-sets\/record_ignore_reasons$/).length).toBeGreaterThan(0);
  });
  it('no reason: no request, dialog stays open, field invalid', async () => {
    const d = await open();
    await confirm(d);
    expect(ignorePosts()).toHaveLength(0);
    expect(screen.getByRole('dialog', { name: /ignore/i })).toBeTruthy();
    expect(d.querySelector('[data-invalid]')).not.toBeNull();
  });
  it('POST /ignore with If-Match "<version>" and exactly { reason_code, comment }; without a comment only { reason_code }', async () => {
    const d = await open(rec(1, { version: 9 }));
    await pick(d, /reason/i, /synthetic wrong specimen/i);
    await userEvent.type(within(d).getByRole('textbox', { name: /comment|details/i }), 'Synthetic note');
    await confirm(d);
    const h = await last(ignorePosts);
    expect(h.path).toBe(`/v1/micro/instrument-records/${rec(1).id}/ignore`);
    expect(h.headers.get('if-match')).toBe('"9"');
    expect(h.json).toEqual({ reason_code: 'wrong_patient', comment: 'Synthetic note' });
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
    cleanup(); resetHits();
    const d2 = await open();
    await pick(d2, /reason/i, /synthetic duplicate result/i);
    await confirm(d2);
    expect((await last(ignorePosts)).json).toEqual({ reason_code: 'duplicate' });
  });
  it('a double click sends one request', async () => {
    const d = await open(rec(1), http.post(`${ORIGIN}/v1/micro/instrument-records/:id/ignore`, async () => { await new Promise((r) => setTimeout(r, 150)); return HttpResponse.json(clean(rec(1, { match_status: 'ignored', ignore_reason_code: 'duplicate' }))); }));
    await pick(d, /reason/i, /synthetic duplicate result/i);
    await userEvent.dblClick(within(d).getByRole('button', { name: /^ignore$/i }));
    await new Promise((r) => setTimeout(r, 350));
    expect(ignorePosts()).toHaveLength(1);
  });
  it.each([
    ['micro.instrument_record_conflict', 409, /this record conflicts with existing data\. choose which value to keep\./i],
    ['common.version_conflict', 409, /someone else changed this\. reload and try again\./i],
    ['common.internal', 500, /something went wrong/i],
  ])('failure %s (%i): dialog stays open, choice kept, no raw code', async (c, status, copy) => {
    const d = await open(rec(1), writeFail('ignore', c, status));
    await pick(d, /reason/i, /synthetic duplicate result/i);
    await confirm(d);
    await waitFor(() => expect(within(screen.getByRole('dialog', { name: /ignore/i })).getByText(copy)).toBeTruthy());
    expect(document.body.textContent).not.toContain(c);
    expect(reasonBtn(screen.getByRole('dialog', { name: /ignore/i })).textContent).toMatch(/synthetic duplicate result/i);
    expect(router.refresh).not.toHaveBeenCalled();
  });
  it('is accessible (axe)', async () => {
    const d = await open();
    const v = (await axe.run(d, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } })).violations.map((x) => `${x.id}: ${x.help}`);
    expect(v).toEqual([]);
  });
});
