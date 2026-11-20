// @vitest-environment jsdom
// HC-T19 — Review of a held collection (04-UI-UX §2.2 "On hold" card + Review dialog; TRD H9 reviewHeldCollection; 01-PRD US-09-1, US-09-2, US-09-3, US-09-4 (UI side);
// 07-SECURITY REQ-SEC-050/051 Idempotency-Key on review; permission homecollection.visit.assign). MSW plays the API.
// ASSUMED contract (dispute via the writer if wrong; same VisitDetailView as hc-t19.detail.test.tsx):
//   * "On hold" card: one row per collection with status `held`; the row shows the reason text of its hold_code
//       mutation_superseded  -> "The visit or tube changed on the server before this was uploaded"
//       visit_not_assigned   -> "Collected by someone not assigned at that time"
//       barcode_mismatch     -> "Scanned barcode doesn't match the tube"
//     and a "Review" button (accessible name starts with "Review").
//   * Review dialog (role=dialog): RadioGroup with radios "Apply" and "Discard"; a reason select (label matches /reason/i) with homecollection.review_reasons; a free-text box (maxLength 500);
//     one submit button (name starts with apply|discard|confirm|submit|save|review) and a Cancel button. Apply is DISABLED for barcode_mismatch and the reason text is shown in the dialog.
//   * submit -> H9 `POST /v1/homecollection/collections/{collection_id}/review` { decision, reason_code, reason_text? } with Idempotency-Key (required) and If-Match = collection.version.
//   * success: toast, router.refresh(), dialog closes. Errors are plain sentences (never a code); a failed submit re-sent keeps the SAME Idempotency-Key.
//   * 409 mutation_superseded on Apply -> sentence naming the change + the Apply radio is disabled afterwards ("only Discard remains", US-09-2) and Discard still works.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { API, COL_APPLIED, COL_HELD, COL_MISMATCH, CODES19, PERMS_REVIEW, U, VISIT_ID, axeClean, detail, isEnabled, noRawCodes, pick, problem, recorder, userEvent, wrap, type Call } from './hc-t19.helpers';

const refresh = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh, back: vi.fn() }),
  usePathname: () => `/homecollection/visits/x`,
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: PERMS_REVIEW, displayName: 'Synthetic Dispatcher', tenantCode: 'syn', roles: [], membershipId: U(9) } }),
  getRequestPathname: async () => `/homecollection/visits/${VISIT_ID}`,
}));

const calls: Call[] = [];
const rec = recorder(calls);
type R = () => Response | Promise<Response>;
let review: R;
const reset = () => { review = () => HttpResponse.json({ ...COL_HELD, version: 3, status: 'applied' }); };
reset();
const api = setupServer(http.post(`${API}/collections/:id/review`, async ({ request }) => { await rec(request); return review(); }));
beforeAll(() => api.listen({ onUnhandledFrame: 'error' }));
afterEach(() => { cleanup(); api.resetHandlers(); calls.length = 0; refresh.mockReset(); reset(); });
afterAll(() => api.close());

const posts = () => calls.filter((c) => c.method === 'POST' && c.url.pathname.endsWith('/review'));
const view = async (visit: Record<string, unknown> = detail()) => {
  const path = '../components/VisitDetailView'; // variable path: a missing file fails each test, not the whole suite
  const { VisitDetailView } = (await import(/* @vite-ignore */ path)) as { VisitDetailView: (p: any) => any };
  wrap(<VisitDetailView visit={visit as never} permissions={PERMS_REVIEW} codes={CODES19} />);
};
const onHold = () => screen.getByRole('heading', { level: 2, name: 'On hold' }).closest('.lims-card') as HTMLElement;
const rowFor = (reason: RegExp) => within(onHold()).getAllByRole('row').find((r) => reason.test(r.textContent ?? '')) ?? within(onHold()).getAllByRole('listitem').find((r) => reason.test(r.textContent ?? ''))!;
const SUPERSEDED = /changed on the server before this was uploaded/i;
const MISMATCH = /doesn.t match the tube/i;
const openReview = async (reason: RegExp = SUPERSEDED) => {
  await view();
  await userEvent.click(within(rowFor(reason)).getByRole('button', { name: /^review/i }));
  return screen.findByRole('dialog');
};
const submit = (dlg: HTMLElement) => within(dlg).getAllByRole('button').find((b) => /^(apply|discard|confirm|submit|save|review)/i.test(b.textContent ?? '') && !/cancel/i.test(b.textContent ?? ''))!;
const choose = (dlg: HTMLElement, decision: RegExp) => userEvent.click(within(dlg).getByRole('radio', { name: decision }));

describe('On hold card (§2.2)', () => {
  it('one row per held collection with the plain-words reason and a Review button; the applied collection is not listed', async () => {
    await view();
    const rows = within(onHold()).getAllByRole('button', { name: /^review/i });
    expect(rows).toHaveLength(2);
    expect(onHold().textContent).toMatch(SUPERSEDED);
    expect(onHold().textContent).toMatch(MISMATCH);
    noRawCodes();
    expect(onHold().textContent).not.toMatch(/mutation_superseded|barcode_mismatch/);
  });
  it('visit_not_assigned reason text; a collection already applied or discarded has no Review button', async () => {
    await view(detail({ collections: [{ ...COL_HELD, hold_code: 'visit_not_assigned' }, COL_APPLIED, { ...COL_APPLIED, id: U(8004), status: 'discarded', review: { decision: 'discard', reason_code: 'duplicate_draw', by_display: 'Test Dispatcher 07', at: '2026-11-14T04:00:00.000Z' } }] }));
    expect(onHold().textContent).toMatch(/Collected by someone not assigned at that time/);
    expect(within(onHold()).getAllByRole('button', { name: /^review/i })).toHaveLength(1);
    expect(screen.getByText(/discarded/i)).toBeTruthy(); // tube chip: Discarded (neutral)
  });
});

describe('Review dialog structure', () => {
  it('Apply / Discard radios, reason select with the review_reasons set, free text ≤ 500, a submit and a Cancel button', async () => {
    const dlg = await openReview();
    expect(within(dlg).getByRole('radio', { name: /^apply/i })).toBeTruthy();
    expect(within(dlg).getByRole('radio', { name: /^discard/i })).toBeTruthy();
    expect((within(dlg).getByRole('textbox') as HTMLInputElement).maxLength).toBe(500);
    expect(within(dlg).getByRole('button', { name: /cancel/i })).toBeTruthy();
    expect(submit(dlg)).toBeTruthy();
    await userEvent.click(within(dlg).getByRole('button', { name: /reason/i }));
    for (const d of CODES19.review_reasons.map((r) => r.display)) expect(await screen.findByRole('option', { name: d })).toBeTruthy();
  });
  it('nothing is sent without a decision, or without a reason', async () => {
    const dlg = await openReview();
    await userEvent.click(submit(dlg));
    expect(posts()).toHaveLength(0);
    await choose(dlg, /^apply/i);
    await userEvent.click(submit(dlg));
    expect(posts()).toHaveLength(0);
  });
  it('barcode_mismatch: Apply is disabled and the reason is explained; Discard stays available', async () => {
    const dlg = await openReview(MISMATCH);
    expect(isEnabled(within(dlg).getByRole('radio', { name: /^apply/i }))).toBe(false);
    expect(isEnabled(within(dlg).getByRole('radio', { name: /^discard/i }))).toBe(true);
    expect(dlg.textContent).toMatch(MISMATCH);
  });
  it('Cancel closes without sending anything; axe clean', async () => {
    const dlg = await openReview();
    await axeClean();
    await userEvent.click(within(dlg).getByRole('button', { name: /cancel/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(posts()).toHaveLength(0);
  });
});

describe('US-09-1: Apply', () => {
  it('POST /collections/{id}/review { decision: apply, reason_code }, Idempotency-Key, If-Match = collection version, Bearer; toast, refresh, dialog closes', async () => {
    const dlg = await openReview();
    await choose(dlg, /^apply/i);
    await pick(dlg, 'Order still valid', /reason/i);
    await userEvent.click(submit(dlg));
    await waitFor(() => expect(posts()).toHaveLength(1));
    const c = posts()[0]!;
    expect(c.url.pathname).toBe(`/v1/homecollection/collections/${COL_HELD.id}/review`);
    expect(c.body).toEqual({ decision: 'apply', reason_code: 'order_still_valid' });
    expect(c.headers.get('if-match')).toMatch(/2/);
    expect(c.headers.get('idempotency-key')).toBeTruthy();
    expect(c.headers.get('authorization')).toMatch(/^Bearer /);
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.body.textContent).toMatch(/applied|reviewed/i);
  });
  it('double submit is single-flight: one request', async () => {
    const dlg = await openReview();
    await choose(dlg, /^apply/i);
    await pick(dlg, 'Order still valid', /reason/i);
    const b = submit(dlg);
    await userEvent.dblClick(b);
    await waitFor(() => expect(posts()).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(posts()).toHaveLength(1);
  });
  it('the review request names the collection of THAT row only (second held row -> its own id)', async () => {
    const dlg = await openReview(MISMATCH);
    await choose(dlg, /^discard/i);
    await pick(dlg, 'Wrong patient', /reason/i);
    await userEvent.click(submit(dlg));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]!.url.pathname).toContain(COL_MISMATCH.id);
  });
});

describe('US-09-2: Apply refused because the tube changed', () => {
  it('409 mutation_superseded -> plain sentence, Apply disabled afterwards, Discard still works with its own request', async () => {
    review = () => problem('homecollection.mutation_superseded', 409);
    const dlg = await openReview();
    await choose(dlg, /^apply/i);
    await pick(dlg, 'Order still valid', /reason/i);
    await userEvent.click(submit(dlg));
    const alert = await within(dlg).findByRole('alert');
    expect(alert.textContent).toMatch(/changed|no longer|discard/i);
    noRawCodes();
    expect(refresh).not.toHaveBeenCalled();
    expect(isEnabled(within(dlg).getByRole('radio', { name: /^apply/i }))).toBe(false);
    review = () => HttpResponse.json({ ...COL_HELD, version: 3, status: 'discarded' });
    await choose(dlg, /^discard/i);
    await pick(dlg, 'Duplicate draw', /reason/i);
    await userEvent.click(submit(dlg));
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(posts()[1]!.body).toEqual({ decision: 'discard', reason_code: 'duplicate_draw' });
    expect(posts()[1]!.headers.get('idempotency-key')).not.toBe(posts()[0]!.headers.get('idempotency-key')); // a different request
  });
  it('409 barcode_mismatch (server refuses Apply) -> sentence about the scanned barcode, no code', async () => {
    review = () => problem('homecollection.barcode_mismatch', 409);
    const dlg = await openReview();
    await choose(dlg, /^apply/i);
    await pick(dlg, 'Order still valid', /reason/i);
    await userEvent.click(submit(dlg));
    expect((await within(dlg).findByRole('alert')).textContent).toMatch(/barcode|tube/i);
    noRawCodes();
  });
});

describe('US-09-3: Discard', () => {
  it.each([['Tube destroyed', 'specimen_destroyed'], ['Duplicate draw', 'duplicate_draw'], ['Wrong patient', 'wrong_patient']])('reason "%s" -> { decision: discard, reason_code: %s }', async (label, code) => {
    review = () => HttpResponse.json({ ...COL_HELD, version: 3, status: 'discarded' });
    const dlg = await openReview();
    await choose(dlg, /^discard/i);
    await pick(dlg, label, /reason/i);
    await userEvent.click(submit(dlg));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]!.body).toEqual({ decision: 'discard', reason_code: code });
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });
  it('"Other" needs text: nothing is sent until it is typed; then { reason_code: other, reason_text }', async () => {
    const dlg = await openReview();
    await choose(dlg, /^discard/i);
    await pick(dlg, 'Other', /reason/i);
    await userEvent.click(submit(dlg));
    expect(posts()).toHaveLength(0);
    await userEvent.type(within(dlg).getByRole('textbox'), 'Tube dropped (synthetic)');
    await userEvent.click(submit(dlg));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]!.body).toEqual({ decision: 'discard', reason_code: 'other', reason_text: 'Tube dropped (synthetic)' });
  });
});

describe('US-09-4 and failures', () => {
  it('409 collection_not_held -> plain sentence that it was already handled + reload hint; no code', async () => {
    review = () => problem('homecollection.collection_not_held', 409);
    const dlg = await openReview();
    await choose(dlg, /^discard/i);
    await pick(dlg, 'Wrong patient', /reason/i);
    await userEvent.click(submit(dlg));
    expect((await within(dlg).findByRole('alert')).textContent).toMatch(/already|no longer|reload|refresh/i);
    noRawCodes();
  });
  it('403 auth.forbidden and 500 -> plain words; the dialog stays open; no code', async () => {
    review = () => problem('auth.forbidden', 403);
    const dlg = await openReview();
    await choose(dlg, /^discard/i);
    await pick(dlg, 'Wrong patient', /reason/i);
    await userEvent.click(submit(dlg));
    expect((await within(dlg).findByRole('alert')).textContent).toMatch(/permission/i);
    review = () => problem('common.internal', 500);
    await userEvent.click(submit(dlg));
    await waitFor(() => expect(within(dlg).getByRole('alert').textContent).toMatch(/something went wrong|try again/i));
    expect(screen.getByRole('dialog')).toBeTruthy();
    noRawCodes();
  });
  it('retry after a failure re-sends the SAME Idempotency-Key (replay, not a second review)', async () => {
    review = () => problem('common.internal', 500);
    const dlg = await openReview();
    await choose(dlg, /^discard/i);
    await pick(dlg, 'Wrong patient', /reason/i);
    await userEvent.click(submit(dlg));
    await within(dlg).findByRole('alert');
    await userEvent.click(submit(dlg));
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(posts()[1]!.headers.get('idempotency-key')).toBe(posts()[0]!.headers.get('idempotency-key'));
  });
});
