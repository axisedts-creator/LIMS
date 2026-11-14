// @vitest-environment jsdom
// C11.T-22 — Batches list /anatomic/batches and detail /anatomic/batches/{batch_id} (04-UI-UX §4.6, §8; AC-11.4, AC-11.5 UI side; REQ-SEC-026/027/081/088/100; 07-SECURITY centre restriction "Restricted").
// LD-140 (2026-11-13): kit components only, one primary button per page, every status shows tone + icon + word.
// ASSUMED (t22.harness.tsx header): async server pages awaited directly (T-19 page-state contract: 403 -> no-access state, 400/404/malformed id -> notFound(), other failures reject so error.tsx renders).
//   List: GET /batches with the page's status/assay_code/cursor; filters are Selects named "Status" / "Assay" that router.push the new query. [New batch] Dialog -> POST /batches with Idempotency-Key.
//   Detail: each position is an element with data-position="<n>" (1..capacity); occupied ones show the accession number (or the word "Restricted" when the API omits it) and a checkbox named "Select <accession>";
//   adding = BarcodeInput (textbox named /accession/i, Enter submits) -> POST /cases/lookup {label} -> POST /batches/{id}/members {members:[{case_id, position}]} with Idempotency-Key at the first free position,
//   or at the position of the empty card clicked first. [Remove selected] -> POST members/remove {case_ids} (If-Match "<version>", Idempotency-Key); [Close batch] -> ConfirmDialog -> POST close (If-Match, Idempotency-Key).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { http, HttpResponse } from 'msw';
import { ToastProvider } from '@lims/ui/components/Toast';
import { IDEM_RE, ID, ORIGIN, PERM_NONE, PERM_READ, PERM_WORK, api, batch, batchDetail, hit, hits, member, page, problem, resetHits, router, state, t22Defaults } from './t22.harness';

vi.mock('next/navigation', async () => (await import('./t22.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t22.harness')).sessionMock);

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { resetHits(); router.push.mockReset(); router.refresh.mockReset(); state.permissions = PERM_WORK; api.use(...t22Defaults); });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const BATCH = ID(1001);
const listPage = async (sp: Record<string, string | undefined> = {}) => {
  const mod = await import('../../../app/(staff)/anatomic/batches/page');
  return render(<ToastProvider>{await mod.default({ searchParams: Promise.resolve(sp) } as never)}</ToastProvider>);
};
const detailPage = async (id: string = BATCH) => {
  const mod = await import('../../../app/(staff)/anatomic/batches/[batch_id]/page');
  return render(<ToastProvider>{await mod.default({ params: Promise.resolve({ batch_id: id }) } as never)}</ToastProvider>);
};
const text = () => document.body.textContent ?? '';
const btn = (re: RegExp, scope: HTMLElement = document.body) => within(scope).getByRole('button', { name: re }) as HTMLButtonElement;
const dialog = () => screen.getByRole('dialog');
const choose = async (scope: HTMLElement, label: RegExp, option: RegExp) => {
  await userEvent.click(within(scope).getByRole('button', { name: label }));
  await userEvent.click(await screen.findByRole('option', { name: option }));
};
const cell = (n: number) => document.querySelector(`[data-position="${n}"]`) as HTMLElement;
const scanField = () => screen.getByRole('textbox', { name: /accession/i }) as HTMLInputElement;
const scan = async (v: string) => { await userEvent.type(scanField(), `${v}{Enter}`); };
const row = (re: RegExp) => screen.getAllByRole('row').find((r) => re.test(r.textContent ?? ''))!;
const posts = (re: RegExp) => hit('POST', re);
const addPosts = () => posts(/\/batches\/[^/]+\/members$/);

describe('list (04-UI-UX §4.6)', () => {
  it('columns: Batch no, Assay, Status, Kit lot, Run at, Members/Capacity; one row per batch', async () => {
    await listPage();
    for (const h of ['Batch no', 'Assay', 'Status', 'Kit lot', 'Run at', 'Members']) expect(screen.getByRole('columnheader', { name: new RegExp(`^${h}`, 'i') }), h).toBeTruthy();
    expect(row(/MB260001/).textContent).toContain('SYN_PCR_A');
    expect(row(/MB260001/).textContent).toContain('LOT-1');
    expect(row(/MB260002/).textContent).toMatch(/3\s*\/\s*96/);
  });

  it('status shows tone + icon + word: "Open" and "Closed"', async () => {
    await listPage();
    for (const [no, word] of [['MB260001', 'Open'], ['MB260002', 'Closed']] as const) {
      const r = row(new RegExp(no));
      expect(r.textContent).toContain(word);
      expect(r.querySelector('[data-tone] svg, [data-tone] [aria-hidden=true]'), word).toBeTruthy();
    }
  });

  it('the batch number links to /anatomic/batches/{id}', async () => {
    await listPage();
    const a = within(row(/MB260001/)).getByRole('link', { name: /MB260001/ });
    expect(a.getAttribute('href')).toBe(`/anatomic/batches/${BATCH}`);
  });

  it('empty: a "No batches" state (not an empty table)', async () => {
    api.use(http.get(`${ORIGIN}/v1/anatomic/batches`, () => page([])));
    await listPage();
    expect(text()).toMatch(/No batches/i);
    expect(screen.queryAllByRole('row').filter((r) => !within(r).queryAllByRole('columnheader').length)).toHaveLength(0);
  });

  it('the page query is forwarded: ?status=open&assay_code=SYN_PCR_A -> GET /batches?status=open&assay_code=SYN_PCR_A', async () => {
    await listPage({ status: 'open', assay_code: 'SYN_PCR_A' });
    const g = hit('GET', /^\/v1\/anatomic\/batches$/)[0]!;
    const u = new URLSearchParams(g.search);
    expect(u.get('status')).toBe('open');
    expect(u.get('assay_code')).toBe('SYN_PCR_A');
  });

  it('an unknown status or malformed assay_code in the URL is not forwarded to the API (REQ-SEC-027)', async () => {
    await listPage({ status: 'open,drop table', assay_code: "x'; --" });
    const u = new URLSearchParams(hit('GET', /^\/v1\/anatomic\/batches$/)[0]?.search ?? '');
    expect(u.get('status') ?? '').toMatch(/^(|open|closed|open,closed)$/);
    expect(u.get('assay_code') ?? '').toMatch(/^[A-Z0-9_]{0,32}$/);
  });

  it('Status filter Select pushes ?status=closed', async () => {
    await listPage();
    await userEvent.click(screen.getByRole('button', { name: /status/i }));
    await userEvent.click(await screen.findByRole('option', { name: /^closed$/i }));
    expect(router.push).toHaveBeenCalled();
    expect(new URL(router.push.mock.calls.at(-1)![0] as string, 'http://x').searchParams.get('status')).toBe('closed');
  });

  it('a next_cursor shows a "next" control that pushes ?cursor=…; the last page has none', async () => {
    api.use(http.get(`${ORIGIN}/v1/anatomic/batches`, () => page([batch(1)], 'cur-2')));
    await listPage();
    await userEvent.click(screen.getByRole('button', { name: /next|more/i }));
    expect(new URL(router.push.mock.calls.at(-1)![0] as string, 'http://x').searchParams.get('cursor')).toBe('cur-2');
    cleanup();
    api.use(http.get(`${ORIGIN}/v1/anatomic/batches`, () => page([batch(1)])));
    await listPage();
    expect(screen.queryByRole('button', { name: /next|more/i })).toBeNull();
  });

  it('403 -> no-access state, no rows (REQ-SEC-081)', async () => {
    api.use(http.get(`${ORIGIN}/v1/anatomic/batches`, () => problem('auth.forbidden', 403)));
    await listPage();
    expect(text()).not.toContain('MB26');
    expect(screen.queryAllByRole('row')).toHaveLength(0);
  });

  it.each([500, 503])('%i rejects so error.tsx renders', async (status) => {
    api.use(http.get(`${ORIGIN}/v1/anatomic/batches`, () => problem('common.internal', status)));
    await expect(listPage()).rejects.toBeTruthy();
  });

  it('server text renders as text, never HTML (REQ-SEC-088)', async () => {
    api.use(http.get(`${ORIGIN}/v1/anatomic/batches`, () => page([batch(1, { kit_lot: '<img src=x onerror=alert(1)>', batch_no: 'MB260001' })])));
    await listPage();
    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect(text()).toContain('<img src=x onerror=alert(1)>');
  });
});

describe('[New batch] dialog', () => {
  const open = async () => { await listPage(); await userEvent.click(btn(/^new batch$/i)); return dialog(); };

  it('only holders of anatomic.case.work see [New batch]', async () => {
    state.permissions = PERM_READ;
    await listPage();
    expect(screen.queryByRole('button', { name: /^new batch$/i })).toBeNull();
    expect(text()).toContain('MB260001');
  });

  it('fields: Assay (required Select), Kit name <=120, Kit lot <=64, Kit expiry, Instrument <=120, Run at, Capacity (default 96)', async () => {
    const d = await open();
    expect(within(d).getByRole('button', { name: /assay/i })).toBeTruthy();
    expect(d.textContent).toMatch(/required/i);
    expect((within(d).getByLabelText(/kit name/i) as HTMLInputElement).getAttribute('maxlength')).toBe('120');
    expect((within(d).getByLabelText(/kit lot/i) as HTMLInputElement).getAttribute('maxlength')).toBe('64');
    expect((within(d).getByLabelText(/instrument/i) as HTMLInputElement).getAttribute('maxlength')).toBe('120');
    expect(d.textContent).toMatch(/kit expiry/i);
    expect(d.textContent).toMatch(/run at/i);
    expect((within(d).getByLabelText(/capacity/i) as HTMLInputElement).value).toBe('96');
  });

  it('Assay offers active assays only', async () => {
    const d = await open();
    await userEvent.click(within(d).getByRole('button', { name: /assay/i }));
    const names = (await screen.findAllByRole('option')).map((o) => o.textContent ?? '');
    expect(names.some((n) => /Synthetic PCR A/.test(n))).toBe(true);
    expect(names.some((n) => /Retired assay/.test(n))).toBe(false);
  });

  it('POST /batches {assay_code, kit_name, kit_lot, instrument_text, capacity} with an Idempotency-Key; empty optionals are omitted; goes to the new batch', async () => {
    const d = await open();
    await choose(d, /assay/i, /Synthetic PCR A/);
    await userEvent.type(within(d).getByLabelText(/kit name/i), 'Synthetic kit');
    await userEvent.type(within(d).getByLabelText(/kit lot/i), 'LOT-5');
    await userEvent.clear(within(d).getByLabelText(/capacity/i));
    await userEvent.type(within(d).getByLabelText(/capacity/i), '24');
    await userEvent.click(btn(/^(create|save|add)/i, d));
    await waitFor(() => expect(posts(/^\/v1\/anatomic\/batches$/)).toHaveLength(1));
    const p = posts(/^\/v1\/anatomic\/batches$/)[0]!;
    expect(p.json).toEqual({ assay_code: 'SYN_PCR_A', kit_name: 'Synthetic kit', kit_lot: 'LOT-5', capacity: 24 });
    expect(p.headers.get('idempotency-key')).toMatch(IDEM_RE);
    await waitFor(() => expect(router.push.mock.calls.some((c) => String(c[0]) === `/anatomic/batches/${ID(1007)}`) || router.refresh.mock.calls.length > 0).toBe(true));
  });

  it('no assay -> no request; capacity 0 and 385 -> no request (client hints; the API re-checks 1-384)', async () => {
    const d = await open();
    await userEvent.click(btn(/^(create|save|add)/i, d));
    expect(posts(/^\/v1\/anatomic\/batches$/)).toHaveLength(0);
    await choose(d, /assay/i, /Synthetic PCR A/);
    for (const bad of ['0', '385']) {
      await userEvent.clear(within(d).getByLabelText(/capacity/i));
      await userEvent.type(within(d).getByLabelText(/capacity/i), bad);
      await userEvent.click(btn(/^(create|save|add)/i, d));
      expect(posts(/^\/v1\/anatomic\/batches$/)).toHaveLength(0);
    }
  });

  it('400 common.validation_failed -> "Check the values and try again." and the dialog stays open', async () => {
    api.use(http.post(`${ORIGIN}/v1/anatomic/batches`, () => problem('common.validation_failed', 400, { errors: [{ path: '/assay_code', code: 'unknown', message: 'secret-internal' }] })));
    const d = await open();
    await choose(d, /assay/i, /Synthetic PCR A/);
    await userEvent.click(btn(/^(create|save|add)/i, d));
    expect(await screen.findByText('Check the values and try again.')).toBeTruthy();
    expect(text()).not.toContain('secret-internal');
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('a double click on [Create] sends one request', async () => {
    const d = await open();
    await choose(d, /assay/i, /Synthetic PCR A/);
    await userEvent.dblClick(btn(/^(create|save|add)/i, d));
    await waitFor(() => expect(posts(/^\/v1\/anatomic\/batches$/).length).toBeGreaterThan(0));
    expect(posts(/^\/v1\/anatomic\/batches$/)).toHaveLength(1);
  });
});

describe('detail (04-UI-UX §4.6)', () => {
  it('DescriptionList header: batch number, assay, status word, kit name, kit lot, kit expiry, instrument, run at, members/capacity', async () => {
    await detailPage();
    for (const t of ['MB260001', 'SYN_PCR_A', 'Open', 'Synthetic kit', 'LOT-1', 'Synthetic cycler 1']) expect(text(), t).toContain(t);
    expect(text()).toMatch(/2\s*\/\s*96/);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toMatch(/MB260001/);
  });

  it('position grid has one cell per capacity position; occupied cells show the accession number, empty cells none', async () => {
    await detailPage();
    expect(document.querySelectorAll('[data-position]')).toHaveLength(96);
    expect(cell(1).textContent).toContain('MO26-000001');
    expect(cell(3).textContent).toContain('MO26-000002');
    expect(cell(2).textContent).not.toContain('MO26-');
    expect(cell(1).textContent).toMatch(/\b1\b/); // position number is visible
  });

  it('a capacity that is not a multiple of 12 renders exactly that many cells (partial last row)', async () => {
    api.use(http.get(`${ORIGIN}/v1/anatomic/batches/:id`, () => HttpResponse.json(batchDetail(1, [], { capacity: 30 }))));
    await detailPage();
    expect(document.querySelectorAll('[data-position]')).toHaveLength(30);
    expect(cell(31)).toBeNull();
  });

  it('empty batch: "No samples in this batch yet." and the scan field is still there', async () => {
    api.use(http.get(`${ORIGIN}/v1/anatomic/batches/:id`, () => HttpResponse.json(batchDetail(1, []))));
    await detailPage();
    expect(text()).toContain('No samples in this batch yet.');
    expect(scanField()).toBeTruthy();
  });

  it('a member whose accession number is withheld (centre restriction) shows "Restricted", never an id or a blank', async () => {
    api.use(http.get(`${ORIGIN}/v1/anatomic/batches/:id`, () => HttpResponse.json(batchDetail(1, [member(1, 1, { accession_no: undefined }), member(2, 2)]))));
    await detailPage();
    expect(cell(1).textContent).toContain('Restricted');
    expect(cell(1).textContent).not.toContain(ID(1101));
    expect(cell(2).textContent).toContain('MO26-000002');
  });

  it('member accession numbers link to their case', async () => {
    await detailPage();
    expect(within(cell(1)).getByRole('link', { name: /MO26-000001/ }).getAttribute('href')).toBe(`/anatomic/cases/${ID(1101)}`);
  });

  it('server text renders as text, never HTML (REQ-SEC-088)', async () => {
    api.use(http.get(`${ORIGIN}/v1/anatomic/batches/:id`, () => HttpResponse.json(batchDetail(1, [], { instrument_text: '<script>alert(1)</script>' }))));
    await detailPage();
    expect(document.querySelector('script')).toBeNull();
    expect(text()).toContain('<script>alert(1)</script>');
  });

  describe('page states', () => {
    it.each(['abc', '../../x', `${BATCH}/../${ID(2)}`, '12345'])('malformed id %s -> notFound() and no API call (REQ-SEC-026/027)', async (id) => {
      await expect(detailPage(id)).rejects.toThrow('NEXT_NOT_FOUND');
      expect(hits).toHaveLength(0);
    });
    it('404 (also a batch of another tenant/centre) -> notFound()', async () => {
      api.use(http.get(`${ORIGIN}/v1/anatomic/batches/:id`, () => problem('common.not_found', 404)));
      await expect(detailPage()).rejects.toThrow('NEXT_NOT_FOUND');
    });
    it('403 -> no-access state, no batch data in the DOM', async () => {
      api.use(http.get(`${ORIGIN}/v1/anatomic/batches/:id`, () => problem('auth.forbidden', 403)));
      await detailPage();
      expect(text()).not.toContain('MB26');
      expect(document.querySelectorAll('[data-position]')).toHaveLength(0);
    });
    it('500 rejects so error.tsx renders', async () => {
      api.use(http.get(`${ORIGIN}/v1/anatomic/batches/:id`, () => problem('common.internal', 500)));
      await expect(detailPage()).rejects.toBeTruthy();
    });
  });
});

describe('AC-11.4 add members (open batch)', () => {
  it('scan an accession number -> lookup -> POST members at the next free position (2: positions 1 and 3 are taken) with an Idempotency-Key', async () => {
    await detailPage();
    await scan('MO26-000003');
    await waitFor(() => expect(addPosts()).toHaveLength(1));
    expect(posts(/\/cases\/lookup$/)[0]!.json).toEqual({ label: 'MO26-000003' });
    const p = addPosts()[0]!;
    expect(p.path).toBe(`/v1/anatomic/batches/${BATCH}/members`);
    expect(p.json).toEqual({ members: [{ case_id: ID(1103), position: 2 }] });
    expect(p.headers.get('idempotency-key')).toMatch(IDEM_RE);
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
    expect(scanField().value).toBe(''); // cleared after the scan
  });

  it('choose a position first: click empty position 5, then scan -> position 5', async () => {
    await detailPage();
    await userEvent.click(within(cell(5)).queryByRole('button') ?? cell(5));
    await scan('MO26-000003');
    await waitFor(() => expect(addPosts()).toHaveLength(1));
    expect((addPosts()[0]!.json as { members: { position: number }[] }).members[0]!.position).toBe(5);
  });

  it('three scans on an empty batch fill positions 1, 2, 3 (members listed in position order)', async () => {
    let n = 0;
    api.use(
      http.get(`${ORIGIN}/v1/anatomic/batches/:id`, () => HttpResponse.json(batchDetail(1, []))),
      http.post(`${ORIGIN}/v1/anatomic/cases/lookup`, async ({ request }) => HttpResponse.json({ object_kind: 'case', case_id: ID(1100 + ++n), label: ((await request.clone().json()) as { label: string }).label })),
    );
    await detailPage();
    for (const a of ['MO26-000001', 'MO26-000002', 'MO26-000003']) { await scan(a); await waitFor(() => expect(addPosts().length).toBeGreaterThanOrEqual(['MO26-000001', 'MO26-000002', 'MO26-000003'].indexOf(a) + 1)); }
    expect(addPosts().map((p) => (p.json as { members: { position: number }[] }).members[0]!.position)).toEqual([1, 2, 3]);
  });

  it('409 anatomic.batch_position_taken -> "Position 2 is already used."', async () => {
    api.use(http.post(`${ORIGIN}/v1/anatomic/batches/:id/members`, () => problem('anatomic.batch_position_taken', 409)));
    await detailPage();
    await scan('MO26-000003');
    expect(await screen.findByText('Position 2 is already used.')).toBeTruthy();
  });

  it('409 anatomic.batch_closed (closed by someone else meanwhile) -> "This batch is closed."', async () => {
    api.use(http.post(`${ORIGIN}/v1/anatomic/batches/:id/members`, () => problem('anatomic.batch_closed', 409)));
    await detailPage();
    await scan('MO26-000003');
    expect(await screen.findByText('This batch is closed.')).toBeTruthy();
  });

  it('an accession number that does not resolve (404) -> a message, no POST members', async () => {
    api.use(http.post(`${ORIGIN}/v1/anatomic/cases/lookup`, () => problem('common.not_found', 404)));
    await detailPage();
    await scan('MO26-999999');
    expect(await screen.findByText(/not found|no case|no pathology case/i)).toBeTruthy();
    expect(addPosts()).toHaveLength(0);
  });

  it('a block or slide label (lookup returns object_kind block) is not a molecular case -> no POST members', async () => {
    api.use(http.post(`${ORIGIN}/v1/anatomic/cases/lookup`, () => HttpResponse.json({ object_kind: 'block', case_id: ID(1103), block_id: ID(201) })));
    await detailPage();
    await scan('SP26-000042-A1');
    await new Promise((r) => setTimeout(r, 50));
    expect(addPosts()).toHaveLength(0);
  });

  it('a full batch (member_count = capacity) offers no free position: nothing is posted', async () => {
    api.use(http.get(`${ORIGIN}/v1/anatomic/batches/:id`, () => HttpResponse.json(batchDetail(1, [member(1, 1), member(2, 2)], { capacity: 2 }))));
    await detailPage();
    await scan('MO26-000003');
    await new Promise((r) => setTimeout(r, 50));
    expect(addPosts()).toHaveLength(0);
    expect(text()).toMatch(/full|no free position/i);
  });

  it('403 auth.mfa_required opens the step-up dialog', async () => {
    api.use(http.post(`${ORIGIN}/v1/anatomic/batches/:id/members`, () => problem('auth.mfa_required', 403)));
    await detailPage();
    await scan('MO26-000003');
    expect(await screen.findByText('This action needs two-factor verification.')).toBeTruthy();
  });

  it('a user without anatomic.case.work sees the grid read-only: no scan field, no checkboxes, no [Remove selected], no [Close batch]', async () => {
    state.permissions = PERM_READ;
    await detailPage();
    expect(screen.queryByRole('textbox', { name: /accession/i })).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /remove selected/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /close batch/i })).toBeNull();
    expect(cell(1).textContent).toContain('MO26-000001');
  });

  it('no permission at all -> no-access state (the page never reaches the API with a read it cannot make)', async () => {
    state.permissions = PERM_NONE;
    api.use(http.get(`${ORIGIN}/v1/anatomic/batches/:id`, () => problem('auth.forbidden', 403)));
    await detailPage();
    expect(document.querySelectorAll('[data-position]')).toHaveLength(0);
  });
});

describe('remove selected', () => {
  it('[Remove selected] is disabled with nothing ticked; ticking two members sends their case ids once with If-Match "<version>" and an Idempotency-Key', async () => {
    await detailPage();
    expect(btn(/remove selected/i).disabled).toBe(true);
    await userEvent.click(screen.getByRole('checkbox', { name: /select MO26-000001/i }));
    await userEvent.click(screen.getByRole('checkbox', { name: /select MO26-000002/i }));
    expect(btn(/remove selected/i).disabled).toBe(false);
    await userEvent.click(btn(/remove selected/i));
    const c = screen.queryByRole('alertdialog') ?? screen.queryByRole('dialog');
    if (c) await userEvent.click(within(c).getByRole('button', { name: /^(remove|confirm|yes)/i })); // a confirm step is allowed, not required
    await waitFor(() => expect(posts(/\/members\/remove$/)).toHaveLength(1));
    const p = posts(/\/members\/remove$/)[0]!;
    expect(p.path).toBe(`/v1/anatomic/batches/${BATCH}/members/remove`);
    expect((p.json as { case_ids: string[] }).case_ids.sort()).toEqual([ID(1101), ID(1102)]);
    expect(p.headers.get('if-match')).toBe('"1"');
    expect(p.headers.get('idempotency-key')).toMatch(IDEM_RE);
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
  });

  it('a Restricted member can be removed by position but never by an invented id: its checkbox is named by position, request carries the real case_id from the API', async () => {
    api.use(http.get(`${ORIGIN}/v1/anatomic/batches/:id`, () => HttpResponse.json(batchDetail(1, [member(1, 1, { accession_no: undefined })]))));
    await detailPage();
    await userEvent.click(within(cell(1)).getByRole('checkbox'));
    await userEvent.click(btn(/remove selected/i));
    const c = screen.queryByRole('alertdialog') ?? screen.queryByRole('dialog');
    if (c) await userEvent.click(within(c).getByRole('button', { name: /^(remove|confirm|yes)/i }));
    await waitFor(() => expect(posts(/\/members\/remove$/)).toHaveLength(1));
    expect((posts(/\/members\/remove$/)[0]!.json as { case_ids: string[] }).case_ids).toEqual([ID(1101)]);
  });

  it('409 anatomic.batch_closed -> "This batch is closed."', async () => {
    api.use(http.post(`${ORIGIN}/v1/anatomic/batches/:id/members/remove`, () => problem('anatomic.batch_closed', 409)));
    await detailPage();
    await userEvent.click(screen.getByRole('checkbox', { name: /select MO26-000001/i }));
    await userEvent.click(btn(/remove selected/i));
    const c = screen.queryByRole('alertdialog') ?? screen.queryByRole('dialog');
    if (c) await userEvent.click(within(c).getByRole('button', { name: /^(remove|confirm|yes)/i }));
    expect(await screen.findByText('This batch is closed.')).toBeTruthy();
  });

  it('409 common.version_conflict -> "changed by someone else" with [Reload]', async () => {
    api.use(http.post(`${ORIGIN}/v1/anatomic/batches/:id/members/remove`, () => problem('common.version_conflict', 409)));
    await detailPage();
    await userEvent.click(screen.getByRole('checkbox', { name: /select MO26-000001/i }));
    await userEvent.click(btn(/remove selected/i));
    const c = screen.queryByRole('alertdialog') ?? screen.queryByRole('dialog');
    if (c) await userEvent.click(within(c).getByRole('button', { name: /^(remove|confirm|yes)/i }));
    expect(await screen.findByText(/changed by someone else/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /^reload$/i })).toBeTruthy();
  });
});

describe('close batch', () => {
  it('[Close batch] asks for confirmation first; Cancel sends nothing', async () => {
    await detailPage();
    await userEvent.click(btn(/^close batch$/i));
    const d = await screen.findByRole('alertdialog').catch(() => screen.getByRole('dialog'));
    expect(d.textContent).toMatch(/close/i);
    await userEvent.click(within(d).getByRole('button', { name: /cancel/i }));
    expect(posts(/\/close$/)).toHaveLength(0);
  });

  it('Confirm -> POST /batches/{id}/close with If-Match "<version>" and an Idempotency-Key; refreshes', async () => {
    await detailPage();
    await userEvent.click(btn(/^close batch$/i));
    const d = await screen.findByRole('alertdialog').catch(() => screen.getByRole('dialog'));
    await userEvent.click(within(d).getByRole('button', { name: /^(close batch|close|confirm)/i }));
    await waitFor(() => expect(posts(/\/close$/)).toHaveLength(1));
    const p = posts(/\/close$/)[0]!;
    expect(p.path).toBe(`/v1/anatomic/batches/${BATCH}/close`);
    expect(p.headers.get('if-match')).toBe('"1"');
    expect(p.headers.get('idempotency-key')).toMatch(IDEM_RE);
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
  });

  it('409 anatomic.batch_closed on close -> "This batch is closed."', async () => {
    api.use(http.post(`${ORIGIN}/v1/anatomic/batches/:id/close`, () => problem('anatomic.batch_closed', 409)));
    await detailPage();
    await userEvent.click(btn(/^close batch$/i));
    const d = await screen.findByRole('alertdialog').catch(() => screen.getByRole('dialog'));
    await userEvent.click(within(d).getByRole('button', { name: /^(close batch|close|confirm)/i }));
    expect(await screen.findByText('This batch is closed.')).toBeTruthy();
  });
});

describe('AC-11.5 closed batch', () => {
  const closed = () => api.use(http.get(`${ORIGIN}/v1/anatomic/batches/:id`, () => HttpResponse.json(batchDetail(1, [member(1, 1), member(2, 3)], { status: 'closed' }))));

  it('shows the status word "Closed" with tone + icon and the members read-only', async () => {
    closed();
    await detailPage();
    expect(text()).toContain('Closed');
    expect(document.querySelector('[data-tone] svg, [data-tone] [aria-hidden=true]')).toBeTruthy();
    expect(cell(1).textContent).toContain('MO26-000001');
  });

  it('offers no way to add or remove: no scan field, no checkboxes, no [Remove selected], no [Close batch], no clickable empty positions', async () => {
    closed();
    await detailPage();
    expect(screen.queryByRole('textbox', { name: /accession/i })).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /remove selected/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /close batch/i })).toBeNull();
    expect(within(cell(2)).queryByRole('button')).toBeNull();
  });
});

describe('a11y and page rules', () => {
  const run = async () => (await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } })).violations.map((x) => `${x.id}: ${x.help}`);

  it('axe: list, new-batch dialog, open detail, closed detail have no violations', async () => {
    await listPage();
    expect(await run()).toEqual([]);
    await userEvent.click(btn(/^new batch$/i));
    expect(await run()).toEqual([]);
    cleanup();
    await detailPage();
    expect(await run()).toEqual([]);
    cleanup();
    api.use(http.get(`${ORIGIN}/v1/anatomic/batches/:id`, () => HttpResponse.json(batchDetail(1, [member(1, 1)], { status: 'closed' }))));
    await detailPage();
    expect(await run()).toEqual([]);
  });

  it('one primary button per page (LD-140): list = [New batch]; open detail = at most one of scan / [Close batch]', async () => {
    await listPage();
    expect(document.querySelectorAll('.lims-btn-primary').length).toBe(1);
    cleanup();
    await detailPage();
    expect(document.querySelectorAll('.lims-btn-primary').length).toBeLessThanOrEqual(1);
  });

  it('the 96-position grid makes no per-cell case reads', async () => {
    await detailPage();
    expect(hits.filter((h) => h.method === 'GET' && /\/cases\//.test(h.path))).toHaveLength(0);
  });
});
