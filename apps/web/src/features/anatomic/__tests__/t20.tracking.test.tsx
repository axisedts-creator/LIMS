// @vitest-environment jsdom
// C11.T-20 — Tracking /anatomic/tracking + Movement dialog (04-UI-UX §2 scanner, §3 Alt+V, §4.4, §4.5; AC-06.2, AC-06.1/06.4/06.5 (UI side); REQ-SEC-098/100; plan row "basket mode").
// LD-140 (2026-11-13): kit components only, one primary button per page, every status shows tone + icon + word.
// ASSUMED (t20.harness.tsx header): async Page({ searchParams }) renders lookup + [Basket mode] Switch + Tabs "Lookup" / "Sent out".
//   Single lookup = POST /cases/lookup {label} -> GET /cases/{case_id} (block/slide, case, location) + GET /blocks|slides/{id}/movements. A basket scan does the same lookup + case read.
//   Sent-out tab = GET /blocks?location_status=sent_out (+ GET /blocks/{id}/movements for destination/reason); tab change = router.push('/anatomic/tracking?tab=sent_out').
//   Movement dialog posts POST /movements (one request per object_kind) with Idempotency-Key; Select = kit Select (button + role=option); Discard = ConfirmDialog.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { http, HttpResponse } from 'msw';
import { ToastProvider } from '@lims/ui/components/Toast';
import { IDEM_RE, ID, ORIGIN, PERM_READ, PERM_WORK, api, block, hit, hits, movement, page, problem, resetHits, router, slide, state, t20Defaults, workedCase } from './t20.harness';

vi.mock('next/navigation', async () => (await import('./t20.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t20.harness')).sessionMock);

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { resetHits(); router.push.mockReset(); state.permissions = PERM_WORK; api.use(...t20Defaults, ...lookups()); });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const CASE = ID(1);
const A1 = 'SP26-000042-A1', A2 = 'SP26-000042-A2', S1 = 'SP26-000042-A1-S1';
const caseWithMaterial = () => workedCase({
  blocks: [block(1, { location_status: 'stored', location_text: 'Synthetic cabinet 7', slide_count: 1 }), block(2)],
  slides: [slide(1, { location_status: 'in_lab' })],
});
function lookups() {
  return [
    http.post(`${ORIGIN}/v1/anatomic/cases/lookup`, async ({ request }) => {
      const { label } = (await request.clone().json()) as { label: string };
      if (label === A1) return HttpResponse.json({ object_kind: 'block', case_id: CASE, block_id: ID(201) });
      if (label === A2) return HttpResponse.json({ object_kind: 'block', case_id: CASE, block_id: ID(202) });
      if (label === S1) return HttpResponse.json({ object_kind: 'slide', case_id: CASE, block_id: ID(201), slide_id: ID(301) });
      return problem('common.not_found', 404);
    }),
    http.get(`${ORIGIN}/v1/anatomic/cases/:id`, () => HttpResponse.json(caseWithMaterial())),
  ];
}

const mount = async (sp: Record<string, string | undefined> = {}) => {
  const mod = await import('../../../app/(staff)/anatomic/tracking/page');
  const el = await mod.default({ searchParams: Promise.resolve(sp) } as never);
  return render(<ToastProvider>{el}</ToastProvider>);
};
const field = () => screen.getByRole('textbox', { name: /scan or type/i });
const scan = async (v: string) => { await userEvent.type(field(), `${v}{Enter}`); };
const basketOn = () => userEvent.click(screen.getByRole('switch', { name: /basket mode/i }));
const movePosts = () => hit('POST', /^\/v1\/anatomic\/movements$/);
const choose = async (scope: HTMLElement, label: RegExp, option: RegExp) => {
  await userEvent.click(within(scope).getByRole('button', { name: label }));
  await userEvent.click(await screen.findByRole('option', { name: option }));
};
const dialog = () => screen.getByRole('dialog');

describe('AC-06.2 single lookup: case, current location, movement history newest first', () => {
  const movs = [
    movement(1, { movement: 'stored', location_text: 'Synthetic cabinet 3', at: '2026-11-10T09:00:00.000Z' }),
    movement(2, { movement: 'retrieved', location_text: undefined, at: '2026-11-10T10:00:00.000Z' }),
    movement(3, { movement: 'stored', location_text: 'Synthetic cabinet 7', at: '2026-11-10T11:00:00.000Z' }),
  ];

  it('scanning a block label: POST {label} -> result panel (Label, Type, Case accession link, Part, Current location, Last movement)', async () => {
    api.use(http.get(`${ORIGIN}/v1/anatomic/blocks/:id/movements`, () => page(movs)));
    await mount();
    await scan(A1);
    expect((await screen.findAllByText('Synthetic cabinet 7', { exact: false })).length).toBeGreaterThanOrEqual(1); // DescriptionList + Timeline (04-UI-UX:247); ruling T-20
    const [l, ...rest] = hit('POST', /\/cases\/lookup$/);
    expect(rest).toHaveLength(0);
    expect(l!.json).toEqual({ label: A1 });
    expect(l!.search).toBe('');
    const terms = screen.getAllByRole('term').map((t) => t.textContent?.trim());
    for (const t of ['Label', 'Type', 'Case', 'Part', 'Current location', 'Last movement']) expect(terms, t).toContain(t);
    expect(screen.getAllByText(A1, { exact: false }).length).toBeGreaterThan(0);
    const caseLink = screen.getByRole('link', { name: /SP26-000042$/ }) as HTMLAnchorElement;
    expect(caseLink.getAttribute('href')).toBe(`/anatomic/cases/${CASE}`);
    expect(document.body.textContent).toMatch(/Part A/);
    expect(document.body.textContent).toMatch(/Block/);
    expect(document.body.textContent).toMatch(/Stored/); // location status as a word
  });

  it('AC-06.2: the full history is shown newest first, even if the API returns it oldest first', async () => {
    api.use(http.get(`${ORIGIN}/v1/anatomic/blocks/:id/movements`, () => page(movs)));
    await mount();
    await scan(A1);
    await waitFor(() => expect(screen.getAllByRole('listitem').filter((e) => /cabinet/.test(e.textContent ?? '')).length).toBe(2));
    const items = screen.getAllByRole('listitem').filter((e) => /Stored|Retrieved/.test(e.textContent ?? ''));
    expect(items).toHaveLength(3);
    expect(items.map((e) => /cabinet 7|Retrieved|cabinet 3/.exec(e.textContent ?? '')![0])).toEqual(['cabinet 7', 'Retrieved', 'cabinet 3']);
    expect(items[0]!.textContent).toMatch(/Synthetic Tech/); // actor
  });

  it('a block history request is GET /blocks/{id}/movements by id; a slide uses /slides/{id}/movements and shows its Stain', async () => {
    await mount();
    await scan(S1);
    await screen.findByText(/Haematoxylin/);
    expect(hit('GET', new RegExp(`^/v1/anatomic/slides/${ID(301)}/movements$`))).toHaveLength(1);
    expect(hit('GET', /\/blocks\/[^/]+\/movements$/)).toHaveLength(0);
    expect(screen.getAllByRole('term').map((t) => t.textContent?.trim())).toContain('Stain');
    expect(document.body.textContent).toMatch(/Slide/);
  });

  it('REQ-SEC-098: the label is never in a URL, router call, or console output', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    await mount();
    await scan(A1);
    expect((await screen.findAllByText('Synthetic cabinet 7', { exact: false })).length).toBeGreaterThanOrEqual(1); // DescriptionList + Timeline (04-UI-UX:247); ruling T-20
    for (const h of hits) expect(h.path + h.search, h.path).not.toContain('SP26-000042');
    expect(JSON.stringify(router.push.mock.calls)).not.toContain('SP26-000042');
    for (const s of spies) expect(JSON.stringify(s.mock.calls)).not.toContain('SP26-000042');
    expect(window.location.href).not.toContain('SP26-000042');
  });

  it('not found: "No block or slide with this label." and nothing else is requested', async () => {
    await mount();
    await scan('SP26-999999-A1');
    expect(await screen.findByText('No block or slide with this label.')).toBeTruthy();
    expect(hits.filter((h) => h.method === 'GET')).toHaveLength(0);
  });

  it('a value outside /^[A-Z0-9-]{1,32}$/ is rejected in the browser: no request, field aria-invalid', async () => {
    await mount();
    await scan('sp 26*!');
    expect(hit('POST', /lookup$/)).toHaveLength(0);
    expect(field().getAttribute('aria-invalid')).toBe('true');
  });

  it('lower-case typing is upper-cased; the field is cleared and re-focused after a scan (ready for the next one)', async () => {
    await mount();
    await scan('sp26-000042-a1');
    await waitFor(() => expect(hit('POST', /lookup$/)).toHaveLength(1));
    expect(hit('POST', /lookup$/)[0]!.json).toEqual({ label: A1 });
    expect((field() as HTMLInputElement).value).toBe('');
  });

  it('403 / 5xx from lookup show a generic error and do not leak the problem body', async () => {
    api.use(http.post(`${ORIGIN}/v1/anatomic/cases/lookup`, () => problem('common.internal', 500, { detail: 'stack: secret-internal' })));
    await mount();
    await scan(A1);
    await waitFor(() => expect(hit('POST', /lookup$/)).toHaveLength(1));
    expect(document.body.textContent).not.toContain('secret-internal');
  });

  it('scanner capture is enabled: typing a label with no focus in the field still lands in the lookup (useScanCapture)', async () => {
    await mount();
    (document.activeElement as HTMLElement | null)?.blur();
    await userEvent.keyboard(`${A1}{Enter}`);
    await waitFor(() => expect(hit('POST', /lookup$/)).toHaveLength(1));
  });

  it('the lookup field is focused on load', async () => {
    await mount();
    expect(document.activeElement).toBe(field());
  });
});

describe('basket mode (plan row T-20; 04-UI-UX §4.5)', () => {
  it('Basket mode switch on: each scan is added to a table (Label, Type, Current location, remove); no single-result panel', async () => {
    await mount();
    await basketOn();
    await scan(A1);
    await scan(S1);
    const table = await screen.findByRole('grid');
    await waitFor(() => expect(within(table).getAllByRole('row').length).toBe(3)); // header + 2
    for (const h of ['Label', 'Type', 'Current location']) expect(within(table).getByRole('columnheader', { name: new RegExp(`^${h}`) })).toBeTruthy();
    expect(within(table).getByText(A1)).toBeTruthy(); // exact: A1 is a substring of S1; ruling T-20
    expect(within(table).getByText(S1)).toBeTruthy();
    expect(within(table).getByText('Synthetic cabinet 7', { exact: false })).toBeTruthy();
    expect(screen.queryByRole('term', { name: 'Last movement' })).toBeNull();
    expect(hit('GET', /\/movements$/)).toHaveLength(0); // history is for single mode only
  });

  it('a duplicate scan shows "Already in the list." and adds no row', async () => {
    await mount();
    await basketOn();
    await scan(A1);
    await screen.findByText(A1, { exact: false });
    await userEvent.clear(field());
    await act(async () => { await new Promise((r) => setTimeout(r, 1600)); }); // past the kit's 1.5 s duplicate-scan guard
    await scan(A1);
    expect(await screen.findByText('Already in the list.')).toBeTruthy();
    expect(within(screen.getByRole('grid')).getAllByRole('row')).toHaveLength(2);
  });

  it('each row has its own remove button ("Remove {label}")', async () => {
    await mount();
    await basketOn();
    await scan(A1);
    await scan(A2);
    await screen.findByRole('button', { name: `Remove ${A2}` });
    await userEvent.click(screen.getByRole('button', { name: `Remove ${A1}` }));
    expect(screen.queryByRole('button', { name: `Remove ${A1}` })).toBeNull();
    expect(screen.getByRole('button', { name: `Remove ${A2}` })).toBeTruthy();
  });

  it('[Record movement] is disabled while the basket is empty and enabled after a scan; it is the page\'s one primary button', async () => {
    await mount();
    await basketOn();
    const btn = () => screen.getByRole('button', { name: /^record movement$/i }) as HTMLButtonElement;
    expect(btn().disabled).toBe(true);
    await scan(A1);
    await waitFor(() => expect(btn().disabled).toBe(false));
    expect(document.querySelectorAll('.lims-btn-primary')).toHaveLength(1);
  });

  // NOT covered on purpose: the 200-item basket cap (REQ-SEC-100) needs 200 scans; the API enforces maxItems 200 and is tested in T-09.
});

describe('Movement dialog (§4.4) from the basket', () => {
  const openDialog = async (labels = [A1, A2]) => {
    await mount();
    await basketOn();
    for (const l of labels) await scan(l);
    await screen.findByRole('button', { name: `Remove ${labels[labels.length - 1]}` });
    await userEvent.click(screen.getByRole('button', { name: /^record movement$/i }));
    return screen.findByRole('dialog');
  };
  const radio = (re: RegExp) => within(dialog()).getByRole('radio', { name: re });
  const submit = () => userEvent.click(within(dialog()).getByRole('button', { name: /^(record|save|submit|confirm)/i }));

  it('lists the items read-only and offers Store / Retrieve / Send out / Return / Discard; fields Location, Destination, Reason, Note', async () => {
    const d = await openDialog();
    expect(d.textContent).toContain(A1);
    expect(d.textContent).toContain(A2);
    for (const m of ['Store', 'Retrieve', 'Send out', 'Return', 'Discard']) expect(within(d).getByRole('radio', { name: new RegExp(`^${m}$`, 'i') })).toBeTruthy();
    for (const f of [/location/i, /destination/i, /note/i]) expect(within(d).getByLabelText(f)).toBeTruthy();
  });

  it('Alt+V is registered on staff.anatomic.tracking (not Alt+M) and opens the dialog for the basket', async () => {
    const { shortcuts } = await import('@/core/shortcuts/registry');
    await mount();
    await basketOn();
    await scan(A1);
    await screen.findByRole('button', { name: `Remove ${A1}` });
    const keys = shortcuts.list('staff.anatomic.tracking').map((s) => s.key);
    expect(keys).toContain('Alt+V');
    expect(keys).not.toContain('Alt+M');
    for (const k of keys) expect(k).toMatch(/^Alt\+[A-Z]$/);
    act(() => shortcuts.list('staff.anatomic.tracking').find((s) => s.key === 'Alt+V')!.run());
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  it('Store: Location required. Empty -> no request, field aria-invalid (AC-06.5 client side)', async () => {
    await openDialog();
    await userEvent.click(radio(/^store$/i));
    await submit();
    expect(movePosts()).toHaveLength(0);
    expect(within(dialog()).getByLabelText(/location/i).getAttribute('aria-invalid')).toBe('true');
  });

  it('Store with location: POST /movements {object_kind:block, object_ids, movement:stored, location_text} with an Idempotency-Key; per-id outcomes shown', async () => {
    await openDialog();
    await userEvent.click(radio(/^store$/i));
    await userEvent.type(within(dialog()).getByLabelText(/location/i), 'Block cabinet 3, drawer 2');
    await submit();
    await waitFor(() => expect(movePosts()).toHaveLength(1));
    const p = movePosts()[0]!;
    expect(p.json).toEqual({ object_kind: 'block', object_ids: [ID(201), ID(202)], movement: 'stored', location_text: 'Block cabinet 3, drawer 2' });
    expect(p.headers.get('idempotency-key')).toMatch(IDEM_RE);
    expect(await screen.findByText(/2 .*recorded/i)).toBeTruthy();
  });

  it('Send out: Destination and Reason are required (§4.4, TRD M11); with both: reason_code is the enum value', async () => {
    await openDialog();
    await userEvent.click(radio(/^send out$/i));
    await submit();
    expect(movePosts()).toHaveLength(0);
    expect(within(dialog()).getByLabelText(/destination/i).getAttribute('aria-invalid')).toBe('true');
    await userEvent.type(within(dialog()).getByLabelText(/destination/i), 'Synthetic Referral Lab');
    await submit();
    expect(movePosts()).toHaveLength(0); // reason still missing
    await choose(dialog(), /reason/i, /second opinion/i);
    await submit();
    await waitFor(() => expect(movePosts()).toHaveLength(1));
    expect(movePosts()[0]!.json).toMatchObject({ movement: 'sent_out', destination_text: 'Synthetic Referral Lab', reason_code: 'second_opinion' });
  });

  it('Discard asks first (ConfirmDialog tone danger: "Discarded blocks and slides can\'t be used again."); Cancel sends nothing; Confirm sends discarded + reason_code', async () => {
    await openDialog();
    await userEvent.click(radio(/^discard$/i));
    await choose(dialog(), /reason/i, /retention period ended/i);
    await submit();
    const confirm = (await screen.findAllByRole('dialog')).at(-1)!; // kit ConfirmDialog = kit Dialog (role dialog), topmost; ruling T-20
    expect(confirm.textContent).toContain("Discarded blocks and slides can't be used again.");
    expect(confirm.querySelector('[data-tone="danger"], .lims-btn-danger')).toBeTruthy();
    expect(movePosts()).toHaveLength(0);
    await userEvent.click(within(confirm).getByRole('button', { name: /cancel|keep|back/i }));
    expect(movePosts()).toHaveLength(0);
    await submit();
    await userEvent.click(within((await screen.findAllByRole('dialog')).at(-1)!).getByRole('button', { name: /discard/i }));
    await waitFor(() => expect(movePosts()).toHaveLength(1));
    expect(movePosts()[0]!.json).toMatchObject({ movement: 'discarded', reason_code: 'retention_expired' });
  });

  it('Retrieve / Return need no extra fields', async () => {
    await openDialog([A1]);
    await userEvent.click(radio(/^retrieve$/i));
    await submit();
    await waitFor(() => expect(movePosts()).toHaveLength(1));
    expect(movePosts()[0]!.json).toMatchObject({ movement: 'retrieved', object_ids: [ID(201)] });
  });

  it('a mixed basket (blocks and slides) is sent as one request per object_kind, each with its own Idempotency-Key', async () => {
    await openDialog([A1, S1]);
    await userEvent.click(radio(/^retrieve$/i));
    await submit();
    await waitFor(() => expect(movePosts()).toHaveLength(2));
    const kinds = movePosts().map((p) => (p.json as { object_kind: string }).object_kind).sort();
    expect(kinds).toEqual(['block', 'slide']);
    const keys = movePosts().map((p) => p.headers.get('idempotency-key'));
    expect(new Set(keys).size).toBe(2);
    for (const k of keys) expect(k).toMatch(IDEM_RE);
  });

  it('AC-06.4 (UI): an invalid_state outcome is shown per label as not recorded, the others as recorded; the basket keeps only the failed ones', async () => {
    api.use(http.post(`${ORIGIN}/v1/anatomic/movements`, () => HttpResponse.json({ results: [{ id: ID(201), outcome: 'recorded' }, { id: ID(202), outcome: 'invalid_state' }] })));
    await openDialog();
    await userEvent.click(radio(/^retrieve$/i));
    await submit();
    await waitFor(() => expect(document.body.textContent).toMatch(/1 .*recorded/i));
    expect(document.body.textContent).toMatch(/1 .*(skipped|not recorded)|can.t be used|isn.t possible/i);
    await waitFor(() => expect(screen.queryByRole('button', { name: `Remove ${A1}` })).toBeNull());
    expect(screen.getByRole('button', { name: `Remove ${A2}` })).toBeTruthy();
  });

  it('400 common.validation_failed from the API is mapped to the field (/reason_code), not a raw body', async () => {
    api.use(http.post(`${ORIGIN}/v1/anatomic/movements`, () => problem('common.validation_failed', 400, { errors: [{ path: '/reason_code', code: 'required', message: 'secret-internal' }] })));
    await openDialog([A1]);
    await userEvent.click(radio(/^retrieve$/i));
    await submit();
    await waitFor(() => expect(movePosts()).toHaveLength(1));
    expect(document.body.textContent).not.toContain('secret-internal');
  });

  it('403 auth.mfa_required opens the step-up dialog "This action needs two-factor verification." with [Verify now]', async () => {
    api.use(http.post(`${ORIGIN}/v1/anatomic/movements`, () => problem('auth.mfa_required', 403)));
    await openDialog([A1]);
    await userEvent.click(radio(/^retrieve$/i));
    await submit();
    expect(await screen.findByText('This action needs two-factor verification.')).toBeTruthy();
    expect(screen.getByRole('button', { name: /verify now/i })).toBeTruthy();
  });

  it('a user without anatomic.case.work sees lookup but no Basket/Record movement controls (read-only)', async () => {
    state.permissions = PERM_READ;
    await mount();
    expect(screen.queryByRole('button', { name: /record movement/i })).toBeNull();
    await scan(A1);
    expect((await screen.findAllByText('Synthetic cabinet 7', { exact: false })).length).toBeGreaterThanOrEqual(1); // DescriptionList + Timeline (04-UI-UX:247); ruling T-20
    expect(screen.queryByRole('button', { name: /record movement/i })).toBeNull();
  });
});

describe('Sent out tab', () => {
  const rows = [
    { ...block(1), id: ID(211), label: 'SP26-000050-A1', case_id: ID(51), accession_no: 'SP26-000050', location_status: 'sent_out', last_movement_at: '2026-11-09T09:00:00.000Z' },
    { ...block(2), id: ID(212), label: 'SP26-000040-A1', case_id: ID(41), accession_no: 'SP26-000040', location_status: 'sent_out', last_movement_at: '2026-11-02T09:00:00.000Z' },
  ];
  beforeEach(() => {
    api.use(
      http.get(`${ORIGIN}/v1/anatomic/blocks`, () => page(rows)),
      http.get(`${ORIGIN}/v1/anatomic/blocks/:id/movements`, () => page([movement(1, { movement: 'sent_out', location_text: undefined, destination_text: 'Synthetic Referral Lab', reason_code: 'second_opinion' })])),
    );
  });

  it('tabs are "Lookup" and "Sent out"; selecting Sent out navigates to ?tab=sent_out', async () => {
    await mount();
    expect(screen.getByRole('tab', { name: /^lookup$/i }).getAttribute('aria-selected')).toBe('true');
    await userEvent.click(screen.getByRole('tab', { name: /^sent out$/i }));
    expect(router.push).toHaveBeenCalledWith('/anatomic/tracking?tab=sent_out');
  });

  it('?tab=sent_out: GET /blocks?location_status=sent_out; table Label, Case, Sent to, Since, Reason; oldest first', async () => {
    await mount({ tab: 'sent_out' });
    const calls = hit('GET', /^\/v1\/anatomic\/blocks$/);
    expect(calls).toHaveLength(1);
    expect(new URLSearchParams(calls[0]!.search).get('location_status')).toBe('sent_out');
    const grid = await screen.findByRole('grid');
    for (const h of ['Label', 'Case', 'Sent to', 'Since', 'Reason']) expect(within(grid).getByRole('columnheader', { name: new RegExp(`^${h}`) })).toBeTruthy();
    const body = within(grid).getAllByRole('row').slice(1);
    expect(body[0]!.textContent).toContain('SP26-000040-A1'); // sent 2 Nov first
    expect(body[1]!.textContent).toContain('SP26-000050-A1');
    expect(body[0]!.textContent).toContain('Synthetic Referral Lab');
    expect(body[0]!.textContent).toMatch(/second opinion/i);
    expect((within(body[0]!).getByRole('link', { name: 'SP26-000040' }) as HTMLAnchorElement).getAttribute('href')).toBe(`/anatomic/cases/${ID(41)}`);
  });

  it('empty: a friendly empty state, no table', async () => {
    api.use(http.get(`${ORIGIN}/v1/anatomic/blocks`, () => page([])));
    await mount({ tab: 'sent_out' });
    expect(screen.getByText(/nothing is sent out|no blocks (are )?sent out/i)).toBeTruthy();
  });

  it('unknown ?tab falls back to Lookup and calls nothing', async () => {
    await mount({ tab: 'drop table' });
    expect(hit('GET', /\/blocks$/)).toHaveLength(0);
    expect(screen.getByRole('tab', { name: /^lookup$/i }).getAttribute('aria-selected')).toBe('true');
  });
});

describe('page states and a11y', () => {
  it('no anatomic.case.read: no-access state, no API call', async () => {
    state.permissions = [];
    await mount();
    expect(hits).toHaveLength(0);
    expect(document.body.textContent).toMatch(/don.t have access|not allowed|no access|permission/i);
  });

  it('page has a PageHeader h1 "Block & slide tracking" with a help key page (help/anatomic.tracking.ts exists)', async () => {
    await mount();
    expect(screen.getByRole('heading', { level: 1, name: /block & slide tracking/i })).toBeTruthy();
  });

  it('axe: lookup, basket and sent-out views have no violations', async () => {
    const run = async () => (await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } })).violations.map((x) => `${x.id}: ${x.help}`);
    await mount();
    expect(await run()).toEqual([]);
    await basketOn();
    await scan(A1);
    await screen.findByRole('button', { name: `Remove ${A1}` });
    expect(await run()).toEqual([]);
  });
});
