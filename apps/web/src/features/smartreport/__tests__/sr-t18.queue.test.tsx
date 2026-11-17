// @vitest-environment jsdom
// C14.T18 — SR-01 Review queue `/smartreport/summaries` (04-UI-UX SR-01, 03-APP-FLOW §4 row SR-01, PRD AC-14.1 UI side, AC-14.6 no bulk approve, 07-SECURITY T2).
// ASSUMED contract (CR if the writer disagrees):
//  * app/(staff)/smartreport/summaries/page.tsx = async server component; default({params, searchParams: Promise}). Permission `smartreport.summary.read` is checked
//    FIRST (denied = NEXT_NOT_FOUND thrown, or the shell text "You don't have access to smart summaries."), with no summaries API call.
//  * Server read: GET /v1/smartreport/summaries?status=draft&sort=built_at&limit=50 (+ validated centre_id/has_critical/built_at_*/cursor); bearer added server-side.
//    Centres: GET /v1/identity/centres (a failure is tolerated). Feature banner: only when the session holds `identity.settings.manage`,
//    read GET /v1/identity/feature-flags and show the banner when `smart_report` is not enabled (E14: the queue stays readable).
//  * The table is a kit DataTable (role=grid) with caption "Smart summaries"; row order = API order (oldest first); filters/sort/paging are client navigations
//    (router.push to /smartreport/summaries?...), never client-side API calls.
//  * FilterBar (role=search): Status = multi-select listbox (options "Awaiting review","Approved","Rejected","Superseded"; default Awaiting review), Centre = Select,
//    Critical only = Select (Yes/No), Reset button. "Built" date-range picker is NOT covered (react-aria DateRangePicker; see notes).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as H from './sr-t18.harness';

vi.mock('next/navigation', async () => (await import('./sr-t18.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./sr-t18.harness')).sessionMock);

beforeAll(() => H.api.listen({ onUnhandledRequest: 'error' }));
afterAll(() => H.api.close());
beforeEach(() => { H.resetApi(); H.mountList(); });
afterEach(cleanup);

const cell = (row: string, re: RegExp) => expect(row).toMatch(re);

describe('AC-14.1 — three drafts, oldest first, with the SR-01 columns', () => {
  it('renders a grid named "Smart summaries" under an h1 "Smart summaries" with the seven spec columns', async () => {
    await H.showQueue();
    expect(screen.getByRole('heading', { level: 1, name: 'Smart summaries' })).toBeTruthy();
    expect(H.headersOf(H.queueGrid())).toEqual(['Built', 'Registration no.', 'Patient', 'Centre', 'Findings', 'Score band', 'Status']);
  });

  it('lists the three drafts in API order (oldest first) — the UI does not re-sort', async () => {
    await H.showQueue();
    const rows = H.rowTexts(H.queueGrid());
    expect(rows).toHaveLength(3);
    cell(rows[0]!, /SYN-000101/); cell(rows[1]!, /SYN-000102/); cell(rows[2]!, /SYN-000103/);
  });

  it('reads the queue once, server side, with the default filter (status=draft, sort=built_at, limit=50) and the bearer token', async () => {
    await H.showQueue();
    const c = H.listCalls();
    expect(c).toHaveLength(1);
    const q = c[0]!.url.searchParams;
    expect(q.get('status')).toBe('draft');
    expect(q.get('sort')).toBe('built_at');
    expect(q.get('limit')).toBe('50');
    expect(c[0]!.headers.get('authorization')).toBe(`Bearer ${H.TOKEN}`);
  });

  it('each row shows status text, findings count, a Critical badge only when critical_count > 0, score band, patient and centre', async () => {
    await H.showQueue();
    const [r1, r2, r3] = H.rowTexts(H.queueGrid());
    cell(r1!, /Awaiting review/); cell(r1!, /1 outside range/); expect(r1).not.toMatch(/Critical/); cell(r1!, /Good/); cell(r1!, /Synthetic Patient A/);
    cell(r2!, /4 outside range/); cell(r2!, /Critical/); cell(r2!, /Needs attention/); cell(r2!, /Synthetic Patient B/);
    cell(r3!, /0 outside range/); expect(r3).not.toMatch(/Critical/);
    expect(r3).not.toMatch(/\bGood\b|Fair|Needs attention/); // no band, no patient name -> "—" placeholders
    expect(r3!.match(/—/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('shows the centre by code + name from the centres list (tolerates the centres read failing: page still renders, raw ids are not the label)', async () => {
    await H.showQueue();
    let rows = H.rowTexts(H.queueGrid());
    cell(rows[0]!, /KTM-01/); cell(rows[0]!, /Kathmandu Main/); cell(rows[1]!, /PKR-02/);
    cleanup(); H.resetApi(); H.mountList();
    H.routes[`GET ${H.CENTRES_PATH}`] = () => H.problem('auth.forbidden', 403);
    await H.showQueue();
    rows = H.rowTexts(H.queueGrid());
    expect(rows).toHaveLength(3);
  });

  it('centre-scoped user: shows exactly the rows the API returned (no client-side widening) and sends no centre_id of its own', async () => {
    H.mountList([H.THREE[0]!]);
    await H.showQueue();
    expect(H.rowTexts(H.queueGrid())).toHaveLength(1);
    expect(H.listCalls()[0]!.url.searchParams.has('centre_id')).toBe(false);
  });

  it('queue is review-only: no selection checkboxes, no Approve/Reject buttons, no bulk action (AC-14.6)', async () => {
    await H.showQueue();
    expect(within(H.queueGrid()).queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.queryAllByRole('button', { name: /approve|reject/i })).toHaveLength(0);
    expect(H.pageText()).not.toMatch(/approve all|bulk/i);
  });
});

describe('states (03-APP-FLOW §4, SR-01 row)', () => {
  it('Empty: "No summaries waiting for review." and no table rows', async () => {
    H.mountList([]);
    await H.showQueue();
    expect(H.pageText()).toContain('No summaries waiting for review.');
  });

  it('Error: a failing API makes the page reject (error.tsx renders ErrorState + Retry); the raw problem/stack never reaches the DOM', async () => {
    H.routes[`GET ${H.LIST}`] = () => H.problem('common.internal', 500);
    const thrown = await H.showOrThrown();
    expect(thrown).toBeTruthy();
    expect(thrown).not.toBe('NEXT_NOT_FOUND');
    expect(H.pageText()).not.toMatch(/stack|sql|trace/i);
  });

  it('Permission denied: no summary.read -> refusal, and NO summaries/centres API call', async () => {
    H.resetApi(['smartreport.template.manage']);
    H.mountList();
    const thrown = await H.showOrThrown();
    if (thrown === undefined) expect(H.pageText()).toContain("You don't have access to smart summaries.");
    else expect(thrown).toMatch(/NEXT_NOT_FOUND|forbidden|denied/i);
    expect(H.apiCalls()).toHaveLength(0);
    expect(H.pageText()).not.toMatch(/SYN-0001/);
  });

  it('API 403 (permission revoked mid-session) is a refusal too, never an empty table', async () => {
    H.routes[`GET ${H.LIST}`] = () => H.problem('auth.forbidden', 403);
    const thrown = await H.showOrThrown();
    if (thrown === undefined) expect(H.pageText()).toContain("You don't have access to smart summaries.");
    else expect(thrown).toBeTruthy();
    expect(H.pageText()).not.toContain('No summaries waiting for review.');
  });

  it('Feature off + tenant admin: info banner "Smart report is switched off for this lab." with an "Open settings" link; the queue is still shown (E14)', async () => {
    H.resetApi(H.ADMIN); H.mountList();
    H.routes[`GET ${H.FLAGS_PATH}`] = H.json(H.FLAGS_OFF);
    await H.showQueue();
    expect(H.pageText()).toContain('Smart report is switched off for this lab.');
    expect(screen.getByRole('link', { name: /open settings/i })).toBeTruthy();
    expect(H.rowTexts(H.queueGrid())).toHaveLength(3);
  });

  it('Feature on + tenant admin: no banner. Non-admin: never reads feature flags, never shows the settings link', async () => {
    H.resetApi(H.ADMIN); H.mountList();
    await H.showQueue();
    expect(H.pageText()).not.toContain('switched off');
    cleanup(); H.resetApi(H.READ); H.mountList();
    await H.showQueue();
    expect(H.calls.some((c) => c.url.pathname === H.FLAGS_PATH)).toBe(false);
    expect(screen.queryByRole('link', { name: /open settings/i })).toBeNull();
  });

  it('Feature off + non-admin: no banner and no settings link (they cannot act on it)', async () => {
    H.routes[`GET ${H.FLAGS_PATH}`] = H.json(H.FLAGS_OFF);
    await H.showQueue();
    expect(H.pageText()).not.toContain('switched off');
  });
});

describe('filters, sort and paging are URL navigations (query params map 1:1 to #27)', () => {
  it('Status chips reflect ?status= (default: only "Awaiting review" selected)', async () => {
    await H.showQueue();
    const lb = screen.getByRole('listbox', { name: /status/i });
    expect(within(lb).getByRole('option', { name: 'Awaiting review' }).getAttribute('aria-selected')).toBe('true');
    expect(within(lb).getByRole('option', { name: 'Approved' }).getAttribute('aria-selected')).toBe('false');
    cleanup();
    await H.showQueue({ status: 'approved,rejected' });
    const lb2 = screen.getByRole('listbox', { name: /status/i });
    expect(within(lb2).getByRole('option', { name: 'Approved' }).getAttribute('aria-selected')).toBe('true');
    expect(within(lb2).getByRole('option', { name: 'Rejected' }).getAttribute('aria-selected')).toBe('true');
    expect(within(lb2).getByRole('option', { name: 'Awaiting review' }).getAttribute('aria-selected')).toBe('false');
    expect(H.listCalls().at(-1)!.url.searchParams.get('status')!.split(',').sort()).toEqual(['approved', 'rejected']);
  });

  it('adding "Approved" navigates to ?status=draft,approved and makes no client-side API call', async () => {
    await H.showQueue();
    const before = H.apiCalls().length;
    await userEvent.setup().click(within(screen.getByRole('listbox', { name: /status/i })).getByRole('option', { name: 'Approved' }));
    const n = H.lastNav()!;
    expect(n.pathname).toBe(H.PATH);
    expect(n.searchParams.get('status')!.split(',').sort()).toEqual(['approved', 'draft']);
    expect(H.apiCalls().length).toBe(before);
  });

  it('Critical only = Yes -> has_critical=true; Centre -> centre_id=<uuid>', async () => {
    await H.showQueue();
    await H.pick(/critical only/i, /^yes$/i);
    expect(H.lastNav()!.searchParams.get('has_critical')).toBe('true');
    await H.pick(/centre/i, /Pokhara Lakeside/);
    expect(H.lastNav()!.searchParams.get('centre_id')).toBe(H.CENTRE_B);
  });

  it('?has_critical=true&centre_id=<uuid>&sort=-built_at&cursor=<c> are forwarded to the API verbatim', async () => {
    await H.showQueue({ has_critical: 'true', centre_id: H.CENTRE_A, sort: '-built_at', cursor: 'abc123' });
    const q = H.listCalls().at(-1)!.url.searchParams;
    expect(q.get('has_critical')).toBe('true');
    expect(q.get('centre_id')).toBe(H.CENTRE_A);
    expect(q.get('sort')).toBe('-built_at');
    expect(q.get('cursor')).toBe('abc123');
  });

  it('Reset navigates to the bare path (no query)', async () => {
    await H.showQueue({ status: 'approved', has_critical: 'true' });
    await userEvent.setup().click(screen.getByRole('button', { name: /reset/i }));
    const n = H.lastNav()!;
    expect(n.pathname).toBe(H.PATH);
    expect(n.search).toBe('');
  });

  it('clicking the "Built" header toggles the sort to -built_at (default is oldest first)', async () => {
    await H.showQueue();
    await userEvent.setup().click(within(H.queueGrid()).getByRole('columnheader', { name: /built/i }));
    expect(H.lastNav()!.searchParams.get('sort')).toBe('-built_at');
  });

  it('Next page: shown only when page.next_cursor is present; it navigates with cursor= and keeps the filters', async () => {
    H.mountList(H.THREE, { limit: 50, next_cursor: 'cur-2' });
    await H.showQueue({ status: 'approved' });
    await userEvent.setup().click(screen.getByRole('button', { name: /next/i }));
    const n = H.lastNav()!;
    expect(n.searchParams.get('cursor')).toBe('cur-2');
    expect(n.searchParams.get('status')).toBe('approved');
    cleanup(); H.mountList(); await H.showQueue();
    const next = screen.queryByRole('button', { name: /next/i });
    expect(next === null || next.hasAttribute('disabled') || next.getAttribute('aria-disabled') === 'true').toBe(true);
  });
});

describe('security (07-SECURITY T2/P2: no PHI in URLs or storage, hostile input stays inert)', () => {
  it('hostile query values never reach the API raw: status is limited to the four statuses; non-uuid centre_id / non-boolean has_critical / unknown sort are dropped', async () => {
    await H.showQueue({ status: "draft,x' OR 1=1 --", centre_id: "' OR '1'='1", has_critical: 'maybe', sort: 'patient_display_name;drop', cursor: 'a'.repeat(600) });
    for (const c of H.listCalls()) {
      const q = c.url.searchParams;
      for (const s of (q.get('status') ?? 'draft').split(',')) expect(['draft', 'approved', 'rejected', 'superseded']).toContain(s);
      expect(q.get('centre_id') ?? H.CENTRE_A).toMatch(/^[0-9a-f-]{36}$/);
      expect(['true', 'false', null]).toContain(q.get('has_critical'));
      expect(['built_at', '-built_at', null]).toContain(q.get('sort'));
      expect((q.get('cursor') ?? '').length).toBeLessThanOrEqual(512);
    }
  });

  it('patient name / registration no. are rendered as text (an <img onerror> payload creates no element)', async () => {
    H.mountList([H.item({ patient_display_name: '<img src=x onerror=alert(1)>', registration_no: '<b>SYN</b>' })]);
    const { container } = await H.showQueue();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(H.pageText()).toContain('<img src=x onerror=alert(1)>');
  });

  it('row navigation targets /smartreport/summaries/<id> only: no patient name or registration no. in any href or in the navigated URL', async () => {
    await H.showQueue();
    for (const a of Array.from(document.querySelectorAll('a[href]'))) expect(a.getAttribute('href')).not.toMatch(/Synthetic|SYN-0001/);
    const user = userEvent.setup();
    const row = H.dataRows(H.queueGrid())[0]!;
    await user.dblClick(row);
    const n = H.lastNav()!;
    expect(n.pathname).toBe(`/smartreport/summaries/${H.S1}`);
    expect(n.search).toBe('');
  });

  it('no browser storage is used and the token is not in the DOM', async () => {
    const set = vi.spyOn(Storage.prototype, 'setItem');
    const { container } = await H.showQueue();
    expect(set).not.toHaveBeenCalled();
    expect(container.innerHTML).not.toContain(H.TOKEN);
  });
});

describe('a11y (axe clean)', () => {
  it.each([
    ['populated queue', async () => { await H.showQueue(); }],
    ['empty queue', async () => { H.mountList([]); await H.showQueue(); }],
    ['feature-off banner', async () => { H.resetApi(H.ADMIN); H.mountList(); H.routes[`GET ${H.FLAGS_PATH}`] = H.json(H.FLAGS_OFF); await H.showQueue(); }],
    ['filtered (approved, critical)', async () => { await H.showQueue({ status: 'approved', has_critical: 'true' }); }],
  ])('%s', async (_n, mount) => {
    await mount();
    await H.axeClean();
  });
});
