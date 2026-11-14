// @vitest-environment jsdom
// C9.T-21 — QC run detail `/quality/qc-runs/{qc_run_id}` (04-UI-UX §2.3; 03-APP-FLOW §4; AC-07.4; 07-SECURITY: actions need quality.qc_run.review).
// ASSUMED contract: app/(staff)/quality/qc-runs/[qc_run_id]/page.tsx = default async server component `Page({ params })`; reads GET /v1/quality/qc-runs/{id};
//   malformed id -> notFound() with NO API call; API 404 -> the copy "This QC run doesn't exist or isn't in your lab." (rendered by the page or by a not-found.tsx beside it).
//   Actions are server actions -> serverFetch -> MSW observes: POST …/evaluate {comment?}, …/corrective-actions {action_code, description, performed_at},
//   …/close {comment?}, …/acknowledge {comment}; every POST has an Idempotency-Key; evaluate/close/acknowledge send If-Match "<run.version>".
//   Buttons are real <button>s named as in 04-UI-UX; shortcuts E / C / A (04-UI-UX §2.3) are registered while the page is mounted; Esc closes dialogs.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse } from 'msw';
import {
  RUN_1, api, axeClean, bodyOf, calls, callsTo, has, json, pageText, problem, read, resetApi, routes, router, runDto, show, statusRow, showOrThrown, PERM_MANAGE, PERM_READ, PERM_REVIEW, obsId,
} from './quality-t21.harness';

vi.mock('next/navigation', async () => (await import('./quality-t21.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./quality-t21.harness')).sessionMock);

const PAGE = 'qc-runs/[qc_run_id]/page';
const RUN = `/v1/quality/qc-runs/${RUN_1}`;
const props = (id = RUN_1) => ({ params: { qc_run_id: id } });
const COPY_404 = "This QC run doesn't exist or isn't in your lab.";
const user = () => userEvent.setup();
const btn = (re: RegExp) => screen.queryByRole('button', { name: re });
const anyDialog = () => screen.queryByRole('dialog') ?? screen.queryByRole('alertdialog');
const dialog = () => { const d = anyDialog(); if (!d) throw new Error('no dialog is open'); return d; };

const rejected = () => runDto();
const collecting = () => runDto({ status: 'collecting', outcome: undefined, needs_action: false, needs_action_reason: undefined, rules_violated: [], is_complete: false, observation_count: 1, hold: undefined, evaluated_at: undefined, evaluated_by: undefined, observations: [] });
const warning = () => runDto({ status: 'evaluated', outcome: 'accepted_warning', rules_violated: [], warning_rules: ['1-2s'], needs_action: false, needs_action_reason: undefined, hold: undefined });
const closed = () => runDto({ status: 'closed', closed_at: '2026-11-14T05:00:00.000Z', needs_action: false, needs_action_reason: undefined });

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { resetApi(PERM_REVIEW); routes[`GET ${RUN}`] = json(rejected()); });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

async function expect404(p: ReturnType<typeof props>) {
  const err = await showOrThrown(PAGE, p);
  if (err) {
    expect(err).toMatch(/NEXT_NOT_FOUND/);
    const f = [['qc-runs', '[qc_run_id]', 'not-found.tsx'], ['qc-runs', 'not-found.tsx'], ['not-found.tsx']].find((s) => has(...s));
    expect(f, 'a not-found.tsx carrying the copy').toBeTruthy();
    expect(read(...f!)).toContain(COPY_404);
  } else expect(pageText()).toContain(COPY_404);
}

describe('access and errors', () => {
  it('without quality.qc_run.read: permission-denied state, NO API call', async () => {
    resetApi([]);
    await show(PAGE, props());
    expect(pageText()).toMatch(/You don't have access to this page/);
    expect(calls).toHaveLength(0);
  });
  it('API 404 -> the exact "doesn\'t exist or isn\'t in your lab" copy (another tenant looks identical)', async () => {
    routes[`GET ${RUN}`] = () => problem('common.not_found', 404);
    await expect404(props());
  });
  it.each(['../x', 'not-a-uuid', ''])('malformed id %j -> not found and NO API call', async (id) => {
    await expect404(props(id));
    expect(calls).toHaveLength(0);
  });
  it('API 5xx rejects (error.tsx)', async () => {
    routes[`GET ${RUN}`] = () => problem('common.internal', 500);
    expect(await showOrThrown(PAGE, props())).toBeTruthy();
  });
});

describe('content (04-UI-UX §2.3)', () => {
  it('title, status chip words, DescriptionList facts, hold and rejected banner', async () => {
    // LD-178: QcRunDto has no analyte_code/instrument_label (quality.yaml:6589/:6672); the page resolves PLAN_1 via GET /v1/quality/qc-status (QcStatusRowDto, :6884).
    routes['GET /v1/quality/qc-status'] = json({ data: [statusRow()], page: { limit: 50 } });
    await show(PAGE, props());
    expect(screen.getByRole('heading', { level: 1 }).textContent).toMatch(/QC run · GLU/);
    const t = pageText();
    for (const w of ['Rejected', 'Plan version', '3', 'Classic', 'Hold since', 'Last in-control run']) expect(t).toContain(w);
    expect(t).toMatch(/This run was rejected \(1-3s\)\. Patient results for GLU on .* since .* were put on hold in Lab\./);
  });
  it('observation table: level, lot, value + unit, z with 2 decimals, rule hits as text, status word; no patient identifiers', async () => {
    await show(PAGE, props());
    const g = screen.getAllByRole('grid').find((x) => /observations/i.test(x.getAttribute('aria-label') ?? ''))!;
    expect(g).toBeTruthy();
    const t = within(g).getAllByRole('row').slice(1).map((r) => (r.textContent ?? '').replace(/\s+/g, ' '));
    expect(t[0]).toContain('SYN-LOT-001');
    expect(t[0]).toContain('106.4');
    expect(t[0]).toContain('3.20');
    expect(t[0]).not.toContain('3.200');
    expect(t[0]).toContain('1-3s');
    expect(pageText()).not.toMatch(/patient name|barcode|registration no/i);
  });
  it('corrective actions and reviews render as timelines with who/when', async () => {
    routes[`GET ${RUN}`] = json(runDto({
      corrective_actions: [{ id: obsId(500), qc_run_id: RUN_1, action_code: 'recalibrated', action_display: 'Recalibrated', description: 'Synthetic: recalibrated the analyser', performed_at: '2026-11-14T04:00:00.000Z', performed_by_display: 'Synthetic Reviewer', created_at: '2026-11-14T04:01:00.000Z' }],
      reviews: [{ id: obsId(501), qc_run_id: RUN_1, kind: 'evaluate_now', comment: 'third control not coming', reviewed_by_display: 'Synthetic Reviewer', created_at: '2026-11-14T03:30:00.000Z' }],
    }));
    await show(PAGE, props());
    expect(pageText()).toContain('Recalibrated');
    expect(pageText()).toContain('Synthetic: recalibrated the analyser');
    expect(pageText()).toContain('third control not coming');
  });
  it('axe clean', async () => { await show(PAGE, props()); await axeClean(); });
});

describe('actions by state and permission (03-APP-FLOW §4)', () => {
  it.each([
    ['collecting', collecting, { evaluate: true, corrective: false, close: false, ack: false }],
    ['rejected', rejected, { evaluate: false, corrective: true, close: true, ack: false }],
    ['accepted_warning', warning, { evaluate: false, corrective: false, close: false, ack: true }],
    ['closed', closed, { evaluate: false, corrective: false, close: false, ack: false }],
  ])('%s run offers exactly the right buttons', async (_n, make, want) => {
    routes[`GET ${RUN}`] = json(make());
    await show(PAGE, props());
    expect(!!btn(/evaluate now/i)).toBe(want.evaluate);
    expect(!!btn(/record corrective action/i)).toBe(want.corrective);
    expect(!!btn(/close run/i)).toBe(want.close);
    expect(!!btn(/acknowledge/i)).toBe(want.ack);
  });

  it('without quality.qc_run.review the page is read-only: no action buttons, shortcuts do nothing', async () => {
    resetApi(PERM_READ);
    routes[`GET ${RUN}`] = json(rejected());
    await show(PAGE, props());
    expect(btn(/evaluate now|record corrective action|close run|acknowledge/i)).toBeNull();
    await user().keyboard('c');
    expect(anyDialog()).toBeNull();
  });
});

describe('evaluate now (#30)', () => {
  beforeEach(() => { routes[`GET ${RUN}`] = json(collecting()); routes[`POST ${RUN}/evaluate`] = json(runDto()); });

  it('ConfirmDialog states n of N controls; confirming POSTs {comment} with Idempotency-Key and If-Match "<version>", then refreshes with a toast', async () => {
    const u = user();
    await show(PAGE, props());
    await u.click(btn(/evaluate now/i)!);
    expect(dialog().textContent).toMatch(/Evaluate this run with 1 of 2 controls\? It will be marked incomplete if no rule is violated\./);
    await u.type(within(dialog()).getByRole('textbox'), 'third control not coming');
    await u.click(within(dialog()).getByRole('button', { name: /evaluate/i }));
    await waitFor(() => expect(callsTo('POST', `${RUN}/evaluate`)).toHaveLength(1));
    const c = callsTo('POST', `${RUN}/evaluate`)[0]!;
    expect(bodyOf(c)).toEqual({ comment: 'third control not coming' });
    expect(c.headers.get('idempotency-key')).toMatch(/\S{8,}/);
    expect(c.headers.get('if-match')).toBe('"2"');
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
  });

  it('comment longer than 500 characters is refused in the form (capped at 500)', async () => {
    // LD-178: TextArea max 500 (04-UI-UX.md:71); kit sets native maxLength (TextInputBase.tsx:65), so a 501-char paste is cut to 500 and that request is valid.
    const u = user();
    await show(PAGE, props());
    await u.click(btn(/evaluate now/i)!);
    const box = within(dialog()).getByRole('textbox') as HTMLTextAreaElement;
    await u.click(box);
    await u.paste('x'.repeat(501));
    expect(box.value.length).toBe(500);
    await u.click(within(dialog()).getByRole('button', { name: /evaluate/i }));
    await new Promise((r) => setTimeout(r, 50));
    for (const c of callsTo('POST', `${RUN}/evaluate`)) expect(String(bodyOf(c)?.comment ?? '').length).toBeLessThanOrEqual(500);
  });

  it('keyboard: E opens the dialog, Esc closes it without any request', async () => {
    const u = user();
    await show(PAGE, props());
    await u.keyboard('e');
    expect(anyDialog()).not.toBeNull();
    await u.keyboard('{Escape}');
    expect(anyDialog()).toBeNull();
    expect(callsTo('POST', `${RUN}/evaluate`)).toHaveLength(0);
  });

  it('409 quality.qc_run_already_evaluated is shown as text in the dialog, not swallowed', async () => {
    routes[`POST ${RUN}/evaluate`] = () => problem('quality.qc_run_already_evaluated', 409);
    const u = user();
    await show(PAGE, props());
    await u.click(btn(/evaluate now/i)!);
    await u.click(within(dialog()).getByRole('button', { name: /evaluate/i }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/already|evaluated/i));
  });
});

describe('record corrective action (#31)', () => {
  beforeEach(() => { routes[`POST ${RUN}/corrective-actions`] = () => HttpResponse.json({ id: obsId(600), qc_run_id: RUN_1, action_code: 'recalibrated', action_display: 'Recalibrated', description: 'd', performed_at: '2026-11-14T04:00:00.000Z', performed_by_display: 'x', created_at: '2026-11-14T04:00:00.000Z' }, { status: 201 }); });

  it('fields: coded Action (from quality.corrective_actions), Description 1–1000, Performed at; submitting POSTs {action_code, description, performed_at}', async () => {
    const u = user();
    await show(PAGE, props());
    await u.click(btn(/record corrective action/i)!);
    const d = dialog();
    expect(callsTo('GET', '/v1/quality/coded-sets/corrective_actions').length).toBeGreaterThan(0);
    await u.click(within(d).getByRole('button', { name: /action/i }) /* LD-178: CodedSelect trigger is a button (Select.tsx:53) */);
    await u.click(await screen.findByRole('option', { name: 'Recalibrated' }));
    await u.type(within(d).getByRole('textbox', { name: /description/i }), 'Synthetic: recalibrated');
    await u.click(within(d).getByRole('button', { name: /^(save|record)/i }));
    await waitFor(() => expect(callsTo('POST', `${RUN}/corrective-actions`)).toHaveLength(1));
    const c = callsTo('POST', `${RUN}/corrective-actions`)[0]!;
    const b = bodyOf(c);
    expect(b.action_code).toBe('recalibrated');
    expect(b.description).toBe('Synthetic: recalibrated');
    expect(Number.isNaN(Date.parse(b.performed_at))).toBe(false);
    expect(Object.keys(b).sort()).toEqual(['action_code', 'description', 'performed_at']);
    expect(c.headers.get('idempotency-key')).toBeTruthy();
  });

  it('required fields: empty submit sends nothing and shows an error summary; Ctrl+Enter submits an otherwise valid form', async () => {
    const u = user();
    await show(PAGE, props());
    await u.keyboard('c');
    await u.click(within(dialog()).getByRole('button', { name: /^(save|record)/i }));
    expect(callsTo('POST', `${RUN}/corrective-actions`)).toHaveLength(0);
    expect(pageText()).toMatch(/required|enter|choose|select/i);
  });

  it('description > 1000 characters is refused without a request', async () => {
    const u = user();
    await show(PAGE, props());
    await u.keyboard('c');
    await u.click(within(dialog()).getByRole('textbox', { name: /description/i }));
    await u.paste('y'.repeat(1001));
    await u.click(within(dialog()).getByRole('button', { name: /^(save|record)/i }));
    await new Promise((r) => setTimeout(r, 50));
    expect(callsTo('POST', `${RUN}/corrective-actions`)).toHaveLength(0);
  });
});

describe('close run (#32) — AC-07.4', () => {
  beforeEach(() => { routes[`POST ${RUN}/close`] = json(closed()); });

  it('AC-07.4: closing POSTs with If-Match and the success toast says held results stay on hold until released in Lab › Settings › QC holds', async () => {
    const u = user();
    await show(PAGE, props());
    await u.click(btn(/close run/i)!);
    await u.click(within(dialog()).getByRole('button', { name: /close run|close|confirm/i }));
    await waitFor(() => expect(callsTo('POST', `${RUN}/close`)).toHaveLength(1));
    const c = callsTo('POST', `${RUN}/close`)[0]!;
    expect(c.headers.get('if-match')).toBe('"2"');
    expect(c.headers.get('idempotency-key')).toBeTruthy();
    await waitFor(() => expect(pageText()).toContain('Run closed. Patient results held by this failure stay on hold until released in Lab › Settings › QC holds.'));
    expect(router.refresh).toHaveBeenCalled();
  });

  it.each([
    ['quality.corrective_action_required', 'Record a corrective action first.'],
    ['quality.rerun_required', 'Run QC again and wait for an accepted run before closing.'],
  ])('409 %s shows the plain-language text and keeps the page usable', async (code, copy) => {
    routes[`POST ${RUN}/close`] = () => problem(code, 409);
    const u = user();
    await show(PAGE, props());
    await u.click(btn(/close run/i)!);
    await u.click(within(dialog()).getByRole('button', { name: /close run|close|confirm/i }));
    await waitFor(() => expect(pageText()).toContain(copy));
    expect(pageText()).not.toContain(code);
  });

  it('409 common.version_conflict (E11) is reported, never shown as success', async () => {
    routes[`POST ${RUN}/close`] = () => problem('common.version_conflict', 409);
    const u = user();
    await show(PAGE, props());
    await u.click(btn(/close run/i)!);
    await u.click(within(dialog()).getByRole('button', { name: /close run|close|confirm/i }));
    await waitFor(() => expect(callsTo('POST', `${RUN}/close`)).toHaveLength(1));
    expect(pageText()).not.toContain('Run closed.');
  });

  it('double-clicking the confirm button sends ONE request', async () => {
    const u = user();
    await show(PAGE, props());
    await u.click(btn(/close run/i)!);
    const ok = within(dialog()).getByRole('button', { name: /close run|close|confirm/i });
    await Promise.all([u.click(ok), u.click(ok)]).catch(() => undefined);
    await waitFor(() => expect(callsTo('POST', `${RUN}/close`).length).toBeGreaterThan(0));
    expect(callsTo('POST', `${RUN}/close`)).toHaveLength(1);
  });
});

describe('acknowledge (#33)', () => {
  beforeEach(() => { routes[`GET ${RUN}`] = json(warning()); routes[`POST ${RUN}/acknowledge`] = json(warning()); });

  it('comment is required (1–500); A opens the dialog; submit POSTs {comment} with If-Match', async () => {
    const u = user();
    await show(PAGE, props());
    await u.keyboard('a');
    const d = dialog();
    await u.click(within(d).getByRole('button', { name: /acknowledge|save|confirm/i }));
    expect(callsTo('POST', `${RUN}/acknowledge`)).toHaveLength(0); // empty comment refused
    await u.type(within(d).getByRole('textbox'), 'Seen, within tolerance');
    await u.keyboard('{Control>}{Enter}{/Control}'); // Ctrl+Enter submits the open form
    await waitFor(() => expect(callsTo('POST', `${RUN}/acknowledge`)).toHaveLength(1));
    expect(bodyOf(callsTo('POST', `${RUN}/acknowledge`)[0])).toEqual({ comment: 'Seen, within tolerance' });
    expect(callsTo('POST', `${RUN}/acknowledge`)[0]!.headers.get('if-match')).toBe('"2"');
  });
});

describe('keyboard help', () => {
  it('"?" opens the KeyboardShortcutsDialog listing E / C / A for this page; Esc closes it', async () => {
    resetApi(PERM_MANAGE);
    routes[`GET ${RUN}`] = json(rejected());
    const u = user();
    await show(PAGE, props());
    await u.keyboard('?');
    const d = anyDialog();
    expect(d).not.toBeNull();
    expect(d!.textContent).toMatch(/record corrective action/i);
    await u.keyboard('{Escape}');
    expect(anyDialog()).toBeNull();
  });
});
