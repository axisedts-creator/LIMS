// @vitest-environment jsdom
// C14.T21 — SR-06 Wording terms, app/(staff)/smartreport/wording/page.tsx (04-UI-UX SR-06; 03-APP-FLOW §4 row SR-06; AC-18.2 UI side: global terms cannot be deactivated by a tenant,
// tenant terms can be added and deactivated; 07-SECURITY: permission hiding, text-only rendering).
// ASSUMED contract (spec fixes route, columns, dialog fields, empty copy and endpoints):
//   * default export = async server component `Page({ params, searchParams })`. Permission smartreport.template.manage is checked BEFORE any API call (denied = notFound/PermissionDenied).
//     Reads GET #23 /v1/smartreport/wording-deny-terms?include_global=true (bearer token).
//   * DataTable (role=grid, name /wording terms|deny terms/i), columns Term · Language · Scope · Reason · Active (+ actions). Language cells English / Nepali / Any; Scope "Global" / "This lab";
//     Active "Yes" / "No". Global rows have NO action. Tenant active rows have a row button "Deactivate" (ConfirmDialog, role dialog) -> POST #25 /{term_id}/deactivate, If-Match "<row version>".
//     Inactive tenant rows have no Deactivate.
//   * Empty (no tenant term): text "No lab-specific terms. Global terms always apply." (the global rows stay listed).
//   * "Add term" opens a Dialog: Term textbox (2–60), Language Select (English / Nepali / Any), Reason textarea (≤200, optional) -> POST #24 {term, language[, reason]} with a non-empty
//     Idempotency-Key; success closes the dialog, shows a toast and refreshes; failures are role=alert in plain words (never the raw code).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse } from 'msw';
import {
  GLOBAL_TERMS, MANAGE_ONLY, TENANT_TERMS, TERMS, WORDING_PAGE, api, apiCalls, axeClean, bodyOf, callsTo, gridNamed, headersOf, json, mountTerms, norm, pageText, pick, problem, resetApi, rowTexts,
  router, routes, showOrThrown, showWording, termDto,
} from './sr-t21.harness';

vi.mock('next/navigation', async () => (await import('./sr-t20.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./sr-t20.harness')).sessionMock);

beforeAll(() => api.listen());
beforeEach(() => { resetApi(MANAGE_ONLY); mountTerms(); });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const grid = () => gridNamed(/wording terms|deny terms/i);
const rowOf = (term: string) => within(grid()).getAllByRole('row').find((r) => norm(r.textContent).includes(term))!;
const posts = () => callsTo('POST', TERMS);
const dlg = () => screen.findByRole('dialog');
const openAdd = async () => { await userEvent.click(screen.getByRole('button', { name: /add term/i })); return dlg(); };
const fill = async (d: HTMLElement, term: string, reason?: string) => {
  await userEvent.type(within(d).getByRole('textbox', { name: /^term/i }), term);
  await pick(/language/i, /english/i);
  if (reason !== undefined) await userEvent.type(within(d).getByRole('textbox', { name: /reason/i }), reason);
};
const submit = (d: HTMLElement) => userEvent.click(within(d).getByRole('button', { name: /^(add|save|add term)$/i }));

describe('access', () => {
  it('without smartreport.template.manage: denied (notFound or PermissionDenied) and NO API call', async () => {
    resetApi(['smartreport.summary.read']);
    const out = await showOrThrown(WORDING_PAGE, {});
    if (out !== undefined) expect(out).toMatch(/NEXT_NOT_FOUND/);
    else expect(screen.getByTestId('permission-denied')).toBeTruthy();
    expect(apiCalls()).toHaveLength(0);
  });

  it('a failed read throws (error boundary) instead of showing an empty table', async () => {
    routes[`GET ${TERMS}`] = () => problem('common.internal', 500);
    expect(await showOrThrown(WORDING_PAGE, {})).toBeDefined();
  });
});

describe('list', () => {
  it('reads include_global=true with the bearer token and shows Term · Language · Scope · Reason · Active', async () => {
    await showWording();
    const get = callsTo('GET', TERMS)[0]!;
    expect(get.url.searchParams.get('include_global')).toBe('true');
    expect(get.headers.get('authorization')).toBe('Bearer jwt-synthetic');
    expect(headersOf(grid()).slice(0, 5)).toEqual(['Term', 'Language', 'Scope', 'Reason', 'Active']);
  });

  it('renders words, not codes: English / Nepali / Any, Global / This lab, Yes / No', async () => {
    await showWording();
    expect(norm(rowOf('guaranteed cure').textContent)).toMatch(/English.*This lab.*Synthetic wording rule.*Yes/);
    expect(norm(rowOf('sure thing').textContent)).toMatch(/Nepali/);
    expect(norm(rowOf('http').textContent)).toMatch(/Any.*Global.*Yes/);
    expect(norm(rowOf('old banned phrase').textContent)).toMatch(/This lab.*No/);
    expect(rowTexts(grid())).toHaveLength(GLOBAL_TERMS.length + TENANT_TERMS.length);
  });

  it('only global terms -> "No lab-specific terms. Global terms always apply." and the global rows stay listed', async () => {
    mountTerms([...GLOBAL_TERMS]);
    await showWording();
    expect(pageText()).toContain('No lab-specific terms. Global terms always apply.');
    expect(rowOf('miracle')).toBeTruthy();
  });

  it('empty response -> the same message, no crash', async () => {
    mountTerms([]);
    await showWording();
    expect(pageText()).toContain('No lab-specific terms. Global terms always apply.');
  });

  it('terms are rendered as TEXT: markup never becomes an element', async () => {
    mountTerms([termDto({ term: '<img src=x onerror=alert(1)>', reason: '<script>alert(2)</script>' })]);
    await showWording();
    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
    expect(pageText()).toContain('<img src=x onerror=alert(1)>');
  });
});

describe('AC-18.2 global terms cannot be deactivated; tenant terms can', () => {
  it('global rows have no action — even a global row that carries an id (defence in depth)', async () => {
    mountTerms([{ ...GLOBAL_TERMS[0]!, id: '01940e00-0000-7000-8000-000000000999' }, ...TENANT_TERMS]);
    await showWording();
    expect(within(rowOf('http')).queryAllByRole('button')).toHaveLength(0);
    expect(within(rowOf('http')).queryAllByRole('link')).toHaveLength(0);
  });

  it('active tenant rows have Deactivate; the inactive tenant row has none', async () => {
    await showWording();
    expect(within(rowOf('guaranteed cure')).getByRole('button', { name: /deactivate/i })).toBeTruthy();
    expect(within(rowOf('sure thing')).getByRole('button', { name: /deactivate/i })).toBeTruthy();
    expect(within(rowOf('old banned phrase')).queryByRole('button', { name: /deactivate/i })).toBeNull();
  });

  it('Deactivate -> ConfirmDialog; Cancel sends nothing; Confirm -> POST /{id}/deactivate with If-Match "<row version>" and refreshes', async () => {
    const t = TENANT_TERMS[1]!;
    const url = `${TERMS}/${t.id}/deactivate`;
    routes[`POST ${url}`] = json({ ...t, is_active: false, version: 4 });
    await showWording();
    await userEvent.click(within(rowOf('sure thing')).getByRole('button', { name: /deactivate/i }));
    await userEvent.click(within(await dlg()).getByRole('button', { name: /cancel/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(callsTo('POST', url)).toHaveLength(0);
    await userEvent.click(within(rowOf('sure thing')).getByRole('button', { name: /deactivate/i }));
    await userEvent.click(within(await dlg()).getByRole('button', { name: /^deactivate$/i }));
    await waitFor(() => expect(callsTo('POST', url)).toHaveLength(1));
    const c = callsTo('POST', url)[0]!;
    expect(c.headers.get('if-match')).toBe('"3"');
    expect(c.headers.get('authorization')).toBe('Bearer jwt-synthetic');
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
  });

  it('API refusals on deactivate (404 for a global id, 409 conflict) -> role=alert in plain words, no raw code, row not marked inactive', async () => {
    const t = TENANT_TERMS[0]!;
    const url = `${TERMS}/${t.id}/deactivate`;
    for (const [code, status] of [['common.not_found', 404], ['common.version_conflict', 409], ['common.immutable_record', 409]] as const) {
      cleanup(); resetApi(MANAGE_ONLY); mountTerms();
      routes[`POST ${url}`] = () => problem(code, status);
      await showWording();
      await userEvent.click(within(rowOf('guaranteed cure')).getByRole('button', { name: /deactivate/i }));
      await userEvent.click(within(await dlg()).getByRole('button', { name: /^deactivate$/i }));
      const alert = await screen.findByRole('alert');
      expect(norm(alert.textContent)).not.toContain(code);
      expect(norm(rowOf('guaranteed cure').textContent)).toMatch(/Yes/);
    }
  });
});

describe('Add term', () => {
  it('opens a Dialog with Term, Language and Reason fields; nothing is sent until submit', async () => {
    await showWording();
    const d = await openAdd();
    expect(within(d).getByRole('textbox', { name: /^term/i })).toBeTruthy();
    expect(within(d).getByRole('button', { name: /language/i })).toBeTruthy();
    expect(within(d).getByRole('textbox', { name: /reason/i })).toBeTruthy();
    expect(posts()).toHaveLength(0);
  });

  it('valid term -> POST with a non-empty Idempotency-Key and body {term, language, reason}; then refresh', async () => {
    routes[`POST ${TERMS}`] = () => HttpResponse.json(termDto({ id: '01940e00-0000-7000-8000-000000000555', term: 'cure all', reason: 'Synthetic' }) as never, { status: 201 });
    await showWording();
    const d = await openAdd();
    await fill(d, 'cure all', 'Synthetic');
    await submit(d);
    await waitFor(() => expect(posts()).toHaveLength(1));
    const c = posts()[0]!;
    expect(c.headers.get('idempotency-key')?.length ?? 0).toBeGreaterThan(7);
    expect(c.headers.get('authorization')).toBe('Bearer jwt-synthetic');
    expect(bodyOf(c)).toEqual({ term: 'cure all', language: 'en', reason: 'Synthetic' });
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
  });

  it('reason left empty -> the key is not sent at all (body {term, language})', async () => {
    routes[`POST ${TERMS}`] = () => HttpResponse.json(termDto({ term: 'cure all' }) as never, { status: 201 });
    await showWording();
    const d = await openAdd();
    await fill(d, 'cure all');
    await submit(d);
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(bodyOf(posts()[0])).toEqual({ term: 'cure all', language: 'en' });
  });

  it.each([['1 char', 'a'], ['empty', ''], ['61 chars', 'x'.repeat(61)]])('term %s -> inline error, NO request', async (_n, term) => {
    await showWording();
    const d = await openAdd();
    await pick(/language/i, /english/i);
    if (term) { await userEvent.click(within(d).getByRole('textbox', { name: /^term/i })); await userEvent.paste(term); }
    await submit(d);
    await new Promise((r) => setTimeout(r, 80));
    expect(posts()).toHaveLength(0);
    expect(within(d).queryAllByRole('alert').length + within(d).queryAllByText(/2.{1,6}60|required|too (short|long)|at least|at most|characters/i).length).toBeGreaterThan(0);
  });

  it('reason over 200 characters -> NO request', async () => {
    await showWording();
    const d = await openAdd();
    await userEvent.type(within(d).getByRole('textbox', { name: /^term/i }), 'cure all');
    await pick(/language/i, /english/i);
    await userEvent.click(within(d).getByRole('textbox', { name: /reason/i }));
    await userEvent.paste('r'.repeat(201));
    await submit(d);
    await new Promise((r) => setTimeout(r, 80));
    for (const c of posts()) expect(String(bodyOf(c).reason ?? '').length).toBeLessThanOrEqual(200);
  });

  it('Language options are English / Nepali / Any and map to en / ne / any', async () => {
    for (const [label, code] of [[/nepali/i, 'ne'], [/any/i, 'any']] as const) {
      cleanup(); resetApi(MANAGE_ONLY); mountTerms();
      routes[`POST ${TERMS}`] = () => HttpResponse.json(termDto() as never, { status: 201 });
      await showWording();
      const d = await openAdd();
      await userEvent.type(within(d).getByRole('textbox', { name: /^term/i }), 'cure all');
      await pick(/language/i, label);
      await submit(d);
      await waitFor(() => expect(posts()).toHaveLength(1));
      expect(bodyOf(posts()[0]).language).toBe(code);
    }
  });

  it('double-clicking submit sends ONE request (single flight)', async () => {
    routes[`POST ${TERMS}`] = async () => { await new Promise((r) => setTimeout(r, 150)); return HttpResponse.json(termDto() as never, { status: 201 }); };
    await showWording();
    const d = await openAdd();
    await fill(d, 'cure all');
    await userEvent.dblClick(within(d).getByRole('button', { name: /^(add|save|add term)$/i }));
    await new Promise((r) => setTimeout(r, 300));
    expect(posts()).toHaveLength(1);
  });

  it.each([['common.validation_failed', 422], ['common.validation_failed', 400], ['common.idempotency_key_reused', 409], ['common.internal', 500]] as const)('API %s (%i) -> role=alert, dialog stays open with the input, no raw code', async (code, status) => {
    routes[`POST ${TERMS}`] = () => problem(code, status, { detail: 'SECRET-DB-HINT' });
    await showWording();
    const d = await openAdd();
    await fill(d, 'cure all');
    await submit(d);
    const alert = await screen.findByRole('alert');
    expect(norm(alert.textContent)).not.toMatch(new RegExp(`${code.replace('.', '\\.')}|SECRET-DB-HINT`));
    expect((within(d).getByRole('textbox', { name: /^term/i }) as HTMLInputElement).value).toBe('cure all');
  });

  it('a term with markup is sent as typed (escaping is the renderer\'s job), not executed', async () => {
    routes[`POST ${TERMS}`] = () => HttpResponse.json(termDto({ term: '<b>x</b>' }) as never, { status: 201 });
    await showWording();
    const d = await openAdd();
    await fill(d, '<b>x</b>');
    await submit(d);
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(bodyOf(posts()[0]).term).toBe('<b>x</b>');
    expect(document.querySelector('b')).toBeNull();
  });
});

describe('a11y', () => {
  it('page, Add dialog and Deactivate dialog have no axe violations', async () => {
    await showWording();
    await axeClean();
    await openAdd();
    await axeClean();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await userEvent.click(within(rowOf('guaranteed cure')).getByRole('button', { name: /deactivate/i }));
    await dlg();
    await axeClean();
  });

  it('every status is text (Yes/No, Global/This lab), never colour or icon alone', async () => {
    await showWording();
    for (const r of rowTexts(grid())) expect(r).toMatch(/\b(Yes|No)\b/);
    for (const r of rowTexts(grid())) expect(r).toMatch(/Global|This lab/);
  });
});
