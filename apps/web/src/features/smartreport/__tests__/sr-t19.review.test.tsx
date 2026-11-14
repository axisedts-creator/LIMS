// @vitest-environment jsdom
// C14.T19 — SR-02 Summary review, app/(staff)/smartreport/summaries/[summary_id]/page.tsx
// (04-UI-UX SR-02; 03-APP-FLOW §2.6 + §4 row SR-02; PRD AC-14.2, AC-14.3, AC-14.4, AC-14.5, AC-14.7; 07-SECURITY REQ 081 field allowlist, REQ 088 text-only).
// ASSUMED contract (the spec fixes the route, the copy and the endpoints; the rest is the smallest reading of it):
//   * default export = async server component `Page({ params })`. Order: id shape (non-UUID -> notFound, no API call) -> permission (smartreport.summary.read; without it notFound or
//     PermissionDenied and NO API call) -> GET #28 the summary (+ GET #26 coded set `summary_reject_reasons` for reason display). API 404 -> notFound(); other read failures throw.
//   * Buttons "Approve" and "Reject" only when status = draft AND smartreport.summary.approve. Approve = ConfirmDialog (role dialog), exact copy, confirm "Approve" -> POST #31 /approve,
//     If-Match "<row version>", body EXACTLY {attestation:true} (no use_llm_text while llm.enabled is false). Reject = dialog with a reason Select (coded set #26, label contains "reason"),
//     a comment textarea (<=500, required for `other`), confirm "Reject" -> POST #32 /reject, If-Match, body {reason_code[, comment]}.
//   * Success of approve: Banner "Approved. The PDF report will include this summary the next time it is generated. Use Regenerate on the report screen to add it now." with a link
//     "Open order results" -> /lab/orders/{order_id}/results (route staff.lab.order_results) ONLY with lab.result.read. An already approved summary shows the same banner on load.
//   * 409 smartreport.summary_superseded -> role=alert warning "Results changed after this summary was built. A new summary will be prepared." + link to /smartreport/summaries.
//   * Any other failure -> role=alert in plain words, never the raw error code; nothing is shown as approved/rejected.
//   * "Results used" (review_inputs) is a DataTable (grid) named /results used/, rendered ONLY with smartreport.summary.approve. History = region named /history/ with the Timeline items.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse } from 'msw';
import {
  APPROVER, APPROVER_RESULTS, APPROVE_URL, NEWER_ID, ORDER_ID, READER, REJECT_URL, REASONS_URL, SUMMARY_ID, SUMMARY_PAGE, SUMMARY_URL,
  api, apiCalls, approvedView, axeClean, bodyOf, callsTo, json, mountSummary, norm, pageText, pick, problem, resetApi, router, routes, showOrThrown, showSummary, summaryView,
} from './sr-t19.harness';

vi.mock('next/navigation', async () => (await import('./sr-t20.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./sr-t20.harness')).sessionMock);

const ATTEST = 'I have read every sentence and confirm it is appropriate for this patient.';
const APPROVED_BANNER = 'Approved. The PDF report will include this summary the next time it is generated. Use Regenerate on the report screen to add it now.';
const SUPERSEDED_BANNER = 'Results changed after this summary was built. A new summary will be prepared.';

beforeAll(() => api.listen());
beforeEach(() => { resetApi(APPROVER); mountSummary(); });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const btn = (re: RegExp) => screen.queryByRole('button', { name: re });
const approveBtn = () => screen.getByRole('button', { name: /^approve$/i });
const rejectBtn = () => screen.getByRole('button', { name: /^reject$/i });
const dialog = () => screen.findByRole('dialog');
const approves = () => callsTo('POST', APPROVE_URL);
const rejects = () => callsTo('POST', REJECT_URL);
const mutations = () => apiCalls().filter((c) => c.method !== 'GET');
const confirmApprove = async () => {
  await userEvent.click(approveBtn());
  await userEvent.click(within(await dialog()).getByRole('button', { name: /^approve$/i }));
};
const history = () => screen.getByRole('region', { name: /history/i });
const alertText = () => norm(screen.queryAllByRole('alert').map((a) => a.textContent).join(' '));
const linkTo = (href: string) => screen.queryAllByRole('link').find((a) => a.getAttribute('href') === href);

describe('access and ids', () => {
  it('without smartreport.summary.read: denied (notFound or PermissionDenied) and NO API call', async () => {
    resetApi(['lab.result.read']);
    const out = await showOrThrown(SUMMARY_PAGE, { summary_id: SUMMARY_ID });
    if (out !== undefined) expect(out).toMatch(/NEXT_NOT_FOUND/);
    else expect(screen.getByTestId('permission-denied')).toBeTruthy();
    expect(apiCalls()).toHaveLength(0);
  });

  it.each(['not-a-uuid', '../../x', '01940e00-0000-7000-8000-00000000000z', '%00', '..%2F..%2Fsummaries'])('id %j -> notFound and NO API call', async (bad) => {
    const out = await showOrThrown(SUMMARY_PAGE, { summary_id: bad });
    expect(out).toMatch(/NEXT_NOT_FOUND/);
    expect(apiCalls()).toHaveLength(0);
  });

  it('API 404 -> notFound ("Summary not found or not visible"); any other failed read throws (never rendered as data)', async () => {
    routes[`GET ${SUMMARY_URL}`] = () => problem('common.not_found', 404);
    expect(await showOrThrown(SUMMARY_PAGE, { summary_id: SUMMARY_ID })).toMatch(/NEXT_NOT_FOUND/);
    routes[`GET ${SUMMARY_URL}`] = () => problem('common.internal', 500);
    expect(await showOrThrown(SUMMARY_PAGE, { summary_id: SUMMARY_ID })).toBeDefined();
  });

  it('reads with the bearer token on the server; viewing sends no mutation and no read outside the summary/coded-set/identity endpoints', async () => {
    await showSummary();
    expect(callsTo('GET', SUMMARY_URL)[0]!.headers.get('authorization')).toBe('Bearer jwt-synthetic');
    expect(mutations()).toHaveLength(0);
    for (const c of apiCalls()) expect(c.url.pathname, c.url.pathname).toMatch(new RegExp(`^(${SUMMARY_URL}|/v1/smartreport/coded-sets/|/v1/identity/)`));
  });
});

describe('what the patient will see', () => {
  it('header: title, a TEXT status, registration no, patient, library version, formula', async () => {
    await showSummary();
    const t = pageText();
    expect(t).toMatch(/smart summary/i);
    expect(t).toMatch(/awaiting review|draft/i);
    expect(t).toContain('SYN-000123');
    expect(t).toContain('Synthetic Patient A');
    expect(t).toContain('Library v3');
    expect(t).toContain('hs-1');
  });

  it('preview shows the score, deranged text, advice, follow-up and disclaimer in that order', async () => {
    await showSummary();
    const t = pageText();
    const at = (s: string) => { const i = t.indexOf(s); expect(i, s).toBeGreaterThanOrEqual(0); return i; };
    expect(t).toMatch(/81/);
    const order = [at('Synthetic explanation of the score.'), at('Your Synthetic ALT result is above the reference range.'), at('Synthetic advice: discuss liver results'), at('Consider a repeat Synthetic LFT in 90 days.'), at('Synthetic disclaimer: this summary is not a diagnosis.')];
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(t).toMatch(/liver/i);
    expect(t).toMatch(/blood count/i);
  });

  it('trends have a text alternative: analyte, direction word and every point value', async () => {
    await showSummary();
    const t = pageText();
    expect(t).toContain('Synthetic ALT');
    expect(t).toMatch(/worsened/i);
    expect(t).toContain('41.5');
    expect(t).toContain('63.25');
  });

  it('every text is rendered as TEXT: markup in a summary never becomes an element (07-SECURITY REQ 088)', async () => {
    const evil = '<img src=x onerror=alert(1)> <script>alert(2)</script>';
    mountSummary(summaryView({ advice: [{ template_block_id: NEWER_ID, text: evil }], patient_display_name: evil }));
    await showSummary();
    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
    expect(pageText()).toContain('<img src=x onerror=alert(1)>');
  });

  it('no raw placeholder leakage or JS artefacts when optional parts are missing (no score, no trends, no advice)', async () => {
    mountSummary(summaryView({ health_score: undefined, trends: [], advice: [], follow_ups: [], deranged: [], review_inputs: undefined }));
    await showSummary();
    expect(pageText()).not.toMatch(/undefined|NaN|\[object|\{[a-z_]+\}/);
  });
});

describe('Results used (REQ 081: review_inputs only for summary.approve)', () => {
  const grid = () => screen.getByRole('grid', { name: /results used/i });

  it('approver sees the table: Analyte, Result, Unit, Reference range, Band, Group + caption + counts', async () => {
    await showSummary();
    const heads = within(grid()).getAllByRole('columnheader').map((h) => norm(h.textContent));
    for (const h of [/analyte/i, /result/i, /unit/i, /reference range/i, /band/i, /group/i]) expect(heads.some((x) => h.test(x)), String(h)).toBe(true);
    const rows = within(grid()).getAllByRole('row').slice(1).map((r) => norm(r.textContent));
    expect(rows.some((r) => r.includes('Synthetic ALT') && r.includes('63.25') && r.includes('7 - 40'))).toBe(true);
    expect(rows.some((r) => r.includes('Synthetic Haemoglobin') && /in range/i.test(r))).toBe(true);
    expect(pageText()).toContain('Approved results this summary was built from');
    expect(pageText()).toContain('2 approved results are not mapped to a body system and are not in this summary');
  });

  it('a reader without summary.approve never sees the table even if the response carried review_inputs', async () => {
    resetApi(READER); mountSummary();
    await showSummary();
    expect(screen.queryByRole('grid', { name: /results used/i })).toBeNull();
    expect(pageText()).not.toContain('Synthetic Haemoglobin');
    expect(pageText()).not.toContain('63.25 UL');
  });

  it('llm_text is shown only to approvers (REQ 081): a reader never sees the rephrased wording', async () => {
    const llm = 'Synthetic AI rephrased sentence.';
    resetApi(READER); mountSummary(summaryView({ advice: [{ template_block_id: NEWER_ID, text: 'Synthetic advice: discuss liver results with your doctor.', llm_text: llm }] }));
    await showSummary();
    expect(pageText()).not.toContain(llm);
  });
});

describe('who sees the actions', () => {
  it('draft + smartreport.summary.approve: Approve and Reject (and Approve & next) are shown', async () => {
    await showSummary();
    expect(approveBtn()).toBeTruthy();
    expect(rejectBtn()).toBeTruthy();
    expect(btn(/approve (&|and) next/i)).toBeTruthy();
  });

  it('reader without summary.approve: read-only page, NO action buttons (the API still enforces)', async () => {
    resetApi(READER); mountSummary();
    await showSummary();
    expect(btn(/^approve$/i)).toBeNull();
    expect(btn(/^reject$/i)).toBeNull();
    expect(btn(/approve (&|and) next/i)).toBeNull();
    expect(pageText()).toContain('SYN-000123');
  });

  it.each(['approved', 'rejected', 'superseded'])('status %s: read-only, no Approve / Reject even with the permission', async (status) => {
    mountSummary(summaryView({ status, ...(status === 'superseded' ? { superseded_by_summary_id: NEWER_ID } : {}) }));
    await showSummary();
    expect(btn(/^approve$/i)).toBeNull();
    expect(btn(/^reject$/i)).toBeNull();
  });

  it('keyboard: Ctrl+Enter opens Approve, Ctrl+Shift+R opens Reject; nothing is sent until confirmed', async () => {
    await showSummary();
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    expect(norm((await dialog()).textContent)).toContain(ATTEST);
    await userEvent.click(within(await dialog()).getByRole('button', { name: /cancel/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await userEvent.keyboard('{Control>}{Shift>}R{/Shift}{/Control}');
    expect(norm((await dialog()).textContent)).toMatch(/reject/i);
    expect(mutations()).toHaveLength(0);
  });

  it('keyboard shortcuts do nothing for a reader', async () => {
    resetApi(READER); mountSummary();
    await showSummary();
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('AC-14.2 approve', () => {
  it('Approve opens a ConfirmDialog titled "Approve this summary?" with the exact attestation copy; nothing is sent yet', async () => {
    await showSummary();
    await userEvent.click(approveBtn());
    const d = await dialog();
    expect(norm(d.textContent)).toContain('Approve this summary?');
    expect(norm(d.textContent)).toContain(ATTEST);
    expect(approves()).toHaveLength(0);
  });

  it('Cancel closes the dialog and sends nothing', async () => {
    await showSummary();
    await userEvent.click(approveBtn());
    await userEvent.click(within(await dialog()).getByRole('button', { name: /cancel/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(approves()).toHaveLength(0);
  });

  it('with llm.enabled = false there is no "Use AI-rephrased wording" switch', async () => {
    await showSummary();
    await userEvent.click(approveBtn());
    expect(within(await dialog()).queryByRole('switch')).toBeNull();
  });

  it('confirm -> POST /approve, If-Match "<row version>", bearer token, body EXACTLY {attestation:true}', async () => {
    routes[`POST ${APPROVE_URL}`] = json(approvedView());
    await showSummary();
    await confirmApprove();
    await waitFor(() => expect(approves()).toHaveLength(1));
    const c = approves()[0]!;
    expect(c.headers.get('if-match')).toBe('"4"');
    expect(c.headers.get('authorization')).toBe('Bearer jwt-synthetic');
    expect(bodyOf(c)).toEqual({ attestation: true });
    expect(rejects()).toHaveLength(0);
  });

  it('done_when: success shows the approved Banner and, with lab.result.read, the "Open order results" link to the order results route', async () => {
    resetApi(APPROVER_RESULTS); mountSummary();
    routes[`POST ${APPROVE_URL}`] = json(approvedView());
    await showSummary();
    await confirmApprove();
    await waitFor(() => expect(pageText()).toContain(APPROVED_BANNER));
    const link = screen.getByRole('link', { name: /open order results/i });
    expect(link.getAttribute('href')).toBe(`/lab/orders/${ORDER_ID}/results`);
    expect(btn(/^approve$/i)).toBeNull(); // read-only once approved
  });

  it('without lab.result.read the approved banner has NO "Open order results" link', async () => {
    routes[`POST ${APPROVE_URL}`] = json(approvedView());
    await showSummary();
    await confirmApprove();
    await waitFor(() => expect(pageText()).toContain(APPROVED_BANNER));
    expect(screen.queryByRole('link', { name: /open order results/i })).toBeNull();
    expect(linkTo(`/lab/orders/${ORDER_ID}/results`)).toBeUndefined();
  });

  it('an already approved summary shows the approved banner on load; the link follows lab.result.read', async () => {
    mountSummary(approvedView());
    await showSummary();
    expect(pageText()).toContain(APPROVED_BANNER);
    expect(screen.queryByRole('link', { name: /open order results/i })).toBeNull();
    cleanup(); resetApi(APPROVER_RESULTS); mountSummary(approvedView());
    await showSummary();
    expect(screen.getByRole('link', { name: /open order results/i }).getAttribute('href')).toBe(`/lab/orders/${ORDER_ID}/results`);
  });

  it('double-clicking the confirm button sends ONE request (single flight)', async () => {
    routes[`POST ${APPROVE_URL}`] = async () => { await new Promise((r) => setTimeout(r, 150)); return HttpResponse.json(approvedView() as never); };
    await showSummary();
    await userEvent.click(approveBtn());
    await userEvent.dblClick(within(await dialog()).getByRole('button', { name: /^approve$/i }));
    await waitFor(() => expect(pageText()).toContain(APPROVED_BANNER));
    expect(approves()).toHaveLength(1);
  });
});

describe('AC-14.3 approve of a superseded draft', () => {
  it('409 smartreport.summary_superseded -> warning Banner with the exact words + a link back to the queue; nothing shown as approved', async () => {
    routes[`POST ${APPROVE_URL}`] = () => problem('smartreport.summary_superseded', 409);
    await showSummary();
    await confirmApprove();
    await waitFor(() => expect(pageText()).toContain(SUPERSEDED_BANNER));
    expect(screen.queryAllByRole('alert').some((a) => norm(a.textContent).includes(SUPERSEDED_BANNER))).toBe(true);
    expect(linkTo('/smartreport/summaries')).toBeTruthy();
    expect(pageText()).not.toContain(APPROVED_BANNER);
    expect(pageText()).not.toMatch(/smartreport\.summary_superseded/);
  });

  // review item 1: the page remounts on a version change (key vm.id:vm.version), so a refresh would wipe the banner in the real app.
  it('409 smartreport.summary_superseded does NOT call router.refresh (it would remount the page and wipe the banner)', async () => {
    routes[`POST ${APPROVE_URL}`] = () => problem('smartreport.summary_superseded', 409);
    await showSummary();
    router.refresh.mockClear();
    await confirmApprove();
    await waitFor(() => expect(pageText()).toContain(SUPERSEDED_BANNER));
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it('409 smartreport.summary_invalid_transition does NOT call router.refresh; common.version_conflict does', async () => {
    routes[`POST ${APPROVE_URL}`] = () => problem('smartreport.summary_invalid_transition', 409);
    await showSummary();
    router.refresh.mockClear();
    await confirmApprove();
    await waitFor(() => expect(screen.queryAllByRole('alert').length).toBeGreaterThan(0));
    expect(router.refresh).not.toHaveBeenCalled();
    cleanup();
    routes[`POST ${APPROVE_URL}`] = () => problem('common.version_conflict', 409);
    await showSummary();
    router.refresh.mockClear();
    await confirmApprove();
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
  });

  it('superseded summary view: read-only with a "Replaced by a newer summary" link to the successor', async () => {
    mountSummary(summaryView({ status: 'superseded', superseded_at: '2026-01-15T06:00:00.000Z', superseded_by_summary_id: NEWER_ID, superseded_reason: 'result_amended' }));
    await showSummary();
    const link = screen.getByRole('link', { name: /replaced by a newer summary/i });
    expect(link.getAttribute('href')).toBe(`/smartreport/summaries/${NEWER_ID}`);
    expect(pageText()).toMatch(/superseded/i);
  });
});

describe('AC-14.5 repeated approve / reject', () => {
  it('409 smartreport.summary_invalid_transition on approve -> alert in plain words, never the raw code, nothing shown as approved', async () => {
    routes[`POST ${APPROVE_URL}`] = () => problem('smartreport.summary_invalid_transition', 409);
    await showSummary();
    await confirmApprove();
    await waitFor(() => expect(screen.queryAllByRole('alert').length).toBeGreaterThan(0));
    expect(alertText()).not.toMatch(/smartreport\.|summary_invalid_transition|undefined/);
    expect(alertText().length).toBeGreaterThan(10);
    expect(pageText()).not.toContain(APPROVED_BANNER);
  });

  it('409 on reject -> alert in plain words, never the raw code', async () => {
    routes[`POST ${REJECT_URL}`] = () => problem('smartreport.summary_invalid_transition', 409);
    await showSummary();
    await userEvent.click(rejectBtn());
    await pick(/reason/i, /wording not appropriate/i);
    await userEvent.click(within(await dialog()).getByRole('button', { name: /^reject$/i }));
    await waitFor(() => expect(screen.queryAllByRole('alert').length).toBeGreaterThan(0));
    expect(alertText()).not.toMatch(/smartreport\.|summary_invalid_transition/);
  });

  it.each([['common.version_conflict', 409], ['auth.mfa_required', 403], ['common.internal', 500], ['common.dependency_unavailable', 503]])('%s on approve -> alert, no raw code, nothing approved, a second attempt sends again', async (code, status) => {
    routes[`POST ${APPROVE_URL}`] = () => problem(code, status);
    await showSummary();
    await confirmApprove();
    await waitFor(() => expect(screen.queryAllByRole('alert').length).toBeGreaterThan(0));
    expect(alertText()).not.toContain(code);
    expect(pageText()).not.toContain(APPROVED_BANNER);
    expect(btn(/^approve$/i)).toBeTruthy();
    await confirmApprove();
    await waitFor(() => expect(approves()).toHaveLength(2));
  });
});

describe('AC-14.4 reject', () => {
  it('the dialog offers exactly the coded-set reasons (#26) by display text and a comment box; nothing is sent yet', async () => {
    await showSummary();
    expect(callsTo('GET', REASONS_URL).length).toBeGreaterThan(0);
    await userEvent.click(rejectBtn());
    const d = await dialog();
    expect(within(d).getByRole('textbox', { name: /comment/i })).toBeTruthy();
    await userEvent.click(within(d).getByRole('button', { name: /reason/i }));
    const opts = (await screen.findAllByRole('option')).map((o) => norm(o.textContent));
    expect(opts).toEqual(['Wording not appropriate', 'Library rule or text error', 'Not appropriate for this patient', 'Results under review', 'Other']);
    expect(rejects()).toHaveLength(0);
  });

  it('Reject is blocked until a reason is chosen: no request', async () => {
    await showSummary();
    await userEvent.click(rejectBtn());
    await userEvent.click(within(await dialog()).getByRole('button', { name: /^reject$/i }));
    await new Promise((r) => setTimeout(r, 100));
    expect(rejects()).toHaveLength(0);
  });

  it('reason `other` requires a comment: without one no request; with one the body carries both', async () => {
    routes[`POST ${REJECT_URL}`] = json(summaryView({ status: 'rejected', version: 5 }));
    await showSummary();
    await userEvent.click(rejectBtn());
    await pick(/reason/i, /^other$/i);
    await userEvent.click(within(await dialog()).getByRole('button', { name: /^reject$/i }));
    await new Promise((r) => setTimeout(r, 100));
    expect(rejects()).toHaveLength(0);
    await userEvent.type(within(await dialog()).getByRole('textbox', { name: /comment/i }), 'Synthetic free text');
    await userEvent.click(within(await dialog()).getByRole('button', { name: /^reject$/i }));
    await waitFor(() => expect(rejects()).toHaveLength(1));
    expect(bodyOf(rejects()[0])).toEqual({ reason_code: 'other', comment: 'Synthetic free text' });
  });

  it('reason wording_problem -> POST /reject, If-Match "<row version>", bearer, body {reason_code} only; status shows rejected; read-only', async () => {
    routes[`POST ${REJECT_URL}`] = json(summaryView({ status: 'rejected', version: 5, rejected_at: '2026-01-15T05:30:00.000Z', rejected_by_display_name: 'Synthetic Pathologist', reject_reason_code: 'wording_problem',
      reviews: [{ action: 'rejected', actor_display_name: 'Synthetic Pathologist', reason_code: 'wording_problem', at: '2026-01-15T05:30:00.000Z' }] }));
    await showSummary();
    await userEvent.click(rejectBtn());
    await pick(/reason/i, /wording not appropriate/i);
    await userEvent.click(within(await dialog()).getByRole('button', { name: /^reject$/i }));
    await waitFor(() => expect(rejects()).toHaveLength(1));
    const c = rejects()[0]!;
    expect(c.headers.get('if-match')).toBe('"4"');
    expect(c.headers.get('authorization')).toBe('Bearer jwt-synthetic');
    expect(bodyOf(c)).toEqual({ reason_code: 'wording_problem' });
    expect(approves()).toHaveLength(0);
    await waitFor(() => expect(pageText()).toMatch(/rejected/i));
    expect(btn(/^approve$/i)).toBeNull();
    expect(btn(/^reject$/i)).toBeNull();
  });

  it('a comment over 500 characters is never sent in full (max 500)', async () => {
    routes[`POST ${REJECT_URL}`] = json(summaryView({ status: 'rejected', version: 5 }));
    await showSummary();
    await userEvent.click(rejectBtn());
    await pick(/reason/i, /^other$/i);
    await userEvent.click(within(await dialog()).getByRole('textbox', { name: /comment/i }));
    await userEvent.paste('c'.repeat(501));
    await userEvent.click(within(await dialog()).getByRole('button', { name: /^reject$/i }));
    await new Promise((r) => setTimeout(r, 100));
    for (const c of rejects()) expect(String(bodyOf(c).comment ?? '').length).toBeLessThanOrEqual(500);
  });

  it('a rejected summary loaded from the API shows a TEXT status and the reason display (not the raw code)', async () => {
    mountSummary(summaryView({ status: 'rejected', rejected_at: '2026-01-15T05:30:00.000Z', rejected_by_display_name: 'Synthetic Pathologist', reject_reason_code: 'wording_problem', reject_comment: 'Synthetic comment',
      reviews: [{ action: 'rejected', actor_display_name: 'Synthetic Pathologist', reason_code: 'wording_problem', at: '2026-01-15T05:30:00.000Z' }] }));
    await showSummary();
    expect(pageText()).toMatch(/rejected/i);
    expect(pageText()).toContain('Wording not appropriate');
    expect(pageText()).not.toContain('wording_problem');
  });
});

describe('AC-14.7 History timeline from reviews[] (done_when)', () => {
  it('approved then superseded: "Built", "Approved by <actor>", "Superseded — results changed" (no actor), oldest first', async () => {
    mountSummary(summaryView({ status: 'superseded', superseded_by_summary_id: NEWER_ID, superseded_at: '2026-01-16T08:00:00.000Z', reviews: [
      { action: 'approved', actor_display_name: 'Synthetic Pathologist', at: '2026-01-15T05:10:00.000Z' },
      { action: 'superseded', at: '2026-01-16T08:00:00.000Z' },
    ] }));
    await showSummary();
    const t = norm(history().textContent);
    const built = t.search(/built/i), appr = t.indexOf('Approved by Synthetic Pathologist'), sup = t.indexOf('Superseded — results changed');
    expect(built, 'Built').toBeGreaterThanOrEqual(0);
    expect(appr, 'Approved by').toBeGreaterThanOrEqual(0);
    expect(sup, 'Superseded').toBeGreaterThanOrEqual(0);
    expect([built, appr, sup]).toEqual([built, appr, sup].sort((a, b) => a - b));
    expect(t).not.toMatch(/superseded — results changed\s*by/i);
  });

  it('rejected: "Rejected by <actor> — <reason display>" from the coded set', async () => {
    mountSummary(summaryView({ status: 'rejected', reject_reason_code: 'library_error', reviews: [{ action: 'rejected', actor_display_name: 'Synthetic Pathologist', reason_code: 'library_error', at: '2026-01-15T05:30:00.000Z' }] }));
    await showSummary();
    expect(norm(history().textContent)).toContain('Rejected by Synthetic Pathologist — Library rule or text error');
  });

  it('llm_rephrase_requested: "AI rephrasing requested by <actor>"', async () => {
    mountSummary(summaryView({ reviews: [{ action: 'llm_rephrase_requested', actor_display_name: 'Synthetic Pathologist', at: '2026-01-15T05:00:00.000Z' }] }));
    await showSummary();
    expect(norm(history().textContent)).toContain('AI rephrasing requested by Synthetic Pathologist');
  });

  it('empty reviews[] -> only the "Built {time}" item', async () => {
    await showSummary();
    const t = norm(history().textContent);
    expect(t).toMatch(/built/i);
    expect(t).not.toMatch(/approved|rejected|superseded|rephras/i);
  });

  it('history is built from reviews[] only: no extra endpoint is called and a stray `comment` field is never shown', async () => {
    mountSummary(summaryView({ status: 'rejected', reject_reason_code: 'other', reviews: [{ action: 'rejected', actor_display_name: 'Synthetic Pathologist', reason_code: 'other', comment: 'SYNTHETIC-SECRET-COMMENT', at: '2026-01-15T05:30:00.000Z' }] }));
    await showSummary();
    expect(pageText()).not.toContain('SYNTHETIC-SECRET-COMMENT');
    for (const c of apiCalls()) expect(c.url.pathname).not.toMatch(/review|audit|history/);
  });

  it('a reason code missing from the coded set is shown as plain words, never as a raw snake_case code', async () => {
    mountSummary(summaryView({ status: 'rejected', reviews: [{ action: 'rejected', actor_display_name: 'Synthetic Pathologist', reason_code: 'retired_reason_code', at: '2026-01-15T05:30:00.000Z' }] }));
    await showSummary();
    expect(norm(history().textContent)).not.toContain('retired_reason_code');
  });
});

describe('accessibility', () => {
  it('no axe violations on the draft page (approver) and on the approved read-only page', async () => {
    await showSummary();
    await axeClean();
    cleanup(); mountSummary(approvedView());
    await showSummary();
    await axeClean();
  });

  it('the Approve dialog has no axe violations and returns focus to the trigger when cancelled', async () => {
    await showSummary();
    await userEvent.click(approveBtn());
    await axeClean();
    await userEvent.click(within(await dialog()).getByRole('button', { name: /cancel/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(approveBtn());
  });

  it('router is not driven by PHI: nothing navigates with a registration no or patient name', async () => {
    routes[`POST ${APPROVE_URL}`] = json(approvedView());
    await showSummary();
    await confirmApprove();
    await waitFor(() => expect(pageText()).toContain(APPROVED_BANNER));
    for (const [t] of [...router.push.mock.calls, ...router.replace.mock.calls]) expect(String(t)).not.toMatch(/SYN-000123|Synthetic%20Patient|Synthetic Patient/);
  });
});
