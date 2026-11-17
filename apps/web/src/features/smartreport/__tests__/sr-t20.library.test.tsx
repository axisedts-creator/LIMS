// @vitest-environment jsdom
// C14.T20 — SR-03 Library versions, app/(staff)/smartreport/library/page.tsx (04-UI-UX SR-03; 03-APP-FLOW §4 row SR-03; AC-02.1–AC-02.4 UI side).
// ASSUMED contract (spec fixes only the route + kit primitives):
//   * default export = async server component `Page({ params, searchParams })`; it checks the session permission `smartreport.template.manage` BEFORE any API call
//     (denied = notFound() or the PermissionDenied page; either way no API call) and reads GET /v1/smartreport/library-versions.
//   * list = kit DataTable (role=grid, name /library versions/i), columns Version · Status · Language · Approved by · Approved on · Updated · (actions). Cells: `v{n}`, status TEXT,
//     English / Nepali, approved_by_display_name. Each row has one link: draft -> /smartreport/library/<id>; in_review/approved/retired -> /smartreport/library/<id>/review (SR-05).
//   * header "New draft" = kit Menu trigger button; items "From active version" (POST {source:'clone_active'}), "From starter draft" ({source:'starter'}), "From version…" (dialog with a
//     Select labelled /version/ then a confirm button -> {source:'clone_version', source_version_id}). POST /v1/smartreport/library-versions always carries a non-empty Idempotency-Key.
//     Success -> router.push('/smartreport/library/<new id>'). Disabled (disabled / aria-disabled) while a draft or in_review version exists; the reason
//     "A draft or a version in review already exists" is in the DOM (tooltip on hover/focus of the control or its wrapper, or a visually hidden description).
//   * empty list: "No library yet. Start from the starter draft." + button /start from the starter draft/i (only with the permission).
//   * a failed create shows role=alert text (409 library_invalid_transition -> the reason above); never raw server text.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse } from 'msw';
import {
  LIST_PAGE, MANAGE, VER_APPROVED, VER_DRAFT, VER_REVIEW, VER_RETIRED, api, apiCalls, axeClean, bodyOf, callsTo, gridNamed, headersOf, json, lastNav, norm, pageText, pick, problem, resetApi, rowTexts, router,
  routes, show, showOrThrown, summaryDto, versionDto, SR,
} from './sr-t20.harness';

vi.mock('next/navigation', async () => (await import('./sr-t20.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./sr-t20.harness')).sessionMock);

const REASON = /a draft or a version in review already exists/i;
const APPROVED_ONLY = [summaryDto(), summaryDto({ id: VER_RETIRED, version_no: 1, status: 'retired', language: 'ne', approved_by_display_name: 'Synthetic Reviewer', version: 2 })];
const WITH_DRAFT = [summaryDto({ id: VER_DRAFT, version_no: 3, status: 'draft', language: 'en', version: 4, approved_at: undefined, approved_by_display_name: undefined, approved_by_membership_id: undefined }), ...APPROVED_ONLY];
const list = (data: unknown[]) => json({ data, page: { limit: 50 } });

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { resetApi(MANAGE); routes[`GET ${SR}`] = list(APPROVED_ONLY); });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const newDraftBtn = () => screen.getByRole('button', { name: /new draft/i });
const isDisabled = (el: HTMLElement) => el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true';
const posts = () => callsTo('POST', SR);
const choose = async (item: RegExp) => { await userEvent.click(newDraftBtn()); await userEvent.click(await screen.findByRole('menuitem', { name: item })); };

describe('access (SR-03 denied page)', () => {
  it('without smartreport.template.manage: denied (notFound or PermissionDenied) and NO API call', async () => {
    resetApi(['smartreport.summary.read']);
    const out = await showOrThrown(LIST_PAGE);
    if (out !== undefined) expect(out).toMatch(/NEXT_NOT_FOUND/);
    else expect(screen.getByTestId('permission-denied')).toBeTruthy();
    expect(apiCalls()).toHaveLength(0);
  });
});

describe('list (SR-03)', () => {
  it('reads GET /v1/smartreport/library-versions with the bearer token and shows the 6 documented columns', async () => {
    await show(LIST_PAGE);
    const get = callsTo('GET', SR)[0]!;
    expect(get.headers.get('authorization')).toBe('Bearer jwt-synthetic');
    expect(headersOf(gridNamed(/library versions/i)).slice(0, 6)).toEqual(['Version', 'Status', 'Language', 'Approved by', 'Approved on', 'Updated']);
  });

  it('renders v{n}, a TEXT status label, language words and the approver name from the API (no ids)', async () => {
    await show(LIST_PAGE);
    const rows = rowTexts(gridNamed(/library versions/i));
    expect(rows[0]).toMatch(/v2/); expect(rows[0]).toMatch(/approved/i); expect(rows[0]).toMatch(/English/); expect(rows[0]).toContain('Synthetic Pathologist');
    expect(rows[1]).toMatch(/v1/); expect(rows[1]).toMatch(/retired/i); expect(rows[1]).toMatch(/Nepali/); expect(rows[1]).toContain('Synthetic Reviewer');
    expect(pageText()).not.toContain(VER_APPROVED);
  });

  it('row action: draft opens the editor (SR-04); in_review / approved / retired open the read-only review (SR-05)', async () => {
    routes[`GET ${SR}`] = list([summaryDto({ id: VER_DRAFT, version_no: 4, status: 'draft' }), summaryDto({ id: VER_REVIEW, version_no: 3, status: 'in_review' }), ...APPROVED_ONLY]);
    await show(LIST_PAGE);
    const hrefs = within(gridNamed(/library versions/i)).getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('link').map((a) => a.getAttribute('href')));
    expect(hrefs[0]).toContain(`/smartreport/library/${VER_DRAFT}`);
    expect(hrefs[0]).not.toContain(`/smartreport/library/${VER_DRAFT}/review`);
    expect(hrefs[1]).toContain(`/smartreport/library/${VER_REVIEW}/review`);
    expect(hrefs[2]).toContain(`/smartreport/library/${VER_APPROVED}/review`);
    expect(hrefs[3]).toContain(`/smartreport/library/${VER_RETIRED}/review`);
  });

  it('is axe-clean', async () => { await show(LIST_PAGE); await axeClean(); });
});

describe('empty state (03-APP-FLOW §4 SR-03; AC-02.1)', () => {
  beforeEach(() => { routes[`GET ${SR}`] = list([]); });

  it('shows the documented empty text and a starter button', async () => {
    await show(LIST_PAGE);
    expect(pageText()).toContain('No library yet. Start from the starter draft.');
    expect(screen.getByRole('button', { name: /start from the starter draft/i })).toBeTruthy();
  });

  it('starter button POSTs {source:"starter"} with an Idempotency-Key, then opens the new draft', async () => {
    routes[`POST ${SR}`] = json(versionDto({ id: VER_DRAFT, version_no: 1, source_version_id: undefined }), 201);
    await show(LIST_PAGE);
    await userEvent.click(screen.getByRole('button', { name: /start from the starter draft/i }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(bodyOf(posts()[0])).toEqual({ source: 'starter' });
    expect(posts()[0]!.headers.get('idempotency-key')).toMatch(/\S{8,}/);
    await waitFor(() => expect(lastNav()).toBe(`/smartreport/library/${VER_DRAFT}`));
  });

  it('a double click creates ONE request (AC-02.4 UI side: the control is busy while pending)', async () => {
    routes[`POST ${SR}`] = async () => { await new Promise((r) => setTimeout(r, 60)); return HttpResponse.json(versionDto({ version_no: 1 }), { status: 201 }); };
    await show(LIST_PAGE);
    const b = screen.getByRole('button', { name: /start from the starter draft/i });
    await userEvent.dblClick(b);
    await waitFor(() => expect(lastNav()).toBeTruthy());
    expect(posts()).toHaveLength(1);
  });

  it('without the permission there is no create button (page itself is denied first)', async () => {
    resetApi([]);
    const out = await showOrThrown(LIST_PAGE);
    if (out === undefined) expect(screen.queryByRole('button', { name: /starter/i })).toBeNull();
    expect(apiCalls()).toHaveLength(0);
  });
});

describe('New draft menu (AC-02.1, AC-02.2, AC-02.3)', () => {
  beforeEach(() => { routes[`POST ${SR}`] = json(versionDto({ id: VER_DRAFT, version_no: 3 }), 201); });

  it('offers the three sources', async () => {
    await show(LIST_PAGE);
    await userEvent.click(newDraftBtn());
    const items = (await screen.findAllByRole('menuitem')).map((i) => norm(i.textContent));
    expect(items).toEqual(['From active version', 'From starter draft', 'From version…']);
  });

  it('"From active version" posts {source:"clone_active"} (AC-02.2) and opens the new draft', async () => {
    await show(LIST_PAGE);
    await choose(/from active version/i);
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(bodyOf(posts()[0])).toEqual({ source: 'clone_active' });
    expect(posts()[0]!.headers.get('idempotency-key')).toMatch(/\S{8,}/);
    await waitFor(() => expect(lastNav()).toBe(`/smartreport/library/${VER_DRAFT}`));
  });

  it('"From starter draft" posts {source:"starter"}', async () => {
    await show(LIST_PAGE);
    await choose(/from starter draft/i);
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(bodyOf(posts()[0])).toEqual({ source: 'starter' });
  });

  it('"From version…" asks which version and posts clone_version with source_version_id', async () => {
    await show(LIST_PAGE);
    await choose(/from version/i);
    const dlg = await screen.findByRole('dialog');
    await pick(/version/i, /v1/);
    await userEvent.click(within(dlg).getByRole('button', { name: /create|clone|start|ok/i }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(bodyOf(posts()[0])).toEqual({ source: 'clone_version', source_version_id: VER_RETIRED });
  });

  it('a draft that already exists disables New draft with the documented reason and sends nothing (AC-02.3)', async () => {
    routes[`GET ${SR}`] = list(WITH_DRAFT);
    await show(LIST_PAGE);
    const b = newDraftBtn();
    expect(isDisabled(b)).toBe(true);
    await userEvent.hover(b.parentElement ?? b); await userEvent.tab();
    await waitFor(() => expect(pageText()).toMatch(REASON));
    await userEvent.click(b);
    expect(posts()).toHaveLength(0);
  });

  it('an in_review version also disables it', async () => {
    routes[`GET ${SR}`] = list([summaryDto({ id: VER_REVIEW, version_no: 3, status: 'in_review' }), ...APPROVED_ONLY]);
    await show(LIST_PAGE);
    expect(isDisabled(newDraftBtn())).toBe(true);
  });

  it('server 409 smartreport.library_invalid_transition (a race with another user) shows the reason in an alert', async () => {
    routes[`POST ${SR}`] = () => problem('smartreport.library_invalid_transition', 409);
    await show(LIST_PAGE);
    await choose(/from active version/i);
    const a = await screen.findByRole('alert');
    expect(a.textContent).toMatch(REASON);
    expect(router.push).not.toHaveBeenCalled();
  });

  it('a server failure never leaks raw server text', async () => {
    routes[`POST ${SR}`] = () => HttpResponse.json({ code: 'common.internal', status: 500, title: 'relation "smartreport.library_version" does not exist', detail: 'stack at /srv/api/x.ts' }, { status: 500 });
    await show(LIST_PAGE);
    await choose(/from active version/i);
    await screen.findByRole('alert');
    expect(pageText()).not.toMatch(/relation|smartreport\.library_version|\/srv\/api/);
  });
});
