// @vitest-environment jsdom
// C14.T21 — Preview dialog on SR-04 "Check & submit" (04-UI-UX SR-04 "Preview"; 03-APP-FLOW §2.7 and §4 "Preview dialog" row; AC-19.1, AC-19.2 UI side; 07-SECURITY: order id never in a URL).
// ASSUMED contract (spec fixes the controls, the endpoint and the copy):
//   * On the draft editor's "Check & submit" tab a button "Preview" opens a Dialog. RadioGroup "Synthetic example" (always) / "Real order" (only with lab.result.read).
//     Synthetic = a fixture choice (default synthetic_basic); the dialog's run button (name Run preview | Generate preview | Show preview | Preview) POSTs #22 /preview, body EXACTLY
//     {fixture_code:'synthetic_basic'} or {order_id:'<uuid>'}; no If-Match, bearer token; a non-UUID order id sends nothing. Nothing else is written (no other POST/PUT/PATCH/DELETE).
//   * The returned SmartSummaryPreview is rendered as TEXT: score value + band word, panel display names with a TEXT status, deranged / advice / follow-up / disclaimer texts and the
//     score explanation. 422 smartreport.no_eligible_results -> "Not enough mapped results in this order to build a summary." Other failures -> role=alert, no raw code.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse } from 'msw';
import {
  MANAGE, MANAGE_READ, ORDER_ID, PREVIEW, VER_DRAFT, api, apiCalls, axeClean, bodyOf, callsTo, json, mountEditorApi, norm, pageText, problem, resetApi, router, routes, showEditor, vp,
} from './sr-t21.harness';

vi.mock('next/navigation', async () => (await import('./sr-t20.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./sr-t20.harness')).sessionMock);

const URL_PREVIEW = vp(VER_DRAFT, '/preview');
const NO_ORDER = 'Not enough mapped results in this order to build a summary.';

beforeAll(() => api.listen());
beforeEach(() => { resetApi(MANAGE); mountEditorApi(); routes[`POST ${URL_PREVIEW}`] = json(PREVIEW); });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const previews = () => callsTo('POST', URL_PREVIEW);
const writes = () => apiCalls().filter((c) => c.method !== 'GET' && !(c.method === 'POST' && c.url.pathname.endsWith('/preview')));
const open = async () => {
  await showEditor(VER_DRAFT);
  await userEvent.click(screen.getByRole('tab', { name: /check & submit/i }));
  await userEvent.click(screen.getByRole('button', { name: /^preview$/i }));
  return screen.findByRole('dialog');
};
const run = (d: HTMLElement) => userEvent.click(within(d).getByRole('button', { name: /^(run preview|generate preview|show preview|preview)$/i }));

describe('opening', () => {
  it('Preview is on the Check & submit tab; the dialog offers "Synthetic example" selected by default and, WITHOUT lab.result.read, no "Real order" (AC-19.2 UI)', async () => {
    const d = await open();
    const synth = within(d).getByRole('radio', { name: /synthetic example/i }) as HTMLInputElement;
    expect(synth.checked).toBe(true);
    expect(within(d).queryByRole('radio', { name: /real order/i })).toBeNull();
    expect(previews()).toHaveLength(0);
  });

  it('WITH lab.result.read the "Real order" choice is offered', async () => {
    resetApi(MANAGE_READ); mountEditorApi(); routes[`POST ${URL_PREVIEW}`] = json(PREVIEW);
    const d = await open();
    expect(within(d).getByRole('radio', { name: /real order/i })).toBeTruthy();
  });
});

describe('AC-19.1 synthetic preview', () => {
  it('Run -> POST /preview with body EXACTLY {fixture_code:"synthetic_basic"}, bearer token, no If-Match; nothing else is written', async () => {
    const d = await open();
    await run(d);
    await waitFor(() => expect(previews()).toHaveLength(1));
    const c = previews()[0]!;
    expect(bodyOf(c)).toEqual({ fixture_code: 'synthetic_basic' });
    expect(c.headers.get('authorization')).toBe('Bearer jwt-synthetic');
    expect(c.headers.get('if-match')).toBeNull();
    expect(writes()).toHaveLength(0);
  });

  it('renders the summary: score + band word, panel names with a TEXT status, deranged / advice / follow-up / disclaimer / explanation texts', async () => {
    const d = await open();
    await run(d);
    await waitFor(() => expect(norm(document.body.textContent)).toContain('Synthetic advice text.'));
    const t = pageText();
    expect(t).toContain('81');
    expect(t).toMatch(/good/i);
    expect(t).toContain('Synthetic explanation of the score.');
    expect(t).toMatch(/Blood sugar.*(out of range)/i);
    expect(t).toMatch(/Liver.*(in range)/i);
    expect(t).toContain('Your Synthetic Glucose result is above the reference range.');
    expect(t).toContain('Consider a repeat test in 90 days.');
    expect(t).toContain('This summary is not a diagnosis. Discuss your results with your doctor.');
  });

  it('every synthetic fixture the contract allows can be chosen and is sent verbatim', async () => {
    const d = await open();
    for (const code of ['synthetic_all_in_range', 'synthetic_critical']) {
      const picker = within(d).queryByRole('button', { name: /example|fixture|scenario/i }) ?? within(d).queryByRole('combobox', { name: /example|fixture|scenario/i });
      if (!picker) return; // a single-fixture UI is allowed; the default case is covered above
      await userEvent.click(picker);
      await userEvent.click(await screen.findByRole('option', { name: new RegExp(code.replace('synthetic_', '').replace(/_/g, '[ _]'), 'i') }));
      await run(d);
      await waitFor(() => expect(previews().at(-1) && bodyOf(previews().at(-1))).toEqual({ fixture_code: code }));
    }
  });

  it('preview text is TEXT: markup in a returned text never becomes an element', async () => {
    routes[`POST ${URL_PREVIEW}`] = json({ ...PREVIEW, advice: [{ template_block_id: PREVIEW.advice[0]!.template_block_id, text: '<img src=x onerror=alert(1)> advice' }] });
    const d = await open();
    await run(d);
    await waitFor(() => expect(pageText()).toContain('<img src=x onerror=alert(1)> advice'));
    expect(document.querySelector('img[src="x"]')).toBeNull();
  });

  it('a score-less / empty preview does not crash (score disabled, no findings)', async () => {
    routes[`POST ${URL_PREVIEW}`] = json({ ...PREVIEW, health_score: undefined, deranged: [], advice: [], follow_ups: [], trends: [], panels: [] });
    const d = await open();
    await run(d);
    await waitFor(() => expect(pageText()).toContain('This summary is not a diagnosis.'));
    expect(pageText()).not.toMatch(/undefined|NaN|\[object/);
  });

  it('double-clicking Run sends ONE request (single flight)', async () => {
    routes[`POST ${URL_PREVIEW}`] = async () => { await new Promise((r) => setTimeout(r, 150)); return HttpResponse.json(PREVIEW as never); };
    const d = await open();
    await userEvent.dblClick(within(d).getByRole('button', { name: /^(run preview|generate preview|show preview|preview)$/i }));
    await new Promise((r) => setTimeout(r, 300));
    expect(previews()).toHaveLength(1);
  });
});

describe('AC-19.2 real order (UI side)', () => {
  const real = async (value: string) => {
    resetApi(MANAGE_READ); mountEditorApi(); routes[`POST ${URL_PREVIEW}`] = json(PREVIEW);
    const d = await open();
    await userEvent.click(within(d).getByRole('radio', { name: /real order/i }));
    const box = within(d).getByRole('textbox', { name: /order/i });
    await userEvent.click(box);
    if (value) await userEvent.paste(value);
    return d;
  };

  it('a pasted order id -> POST body EXACTLY {order_id}; the id is never put in a URL (07-SECURITY: no PHI in URLs)', async () => {
    const d = await real(ORDER_ID);
    await run(d);
    await waitFor(() => expect(previews()).toHaveLength(1));
    expect(bodyOf(previews()[0])).toEqual({ order_id: ORDER_ID });
    for (const c of apiCalls()) expect(c.url.href).not.toContain(ORDER_ID);
    for (const [t] of [...router.push.mock.calls, ...router.replace.mock.calls]) expect(String(t)).not.toContain(ORDER_ID);
  });

  it.each(['', 'ORD-123', ' ', '../../etc', `${ORDER_ID}x`])('order id %j is not a UUID -> inline error, NO request', async (v) => {
    const d = await real(v);
    await run(d);
    await new Promise((r) => setTimeout(r, 80));
    expect(previews()).toHaveLength(0);
    expect(within(d).queryAllByRole('alert').length + within(d).queryAllByText(/order id|valid|required/i).length).toBeGreaterThan(0);
  });

  it('422 smartreport.no_eligible_results -> "Not enough mapped results in this order to build a summary."', async () => {
    const d = await real(ORDER_ID);
    routes[`POST ${URL_PREVIEW}`] = () => problem('smartreport.no_eligible_results', 422);
    await run(d);
    await waitFor(() => expect(pageText()).toContain(NO_ORDER));
    expect(pageText()).not.toContain('smartreport.no_eligible_results');
  });

  it.each([['auth.forbidden', 403], ['common.not_found', 404], ['common.internal', 500]] as const)('API %s (%i) -> role=alert in plain words, no raw code, no summary shown', async (code, status) => {
    const d = await real(ORDER_ID);
    routes[`POST ${URL_PREVIEW}`] = () => problem(code, status, { detail: 'SECRET-DB-HINT' });
    await run(d);
    const alert = await screen.findByRole('alert');
    expect(norm(alert.textContent)).not.toMatch(new RegExp(`${code.replace('.', '\\.')}|SECRET-DB-HINT`));
    expect(pageText()).not.toContain('Synthetic advice text.');
  });
});

describe('a11y', () => {
  it('dialog (before and after a result) has no axe violations and closes with Escape', async () => {
    const d = await open();
    await axeClean();
    await run(d);
    await waitFor(() => expect(pageText()).toContain('Synthetic advice text.'));
    await axeClean();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
