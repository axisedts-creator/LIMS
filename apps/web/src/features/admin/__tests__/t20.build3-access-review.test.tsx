// @vitest-environment jsdom
// T0D-BUILD-3 (LD-447, LD-189 AUTH SENSITIVE): /admin/access-review is BUILT on listAccessReviews + recordAccessReview (replaces the NotAvailable page).
// Done_when 3: DataTable of reviews (date DD/MM/YYYY, reviewer name or short id, memberships reviewed, notes); "Record review" kit Dialog (number field
// prefilled with the count of ACTIVE memberships, notes textarea, primary Record button); the button hidden without identity.user.manage; success and error
// toasts/messages; empty and loading states. MSW plays the identity API; synthetic data only. Reuses the t20 harness (so it runs with vitest.t20.config.ts).
// ASSUMED seams (writer: dispute in notes if wrong): the list is read with GET /v1/identity/access-reviews; the count comes from GET /v1/identity/users
// (active memberships, with or without the status=active filter: the mock answers both ways); the write is the existing server action
// recordAccessReview -> POST /v1/identity/access-reviews with {memberships_reviewed, notes?} and an Idempotency-Key header.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HttpResponse } from 'msw';
import {
  ID, ME_M, USER_M, USER_M2, NOW, FEATURE, api, calls, callsTo, bodyOf, resetApi, routes, json, problem, page, userSummary,
  show, norm, router, has, read, appFile,
} from './t20.harness';

vi.mock('next/navigation', async () => (await import('./t20.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t20.harness')).sessionMock);

beforeAll(() => api.listen({ onUnhandledFrame: 'error' }));
afterAll(() => api.close());
beforeEach(() => { resetApi(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(NOW)); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

const R = `${ID}/access-reviews`;
const UNKNOWN_M = '01a1a98a-ac40-7000-8000-0000000000ee';
const NOTES = 'Quarterly review, synthetic notes 8842';
const rev = (n: number, over: Record<string, unknown> = {}) => ({
  access_review_id: `01a1a98a-ac40-7000-8000-0000000001${String(n).padStart(2, '0')}`, reviewed_by_membership_id: ME_M, memberships_reviewed: n,
  reviewed_at: '2026-11-05T04:15:00.000Z', ...over,
});
const asha = userSummary({ membership_id: ME_M, display_name: 'Synthetic Asha Admin', status: 'active' });
const sita = userSummary({ membership_id: USER_M, display_name: 'Synthetic Sita Rai', status: 'active' });
const gone = userSummary({ membership_id: USER_M2, display_name: 'Synthetic Gone User', status: 'deactivated' });
const invited = userSummary({ membership_id: '01a1a98a-ac40-7000-8000-0000000000a1', display_name: 'Synthetic Invitee', status: 'invited' });
const ACTIVE = 2;
const seed = (reviews: unknown[] = [rev(12, { notes: NOTES })]) => {
  routes[`GET ${R}`] = json({ data: reviews });
  routes[`GET ${ID}/users`] = (c) => {
    const all = [asha, sita, gone, invited];
    const st = c.url.searchParams.get('status');
    return HttpResponse.json(page(st ? all.filter((u) => u.status === st) : all) as never);
  };
};
const created = (over: Record<string, unknown> = {}) => ({ ...rev(7), ...over });
const dlg = async () => screen.findByRole('dialog').catch(() => screen.findByRole('alertdialog'));
const recordButtons = () => screen.queryAllByRole('button', { name: /record/i });
const openDialog = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(recordButtons()[0]!);
  return dlg();
};
const confirm = (d: HTMLElement) => { const b = within(d).getAllByRole('button', { name: /^record/i }); return b[b.length - 1]!; };
const count = (d: HTMLElement) => within(d).getByRole('spinbutton') as HTMLInputElement;
const notesBox = (d: HTMLElement) => within(d).getByRole('textbox') as HTMLTextAreaElement;
const bodyText = () => norm(document.body.textContent);

describe('permissions', () => {
  it('without identity.user.read: permission denied and NO API call', async () => {
    resetApi(['identity.self.manage']);
    seed();
    await show('access-review').catch(() => undefined);
    expect(screen.queryByTestId('permission-denied') ?? bodyText()).toBeTruthy();
    expect(calls).toEqual([]);
  });
  it('identity.user.read only: the history is shown, the Record button is NOT there', async () => {
    resetApi(['identity.user.read']);
    seed();
    await show('access-review');
    expect(screen.getAllByRole('grid').length).toBeGreaterThan(0);
    expect(recordButtons()).toEqual([]);
    expect(callsTo('POST', R)).toEqual([]);
  });
  it('identity.user.manage + read: the Record button is there', async () => {
    seed();
    await show('access-review');
    expect(recordButtons().length).toBeGreaterThan(0);
  });
});

describe('history table', () => {
  it('replaces NotAvailable: a DataTable with Date, Reviewer, Memberships reviewed, Notes columns and one row per review in the API order (newest first)', async () => {
    seed([rev(12, { notes: NOTES }), rev(9, { reviewed_at: '2026-08-02T04:15:00.000Z', reviewed_by_membership_id: UNKNOWN_M })]);
    await show('access-review');
    expect(bodyText()).not.toMatch(/not available yet/i);
    const g = screen.getAllByRole('grid')[0]!;
    const heads = within(g).getAllByRole('columnheader').map((h) => norm(h.textContent));
    expect(heads).toHaveLength(4);
    [/date|reviewed at/i, /reviewer|reviewed by/i, /memberships|reviewed/i, /notes/i].forEach((re, i) => expect(heads[i], heads.join('|')).toMatch(re));
    const rows = within(g).getAllByRole('row').slice(1).map((r) => norm(r.textContent));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('12');
    expect(rows[0]).toContain(NOTES);
    expect(rows[1]).toContain('9');
    expect(callsTo('GET', R)).toHaveLength(1);
  });
  it('dates are DD/MM/YYYY (never ISO text)', async () => {
    seed([rev(12), rev(9, { reviewed_at: '2026-08-02T04:15:00.000Z' })]);
    await show('access-review');
    const g = screen.getAllByRole('grid')[0]!;
    expect(norm(g.textContent)).toContain('05/11/2026');
    expect(norm(g.textContent)).toContain('02/08/2026');
    expect(norm(g.textContent)).not.toMatch(/2026-11-05|T04:15/);
  });
  it('reviewer: the name when the membership is known, else the short id (first 8 characters), never the whole uuid', async () => {
    seed([rev(12), rev(9, { reviewed_by_membership_id: UNKNOWN_M })]);
    await show('access-review');
    const rows = within(screen.getAllByRole('grid')[0]!).getAllByRole('row').slice(1).map((r) => norm(r.textContent));
    expect(rows[0]!.includes('Synthetic Asha Admin') || rows[0]!.includes(ME_M.slice(0, 8))).toBe(true);
    expect(rows[1]).toContain(UNKNOWN_M.slice(0, 8));
    expect(norm(screen.getAllByRole('grid')[0]!.textContent)).not.toContain(UNKNOWN_M);
  });
  it('notes are text, markup is not interpreted', async () => {
    seed([rev(3, { notes: '<img src=x onerror=alert(1)>' })]);
    await show('access-review');
    expect(bodyText()).toContain('<img src=x onerror=alert(1)>');
    expect(document.querySelector('img[onerror]')).toBeNull();
  });
  it('a review without notes renders a row (no "undefined" / "null" text)', async () => {
    seed([rev(3)]);
    await show('access-review');
    const row = within(screen.getAllByRole('grid')[0]!).getAllByRole('row')[1]!;
    expect(norm(row.textContent)).not.toMatch(/undefined|null/);
  });
  it('empty state: no reviews keeps the table header and says so plainly (no error chrome, no "not available")', async () => {
    seed([]);
    await show('access-review');
    expect(within(screen.getAllByRole('grid')[0]!).getAllByRole('columnheader')).toHaveLength(4);
    expect(bodyText()).toMatch(/no .*review/i);
    expect(bodyText()).not.toMatch(/not available|could not load|something went wrong/i);
  });
  it('a failed read shows the error state with the request reference and no rows; no Record call is made', async () => {
    routes[`GET ${R}`] = () => problem('common.internal', 500, { request_id: 'req-b3-0001' });
    routes[`GET ${ID}/users`] = json(page([asha]));
    await show('access-review');
    expect(bodyText()).toMatch(/could not load/i);
    expect(bodyText()).toContain('req-b3-0001');
    expect(callsTo('POST', R)).toEqual([]);
  });
  it('loading state: the admin route group has a loading.tsx (the review page is an async server page)', () => {
    expect(has('loading.tsx')).toBe(true);
  });
});

describe('Record review dialog', () => {
  it('opens a kit Dialog: number field PREFILLED with the count of ACTIVE memberships (deactivated and invited are not counted), notes textarea, primary Record button', async () => {
    seed();
    await show('access-review');
    const user = userEvent.setup();
    const d = await openDialog(user);
    expect(count(d).value).toBe(String(ACTIVE));
    expect(notesBox(d).tagName).toBe('TEXTAREA');
    expect(confirm(d)).toBeTruthy();
    expect(callsTo('POST', R)).toEqual([]);
  });
  it('Record posts {memberships_reviewed, notes} with an Idempotency-Key, shows a success toast, closes the dialog and refreshes the list', async () => {
    seed();
    routes[`POST ${R}`] = json(created({ notes: NOTES }), 201);
    await show('access-review');
    const user = userEvent.setup();
    const d = await openDialog(user);
    await user.type(notesBox(d), NOTES);
    await user.click(confirm(d));
    await waitFor(() => expect(callsTo('POST', R)).toHaveLength(1));
    const c = callsTo('POST', R)[0]!;
    expect(bodyOf(c)).toEqual({ memberships_reviewed: ACTIVE, notes: NOTES });
    expect(c.headers.get('idempotency-key') ?? '').toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    await waitFor(() => expect(bodyText()).toMatch(/review recorded|recorded/i));
    await waitFor(() => expect(screen.queryByRole('dialog') ?? screen.queryByRole('alertdialog')).toBeNull());
    expect(router.refresh).toHaveBeenCalled();
  });
  it('the count can be changed; empty or whitespace notes are not sent', async () => {
    seed();
    routes[`POST ${R}`] = json(created({ memberships_reviewed: 5 }), 201);
    await show('access-review');
    const user = userEvent.setup();
    const d = await openDialog(user);
    await user.clear(count(d));
    await user.type(count(d), '5');
    await user.type(notesBox(d), '   ');
    await user.click(confirm(d));
    await waitFor(() => expect(callsTo('POST', R)).toHaveLength(1));
    expect(bodyOf(callsTo('POST', R)[0])).toEqual({ memberships_reviewed: 5 });
  });
  it('a double click on Record sends ONE request', async () => {
    seed();
    routes[`POST ${R}`] = async () => { await new Promise((r) => setTimeout(r, 60)); return HttpResponse.json(created() as never, { status: 201 }); };
    await show('access-review');
    const user = userEvent.setup();
    const d = await openDialog(user);
    const b = confirm(d);
    await user.dblClick(b);
    await waitFor(() => expect(callsTo('POST', R).length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 120));
    expect(callsTo('POST', R)).toHaveLength(1);
  });
  it.each([[422, 'common.validation_failed'], [403, 'auth.forbidden'], [422, 'common.idempotency_key_reused'], [503, 'common.dependency_unavailable'], [500, 'common.internal']] as const)(
    'API answers %i %s: an error is shown, NO success toast, the dialog stays open with the typed values', async (status, code) => {
      seed();
      routes[`POST ${R}`] = () => problem(code, status, { request_id: 'req-b3-0002' });
      await show('access-review');
      const user = userEvent.setup();
      const d = await openDialog(user);
      await user.type(notesBox(d), NOTES);
      await user.click(confirm(d));
      await waitFor(() => expect(callsTo('POST', R)).toHaveLength(1));
      await waitFor(() => expect(bodyText()).toMatch(/could not|couldn.t|failed|not (be )?(saved|recorded)|try again|not allowed|permission|invalid|already/i));
      expect(bodyText()).not.toMatch(/review recorded/i);
      expect((await dlg())).toBeTruthy();
      expect(notesBox(await dlg()).value).toBe(NOTES);
      expect(router.refresh).not.toHaveBeenCalled();
    });
  describe('bad input is stopped in the form: no request is sent, the dialog stays open, a message is shown', () => {
    const cases: Array<[string, string]> = [['negative count', '-1'], ['fractional count', '1.5'], ['empty count', ''], ['count above 100000', '100001']];
    it.each(cases)('%s', async (_n, v) => {
      seed();
      routes[`POST ${R}`] = json(created(), 201);
      await show('access-review');
      const user = userEvent.setup();
      const d = await openDialog(user);
      await user.clear(count(d));
      if (v) await user.type(count(d), v);
      await user.click(confirm(d));
      await new Promise((r) => setTimeout(r, 50));
      expect(callsTo('POST', R)).toEqual([]);
      expect(await dlg()).toBeTruthy();
      expect(within(await dlg()).getAllByText(/./).some((e) => /whole number|number|between|0|100000|valid|required|at least|at most/i.test(e.textContent ?? ''))).toBe(true);
    });
    it('notes of 2001 characters', async () => {
      seed();
      routes[`POST ${R}`] = json(created(), 201);
      await show('access-review');
      const user = userEvent.setup();
      const d = await openDialog(user);
      await user.click(notesBox(d));
      await user.paste('n'.repeat(2001));
      await user.click(confirm(d));
      await new Promise((r) => setTimeout(r, 50));
      expect(callsTo('POST', R)).toEqual([]);
      expect(bodyText()).toMatch(/2000/);
    });
    it('notes of exactly 2000 characters are sent', async () => {
      seed();
      routes[`POST ${R}`] = json(created(), 201);
      await show('access-review');
      const user = userEvent.setup();
      const d = await openDialog(user);
      await user.click(notesBox(d));
      await user.paste('n'.repeat(2000));
      await user.click(confirm(d));
      await waitFor(() => expect(callsTo('POST', R)).toHaveLength(1));
      expect(bodyOf(callsTo('POST', R)[0]).notes).toHaveLength(2000);
    });
  });
  it('Cancel closes the dialog and sends nothing', async () => {
    seed();
    await show('access-review');
    const user = userEvent.setup();
    const d = await openDialog(user);
    await user.click(within(d).getByRole('button', { name: /cancel|close/i }));
    await waitFor(() => expect(screen.queryByRole('dialog') ?? screen.queryByRole('alertdialog')).toBeNull());
    expect(callsTo('POST', R)).toEqual([]);
  });
});

describe('source rules (UIX-1 table look, UIX-6 button roles, kit only)', () => {
  const files = (): string[] => {
    const out: string[] = [];
    const dir = appFile('access-review');
    for (const f of readdirSync(dir)) if (/\.tsx?$/.test(f)) out.push(join(dir, f));
    const comp = join(FEATURE, 'components');
    for (const f of readdirSync(comp)) if (/review/i.test(f) && /\.tsx?$/.test(f)) out.push(join(comp, f));
    return out;
  };
  it('the page no longer renders the NotAvailable placeholder', () => {
    expect(read('access-review', 'page.tsx')).not.toMatch(/NotAvailable|not available yet/i);
  });
  it('kit components only: Dialog + Button from @lims/ui, no raw <button>, <dialog>, <textarea>, <select>, no new library import', () => {
    const src = files().map((f) => readFileSync(f, 'utf8')).join('\n');
    expect(src).toMatch(/@lims\/ui\/components\/Dialog/);
    expect(src).toMatch(/@lims\/ui\/components\/Button/);
    expect(src).not.toMatch(/<button[\s>]|<dialog[\s>]|<textarea[\s>]|<select[\s>]/);
    const imports = [...src.matchAll(/from\s+'([^'.@][^']*)'/g)].map((m) => m[1]!);
    expect(imports.filter((i) => !['react', 'next/navigation', 'next/link'].includes(i)), imports.join(',')).toEqual([]);
  });
  it('exactly one primary button in the dialog footer (Record); Cancel is not primary', () => {
    const src = files().map((f) => readFileSync(f, 'utf8')).join('\n');
    expect(src).toMatch(/variant="primary"[^>]*>\s*Record/);
    expect(src).toMatch(/variant="(ghost|secondary)"[^>]*>\s*Cancel/);
  });
  it('the write goes through the existing server action (no client-side fetch, no tenant or reviewer sent)', () => {
    const src = files().map((f) => readFileSync(f, 'utf8')).join('\n');
    expect(src).toMatch(/recordAccessReview/);
    expect(src).not.toMatch(/\bfetch\(|reviewed_by_membership_id\s*:/);
  });
});
