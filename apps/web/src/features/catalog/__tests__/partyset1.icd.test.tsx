// @vitest-environment jsdom
// T0D-PARTYSET-1 — ICD master (done_when 5, 6, 7; LD-321; LD-353 template 1 LIST). Page app/(staff)/catalog/icd/page.tsx, route /catalog/icd, permission catalog.icd.manage.
// PINNED UI NAMES (tester choice; writer may dispute through the ruling path):
//   - headers Code, Title, Chapter, Active (+ optional "Actions"); Active = Yes / No; a missing chapter shows a dash. FilterBar: searchbox "Search" (q on the list call; pushes ?q=).
//   - "Add ICD code" -> dialog Code (^[0-9A-Z][0-9A-Z.]{0,15}$, typed lowercase is refused), Title (1..500), Chapter (optional, 1..120); POST /v1/catalog/icd-master with Idempotency-Key, empty chapter not sent.
//   - row "Edit" (Code read-only; PATCH only changed title / chapter, If-Match "<version>"), row "Deactivate" (confirm, POST .../deactivate, If-Match); inactive rows have neither.
//   - the list is paged (limit <= 50 on the call; a "Next" button when next_cursor is sent, which pushes ?cursor=).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { expectListScreen, expectStateInPage } from './uilist3.helpers';
import { API, ID, IDEM, PATHS, PERM, ROUTE, TM, api, headers, openPage, prob, quiet, rowOf } from '../../partners/__tests__/partyset1.harness';

beforeAll(() => api.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => { API.reset(); TM.refresh.mockReset(); TM.push.mockClear(); TM.replace.mockClear(); });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const HEADS = ['Code', 'Title', 'Chapter', 'Active'];
const open = (search = '') => openPage(ROUTE.icd, { perms: [PERM.icd], search });
const dlg = () => screen.findByRole('dialog');
const field = (d: HTMLElement, label: string) => within(d).getByLabelText(new RegExp(`^${label}`, 'i')) as HTMLInputElement;
const typeInto = async (user: ReturnType<typeof userEvent.setup>, el: HTMLElement, v: string) => { await user.clear(el); if (v) await user.type(el, v); };
const btn = (row: HTMLElement, name: RegExp) => within(row).queryByRole('button', { name });
const posts = () => API.find('POST', /icd-master$/);

describe('ICD master', () => {
  it('LIST template: headers Code, Title, Chapter, Active; Yes / No; dash for a missing chapter', async () => {
    const { container } = await open();
    await screen.findByText('Cholera');
    expectListScreen(container as HTMLElement, { path: PATHS.icd, headers: HEADS });
    expect(headers().slice(0, 4)).toEqual(HEADS);
    expect(rowOf('Cholera').textContent).toMatch(/A00.*Certain infectious and parasitic diseases.*Yes/);
    expect(rowOf('E11.9').textContent).toContain('Type 2 diabetes mellitus without complications');
    expect(rowOf('Z99').textContent).toMatch(/—.*No|No.*—/);
  });
  it('the list call is paged (limit <= 50) and sends q from ?q=', async () => {
    await open('q=diab');
    await waitFor(() => expect(API.find('GET', /icd-master$/).length).toBeGreaterThan(0));
    const q = API.find('GET', /icd-master$/)[0]!.search;
    expect(q.get('q')).toBe('diab');
    expect(Number(q.get('limit') ?? 50)).toBeLessThanOrEqual(50);
    await screen.findByText('Type 2 diabetes mellitus without complications');
  });
  it('searching pushes ?q=; Next appears with a next_cursor and pushes ?cursor=', async () => {
    const user = userEvent.setup();
    API.nextCursor = 'CUR1';
    await open();
    await screen.findByText('Cholera');
    await user.type(screen.getByRole('searchbox', { name: /search/i }), 'cholera{Enter}');
    await waitFor(() => expect(TM.push.mock.calls.concat(TM.replace.mock.calls).some((c) => /q=cholera/.test(String(c[0])))).toBe(true));
    await user.click(screen.getByRole('button', { name: /^next/i }));
    await waitFor(() => expect(TM.push.mock.calls.concat(TM.replace.mock.calls).some((c) => /cursor=CUR1/.test(String(c[0])))).toBe(true));
  });
  it('empty: the four headers stay with an EmptyState; failing read keeps the title; no permission = notice and no call', async () => {
    API.icd = [];
    const { container } = await open();
    await waitFor(() => expect(headers().slice(0, 4)).toEqual(HEADS));
    expect(container.querySelector('.lims-empty-state, [class*="empty-state"]')).toBeTruthy();
    cleanup(); API.reset(); API.readFail = 500;
    const failed = await open();
    await screen.findByRole('alert');
    expectStateInPage(failed.container as HTMLElement, { path: PATHS.icd, kind: 'either' });
    cleanup(); API.reset();
    await openPage(ROUTE.icd, { perms: [PERM.referrerRead] });
    await screen.findByText(/do not have permission/i);
    expect(API.calls).toHaveLength(0);
  });
  it('Add ICD code: POST { code, title, chapter } with an Idempotency-Key; an empty chapter is not sent', async () => {
    const user = userEvent.setup();
    await open();
    await screen.findByText('Cholera');
    await user.click(screen.getByRole('button', { name: /^add icd code$/i }));
    const d = await dlg();
    await typeInto(user, field(d, 'Code'), 'J18.9');
    await typeInto(user, field(d, 'Title'), 'Pneumonia, unspecified organism');
    await user.click(within(d).getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]!.json).toEqual({ code: 'J18.9', title: 'Pneumonia, unspecified organism' });
    expect(posts()[0]!.headers.get('idempotency-key') ?? '').toMatch(IDEM);
    await waitFor(() => expect(TM.refresh.mock.calls.length).toBeGreaterThan(0));
  });
  it.each([['lowercase code', 'a00', 'T'], ['code with a space', 'A 00', 'T'], ['code starting with a dot', '.A0', 'T'], ['code of 17 characters', 'A'.repeat(17), 'T'], ['empty code', '', 'T'], ['empty title', 'A01', ''], ['title of 501 characters', 'A01', 'T'.repeat(501)]])(
    '%s: refused with an inline error, no request',
    async (_n, code, title) => {
      const user = userEvent.setup();
      await open();
      await screen.findByText('Cholera');
      await user.click(screen.getByRole('button', { name: /^add icd code$/i }));
      const d = await dlg();
      await typeInto(user, field(d, 'Code'), code);
      await typeInto(user, field(d, 'Title'), title);
      await user.click(within(d).getByRole('button', { name: /^save/i }));
      await quiet();
      expect(posts()).toHaveLength(0);
      expect(within(d).queryAllByRole('alert').length + d.querySelectorAll('[aria-invalid="true"]').length).toBeGreaterThan(0);
    },
  );
  it('a duplicate code answered by the server shows the server message and keeps the dialog', async () => {
    const user = userEvent.setup();
    await open();
    await screen.findByText('Cholera');
    await user.click(screen.getByRole('button', { name: /^add icd code$/i }));
    const d = await dlg();
    await typeInto(user, field(d, 'Code'), 'A00');
    await typeInto(user, field(d, 'Title'), 'Again');
    API.fail = prob(422, 'common.validation_failed', [{ path: 'code', code: 'duplicate', message: 'This ICD code already exists.' }]);
    await user.click(within(d).getByRole('button', { name: /^save/i }));
    await screen.findByText('This ICD code already exists.');
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
  it('a double press on Save sends one request', async () => {
    API.writeDelayMs = 150;
    const user = userEvent.setup();
    await open();
    await screen.findByText('Cholera');
    await user.click(screen.getByRole('button', { name: /^add icd code$/i }));
    const d = await dlg();
    await typeInto(user, field(d, 'Code'), 'K35');
    await typeInto(user, field(d, 'Title'), 'Acute appendicitis');
    const s = within(d).getByRole('button', { name: /^save/i });
    await user.click(s); await user.click(s).catch(() => undefined);
    await quiet(400);
    expect(posts()).toHaveLength(1);
  });
  it('Edit: code read-only, PATCH sends only the changed field with If-Match "<version>"; a cleared chapter is not allowed to send an empty string', async () => {
    const user = userEvent.setup();
    await open();
    await screen.findByText('Cholera');
    await user.click(btn(rowOf('E11.9'), /^edit$/i)!);
    const d = await dlg();
    expect(field(d, 'Code').readOnly || field(d, 'Code').disabled).toBe(true);
    await typeInto(user, field(d, 'Title'), 'Type 2 diabetes, no complications');
    await user.click(within(d).getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(API.find('PATCH', /icd-master\//)).toHaveLength(1));
    const c = API.find('PATCH', /icd-master\//)[0]!;
    expect(c.path).toBe(`/v1/catalog/icd-master/${ID(132)}`);
    expect(c.json).toEqual({ title: 'Type 2 diabetes, no complications' });
    expect(c.headers.get('if-match')).toMatch(/^"?3"?$/);
  });
  it('Edit with nothing changed makes no call; a 409 shows a banner with Refresh', async () => {
    const user = userEvent.setup();
    await open();
    await screen.findByText('Cholera');
    await user.click(btn(rowOf('Cholera'), /^edit$/i)!);
    let d = await dlg();
    await user.click(within(d).getByRole('button', { name: /^save/i }));
    await quiet();
    expect(API.find('PATCH', /icd-master\//)).toHaveLength(0);
    await typeInto(user, field(d, 'Title'), 'Cholera, synthetic');
    API.fail = prob(409, 'common.version_conflict');
    await user.click(within(d).getByRole('button', { name: /^save/i }));
    d = await dlg();
    expect(await screen.findByRole('button', { name: /refresh/i })).toBeTruthy();
  });
  it('Deactivate asks first, then POSTs .../deactivate with If-Match; inactive rows have no Edit or Deactivate', async () => {
    const user = userEvent.setup();
    await open();
    await screen.findByText('Cholera');
    expect(btn(rowOf('Z99'), /^(edit|deactivate)$/i)).toBeNull();
    await user.click(btn(rowOf('E11.9'), /^deactivate$/i)!);
    const d = await dlg();
    expect(API.find('POST', /deactivate/)).toHaveLength(0);
    await user.click(within(d).getByRole('button', { name: /^deactivate$/i }));
    await waitFor(() => expect(API.find('POST', /deactivate/)).toHaveLength(1));
    expect(API.find('POST', /deactivate/)[0]!.path).toBe(`/v1/catalog/icd-master/${ID(132)}/deactivate`);
    expect(API.find('POST', /deactivate/)[0]!.headers.get('if-match')).toMatch(/^"?3"?$/);
  });
  it('has no axe violations (list and dialog)', async () => {
    const user = userEvent.setup();
    await open();
    await screen.findByText('Cholera');
    const run = async () => expect((await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } })).violations.map((v) => v.id)).toEqual([]);
    await run();
    await user.click(screen.getByRole('button', { name: /^add icd code$/i }));
    await dlg();
    await run();
  });
});
