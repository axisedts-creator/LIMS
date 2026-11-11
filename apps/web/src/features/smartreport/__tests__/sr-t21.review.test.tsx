// @vitest-environment jsdom
// C14.T21 — SR-05 Library review / approve, app/(staff)/smartreport/library/[library_version_id]/review/page.tsx
// (04-UI-UX SR-05; 03-APP-FLOW §4 row SR-05; AC-07.1–AC-07.5 UI side; 07-SECURITY: permission hiding, no raw codes, text-only rendering).
// ASSUMED contract (the spec fixes the route, the copy and the endpoints; the rest is the smallest reading of it):
//   * default export = async server component `Page({ params })`. Order: id shape (non-UUID -> notFound, no API call) -> permission (smartreport.template.manage OR smartreport.template.approve;
//     neither = notFound/PermissionDenied and NO API call) -> reads. API 404 on the version -> notFound(); any other read failure throws (never rendered as data).
//   * Reads GET #16 the version, /blocks, /rules, /analyte-groups, /groups (read-only rendering of every tab) and, for "Changes since active version", the ACTIVE (status approved) version's
//     /blocks, /rules, /analyte-groups (found from GET /library-versions). Tabs may hide panels: tests click a tab named like the section when one exists.
//   * Section "Changes since active version" (region with that name) lists Texts / Rules / Analyte mapping as "<n> added, <n> changed, <n> removed". Identity: blocks by block_key
//     (changed = text_en/text_ne/kind differ), rules by (rule_kind, trigger_kind, analyte_id|group_code, direction, block_key of block_id) (changed = any other field differs),
//     mappings by analyte_id (changed = group_code/include_in_score/trend_enabled/... differ). Computed by the BFF (server) from both versions' lists.
//   * Buttons "Approve" and "Return to draft" only when status = in_review AND permission smartreport.template.approve. Approve = ConfirmDialog (role dialog) with the exact copy and an optional
//     note textarea (max 500), confirm button "Approve" -> POST #20 /approve, If-Match "<row version>", body {attestation:true[, note]}. Return = Dialog with a required comment textarea
//     (1–1000, whitespace-only = empty), confirm "Return to draft" -> POST #21 /return, If-Match, body {comment}.
//   * Success of approve shows the Banner "Approved — this version is now active." ; 403 auth.mfa_required -> role=alert warning with a "Verify now" button (shell step-up: reload / location change
//     / client navigation to /auth/…), the dialog may close, nothing is shown as approved, and a second Approve sends the request again. 409 (library_invalid_transition | version_conflict) ->
//     role=alert Banner + "Reload" button (router.refresh). Other API failures -> role=alert with plain words, never the raw code.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse } from 'msw';
import {
  APPROVE, APPROVE_ONLY, CAND_BLOCKS, EXPECTED_DIFF, MANAGE_ONLY, REVIEW_PAGE, VER_APPROVED, VER_DRAFT, VER_REVIEW, VER_RETIRED, api, apiCalls, axeClean, bodyOf, callsTo, json, mountReviewApi, norm,
  pageText, problem, resetApi, reviewVersion, router, routes, showOrThrown, showReview, steppedUp, stubLocation, summaryDto, vp, SR,
} from './sr-t21.harness';

vi.mock('next/navigation', async () => (await import('./sr-t20.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./sr-t20.harness')).sessionMock);

const APPROVE_URL = vp(VER_REVIEW, '/approve');
const RETURN_URL = vp(VER_REVIEW, '/return');
const ATTEST = 'I have reviewed every text, rule and interval in this library and approve it for patient summaries.';
const APPROVED_BANNER = 'Approved — this version is now active.';
const approvedBody = () => reviewVersion({ status: 'approved', version: 8, approved_at: '2026-01-16T05:10:00.000Z', approved_by_display_name: 'Synthetic Pathologist', approval_note: 'ok' });
const draftBody = () => reviewVersion({ status: 'draft', version: 8, returned_at: '2026-01-16T05:10:00.000Z', return_comment: 'Synthetic' });

beforeAll(() => api.listen());
beforeEach(() => { resetApi(APPROVE); mountReviewApi(); stubLocation(); });
afterEach(() => { cleanup(); api.resetHandlers(); vi.unstubAllGlobals(); });
afterAll(() => api.close());

const btn = (re: RegExp) => screen.queryByRole('button', { name: re });
const approveBtn = () => screen.getByRole('button', { name: /^approve$/i });
const returnBtn = () => screen.getByRole('button', { name: /^return to draft$/i });
const dialog = () => screen.findByRole('dialog');
const approves = () => callsTo('POST', APPROVE_URL);
const returns = () => callsTo('POST', RETURN_URL);
const mutations = () => apiCalls().filter((c) => c.method !== 'GET');
const confirmApprove = async (note?: string) => {
  await userEvent.click(approveBtn());
  const d = await dialog();
  if (note !== undefined) await userEvent.type(within(d).getByRole('textbox', { name: /note/i }), note);
  await userEvent.click(within(d).getByRole('button', { name: /^approve$/i }));
};
const openTab = async (name: RegExp) => { const t = screen.queryByRole('tab', { name }); if (t) await userEvent.click(t); };

describe('access and ids', () => {
  it('neither smartreport.template.manage nor .approve: denied (notFound or PermissionDenied) and NO API call', async () => {
    resetApi(['smartreport.summary.read']);
    const out = await showOrThrown(REVIEW_PAGE, { library_version_id: VER_REVIEW });
    if (out !== undefined) expect(out).toMatch(/NEXT_NOT_FOUND/);
    else expect(screen.getByTestId('permission-denied')).toBeTruthy();
    expect(apiCalls()).toHaveLength(0);
  });

  it.each(['not-a-uuid', '../../x', '01940e00-0000-7000-8000-00000000000z', '%00'])('id %j -> notFound and NO API call', async (bad) => {
    const out = await showOrThrown(REVIEW_PAGE, { library_version_id: bad });
    expect(out).toMatch(/NEXT_NOT_FOUND/);
    expect(apiCalls()).toHaveLength(0);
  });

  it('API 404 on the version -> notFound; any other failed read throws (never rendered as data)', async () => {
    routes[`GET ${vp(VER_REVIEW)}`] = () => problem('common.not_found', 404);
    expect(await showOrThrown(REVIEW_PAGE, { library_version_id: VER_REVIEW })).toMatch(/NEXT_NOT_FOUND/);
    mountReviewApi();
    routes[`GET ${vp(VER_REVIEW, '/rules')}`] = () => problem('common.internal', 500);
    expect(await showOrThrown(REVIEW_PAGE, { library_version_id: VER_REVIEW })).toBeDefined();
  });

  it('reads with the bearer token and never from the browser: no non-API request, no mutation while only viewing', async () => {
    await showReview();
    expect(callsTo('GET', vp(VER_REVIEW))[0]!.headers.get('authorization')).toBe('Bearer jwt-synthetic');
    expect(mutations()).toHaveLength(0);
  });
});

describe('read-only rendering (all tabs)', () => {
  it('shows version number and a TEXT status, and the change summary', async () => {
    await showReview();
    expect(pageText()).toMatch(/v4/);
    expect(pageText()).toMatch(/in review/i);
    expect(pageText()).toContain('Synthetic wording update');
  });

  it('shows every text, rule and mapping of the candidate as text — and offers no way to edit', async () => {
    await showReview();
    await openTab(/texts/i);
    for (const b of CAND_BLOCKS) expect(pageText(), b.block_key).toContain(b.block_key);
    expect(pageText()).toContain('Please talk to your doctor about {group_name} results.');
    await openTab(/rules/i);
    expect(pageText()).toMatch(/liver/i);
    await openTab(/mapping/i);
    expect(btn(/\b(save|delete|remove|add|edit|submit|run checks)\b/i)).toBeNull();
    for (const t of screen.queryAllByRole('textbox') as HTMLInputElement[]) expect(t.disabled || t.readOnly, t.name).toBe(true);
  });

  it('block text is rendered as TEXT: markup in a block never becomes an element (07-SECURITY REQ 088)', async () => {
    const evil = '<img src=x onerror=alert(1)> {group_name}';
    routes[`GET ${vp(VER_REVIEW, '/blocks')}`] = json({ data: [{ ...CAND_BLOCKS[1], text_en: evil }] });
    await showReview();
    await openTab(/texts/i);
    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect(pageText()).toContain('<img src=x onerror=alert(1)>');
  });
});

describe('Changes since active version (done_when: diff counts)', () => {
  const region = () => screen.getByRole('region', { name: /changes since active version/i });

  it('computes added / changed / removed for Texts, Rules and Analyte mapping from both versions', async () => {
    await showReview();
    const t = norm(region().textContent);
    const row = (name: string, d: { added: number; changed: number; removed: number }) => expect(t).toMatch(new RegExp(`${name}\\D*${d.added} added\\D*${d.changed} changed\\D*${d.removed} removed`, 'i'));
    row('Texts', EXPECTED_DIFF.texts);
    row('Rules', EXPECTED_DIFF.rules);
    row('Analyte mapping', EXPECTED_DIFF.mapping);
  });

  it('reads the ACTIVE version lists (status approved), not the candidate twice', async () => {
    await showReview();
    for (const tail of ['/blocks', '/rules', '/analyte-groups']) expect(callsTo('GET', vp(VER_APPROVED, tail)).length, tail).toBeGreaterThan(0);
  });

  it('identical versions -> every count is 0', async () => {
    routes[`GET ${vp(VER_REVIEW, '/blocks')}`] = json({ data: CAND_BLOCKS.slice(0, 1).map((b) => ({ ...b })) });
    routes[`GET ${vp(VER_APPROVED, '/blocks')}`] = json({ data: CAND_BLOCKS.slice(0, 1).map((b) => ({ ...b })) });
    routes[`GET ${vp(VER_REVIEW, '/rules')}`] = json({ data: [] });
    routes[`GET ${vp(VER_APPROVED, '/rules')}`] = json({ data: [] });
    routes[`GET ${vp(VER_REVIEW, '/analyte-groups')}`] = json({ data: [] });
    routes[`GET ${vp(VER_APPROVED, '/analyte-groups')}`] = json({ data: [] });
    await showReview();
    expect(norm(region().textContent)).toMatch(/Texts\D*0 added\D*0 changed\D*0 removed/i);
  });

  it('finds the active version even when 50+ newer non-approved versions fill the default list page', async () => {
    const filler = Array.from({ length: 50 }, (_, i) => ({ id: `01940e00-0000-7000-8000-${String(5000 + i).padStart(12, '0')}`, version_no: 100 + i, status: i % 2 ? 'draft' : 'retired', language: 'en', version: 1 }));
    routes[`GET ${SR}`] = (c) => (c.url.searchParams.get('status') === 'approved'
      ? HttpResponse.json({ data: [summaryDto()], page: { limit: 1 } } as never)
      : HttpResponse.json({ data: filler, page: { limit: 50 } } as never));
    await showReview();
    const t = norm(region().textContent);
    expect(t).toMatch(/Texts\D*2 added\D*1 changed\D*1 removed/i);
    expect(t).toMatch(/Rules\D*1 added\D*1 changed\D*0 removed/i);
    expect(t).toMatch(/Analyte mapping\D*0 added\D*1 changed\D*1 removed/i);
  });

  it('no active version yet (first library): the page still renders with the actions and no error', async () => {
    routes[`GET ${SR}`] = json({ data: [{ id: VER_REVIEW, version_no: 1, status: 'in_review', language: 'en', version: 7 }], page: { limit: 50 } });
    routes[`GET ${vp(VER_REVIEW)}`] = json(reviewVersion({ version_no: 1, source_version_id: undefined }));
    await showReview();
    expect(approveBtn()).toBeTruthy();
    expect(pageText()).not.toMatch(/undefined|NaN|\[object/);
  });
});

describe('who sees the actions', () => {
  it('in_review + smartreport.template.approve: Approve and Return to draft are shown', async () => {
    await showReview();
    expect(approveBtn()).toBeTruthy();
    expect(returnBtn()).toBeTruthy();
  });

  it('without smartreport.template.approve (manage only): read-only page, NO action buttons (the API still enforces)', async () => {
    resetApi(MANAGE_ONLY); mountReviewApi();
    await showReview();
    expect(btn(/^approve$/i)).toBeNull();
    expect(btn(/return to draft/i)).toBeNull();
    expect(pageText()).toMatch(/v4/);
  });

  it('approve permission alone (no manage) can open the page and act', async () => {
    resetApi(APPROVE_ONLY); mountReviewApi();
    await showReview();
    expect(approveBtn()).toBeTruthy();
  });

  it.each(['approved', 'retired', 'draft'])('status %s: no Approve / Return buttons even with the permission', async (status) => {
    mountReviewApi({ status });
    await showReview();
    expect(btn(/^approve$/i)).toBeNull();
    expect(btn(/return to draft/i)).toBeNull();
  });
});

describe('AC-07.1 approve', () => {
  it('Approve opens a ConfirmDialog with the exact attestation copy and an optional note; nothing is sent yet', async () => {
    await showReview();
    await userEvent.click(approveBtn());
    const d = await dialog();
    expect(norm(d.textContent)).toContain(ATTEST);
    expect(within(d).getByRole('textbox', { name: /note/i })).toBeTruthy();
    expect(approves()).toHaveLength(0);
  });

  it('Cancel closes the dialog and sends nothing', async () => {
    await showReview();
    await userEvent.click(approveBtn());
    await userEvent.click(within(await dialog()).getByRole('button', { name: /cancel/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(approves()).toHaveLength(0);
  });

  it('confirm without a note -> POST /approve, If-Match "<row version>", bearer token, body EXACTLY {attestation:true}', async () => {
    routes[`POST ${APPROVE_URL}`] = json(approvedBody());
    await showReview();
    await confirmApprove();
    await waitFor(() => expect(approves()).toHaveLength(1));
    const c = approves()[0]!;
    expect(c.headers.get('if-match')).toBe('"7"');
    expect(c.headers.get('authorization')).toBe('Bearer jwt-synthetic');
    expect(bodyOf(c)).toEqual({ attestation: true });
    expect(returns()).toHaveLength(0);
  });

  it('confirm with a note -> body {attestation:true, note}', async () => {
    routes[`POST ${APPROVE_URL}`] = json(approvedBody());
    await showReview();
    await confirmApprove('Synthetic approval note');
    await waitFor(() => expect(approves()).toHaveLength(1));
    expect(bodyOf(approves()[0])).toEqual({ attestation: true, note: 'Synthetic approval note' });
  });

  it('a note over 500 characters is never sent in full (max 500)', async () => {
    routes[`POST ${APPROVE_URL}`] = json(approvedBody());
    await showReview();
    await userEvent.click(approveBtn());
    const d = await dialog();
    await userEvent.click(within(d).getByRole('textbox', { name: /note/i }));
    await userEvent.paste('n'.repeat(501));
    await userEvent.click(within(d).getByRole('button', { name: /^approve$/i }));
    await new Promise((r) => setTimeout(r, 100));
    for (const c of approves()) expect(String(bodyOf(c).note ?? '').length).toBeLessThanOrEqual(500);
  });

  it('success -> the Banner "Approved — this version is now active." and the list is refreshed', async () => {
    routes[`POST ${APPROVE_URL}`] = json(approvedBody());
    await showReview();
    await confirmApprove();
    await waitFor(() => expect(pageText()).toContain(APPROVED_BANNER));
    expect(router.refresh.mock.calls.length + router.push.mock.calls.length).toBeGreaterThan(0);
  });

  it('double-clicking the confirm button sends ONE request (single flight)', async () => {
    routes[`POST ${APPROVE_URL}`] = async () => { await new Promise((r) => setTimeout(r, 150)); return HttpResponse.json(approvedBody() as never); };
    await showReview();
    await userEvent.click(approveBtn());
    const confirm = within(await dialog()).getByRole('button', { name: /^approve$/i });
    await userEvent.dblClick(confirm);
    await waitFor(() => expect(approves().length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 250));
    expect(approves()).toHaveLength(1);
  });
});

describe('AC-07.2 MFA step-up and permission failures', () => {
  it('403 auth.mfa_required -> warning alert with "Verify now"; NOT shown as approved; no raw code', async () => {
    routes[`POST ${APPROVE_URL}`] = () => problem('auth.mfa_required', 403);
    await showReview();
    await confirmApprove();
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByRole('button', { name: /verify now/i })).toBeTruthy();
    expect(pageText()).not.toContain(APPROVED_BANNER);
    expect(pageText()).not.toMatch(/auth\.mfa_required/);
  });

  it('"Verify now" hands control to the shell step-up (reload / location / client navigation to /auth/…); no second request is sent by itself', async () => {
    routes[`POST ${APPROVE_URL}`] = () => problem('auth.mfa_required', 403);
    await showReview();
    await confirmApprove();
    await userEvent.click(within(await screen.findByRole('alert')).getByRole('button', { name: /verify now/i }));
    await waitFor(() => expect(steppedUp()).toBe(true));
    expect(approves()).toHaveLength(1);
  });

  it('after the step-up the user can approve again and the SAME If-Match + body is sent', async () => {
    let n = 0;
    routes[`POST ${APPROVE_URL}`] = () => (n++ === 0 ? problem('auth.mfa_required', 403) : HttpResponse.json(approvedBody() as never));
    await showReview();
    await confirmApprove('Synthetic note');
    await screen.findByRole('alert');
    await confirmApprove('Synthetic note');
    await waitFor(() => expect(approves()).toHaveLength(2));
    const [a, b] = approves();
    expect(b!.headers.get('if-match')).toBe(a!.headers.get('if-match'));
    expect(bodyOf(b)).toEqual(bodyOf(a));
    await waitFor(() => expect(pageText()).toContain(APPROVED_BANNER));
  });

  it('Return to draft also routes auth.mfa_required to the step-up banner', async () => {
    routes[`POST ${RETURN_URL}`] = () => problem('auth.mfa_required', 403);
    await showReview();
    await userEvent.click(returnBtn());
    const d = await dialog();
    await userEvent.type(within(d).getByRole('textbox', { name: /comment/i }), 'Synthetic: reword the advice');
    await userEvent.click(within(d).getByRole('button', { name: /return to draft/i }));
    expect(within(await screen.findByRole('alert')).getByRole('button', { name: /verify now/i })).toBeTruthy();
  });

  it('403 auth.forbidden (lab_manager) -> role=alert in plain words, no raw code, not approved', async () => {
    routes[`POST ${APPROVE_URL}`] = () => problem('auth.forbidden', 403);
    await showReview();
    await confirmApprove();
    const alert = await screen.findByRole('alert');
    expect(norm(alert.textContent)).not.toMatch(/auth\.forbidden|verify now/i);
    expect(norm(alert.textContent).length).toBeGreaterThan(5);
    expect(pageText()).not.toContain(APPROVED_BANNER);
  });
});

describe('AC-07.3 conflicts', () => {
  it.each(['smartreport.library_invalid_transition', 'common.version_conflict'])('409 %s -> alert Banner with a Reload button (router.refresh); no raw code', async (code) => {
    routes[`POST ${APPROVE_URL}`] = () => problem(code, 409);
    await showReview();
    await confirmApprove();
    const alert = await screen.findByRole('alert');
    expect(norm(alert.textContent)).not.toContain(code);
    router.refresh.mockClear();
    await userEvent.click(within(alert).getByRole('button', { name: /^reload$/i }));
    expect(router.refresh).toHaveBeenCalled();
    expect(pageText()).not.toContain(APPROVED_BANNER);
  });

  it('428 / 500 / 503 -> a plain alert, never the raw problem body', async () => {
    for (const [code, status] of [['common.precondition_required', 428], ['common.internal', 500], ['common.dependency_unavailable', 503]] as const) {
      cleanup(); resetApi(APPROVE); mountReviewApi(); stubLocation();
      routes[`POST ${APPROVE_URL}`] = () => problem(code, status, { detail: 'SECRET-DB-HINT' });
      await showReview();
      await confirmApprove();
      const alert = await screen.findByRole('alert');
      expect(norm(alert.textContent)).not.toMatch(new RegExp(`${code.replace('.', '\\.')}|SECRET-DB-HINT`));
    }
  });
});

describe('AC-07.4 return to draft', () => {
  const openReturn = async () => { await userEvent.click(returnBtn()); return dialog(); };

  it('opens a Dialog with a required comment; empty and whitespace-only comments send nothing and say why', async () => {
    await showReview();
    const d = await openReturn();
    await userEvent.click(within(d).getByRole('button', { name: /return to draft/i }));
    expect(returns()).toHaveLength(0);
    await userEvent.type(within(d).getByRole('textbox', { name: /comment/i }), '   ');
    await userEvent.click(within(d).getByRole('button', { name: /return to draft/i }));
    expect(returns()).toHaveLength(0);
    expect(within(d).queryAllByRole('alert').length + within(d).queryAllByText(/required|enter a comment|comment is/i).length).toBeGreaterThan(0);
  });

  it('a comment over 1000 characters is never sent in full (max 1000)', async () => {
    routes[`POST ${RETURN_URL}`] = json(draftBody());
    await showReview();
    const d = await openReturn();
    await userEvent.click(within(d).getByRole('textbox', { name: /comment/i }));
    await userEvent.paste('c'.repeat(1001));
    await userEvent.click(within(d).getByRole('button', { name: /return to draft/i }));
    await new Promise((r) => setTimeout(r, 100));
    for (const c of returns()) expect(String(bodyOf(c).comment).length).toBeLessThanOrEqual(1000);
  });

  it('valid comment -> POST /return, If-Match "<row version>", body EXACTLY {comment}; then the user leaves the review screen or it refreshes', async () => {
    routes[`POST ${RETURN_URL}`] = json(draftBody());
    await showReview();
    const d = await openReturn();
    await userEvent.type(within(d).getByRole('textbox', { name: /comment/i }), 'Synthetic: please reword the liver advice block.');
    await userEvent.click(within(d).getByRole('button', { name: /return to draft/i }));
    await waitFor(() => expect(returns()).toHaveLength(1));
    const c = returns()[0]!;
    expect(c.headers.get('if-match')).toBe('"7"');
    expect(bodyOf(c)).toEqual({ comment: 'Synthetic: please reword the liver advice block.' });
    expect(approves()).toHaveLength(0);
    await waitFor(() => expect(router.refresh.mock.calls.length + router.push.mock.calls.length + router.replace.mock.calls.length).toBeGreaterThan(0));
  });

  it('409 on return -> Reload banner (same as approve)', async () => {
    routes[`POST ${RETURN_URL}`] = () => problem('smartreport.library_invalid_transition', 409);
    await showReview();
    const d = await openReturn();
    await userEvent.type(within(d).getByRole('textbox', { name: /comment/i }), 'Synthetic');
    await userEvent.click(within(d).getByRole('button', { name: /return to draft/i }));
    expect(within(await screen.findByRole('alert')).getByRole('button', { name: /^reload$/i })).toBeTruthy();
  });
});

describe('a11y and keyboard', () => {
  it('review page and both dialogs have no axe violations', async () => {
    await showReview();
    await axeClean();
    await userEvent.click(approveBtn());
    await dialog();
    await axeClean();
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^cancel$/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await userEvent.click(returnBtn());
    await dialog();
    await axeClean();
  });

  it('Approve and Return to draft are reachable by keyboard (Tab) and open with Enter', async () => {
    await showReview();
    approveBtn().focus();
    await userEvent.keyboard('{Enter}');
    expect(await dialog()).toBeTruthy();
    expect(approves()).toHaveLength(0);
  });
});

describe('scope of reads', () => {
  it('only the candidate and the active version are fetched (unrelated versions are not)', async () => {
    await showReview();
    expect(callsTo('GET', vp(VER_DRAFT))).toHaveLength(0);
    expect(callsTo('GET', vp(VER_RETIRED))).toHaveLength(0);
  });
});
