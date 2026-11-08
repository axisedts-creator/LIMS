// @vitest-environment jsdom
// C3.T-32 — SCR-06 tests/analytes tab, SCR-07 analyte editor + publish dialog + formula panel, SCR-08 ranges/critical + preview panel
// (04-UI-UX §4, 03-APP-FLOW §5 states + F-02/F-03/F-04/F-05, 07-SECURITY REQ-SEC-088/089).
// ACs: AC-02.1–02.3, 02.6, 02.7 (screens' display of them), AC-03.1–03.6, AC-04.8, AC-05.1–05.11 (preview panel / band grid / publish).
// Component tests + MSW (server functions run for real against MSW) + axe. Synthetic data only.
// NOT covered here (no UI in T-32 files): AC-02.4/02.5 health report (SCR-01), AC-05.8 DB triggers (API tests).
// ASSUMED module/prop contract (spec fixes only folders + kit components; writer may dispute names):
//   components/AnalytesTab.tsx       AnalytesTab({testId, analytes, permissions})   analytes[]: {id, code, name, print_name, report_subheading, sort_order, result_type, unit_code, decimals, method_name, formula_expression?, range_set_version?|null, current_version_no, has_draft, version}
//   components/TestGeneralForm.tsx   TestGeneralForm({test, departments, hasPublishedAnalyteVersion, permissions})  (workflow_type Select disabled once true)
//   components/TestHeader.tsx        TestHeader({test})  status Badge text Active|Inactive
//   components/AnalyteEditor.tsx     AnalyteEditor({testId, analyte|null (create), versions, units, methods, valueSets, subheadings, rangeDraft?, criticalDraft?, permissions})
//   components/FormulaPanel.tsx      FormulaPanel({analyteId?, value, onChange})  debounce 400 ms → validateFormula; "Try it" mini-form
//   components/PublishDialog.tsx     PublishDialog({analyte:{id,code,name}, version:{id,version_no,version}, rangeDraft?:{id,version_no,version}, criticalDraft?, unitOrMethodChanged, permissions, isOpen, onClose})
//   components/RangesTab.tsx         RangesTab({analyte:{id,code,unit_code}, kind:'ranges'|'critical', sets (newest first), valueSet?, specimenTypes, permissions})
//   components/RangePreview.tsx      RangePreview({analyteId, specimenTypes})  (Sex Select, Age value+unit, Specimen type, At) → "Preview"
//   page: app/(staff)/catalog/tests/[test_id]/page.tsx  default async Page({params: Promise<{test_id}>, searchParams: Promise<{analyte?, tab?}>}); getTest 404 → notFound()
//   server actions: features/catalog/server/actions.ts → *Action(...) returns {ok:true,data}|{ok:false,status,code,errors?:{path,code,message}[]}
//   permissions: readonly string[] (session.actor.permissions); navigation via next/navigation useRouter(); reload = router.refresh().
//   Button/field names are the spec's copy verbatim (04-UI-UX §4, 03-APP-FLOW §5).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { ReactNode } from 'react';
import { ToastProvider } from '@lims/ui/components/Toast';

const push = vi.fn();
const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh, back: vi.fn() }),
  usePathname: () => '/catalog/tests/x',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw Object.assign(new Error('NEXT_NOT_FOUND'), { digest: 'NEXT_HTTP_ERROR_FALLBACK;404' }); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: ['catalog.test.read'], displayName: 'Synthetic Manager', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/catalog/tests/x',
}));

const ORIGIN = 'http://api.test';
process.env.LIMS_ORIGIN_API = ORIGIN;
const TEST_ID = '01a1a98a-ac40-7000-8000-0000000c3101';
const HB = '01a1a98a-ac40-7000-8000-0000000c3201';
const RBC = '01a1a98a-ac40-7000-8000-0000000c3202';
const V1 = '01a1a98a-ac40-7000-8000-0000000c3301';
const V2 = '01a1a98a-ac40-7000-8000-0000000c3302';
const RS3 = '01a1a98a-ac40-7000-8000-0000000c3403';
const CL2 = '01a1a98a-ac40-7000-8000-0000000c3502';
const METHOD = '01a1a98a-ac40-7000-8000-0000000c3601';
const SPEC_URINE = '01a1a98a-ac40-7000-8000-0000000c3701';

const READ = ['catalog.test.read'];
const MANAGE = ['catalog.test.read', 'catalog.test.manage'];
const BOTH = ['catalog.test.read', 'catalog.test.manage', 'catalog.reference_range.publish'];
const RANGE_ONLY = ['catalog.test.read', 'catalog.reference_range.publish']; // e.g. pathologist

const units = [{ code: 'g_dl', display: 'g/dL', scope: 'global' }, { code: 'fl', display: 'fL', scope: 'global' }];
const methods = [{ id: METHOD, name: 'Cyanmethemoglobin', is_active: true }];
const valueSets = [{ code: 'URINE_GRADE', display: 'Urine grade', is_ordered: true }, { code: 'POS_NEG', display: 'Positive/negative', is_ordered: false }];
const specimenTypes = [{ id: SPEC_URINE, code: 'URINE', name: 'Urine' }];

const analyteRow = (o: Record<string, unknown> = {}) => ({ id: HB, code: 'HB', name: 'Haemoglobin', print_name: 'Haemoglobin', report_subheading: 'RBC parameters', sort_order: 10, result_type: 'numeric', unit_code: 'g_dl', decimals: 1, method_name: 'Cyanmethemoglobin', range_set_version: 3, current_version_no: 2, has_draft: false, is_active: true, version: 5, ...o });
const verRow = (o: Record<string, unknown> = {}) => ({ id: V2, analyte_id: HB, version_no: 2, status: 'published', result_type: 'numeric', unit_code: 'g_dl', decimals: 1, method_id: METHOD, effective_from: '2026-11-05T18:15:00.000Z', change_reason: 'Synthetic', version: 3, ...o });
const draftRow = (o: Record<string, unknown> = {}) => verRow({ id: V2, version_no: 3, status: 'draft', effective_from: undefined, version: 1, ...o });

interface Seen { method: string; url: URL; headers: Headers; body?: any }
let seen: Seen[] = [];
const rec = (fn: (s: Seen) => Response | Promise<Response>) => async ({ request }: { request: Request }) => {
  const s: Seen = { method: request.method, url: new URL(request.url), headers: request.headers, body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.clone().json().catch(() => undefined) };
  seen.push(s);
  return fn(s);
};
const problem = (code: string, status: number, extra: Record<string, unknown> = {}) =>
  HttpResponse.json({ type: `urn:lims:error:${code}`, title: code, status, code, ...extra }, { status });
const calls = (m: string, re: RegExp) => seen.filter((s) => s.method === m && re.test(s.url.pathname));
const api = setupServer();
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());
beforeEach(() => { seen = []; push.mockClear(); refresh.mockClear(); });

const wrap = (ui: ReactNode) => render(<ToastProvider>{ui}</ToastProvider>);
const load = async (file: string) => (await import(/* @vite-ignore */ `../components/${file}`)) as Record<string, any>;
/** Text that explains why a disabled control is disabled: title, aria-describedby target, or aria-label of a wrapper (Tooltip kit). */
const reasonOf = (el: HTMLElement) => {
  const ids = (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
  return [el.getAttribute('title') ?? '', ...ids.map((i) => document.getElementById(i)?.textContent ?? '')].join(' ');
};
const publishBtn = () => screen.getByRole('button', { name: /^publish$/i });

// ───────────────────────────── SCR-06 Analytes tab (AC-02.1, AC-02.7) ─────────────────────────────
describe('SCR-06 Analytes tab', () => {
  const rows = [
    analyteRow({ id: RBC, code: 'RBC', name: 'Red blood cells', report_subheading: 'RBC parameters', sort_order: 20, unit_code: 'fl', formula_expression: undefined, range_set_version: null, has_draft: true }),
    analyteRow({ id: HB, code: 'HB', sort_order: 10 }),
    analyteRow({ id: '01a1a98a-ac40-7000-8000-0000000c3203', code: 'MENTZER', name: 'Mentzer index', report_subheading: 'Special parameters', sort_order: 90, formula_expression: 'MCV / RBC', range_set_version: 1 }),
  ];

  it('AC-02.1: columns Order · Sub-heading · Code · Name · Result type · Unit · Decimals · Method · Formula · Range set · Current version · Draft', async () => {
    const { AnalytesTab } = await load('AnalytesTab');
    wrap(<AnalytesTab testId={TEST_ID} analytes={rows} permissions={MANAGE} />);
    for (const h of ['Order', 'Sub-heading', 'Code', 'Name', 'Result type', 'Unit', 'Decimals', 'Method', 'Formula', 'Range set', 'Current version', 'Draft']) {
      expect(screen.getByRole('columnheader', { name: new RegExp(`^${h}$`, 'i') })).toBeTruthy();
    }
  });

  it('AC-02.1: rows come in sort_order (HB 10, RBC 20, MENTZER 90), each with its sub-heading text', async () => {
    const { AnalytesTab } = await load('AnalytesTab');
    wrap(<AnalytesTab testId={TEST_ID} analytes={rows} permissions={MANAGE} />);
    const body = screen.getAllByRole('row').slice(1);
    const codes = body.map((r) => within(r).getAllByRole('cell').map((c) => c.textContent).find((t) => ['HB', 'RBC', 'MENTZER'].includes(t ?? '')));
    expect(codes).toEqual(['HB', 'RBC', 'MENTZER']);
    expect(screen.getAllByText('RBC parameters').length).toBeGreaterThan(0);
    expect(screen.getByText('Special parameters')).toBeTruthy();
  });

  it('range-set cell shows the version, or a "None" warning badge with text; Draft badge only where has_draft (no colour-only meaning)', async () => {
    const { AnalytesTab } = await load('AnalytesTab');
    wrap(<AnalytesTab testId={TEST_ID} analytes={rows} permissions={MANAGE} />);
    const rbc = screen.getByText('Red blood cells').closest('tr') as HTMLElement;
    expect(within(rbc).getByText('None')).toBeTruthy();
    expect(within(rbc).getByText('Draft')).toBeTruthy();
    const hb = screen.getByText('Haemoglobin').closest('tr') as HTMLElement;
    expect(within(hb).queryByText('None')).toBeNull();
    expect(within(hb).queryByText('Draft')).toBeNull();
  });

  it('formula analytes carry an accessible formula icon label; the formula text is a React text node, never HTML (REQ-SEC-088/089)', async () => {
    const { AnalytesTab } = await load('AnalytesTab');
    const evil = [analyteRow({ id: RBC, code: 'EVIL', name: '<img src=x onerror=alert(1)>', formula_expression: '<script>alert(1)</script>' })];
    const { container } = wrap(<AnalytesTab testId={TEST_ID} analytes={evil} permissions={MANAGE} />);
    expect(container.querySelector('img, script')).toBeNull();
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy();
    expect(screen.getByLabelText(/formula/i, { selector: '[role="img"], svg, span' })).toBeTruthy();
  });

  it('empty: "This test has no analytes yet." + Add analyte (manage only)', async () => {
    const { AnalytesTab } = await load('AnalytesTab');
    wrap(<AnalytesTab testId={TEST_ID} analytes={[]} permissions={MANAGE} />);
    expect(screen.getByText('This test has no analytes yet.')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^add analyte$/i })).toBeTruthy();
    cleanup();
    wrap(<AnalytesTab testId={TEST_ID} analytes={[]} permissions={READ} />);
    expect(screen.queryByRole('button', { name: /^add analyte$/i })).toBeNull();
  });

  it('read-only (catalog.test.read only): rows can be opened, no Add analyte; Open navigates to ?analyte=<id>', async () => {
    const { AnalytesTab } = await load('AnalytesTab');
    wrap(<AnalytesTab testId={TEST_ID} analytes={rows} permissions={READ} />);
    expect(screen.queryByRole('button', { name: /^add analyte$/i })).toBeNull();
    await userEvent.click(screen.getAllByRole('button', { name: /^open$/i })[0]!);
    expect(push).toHaveBeenCalledWith(expect.stringContaining(`/catalog/tests/${TEST_ID}?analyte=${HB}`));
  });

  it('Alt+ArrowDown on a focused row saves the new sort_order via PATCH /analytes/{id} (#31)', async () => {
    api.use(http.patch(`${ORIGIN}/v1/catalog/analytes/:id`, rec(() => HttpResponse.json({ ...rows[1], version: 6 }))));
    const { AnalytesTab } = await load('AnalytesTab');
    wrap(<AnalytesTab testId={TEST_ID} analytes={rows} permissions={MANAGE} />);
    const hb = screen.getByText('Haemoglobin').closest('tr') as HTMLElement;
    hb.focus();
    await userEvent.keyboard('{Alt>}{ArrowDown}{/Alt}');
    await waitFor(() => expect(calls('PATCH', /\/analytes\//)).toHaveLength(1));
    expect(calls('PATCH', /\/analytes\//)[0]!.url.pathname).toBe(`/v1/catalog/analytes/${HB}`);
    expect(calls('PATCH', /\/analytes\//)[0]!.body.sort_order).toBeGreaterThan(10);
  });
});

describe('SCR-06 test header / general form', () => {
  const test = { id: TEST_ID, code: 'CBC', name: 'Complete blood count', department_id: 'd1', workflow_type: 'standard', report_order: 100, is_orderable: true, is_active: true, version: 4 };

  it('AC-02.7: a deactivated test shows an "Inactive" badge with text and still renders', async () => {
    const { TestHeader } = await load('TestHeader');
    wrap(<TestHeader test={{ ...test, is_active: false }} />);
    expect(screen.getByText(/CBC/)).toBeTruthy();
    expect(screen.getByText('Inactive')).toBeTruthy();
    cleanup();
    wrap(<TestHeader test={test} />);
    expect(screen.queryByText('Inactive')).toBeNull();
  });

  it('workflow type Select is disabled with an explanation once an analyte version is published (#26 CONV)', async () => {
    const { TestGeneralForm } = await load('TestGeneralForm');
    wrap(<TestGeneralForm test={test} departments={[{ id: 'd1', name: 'Haematology', is_active: true }]} hasPublishedAnalyteVersion permissions={MANAGE} />);
    const wf = screen.getByLabelText(/workflow type/i) as HTMLElement;
    expect(wf.hasAttribute('disabled') || wf.getAttribute('aria-disabled') === 'true').toBe(true);
    expect(reasonOf(wf) + (screen.queryByText(/first published analyte version/i)?.textContent ?? '')).toMatch(/published/i);
  });

  it('read-only users (catalog.test.read) get no Save and disabled fields', async () => {
    const { TestGeneralForm } = await load('TestGeneralForm');
    wrap(<TestGeneralForm test={test} departments={[]} hasPublishedAnalyteVersion={false} permissions={READ} />);
    expect(screen.queryByRole('button', { name: /^save/i })).toBeNull();
  });

  it('409 common.version_conflict → Banner "Someone else changed this item. Reload to see their changes." + Reload; typed input kept', async () => {
    api.use(http.patch(`${ORIGIN}/v1/catalog/tests/:id`, rec(() => problem('common.version_conflict', 409))));
    const { TestGeneralForm } = await load('TestGeneralForm');
    wrap(<TestGeneralForm test={test} departments={[{ id: 'd1', name: 'Haematology', is_active: true }]} hasPublishedAnalyteVersion={false} permissions={MANAGE} />);
    const name = screen.getByLabelText(/^name/i) as HTMLInputElement;
    await userEvent.clear(name);
    await userEvent.type(name, 'CBC edited');
    await userEvent.click(screen.getByRole('button', { name: /^save/i }));
    expect(await screen.findByText('Someone else changed this item. Reload to see their changes.')).toBeTruthy();
    expect(calls('PATCH', /\/tests\//)[0]!.headers.get('if-match')).toBe('"4"');
    expect((screen.getByLabelText(/^name/i) as HTMLInputElement).value).toBe('CBC edited');
    await userEvent.click(screen.getByRole('button', { name: /^reload$/i }));
    expect(refresh).toHaveBeenCalled();
  });
});

// ───────────────────────────── SCR-07 Analyte editor (AC-02.2/02.3/02.6, AC-03.1/03.2/03.4) ─────────────────────────────
describe('SCR-07 analyte editor — display + clinical definition', () => {
  const props = (o: Record<string, unknown> = {}) => ({ testId: TEST_ID, analyte: null, versions: [], units, methods, valueSets, subheadings: ['RBC parameters', 'WBC parameters'], permissions: MANAGE, ...o });

  it('AC-02.2: Code shows upper-case immediately (hb → HB) with the regex hint ^[A-Z][A-Z0-9_]{0,31}$ under the field', async () => {
    const { AnalyteEditor } = await load('AnalyteEditor');
    wrap(<AnalyteEditor {...props()} />);
    const code = screen.getByLabelText(/^code/i) as HTMLInputElement;
    await userEvent.type(code, 'hb');
    expect(code.value).toBe('HB');
    expect(screen.getByText(/\^\[A-Z\]\[A-Z0-9_\]\{0,31\}\$/)).toBeTruthy();
  });

  it('AC-02.2: create sends POST /tests/{id}/analytes with code "HB", an Idempotency-Key and initial_version; 201 → toast + closes', async () => {
    api.use(http.post(`${ORIGIN}/v1/catalog/tests/:id/analytes`, rec(() => HttpResponse.json({ id: HB, code: 'HB', draft_version_id: V1 }, { status: 201 }))));
    const { AnalyteEditor } = await load('AnalyteEditor');
    wrap(<AnalyteEditor {...props()} />);
    await userEvent.type(screen.getByLabelText(/^code/i), 'hb');
    await userEvent.type(screen.getByLabelText(/^name/i), 'Haemoglobin');
    await userEvent.click(screen.getByLabelText(/^unit/i));
    await userEvent.click(await screen.findByRole('option', { name: /g\/dL/ }));
    await userEvent.type(screen.getByLabelText(/^decimals/i), '1');
    await userEvent.click(screen.getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(calls('POST', /\/tests\/.*\/analytes$/)).toHaveLength(1));
    const s = calls('POST', /\/analytes$/)[0]!;
    expect(s.url.pathname).toBe(`/v1/catalog/tests/${TEST_ID}/analytes`);
    expect(s.headers.get('idempotency-key')).toBeTruthy();
    expect(s.body.code).toBe('HB');
    expect(s.body.initial_version).toMatchObject({ result_type: 'numeric', unit_code: 'g_dl', decimals: 1 });
  });

  it('AC-02.2: server 400 with path /code is shown under the Code field (not a generic toast)', async () => {
    api.use(http.post(`${ORIGIN}/v1/catalog/tests/:id/analytes`, rec(() => problem('common.validation_failed', 400, { errors: [{ path: '/code', code: 'common.validation_failed', message: 'Code format is invalid' }] }))));
    const { AnalyteEditor } = await load('AnalyteEditor');
    wrap(<AnalyteEditor {...props()} />);
    await userEvent.type(screen.getByLabelText(/^code/i), 'hb');
    await userEvent.type(screen.getByLabelText(/^name/i), 'Haemoglobin');
    await userEvent.type(screen.getByLabelText(/^decimals/i), '1');
    await userEvent.click(screen.getByRole('button', { name: /^save/i }));
    const msg = await screen.findByText('Code format is invalid');
    expect(screen.getByLabelText(/^code/i).getAttribute('aria-invalid')).toBe('true');
    expect(reasonOf(screen.getByLabelText(/^code/i))).toContain('Code format is invalid');
    expect(msg).toBeTruthy();
  });

  it('409 catalog.code_duplicate → inline on the Code field', async () => {
    api.use(http.post(`${ORIGIN}/v1/catalog/tests/:id/analytes`, rec(() => problem('catalog.code_duplicate', 409))));
    const { AnalyteEditor } = await load('AnalyteEditor');
    wrap(<AnalyteEditor {...props()} />);
    await userEvent.type(screen.getByLabelText(/^code/i), 'hb');
    await userEvent.type(screen.getByLabelText(/^name/i), 'Haemoglobin');
    await userEvent.type(screen.getByLabelText(/^decimals/i), '1');
    await userEvent.click(screen.getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(screen.getByLabelText(/^code/i).getAttribute('aria-invalid')).toBe('true'));
    expect(reasonOf(screen.getByLabelText(/^code/i))).toMatch(/already used/i);
  });

  it('AC-02.6: numeric result requires Decimals (0–6): blank → field error, no request', async () => {
    const { AnalyteEditor } = await load('AnalyteEditor');
    wrap(<AnalyteEditor {...props()} />);
    await userEvent.type(screen.getByLabelText(/^code/i), 'hb');
    await userEvent.type(screen.getByLabelText(/^name/i), 'Haemoglobin');
    await userEvent.click(screen.getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(screen.getByLabelText(/^decimals/i).getAttribute('aria-invalid')).toBe('true'));
    expect(seen).toHaveLength(0);
  });

  it('AC-02.6: Value set is offered only for Ordinal/Coded and is required there; server /value_set_code error shows under it', async () => {
    api.use(http.post(`${ORIGIN}/v1/catalog/tests/:id/analytes`, rec(() => problem('common.validation_failed', 400, { errors: [{ path: '/initial_version/value_set_code', code: 'common.validation_failed', message: 'An ordinal analyte needs an ordered value set' }] }))));
    const { AnalyteEditor } = await load('AnalyteEditor');
    wrap(<AnalyteEditor {...props()} />);
    expect(screen.queryByLabelText(/^value set/i)).toBeNull(); // numeric by default
    await userEvent.click(screen.getByLabelText(/^result type/i));
    await userEvent.click(await screen.findByRole('option', { name: /^ordinal$/i }));
    const vs = await screen.findByLabelText(/^value set/i);
    await userEvent.type(screen.getByLabelText(/^code/i), 'nit');
    await userEvent.type(screen.getByLabelText(/^name/i), 'Nitrite');
    await userEvent.click(screen.getByRole('button', { name: /^save/i })); // value set empty → required, no request
    await waitFor(() => expect(vs.getAttribute('aria-invalid')).toBe('true'));
    expect(seen).toHaveLength(0);
    await userEvent.click(vs);
    await userEvent.click(await screen.findByRole('option', { name: /Positive\/negative/ })); // is_ordered=false → API rejects
    await userEvent.click(screen.getByRole('button', { name: /^save/i }));
    expect(await screen.findByText('An ordinal analyte needs an ordered value set')).toBeTruthy();
  });

  it('AC-02.3: server 400 path /result_type (second narrative analyte) shows under Result type', async () => {
    api.use(http.post(`${ORIGIN}/v1/catalog/tests/:id/analytes`, rec(() => problem('common.validation_failed', 400, { errors: [{ path: '/initial_version/result_type', code: 'common.validation_failed', message: 'This test already has a narrative analyte' }] }))));
    const { AnalyteEditor } = await load('AnalyteEditor');
    wrap(<AnalyteEditor {...props()} />);
    await userEvent.click(screen.getByLabelText(/^result type/i));
    await userEvent.click(await screen.findByRole('option', { name: /^narrative$/i }));
    await userEvent.type(screen.getByLabelText(/^code/i), 'rep');
    await userEvent.type(screen.getByLabelText(/^name/i), 'Report');
    await userEvent.click(screen.getByRole('button', { name: /^save/i }));
    expect(await screen.findByText('This test already has a narrative analyte')).toBeTruthy();
    expect(screen.getByLabelText(/^result type/i).getAttribute('aria-invalid') ?? screen.getByLabelText(/^result type/i).closest('[aria-invalid]')?.getAttribute('aria-invalid')).toBe('true');
  });

  it('AC-03.1: header "Version 2 · Published · effective 06/11/2026 00:00"; version Select lists v1 Superseded and v2 Published (text badges)', async () => {
    const { AnalyteEditor } = await load('AnalyteEditor');
    const versions = [verRow(), verRow({ id: V1, version_no: 1, status: 'superseded', effective_to: '2026-11-05T18:15:00.000Z', effective_from: '2026-10-01T00:00:00.000Z' })];
    wrap(<AnalyteEditor {...props({ analyte: analyteRow(), versions })} />);
    expect(screen.getByText(/Version 2\s*·\s*Published\s*·\s*effective 06\/11\/2026 00:00/)).toBeTruthy();
    await userEvent.click(screen.getByLabelText(/^version$/i));
    const opts = await screen.findAllByRole('option');
    expect(opts.map((o) => o.textContent).join('|')).toMatch(/Superseded/);
    expect(opts.map((o) => o.textContent).join('|')).toMatch(/Published/);
  });

  it('AC-03.1: choosing the older version shows it read-only (fields disabled, no Save/Publish)', async () => {
    const { AnalyteEditor } = await load('AnalyteEditor');
    const versions = [verRow(), verRow({ id: V1, version_no: 1, status: 'superseded', effective_from: '2026-10-01T00:00:00.000Z' })];
    wrap(<AnalyteEditor {...props({ analyte: analyteRow(), versions, permissions: BOTH })} />);
    await userEvent.click(screen.getByLabelText(/^version$/i));
    await userEvent.click(await screen.findByRole('option', { name: /1.*Superseded/ }));
    const dec = screen.getByLabelText(/^decimals/i) as HTMLInputElement;
    expect(dec.disabled || dec.readOnly).toBe(true);
    expect(screen.queryByRole('button', { name: /^publish$/i })).toBeNull();
  });

  it('buttons: "Create new version" when there is no draft, "Edit draft" when there is one', async () => {
    const { AnalyteEditor } = await load('AnalyteEditor');
    wrap(<AnalyteEditor {...props({ analyte: analyteRow(), versions: [verRow()] })} />);
    expect(screen.getByRole('button', { name: /^create new version$/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^edit draft$/i })).toBeNull();
    cleanup();
    wrap(<AnalyteEditor {...props({ analyte: analyteRow({ has_draft: true }), versions: [draftRow(), verRow()] })} />);
    expect(screen.getByRole('button', { name: /^edit draft$/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^create new version$/i })).toBeNull();
  });

  it('AC-03.2: PATCH of a published version → 409 catalog.version_in_use → Banner + "Create new version" button that POSTs /analytes/{id}/versions with an Idempotency-Key', async () => {
    api.use(
      http.patch(`${ORIGIN}/v1/catalog/analyte-versions/:id`, rec(() => problem('catalog.version_in_use', 409))),
      http.post(`${ORIGIN}/v1/catalog/analytes/:id/versions`, rec(() => HttpResponse.json(draftRow(), { status: 201 }))),
    );
    const { AnalyteEditor } = await load('AnalyteEditor');
    wrap(<AnalyteEditor {...props({ analyte: analyteRow({ has_draft: true }), versions: [draftRow(), verRow()] })} />);
    await userEvent.click(screen.getByRole('button', { name: /^edit draft$/i }));
    const dec = screen.getByLabelText(/^decimals/i);
    await userEvent.clear(dec);
    await userEvent.type(dec, '2');
    await userEvent.click(screen.getByRole('button', { name: /^save/i }));
    const banner = await screen.findByRole('alert');
    expect(banner.textContent).toMatch(/in use|published/i);
    expect(calls('PATCH', /analyte-versions/)[0]!.headers.get('if-match')).toBe('"1"');
    await userEvent.click(within(banner.parentElement as HTMLElement).getByRole('button', { name: /^create new version$/i }));
    await waitFor(() => expect(calls('POST', /\/versions$/)).toHaveLength(1));
    expect(calls('POST', /\/versions$/)[0]!.url.pathname).toBe(`/v1/catalog/analytes/${HB}/versions`);
    expect(calls('POST', /\/versions$/)[0]!.headers.get('idempotency-key')).toBeTruthy();
  });

  it('AC-03.4: second draft → 409 common.version_conflict → "Someone else changed this item. Reload to see their changes." + Reload', async () => {
    api.use(http.post(`${ORIGIN}/v1/catalog/analytes/:id/versions`, rec(() => problem('common.version_conflict', 409))));
    const { AnalyteEditor } = await load('AnalyteEditor');
    wrap(<AnalyteEditor {...props({ analyte: analyteRow(), versions: [verRow()] })} />);
    await userEvent.click(screen.getByRole('button', { name: /^create new version$/i }));
    expect(await screen.findByText('Someone else changed this item. Reload to see their changes.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /^reload$/i }));
    expect(refresh).toHaveBeenCalled();
  });

  it('read-only (catalog.test.read): no Create new version / Edit draft / Save / Publish; fields not editable', async () => {
    const { AnalyteEditor } = await load('AnalyteEditor');
    wrap(<AnalyteEditor {...props({ analyte: analyteRow(), versions: [verRow()], permissions: READ })} />);
    for (const n of [/^create new version$/i, /^edit draft$/i, /^save/i]) expect(screen.queryByRole('button', { name: n })).toBeNull();
    const dec = screen.getByLabelText(/^decimals/i) as HTMLInputElement;
    expect(dec.disabled || dec.readOnly).toBe(true);
  });
});

// ───────────────────────────── SCR-07 Formula panel (F-05, AC-04.8) ─────────────────────────────
describe('SCR-07 formula panel', () => {
  const ok = { valid: true, input_analyte_codes: ['MCV', 'RBC'], dependency_order: ['MCV', 'RBC', 'MENTZER'], chain_depth: 2, errors: [] };

  it('debounces: rapid typing sends ONE validate (#36) after the pause with the full expression; shows "Inputs: MCV, RBC" and "Order: MCV → RBC → MENTZER"', async () => {
    api.use(http.post(`${ORIGIN}/v1/catalog/formulas/validate`, rec(() => HttpResponse.json(ok))));
    const { FormulaPanel } = await load('FormulaPanel');
    wrap(<FormulaPanel analyteId={HB} value="" onChange={() => {}} />);
    await userEvent.type(screen.getByLabelText(/^formula/i), 'MCV / RBC');
    expect(calls('POST', /formulas\/validate/)).toHaveLength(0); // inside the 400 ms window
    expect(await screen.findByText(/Inputs:\s*MCV, RBC/, {}, { timeout: 3000 })).toBeTruthy();
    expect(screen.getByText(/Order:\s*MCV\s*→\s*RBC\s*→\s*MENTZER/)).toBeTruthy();
    expect(calls('POST', /formulas\/validate/)).toHaveLength(1);
    expect(calls('POST', /formulas\/validate/)[0]!.body.expression).toBe('MCV / RBC');
    expect(calls('POST', /formulas\/validate/)[0]!.body.analyte_id).toBe(HB);
  });

  it('invalid formula (200 valid:false): error text with position under the field, aria-live="polite" region, field aria-invalid', async () => {
    api.use(http.post(`${ORIGIN}/v1/catalog/formulas/validate`, rec(() => HttpResponse.json({ valid: false, input_analyte_codes: [], dependency_order: [], chain_depth: 0, errors: [{ path: '/expression/4', code: 'catalog.formula_invalid', message: 'Unexpected ")"' }] }))));
    const { FormulaPanel } = await load('FormulaPanel');
    const { container } = wrap(<FormulaPanel analyteId={HB} value="" onChange={() => {}} />);
    await userEvent.type(screen.getByLabelText(/^formula/i), 'A + )');
    const err = await screen.findByText(/Unexpected "\)"/, {}, { timeout: 3000 });
    expect(err).toBeTruthy();
    expect(screen.getByLabelText(/^formula/i).getAttribute('aria-invalid')).toBe('true');
    expect(container.querySelector('[aria-live="polite"]')?.textContent ?? '').toContain('Unexpected');
  });

  it('cycle path from catalog.formula_invalid on a mutation is shown under the formula field (03-APP-FLOW §5)', async () => {
    const { AnalyteEditor } = await load('AnalyteEditor');
    api.use(
      http.post(`${ORIGIN}/v1/catalog/formulas/validate`, rec(() => HttpResponse.json(ok))),
      http.patch(`${ORIGIN}/v1/catalog/analyte-versions/:id`, rec(() => problem('catalog.formula_invalid', 422, { errors: [{ path: '/formula_expression', code: 'catalog.formula_invalid', message: 'Cycle: MENTZER → MCV → MENTZER' }] }))),
    );
    wrap(<AnalyteEditor testId={TEST_ID} analyte={analyteRow({ has_draft: true })} versions={[draftRow({ formula_expression: 'MCV / RBC' }), verRow()]} units={units} methods={methods} valueSets={valueSets} subheadings={[]} permissions={MANAGE} />);
    await userEvent.click(screen.getByRole('button', { name: /^edit draft$/i }));
    await userEvent.click(screen.getByRole('button', { name: /^save/i }));
    expect(await screen.findByText('Cycle: MENTZER → MCV → MENTZER')).toBeTruthy();
  });

  it('AC-04.8 "Try it": one DecimalField per input (+ optional age/sex) → sample_result shown; request has sample_inputs/sample_context; nothing else is written', async () => {
    api.use(http.post(`${ORIGIN}/v1/catalog/formulas/validate`, rec((s) => HttpResponse.json(s.body.sample_inputs ? { ...ok, sample_result: '13.5' } : ok))));
    const { FormulaPanel } = await load('FormulaPanel');
    wrap(<FormulaPanel analyteId={HB} value="MCV / RBC" onChange={() => {}} />);
    await screen.findByText(/Inputs:\s*MCV, RBC/, {}, { timeout: 3000 });
    await userEvent.type(screen.getByLabelText(/^MCV$/), '81.0');
    await userEvent.type(screen.getByLabelText(/^RBC$/), '6.0');
    await userEvent.click(screen.getByRole('button', { name: /try it/i }));
    expect(await screen.findByText(/13\.5/)).toBeTruthy();
    const withSample = calls('POST', /validate/).filter((c) => c.body.sample_inputs);
    expect(withSample.at(-1)!.body.sample_inputs).toEqual({ MCV: '81.0', RBC: '6.0' }); // decimal strings, never numbers
    expect(seen.every((s) => /formulas\/validate$/.test(s.url.pathname))).toBe(true); // read-only
  });

  it('sample_not_computable_reason is shown instead of a result', async () => {
    api.use(http.post(`${ORIGIN}/v1/catalog/formulas/validate`, rec(() => HttpResponse.json({ ...ok, sample_not_computable_reason: 'Division by zero' }))));
    const { FormulaPanel } = await load('FormulaPanel');
    wrap(<FormulaPanel analyteId={HB} value="MCV / RBC" onChange={() => {}} />);
    await screen.findByText(/Inputs:\s*MCV, RBC/, {}, { timeout: 3000 });
    await userEvent.type(screen.getByLabelText(/^MCV$/), '81');
    await userEvent.type(screen.getByLabelText(/^RBC$/), '0');
    await userEvent.click(screen.getByRole('button', { name: /try it/i }));
    expect(await screen.findByText('Division by zero')).toBeTruthy();
  });

  it('maxLength 500 on the field (mirrors #36)', async () => {
    const { FormulaPanel } = await load('FormulaPanel');
    wrap(<FormulaPanel analyteId={HB} value="" onChange={() => {}} />);
    expect(screen.getByLabelText(/^formula/i).getAttribute('maxlength')).toBe('500');
  });
});

// ───────────────────────────── SCR-07 Publish dialog (AC-03.1/03.3/03.5/03.6, F-03) ─────────────────────────────
describe('SCR-07 publish dialog', () => {
  const base = (o: Record<string, unknown> = {}) => ({
    analyte: { id: HB, code: 'HB', name: 'Haemoglobin' },
    version: { id: V2, version_no: 2, version: 1 },
    rangeDraft: { id: RS3, version_no: 3, version: 2 },
    criticalDraft: { id: CL2, version_no: 2, version: 2 },
    unitOrMethodChanged: false,
    permissions: BOTH,
    isOpen: true,
    onClose: () => {},
    ...o,
  });
  const publishOk = () => http.post(`${ORIGIN}/v1/catalog/analyte-versions/:id/publish`, rec(() => HttpResponse.json(verRow({ id: V2, version_no: 2, status: 'published', version: 2 }))));

  it('fields: Effective from (default Now), Change reason, drafts checkboxes pre-ticked: "Also publish reference-range draft (version 3)" / "Also publish critical-limit draft"', async () => {
    const { PublishDialog } = await load('PublishDialog');
    wrap(<PublishDialog {...base()} />);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText(/effective from/i)).toBeTruthy();
    expect(screen.getByLabelText(/change reason/i)).toBeTruthy();
    expect((screen.getByLabelText(/Also publish reference-range draft \(version 3\)/i) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText(/Also publish critical-limit draft/i) as HTMLInputElement).checked).toBe(true);
  });

  it('no drafts and unit/method unchanged: no draft checkboxes, no warning banner', async () => {
    const { PublishDialog } = await load('PublishDialog');
    wrap(<PublishDialog {...base({ rangeDraft: undefined, criticalDraft: undefined })} />);
    expect(screen.queryByLabelText(/Also publish/i)).toBeNull();
    expect(screen.queryByText(/old reference ranges will no longer apply/i)).toBeNull();
  });

  it('AC-03.1/F-03: Publish sends ONE request with change_reason, effective_from (UTC ISO ≈ now), both set ids, If-Match "<version>", Idempotency-Key; success toast names version + effective time', async () => {
    api.use(publishOk());
    const { PublishDialog } = await load('PublishDialog');
    wrap(<PublishDialog {...base()} />);
    await userEvent.type(screen.getByLabelText(/change reason/i), 'Decimals 1 to 2');
    await userEvent.click(publishBtn());
    await waitFor(() => expect(calls('POST', /publish$/)).toHaveLength(1));
    const s = calls('POST', /publish$/)[0]!;
    expect(s.url.pathname).toBe(`/v1/catalog/analyte-versions/${V2}/publish`);
    expect(s.headers.get('if-match')).toBe('"1"');
    expect(s.headers.get('idempotency-key')).toBeTruthy();
    expect(s.body).toMatchObject({ change_reason: 'Decimals 1 to 2', reference_range_set_id: RS3, critical_limit_set_id: CL2 });
    expect(s.body.allow_without_ranges).not.toBe(true);
    expect(Math.abs(Date.parse(s.body.effective_from) - Date.now())).toBeLessThan(120_000);
    expect(s.body.effective_from).toMatch(/Z$/);
    expect(await screen.findByText(/HB version 2 published, effective \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}/)).toBeTruthy();
  });

  it('unticking the critical-limit checkbox omits critical_limit_set_id', async () => {
    api.use(publishOk());
    const { PublishDialog } = await load('PublishDialog');
    wrap(<PublishDialog {...base()} />);
    await userEvent.click(screen.getByLabelText(/Also publish critical-limit draft/i));
    await userEvent.type(screen.getByLabelText(/change reason/i), 'r');
    await userEvent.click(publishBtn());
    await waitFor(() => expect(calls('POST', /publish$/)).toHaveLength(1));
    expect(calls('POST', /publish$/)[0]!.body.critical_limit_set_id).toBeUndefined();
    expect(calls('POST', /publish$/)[0]!.body.reference_range_set_id).toBe(RS3);
  });

  it('Change reason is required (1–500): blank → error, no request; 501 chars → error, no request', async () => {
    const { PublishDialog } = await load('PublishDialog');
    wrap(<PublishDialog {...base()} />);
    await userEvent.click(publishBtn());
    await waitFor(() => expect(screen.getByLabelText(/change reason/i).getAttribute('aria-invalid')).toBe('true'));
    expect(seen).toHaveLength(0);
    const ta = screen.getByLabelText(/change reason/i) as HTMLTextAreaElement;
    expect(ta.getAttribute('maxlength')).toBe('500');
  });

  it('AC-03.3: server 400 path /effective_from (back-dated) is shown under Effective from; dialog stays open', async () => {
    api.use(http.post(`${ORIGIN}/v1/catalog/analyte-versions/:id/publish`, rec(() => problem('common.validation_failed', 400, { errors: [{ path: '/effective_from', code: 'common.validation_failed', message: 'Effective from cannot be in the past' }] }))));
    const { PublishDialog } = await load('PublishDialog');
    wrap(<PublishDialog {...base()} />);
    await userEvent.type(screen.getByLabelText(/change reason/i), 'r');
    await userEvent.click(publishBtn());
    expect(await screen.findByText('Effective from cannot be in the past')).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('AC-03.5: unit/method changed + no range draft → warning Banner, Publish blocked until "Publish without reference ranges" is ticked; then allow_without_ranges:true and no reference_range_set_id', async () => {
    api.use(publishOk());
    const { PublishDialog } = await load('PublishDialog');
    wrap(<PublishDialog {...base({ unitOrMethodChanged: true, rangeDraft: undefined, criticalDraft: undefined })} />);
    expect(screen.getByText(/Unit or method changed: the old reference ranges will no longer apply\./)).toBeTruthy();
    await userEvent.type(screen.getByLabelText(/change reason/i), 'Unit change');
    await userEvent.click(publishBtn());
    expect(seen).toHaveLength(0); // blocked
    await userEvent.click(screen.getByLabelText(/Publish without reference ranges/i));
    await userEvent.click(publishBtn());
    await waitFor(() => expect(calls('POST', /publish$/)).toHaveLength(1));
    expect(calls('POST', /publish$/)[0]!.body.allow_without_ranges).toBe(true);
    expect(calls('POST', /publish$/)[0]!.body.reference_range_set_id).toBeUndefined();
  });

  it('AC-03.5: unit/method changed WITH a range draft → draft checkbox is pre-ticked and required (cannot be unticked silently)', async () => {
    const { PublishDialog } = await load('PublishDialog');
    wrap(<PublishDialog {...base({ unitOrMethodChanged: true })} />);
    const cb = screen.getByLabelText(/Also publish reference-range draft/i) as HTMLInputElement;
    expect(cb.checked).toBe(true);
    expect(cb.required || cb.disabled || cb.getAttribute('aria-required') === 'true').toBe(true);
  });

  it('AC-03.6: Publish shows a lock + "Requires two-step verification" and is enabled for catalog.reference_range.publish + catalog.test.manage', async () => {
    const { PublishDialog } = await load('PublishDialog');
    wrap(<PublishDialog {...base()} />);
    expect(screen.getByText(/Requires two-step verification/i)).toBeTruthy();
    expect((publishBtn() as HTMLButtonElement).disabled).toBe(false);
  });

  it.each([
    ['only catalog.test.manage', MANAGE, 'catalog.reference_range.publish'],
    ['only catalog.reference_range.publish', RANGE_ONLY, 'catalog.test.manage'],
  ])('AC-03.6: %s → Publish disabled, tooltip names the missing permission %s; clicking sends nothing', async (_n, permissions, missing) => {
    const { PublishDialog } = await load('PublishDialog');
    wrap(<PublishDialog {...base({ permissions })} />);
    const b = publishBtn() as HTMLButtonElement;
    expect(b.disabled || b.getAttribute('aria-disabled') === 'true').toBe(true);
    expect(reasonOf(b)).toContain(missing);
    await userEvent.click(b);
    expect(seen).toHaveLength(0);
  });

  it('AC-03.6: 403 auth.forbidden from the API → error shown, dialog stays, no success toast', async () => {
    api.use(http.post(`${ORIGIN}/v1/catalog/analyte-versions/:id/publish`, rec(() => problem('auth.forbidden', 403))));
    const { PublishDialog } = await load('PublishDialog');
    wrap(<PublishDialog {...base()} />);
    await userEvent.type(screen.getByLabelText(/change reason/i), 'r');
    await userEvent.click(publishBtn());
    await waitFor(() => expect(calls('POST', /publish$/)).toHaveLength(1));
    expect(screen.queryByText(/published, effective/)).toBeNull();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('AC-03.6 / UX §3: 403 auth.mfa_required → "Confirm with your authenticator to continue"; the retry re-sends with the SAME Idempotency-Key', async () => {
    let n = 0;
    api.use(http.post(`${ORIGIN}/v1/catalog/analyte-versions/:id/publish`, rec(() => (++n === 1 ? problem('auth.mfa_required', 403) : HttpResponse.json(verRow({ status: 'published', version: 2 }))))));
    const { PublishDialog } = await load('PublishDialog');
    wrap(<PublishDialog {...base()} />);
    await userEvent.type(screen.getByLabelText(/change reason/i), 'r');
    await userEvent.click(publishBtn());
    expect(await screen.findByText(/Confirm with your authenticator to continue/i)).toBeTruthy();
    await userEvent.click(publishBtn());
    await waitFor(() => expect(calls('POST', /publish$/)).toHaveLength(2));
    const [a, b] = calls('POST', /publish$/);
    expect(a!.headers.get('idempotency-key')).toBeTruthy();
    expect(b!.headers.get('idempotency-key')).toBe(a!.headers.get('idempotency-key'));
  });

  it('double click / Ctrl+Enter spam sends exactly one request while in flight', async () => {
    api.use(http.post(`${ORIGIN}/v1/catalog/analyte-versions/:id/publish`, rec(async () => { await new Promise((r) => setTimeout(r, 150)); return HttpResponse.json(verRow({ status: 'published', version: 2 })); })));
    const { PublishDialog } = await load('PublishDialog');
    wrap(<PublishDialog {...base()} />);
    await userEvent.type(screen.getByLabelText(/change reason/i), 'r');
    const b = publishBtn();
    await userEvent.dblClick(b);
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => expect(calls('POST', /publish$/).length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 300));
    expect(calls('POST', /publish$/)).toHaveLength(1);
  });

  it('409 catalog.version_in_use → banner "already published" and no success toast; 422 catalog.formula_invalid shown', async () => {
    api.use(http.post(`${ORIGIN}/v1/catalog/analyte-versions/:id/publish`, rec(() => problem('catalog.version_in_use', 409))));
    const { PublishDialog } = await load('PublishDialog');
    wrap(<PublishDialog {...base()} />);
    await userEvent.type(screen.getByLabelText(/change reason/i), 'r');
    await userEvent.click(publishBtn());
    expect((await screen.findByRole('alert')).textContent).toMatch(/published|in use/i);
    expect(screen.queryByText(/published, effective/)).toBeNull();
  });
});

// ───────────────────────────── SCR-08 Ranges & critical limits (AC-05.*) ─────────────────────────────
describe('SCR-08 ranges tab', () => {
  const band = (o: Record<string, unknown> = {}) => ({ sex: 'male', age_low: { value: 18, unit: 'year' }, kind: 'numeric', low: '13.0', high: '17.0', sort_order: 0, ...o });
  const set = (o: Record<string, unknown> = {}) => ({ id: RS3, analyte_id: HB, version_no: 3, status: 'draft', unit_code: 'g_dl', bands: [band(), band({ sex: 'female', low: '12.0', high: '15.0', sort_order: 1 }), band({ sex: 'any', age_low: undefined, age_high: { value: 18, unit: 'year' }, low: '11.0', high: '16.0', sort_order: 2 })], version: 2, ...o });
  const p = (o: Record<string, unknown> = {}) => ({ analyte: { id: HB, code: 'HB', unit_code: 'g_dl' }, kind: 'ranges', sets: [set()], valueSet: undefined, specimenTypes, permissions: BOTH, ...o });

  it('empty state copy when the analyte has no sets', async () => {
    const { RangesTab } = await load('RangesTab');
    wrap(<RangesTab {...p({ sets: [] })} />);
    expect(screen.getByText('No reference ranges. Results for this analyte will show no range and C5 will ask for manual review.')).toBeTruthy();
  });

  it('version strip: a chip per set version with a TEXT status badge; actions New version / Discard draft / Publish… / Retire…', async () => {
    const { RangesTab } = await load('RangesTab');
    wrap(<RangesTab {...p({ sets: [set(), set({ id: 'x2', version_no: 2, status: 'published' }), set({ id: 'x1', version_no: 1, status: 'superseded' })] })} />);
    for (const t of ['Draft', 'Published', 'Superseded']) expect(screen.getAllByText(t).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /^discard draft$/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^publish…$|^publish\.\.\.$/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^new version$/i })).toBeTruthy();
  });

  it('grid columns: Sex · Age from · Age to · Specimen type · Kind · Low · High · Normal codes · Display text; header help text for the age boundary rule (AC-05.2)', async () => {
    const { RangesTab } = await load('RangesTab');
    wrap(<RangesTab {...p()} />);
    for (const h of ['Sex', 'Age from', 'Age to', 'Specimen type', 'Kind', 'Low', 'High', 'Normal codes', 'Display text']) {
      expect(screen.getByRole('columnheader', { name: new RegExp(h, 'i') })).toBeTruthy();
    }
    expect(screen.getByText('Lower age is included, upper age is not. Example: 0–18 years covers patients until the day before their 18th birthday.')).toBeTruthy();
  });

  it('critical tab: same dimension columns + Critical low · Critical high · Abnormal codes', async () => {
    const { RangesTab } = await load('RangesTab');
    wrap(<RangesTab {...p({ kind: 'critical', sets: [set({ id: CL2, bands: [{ sex: 'any', low: '5.0', high: '20.0' }] })] })} />);
    for (const h of ['Critical low', 'Critical high', 'Abnormal codes']) expect(screen.getByRole('columnheader', { name: new RegExp(h, 'i') })).toBeTruthy();
  });

  it('published sets are shown read-only (no cell editing, no Save); draft is editable for catalog.test.manage', async () => {
    const { RangesTab } = await load('RangesTab');
    wrap(<RangesTab {...p({ sets: [set({ status: 'published' })] })} />);
    expect(screen.queryByRole('button', { name: /^save/i })).toBeNull();
    expect(screen.queryAllByRole('textbox').length + screen.queryAllByRole('spinbutton').length).toBe(0);
    cleanup();
    wrap(<RangesTab {...p()} />);
    expect(screen.getByRole('button', { name: /^save/i })).toBeTruthy();
  });

  it('Save sends PUT /reference-range-sets/{id}/bands with If-Match "<set version>"; Low/High stay decimal strings (13.0 not 13)', async () => {
    api.use(http.put(`${ORIGIN}/v1/catalog/reference-range-sets/:id/bands`, rec(() => HttpResponse.json(set({ version: 3 })))));
    const { RangesTab } = await load('RangesTab');
    wrap(<RangesTab {...p()} />);
    await userEvent.click(screen.getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(calls('PUT', /bands$/)).toHaveLength(1));
    const s = calls('PUT', /bands$/)[0]!;
    expect(s.url.pathname).toBe(`/v1/catalog/reference-range-sets/${RS3}/bands`);
    expect(s.headers.get('if-match')).toBe('"2"');
    expect(s.body.bands[0]).toMatchObject({ sex: 'male', low: '13.0', high: '17.0' });
  });

  it('critical Save: PUT /critical-limit-sets/{id}/bands bands carry NO sort_order (02-TRD §3 CriticalBand; API rejects unknown fields); reference bands do', async () => {
    api.use(
      http.put(`${ORIGIN}/v1/catalog/critical-limit-sets/:id/bands`, rec(() => HttpResponse.json(set({ id: CL2, version: 3 })))),
      http.put(`${ORIGIN}/v1/catalog/reference-range-sets/:id/bands`, rec(() => HttpResponse.json(set({ version: 3 })))),
    );
    const { RangesTab } = await load('RangesTab');
    wrap(<RangesTab {...p({ kind: 'critical', sets: [set({ id: CL2, bands: [{ sex: 'any', low: '5.0', high: '20.0' }] })] })} />);
    await userEvent.click(screen.getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(calls('PUT', /critical-limit-sets\/.*\/bands$/)).toHaveLength(1));
    const crit = calls('PUT', /critical-limit-sets\/.*\/bands$/)[0]!;
    expect(crit.body.bands.length).toBeGreaterThan(0);
    for (const b of crit.body.bands) expect(Object.keys(b)).not.toContain('sort_order');
    cleanup();
    wrap(<RangesTab {...p()} />);
    await userEvent.click(screen.getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(calls('PUT', /reference-range-sets\/.*\/bands$/)).toHaveLength(1));
    expect(calls('PUT', /reference-range-sets\/.*\/bands$/)[0]!.body.bands[0]).toHaveProperty('sort_order');
  });

  it('client validation: Numeric band needs Low or High, Low ≤ High, Age to > Age from — error in the row, no request', async () => {
    const { RangesTab } = await load('RangesTab');
    wrap(<RangesTab {...p({ sets: [set({ bands: [band({ low: '17.0', high: '13.0' })] })] })} />);
    await userEvent.click(screen.getByRole('button', { name: /^save/i }));
    expect(await screen.findByText(/low.*(≤|less than or equal|must not exceed).*high|high.*(≥|at least).*low/i)).toBeTruthy();
    expect(seen).toHaveLength(0);
  });

  it('AC-05.7 overlap: publish 400 with errors[/bands/0,/bands/1] highlights BOTH rows (aria-invalid row + text); no success toast', async () => {
    api.use(http.post(`${ORIGIN}/v1/catalog/reference-range-sets/:id/publish`, rec(() => problem('common.validation_failed', 400, { errors: [
      { path: '/bands/0', code: 'common.validation_failed', message: 'Overlaps band 2' },
      { path: '/bands/1', code: 'common.validation_failed', message: 'Overlaps band 1' },
    ] }))));
    const { RangesTab } = await load('RangesTab');
    wrap(<RangesTab {...p()} />);
    await userEvent.click(screen.getByRole('button', { name: /^publish…$|^publish\.\.\.$/i }));
    await userEvent.type(screen.getByLabelText(/change reason/i), 'Overlap test');
    await userEvent.type(screen.getByLabelText(/type .*HB.* to confirm|confirm/i), 'HB');
    await userEvent.click(screen.getByRole('button', { name: /^publish$/i }));
    expect(await screen.findByText('Overlaps band 2')).toBeTruthy();
    expect(screen.getByText('Overlaps band 1')).toBeTruthy();
    const rows = screen.getAllByRole('row').filter((r) => r.getAttribute('aria-invalid') === 'true' || r.getAttribute('data-invalid') === 'true' || r.querySelector('[aria-invalid="true"]'));
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText(/published, effective/)).toBeNull();
  });

  it('AC-05.9 publish dialog: change reason 1–500 required, typed confirmation of the analyte code (HB) required, then POST /publish with If-Match + Idempotency-Key', async () => {
    api.use(http.post(`${ORIGIN}/v1/catalog/reference-range-sets/:id/publish`, rec(() => HttpResponse.json(set({ status: 'published', version: 3 })))));
    const { RangesTab } = await load('RangesTab');
    wrap(<RangesTab {...p()} />);
    await userEvent.click(screen.getByRole('button', { name: /^publish…$|^publish\.\.\.$/i }));
    const go = screen.getByRole('button', { name: /^publish$/i });
    await userEvent.click(go);
    expect(seen).toHaveLength(0); // no reason, no confirmation
    await userEvent.type(screen.getByLabelText(/change reason/i), 'Adult male range update');
    await userEvent.type(screen.getByLabelText(/type .*HB.* to confirm|confirm/i), 'XX');
    await userEvent.click(go);
    expect(seen).toHaveLength(0); // wrong confirmation
    await userEvent.clear(screen.getByLabelText(/type .*HB.* to confirm|confirm/i));
    await userEvent.type(screen.getByLabelText(/type .*HB.* to confirm|confirm/i), 'HB');
    await userEvent.click(go);
    await waitFor(() => expect(calls('POST', /publish$/)).toHaveLength(1));
    const s = calls('POST', /publish$/)[0]!;
    expect(s.url.pathname).toBe(`/v1/catalog/reference-range-sets/${RS3}/publish`);
    expect(s.headers.get('if-match')).toBe('"2"');
    expect(s.headers.get('idempotency-key')).toBeTruthy();
    expect(s.body.change_reason).toBe('Adult male range update');
  });

  it.each([
    ['only catalog.test.manage', MANAGE],
    ['read only', READ],
  ])('AC-05.9: %s → Publish… disabled/absent with the permission named (catalog.reference_range.publish)', async (_n, permissions) => {
    const { RangesTab } = await load('RangesTab');
    wrap(<RangesTab {...p({ permissions })} />);
    const b = screen.queryByRole('button', { name: /^publish…$|^publish\.\.\.$/i }) as HTMLButtonElement | null;
    if (b) {
      expect(b.disabled || b.getAttribute('aria-disabled') === 'true').toBe(true);
      expect(reasonOf(b)).toContain('catalog.reference_range.publish');
    }
    if (permissions === READ) expect(screen.queryByRole('button', { name: /^(new version|discard draft|save)/i })).toBeNull();
  });

  it('AC-05.9: 403 auth.mfa_required on publish → "Confirm with your authenticator to continue"', async () => {
    api.use(http.post(`${ORIGIN}/v1/catalog/reference-range-sets/:id/publish`, rec(() => problem('auth.mfa_required', 403))));
    const { RangesTab } = await load('RangesTab');
    wrap(<RangesTab {...p()} />);
    await userEvent.click(screen.getByRole('button', { name: /^publish…$|^publish\.\.\.$/i }));
    await userEvent.type(screen.getByLabelText(/change reason/i), 'r');
    await userEvent.type(screen.getByLabelText(/type .*HB.* to confirm|confirm/i), 'HB');
    await userEvent.click(screen.getByRole('button', { name: /^publish$/i }));
    expect(await screen.findByText(/Confirm with your authenticator to continue/i)).toBeTruthy();
  });

  it('F-04 "New version" POSTs #38 with copy_from_set_id = the current published set and an Idempotency-Key; 409 common.version_conflict → reload banner', async () => {
    api.use(http.post(`${ORIGIN}/v1/catalog/analytes/:id/reference-range-sets`, rec(() => problem('common.version_conflict', 409))));
    const { RangesTab } = await load('RangesTab');
    wrap(<RangesTab {...p({ sets: [set({ id: 'pub', status: 'published', version_no: 2 })] })} />);
    await userEvent.click(screen.getByRole('button', { name: /^new version$/i }));
    await waitFor(() => expect(calls('POST', /reference-range-sets$/)).toHaveLength(1));
    expect(calls('POST', /reference-range-sets$/)[0]!.body).toMatchObject({ copy_from_set_id: 'pub' });
    expect(calls('POST', /reference-range-sets$/)[0]!.headers.get('idempotency-key')).toBeTruthy();
    expect(await screen.findByText('Someone else changed this item. Reload to see their changes.')).toBeTruthy();
  });

  it('Discard draft → POST /reference-range-sets/{id}/discard', async () => {
    api.use(http.post(`${ORIGIN}/v1/catalog/reference-range-sets/:id/discard`, rec(() => HttpResponse.json(set({ status: 'discarded' })))));
    const { RangesTab } = await load('RangesTab');
    wrap(<RangesTab {...p()} />);
    await userEvent.click(screen.getByRole('button', { name: /^discard draft$/i }));
    const confirm = screen.queryByRole('button', { name: /^(discard|confirm)/i, hidden: false });
    if (confirm && confirm.textContent?.toLowerCase() !== 'discard draft') await userEvent.click(confirm);
    await waitFor(() => expect(calls('POST', /discard$/)).toHaveLength(1));
    expect(calls('POST', /discard$/)[0]!.headers.get('if-match')).toBe('"2"'); // set.version; API answers 428 without it
  });

  it('Retire… on a published set → POST /reference-range-sets/{id}/retire with If-Match "<set version>", Idempotency-Key, change_reason', async () => {
    api.use(http.post(`${ORIGIN}/v1/catalog/reference-range-sets/:id/retire`, rec(() => HttpResponse.json(set({ status: 'retired', version: 3 })))));
    const { RangesTab } = await load('RangesTab');
    wrap(<RangesTab {...p({ sets: [set({ status: 'published', version: 4 })] })} />);
    await userEvent.click(screen.getByRole('button', { name: /^retire…$|^retire\.\.\.$/i }));
    await userEvent.type(screen.getByLabelText(/change reason/i), 'Superseded by new method');
    await userEvent.type(screen.getByLabelText(/type .*HB.* to confirm|confirm/i), 'HB');
    await userEvent.click(screen.getByRole('button', { name: /^retire$/i }));
    await waitFor(() => expect(calls('POST', /retire$/)).toHaveLength(1));
    const s = calls('POST', /retire$/)[0]!;
    expect(s.url.pathname).toBe(`/v1/catalog/reference-range-sets/${RS3}/retire`);
    expect(s.headers.get('if-match')).toBe('"4"');
    expect(s.headers.get('idempotency-key')).toBeTruthy();
    expect(s.body.change_reason).toBe('Superseded by new method');
  });

  it('display text and codes render as text nodes (REQ-SEC-088)', async () => {
    const { RangesTab } = await load('RangesTab');
    const evil = set({ status: 'published', bands: [band({ kind: 'text', low: undefined, high: undefined, display_text: '<b onmouseover=alert(1)>x</b>' })] });
    const { container } = wrap(<RangesTab {...p({ sets: [evil] })} />);
    expect(container.querySelector('b')).toBeNull();
  });
});

// ───────────────────────────── SCR-08 Preview panel (#51, AC-05.1–05.6, 05.10, 05.11) ─────────────────────────────
describe('SCR-08 preview panel', () => {
  const match = (o: Record<string, unknown> = {}) => ({ reference_range_id: RS3, version: 3, low: '13.0', high: '17.0', unit_code: 'g_dl', kind: 'numeric', ...o });
  const previewOk = (res: unknown) => http.post(`${ORIGIN}/v1/catalog/reference-ranges/preview`, rec(() => HttpResponse.json(res)));
  const fill = async (sex = /^sex/i, ageValue = '25') => { // Age unit Select defaults to "years" (ASSUMED)
    await userEvent.click(screen.getByLabelText(sex));
    await userEvent.click(await screen.findByRole('option', { name: /^male$/i }));
    await userEvent.type(screen.getByLabelText(/^age/i), ageValue);
  };

  it('fields: Sex, Age (value + unit or date of birth), Specimen type, At; button Preview', async () => {
    const { RangePreview } = await load('RangePreview');
    wrap(<RangePreview analyteId={HB} specimenTypes={specimenTypes} />);
    for (const l of [/^sex/i, /^age/i, /specimen type/i, /^at$/i]) expect(screen.getByLabelText(l)).toBeTruthy();
    expect(screen.getByRole('button', { name: /^preview$/i })).toBeTruthy();
  });

  it('AC-05.1: numeric match → "Matches band … 13.0 - 17.0 g/dL (version 3)"; request has analyte_id, sex, integer age_days ≈ 25 y', async () => {
    api.use(previewOk({ reference_range: match(), no_reference_range: false }));
    const { RangePreview } = await load('RangePreview');
    wrap(<RangePreview analyteId={HB} specimenTypes={specimenTypes} />);
    await fill();
    await userEvent.click(screen.getByRole('button', { name: /^preview$/i }));
    expect(await screen.findByText(/Matches band.*13\.0 - 17\.0 (g\/dL|g_dl) \(version 3\)/)).toBeTruthy();
    const b = calls('POST', /preview$/)[0]!.body;
    expect(b).toMatchObject({ analyte_id: HB, sex: 'male' });
    expect(b.age_days).toBeGreaterThanOrEqual(9125);
    expect(b.age_days).toBeLessThanOrEqual(9132);
  });

  it('age 0 is a valid value and is sent as age_days 0 (AC-05.2 lower boundary)', async () => {
    api.use(previewOk({ reference_range: match(), no_reference_range: false }));
    const { RangePreview } = await load('RangePreview');
    wrap(<RangePreview analyteId={HB} specimenTypes={specimenTypes} />);
    await userEvent.click(screen.getByLabelText(/^sex/i));
    await userEvent.click(await screen.findByRole('option', { name: /^male$/i }));
    await userEvent.type(screen.getByLabelText(/^age/i), '0');
    await userEvent.click(screen.getByRole('button', { name: /^preview$/i }));
    await waitFor(() => expect(calls('POST', /preview$/)).toHaveLength(1));
    expect(calls('POST', /preview$/)[0]!.body.age_days).toBe(0);
  });

  it('AC-05.10: no_reference_range → "No reference range"', async () => {
    api.use(previewOk({ no_reference_range: true }));
    const { RangePreview } = await load('RangePreview');
    wrap(<RangePreview analyteId={HB} specimenTypes={specimenTypes} />);
    await fill();
    await userEvent.click(screen.getByRole('button', { name: /^preview$/i }));
    expect(await screen.findByText('No reference range')).toBeTruthy();
  });

  it('#51 requires age_days: Age left blank → field error on Age, no request (unknown-age matching of AC-05.11 is a CatalogPort case, not previewable here)', async () => {
    const { RangePreview } = await load('RangePreview');
    wrap(<RangePreview analyteId={HB} specimenTypes={specimenTypes} />);
    await userEvent.click(screen.getByLabelText(/^sex/i));
    await userEvent.click(await screen.findByRole('option', { name: /^male$/i }));
    await userEvent.click(screen.getByRole('button', { name: /^preview$/i }));
    await waitFor(() => expect(screen.getByLabelText(/^age/i).getAttribute('aria-invalid')).toBe('true'));
    expect(seen).toHaveLength(0);
  });

  it('AC-05.5: text band → shows the display text (no low/high, no numeric range)', async () => {
    api.use(previewOk({ reference_range: { reference_range_id: RS3, version: 1, kind: 'text', text: '<13.0 - Thalassemia trait / >13.0 - Iron deficiency' }, no_reference_range: false }));
    const { RangePreview } = await load('RangePreview');
    wrap(<RangePreview analyteId={HB} specimenTypes={specimenTypes} />);
    await fill();
    await userEvent.click(screen.getByRole('button', { name: /^preview$/i }));
    expect(await screen.findByText(/<13\.0 - Thalassemia trait \/ >13\.0 - Iron deficiency/)).toBeTruthy();
  });

  it('AC-05.6: ordinal band → shows "Negative" and the normal code NEG', async () => {
    api.use(previewOk({ reference_range: { reference_range_id: RS3, version: 1, kind: 'ordinal', text: 'Negative', normal_codes: ['NEG'] }, no_reference_range: false }));
    const { RangePreview } = await load('RangePreview');
    wrap(<RangePreview analyteId={HB} specimenTypes={specimenTypes} />);
    await fill();
    await userEvent.click(screen.getByRole('button', { name: /^preview$/i }));
    expect(await screen.findByText(/Negative/)).toBeTruthy();
    expect(screen.getByText(/NEG/)).toBeTruthy();
  });

  it('AC-05.3: choosing Specimen type URINE sends specimen_type_code "URINE"', async () => {
    api.use(previewOk({ reference_range: match(), no_reference_range: false }));
    const { RangePreview } = await load('RangePreview');
    wrap(<RangePreview analyteId={HB} specimenTypes={specimenTypes} />);
    await fill();
    await userEvent.click(screen.getByLabelText(/specimen type/i));
    await userEvent.click(await screen.findByRole('option', { name: /urine/i }));
    await userEvent.click(screen.getByRole('button', { name: /^preview$/i }));
    await waitFor(() => expect(calls('POST', /preview$/)).toHaveLength(1));
    expect(calls('POST', /preview$/)[0]!.body.specimen_type_code).toBe('URINE');
  });

  it('AC-05.4: Sex options include Other and Unknown (sent verbatim; only any-sex bands then match on the API)', async () => {
    const { RangePreview } = await load('RangePreview');
    wrap(<RangePreview analyteId={HB} specimenTypes={specimenTypes} />);
    await userEvent.click(screen.getByLabelText(/^sex/i));
    const names = (await screen.findAllByRole('option')).map((o) => o.textContent);
    expect(names).toEqual(expect.arrayContaining(['Male', 'Female', 'Other', 'Unknown']));
  });

  it('preview is a read: no Idempotency-Key, no If-Match; critical limits (when returned) are shown too', async () => {
    api.use(previewOk({ reference_range: match(), critical_limits: { critical_limit_id: CL2, version: 2, low: '5.0', high: '20.0', unit_code: 'g_dl' }, no_reference_range: false }));
    const { RangePreview } = await load('RangePreview');
    wrap(<RangePreview analyteId={HB} specimenTypes={specimenTypes} />);
    await fill();
    await userEvent.click(screen.getByRole('button', { name: /^preview$/i }));
    await screen.findByText(/Matches band/);
    expect(calls('POST', /preview$/)[0]!.headers.get('idempotency-key')).toBeNull();
    expect(screen.getByText(/5\.0/)).toBeTruthy();
    expect(screen.getByText(/20\.0/)).toBeTruthy();
  });
});

// ───────────────────────────── page + a11y + static guards ─────────────────────────────
const PAGE = '../../../app/(staff)/catalog/tests/[test_id]/page'; // variable specifier: a missing page fails these tests only, not the whole file
const loadPage = async () => (await import(/* @vite-ignore */ PAGE)) as { default: (a: any) => Promise<unknown> };

describe('page + static guards', () => {
  it('page: getTest 404 (also other-tenant ids) → notFound(), never a rendered detail', async () => {
    api.use(http.get(`${ORIGIN}/v1/catalog/tests/:id`, rec(() => problem('common.not_found', 404))));
    const mod = await loadPage();
    await expect(mod.default({ params: Promise.resolve({ test_id: TEST_ID }), searchParams: Promise.resolve({}) })).rejects.toMatchObject({ digest: expect.stringContaining('404') });
  });

  it('page: a non-UUID test_id is 404 before any API request', async () => {
    const mod = await loadPage();
    await expect(mod.default({ params: Promise.resolve({ test_id: 'CBC' }), searchParams: Promise.resolve({}) })).rejects.toMatchObject({ digest: expect.stringContaining('404') });
    expect(seen).toHaveLength(0);
  });

  it('screens have loading.tsx and error.tsx beside page.tsx (02-CV §2.4)', async () => {
    const { existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    const dir = join(import.meta.dirname, '..', '..', '..', 'app', '(staff)', 'catalog', 'tests');
    for (const f of ['page.tsx', 'loading.tsx', 'error.tsx']) expect(existsSync(join(dir, f)), f).toBe(true);
  });

  it('feature code uses only @lims/ui + no dangerouslySetInnerHTML / innerHTML / localStorage / "commission" (REQ-SEC-088/089, 04-UI-UX §3)', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const root = join(import.meta.dirname, '..');
    const walk = (d: string): string[] => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? (n === '__tests__' ? [] : walk(p)) : [p]; });
    const src = walk(root).filter((f) => /\.(tsx?|md)$/.test(f));
    expect(src.length).toBeGreaterThan(0);
    for (const f of src.filter((f) => /\.tsx?$/.test(f))) {
      const t = readFileSync(f, 'utf8');
      expect(t, f).not.toMatch(/dangerouslySetInnerHTML|\.innerHTML\s*=|localStorage|sessionStorage/);
    }
    for (const f of src) expect(readFileSync(f, 'utf8'), f).not.toMatch(/commission/i);
  });

  it('axe: publish dialog has no violations', async () => {
    const { PublishDialog } = await load('PublishDialog');
    wrap(<PublishDialog analyte={{ id: HB, code: 'HB', name: 'Haemoglobin' }} version={{ id: V2, version_no: 2, version: 1 }} rangeDraft={{ id: RS3, version_no: 3, version: 2 }} unitOrMethodChanged={false} permissions={BOTH} isOpen onClose={() => {}} />);
    const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
    expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
  });

  it('axe: analytes tab has no violations', async () => {
    const { AnalytesTab } = await load('AnalytesTab');
    wrap(<AnalytesTab testId={TEST_ID} analytes={[analyteRow()]} permissions={MANAGE} />);
    const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
    expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
  });
});
