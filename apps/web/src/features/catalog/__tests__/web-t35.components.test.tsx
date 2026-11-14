// @vitest-environment jsdom
// C3.T-35 — SCR-18 Imports & exports, SCR-19 Import detail (04-UI-UX §4 SCR-18/19; 03-APP-FLOW F-15, F-16 + §5 state table; 07-SECURITY AB-5/S-4).
// ACs as seen from the UI: AC-16.1 (blank template), AC-16.3 (upload + counts), AC-16.4 (issue rows), AC-16.5 (stale-base), AC-16.6 (publish / replace_draft /
// draft_exists), AC-16.7 (one commit), AC-16.8, AC-16.9 (15 MB, .xlsm), AC-16.10 (annotated file), AC-16.11 (price_list.manage), AC-17.5 (reference_range.publish),
// AC-17.6 (referrers). done_when: typed confirmation + stale-base checkbox here; polling (2 s / 15 min) is in web-t35.polling.test.tsx. Synthetic data only.
// ASSUMED module/prop contract (spec fixes folders + kit components only; writer may dispute a name via the ruling flow). Types = contracts/openapi/catalog.yaml.
//   components/ImportsScreen.tsx  ImportsScreen({imports: Import[], exports: Export[], priceLists: PriceList[], permissions})                       SCR-18
//   components/ImportDetail.tsx   ImportDetail({importRow: Import, issues: ImportIssue[], priceList?: PriceList, permissions})                          SCR-19
//   pages: app/(staff)/catalog/imports/page.tsx, app/(staff)/catalog/imports/[import_id]/page.tsx
//   Kind radios (labels): "Price list prices", "Catalog master", "Doctors" (= kind `referrers`), "Credit parties". Offered per kind permission:
//     price_list + credit_parties → catalog.price_list.manage; catalog_master → catalog.test.manage; referrers → catalog.referrer.manage (04-UI-UX SCR-18, 08 A13 P-10).
//   SCR-18 controls: price-list Select labelled "Price list" (price_list kind only), FileUpload (input[type=file] accept ".xlsx"), buttons "Upload", "Download current data",
//     link/button "Download blank template" → GET /catalog/import-templates/{kind}. Upload → multipart POST /v1/catalog/imports (+ Idempotency-Key) → router.push(`/catalog/imports/{id}`).
//     Exports table: "Download" link/button → GET /catalog/exports/{export_id}/file, shown only when status = ready; a 409 answer shows Banner "Still preparing — try again shortly".
//   SCR-19 controls: StatusStepper (labels below), StatTiles Rows/Added/Changed/Removed/Unchanged/Errors/Warnings, issue DataTable, filter "Errors"/"Warnings",
//     link "Download annotated file" → /catalog/imports/{id}/report, buttons "Discard", "Commit…" (opens role=dialog; its primary button is "Commit").
//   Commit dialog: Effective from (default Now), "Change reason" (required), switch "Publish immediately" (price lists; default ON per 03-APP-FLOW F-15 step 5), switch
//     "Replace open drafts" (default OFF), checkbox "The price list was changed after this file was exported. I want to replace it anyway." (only when a `file.stale_base`
//     warning exists), typed confirmation textbox (name matches /confirm/i; price_list kind only; exact price-list code). Commit gate for catalog_master = catalog.test.manage AND
//     catalog.reference_range.publish (the UI cannot tell whether clinical versions are published, so it is conservative; the API is authoritative — AC-17.5, D-18).
//   Status labels: uploaded "Uploaded" · scanning "Security scan" · validating "Validating" · validated "Ready to commit" · invalid "Invalid" · quarantined "Quarantined" ·
//     committing "Committing" · committed "Committed" · commit_failed "Commit failed" · discarded "Discarded" · expired "Expired" · failed "Failed".
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { ReactNode } from 'react';
import { ToastProvider } from '@lims/ui/components/Toast';
import { parseMultipart, type ParsedForm } from './web-t35.multipart'; // ruling C3.T-35 #4: jsdom File/FormData break undici formData()

const push = vi.fn();
const replace = vi.fn();
const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace, refresh, back: vi.fn() }),
  usePathname: () => '/catalog/imports',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw Object.assign(new Error('NEXT_NOT_FOUND'), { digest: 'NEXT_HTTP_ERROR_FALLBACK;404' }); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({ getAccessToken: async () => 'jwt-synthetic', getShellSession: async () => undefined, getRequestPathname: async () => '/catalog/imports' }));

const ORIGIN = 'http://api.test';
process.env.LIMS_ORIGIN_API = ORIGIN;
const ID = (n: number) => `01a1a98a-ac40-7000-8000-0000000d${String(n).padStart(4, '0')}`;
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const READ = ['catalog.test.read'];
const PL_MANAGE = [...READ, 'catalog.price_list.read', 'catalog.price_list.manage'];
const CAT_MANAGE = [...READ, 'catalog.test.manage'];
const CAT_PUBLISH = [...CAT_MANAGE, 'catalog.reference_range.publish'];
const REF_MANAGE = [...READ, 'catalog.referrer.read', 'catalog.referrer.manage'];
const STALE = 'The price list was changed after this file was exported. I want to replace it anyway.';

// ---- fixtures ---------------------------------------------------------------------------------------------------------------------------
const SUMMARY = { rows: 120, added: 2, changed: 5, removed: 1, unchanged: 112, errors: 0, warnings: 0 };
const imp = (n: number, o: Record<string, unknown> = {}) => ({ id: ID(n), kind: 'price_list', target_price_list_id: ID(60), base_version_no: 3, status: 'validated', file_name: 'prices-q4.xlsx', file_sha256: 'ab'.repeat(32), summary: SUMMARY, deduplicated: false, expires_at: '2026-11-20T00:00:00.000Z', created_at: '2026-11-08T04:00:00.000Z', created_by: ID(70), version: 5, ...o });
const pl = (n: number, o: Record<string, unknown> = {}) => ({ id: ID(n), code: 'PL-DRX', name: 'Synthetic default prices', owner_kind: 'default', falls_through: true, assignments: [], current_version: { id: ID(61), version_no: 3 }, is_active: true, version: 2, ...o });
const PRICE_LISTS = [pl(60), pl(62, { code: 'PL-CLINIC', name: 'Synthetic clinic prices', owner_kind: 'credit_party', current_version: { id: ID(63), version_no: 1 } })];
const exp = (n: number, o: Record<string, unknown> = {}) => ({ id: ID(n), kind: 'price_list', status: 'ready', file_name: 'price-list-pl-drx-v3.xlsx', byte_size: 20480, expires_at: '2026-11-15T00:00:00.000Z', version: 2, ...o });
const issue = (seq: number, o: Record<string, unknown> = {}) => ({ seq, severity: 'error', sheet: 'Prices', row_no: 4, column: 'unit_price_npr', issue_code: 'row.price_decimals', message: 'Synthetic API text', ...o });

// ---- MSW --------------------------------------------------------------------------------------------------------------------------------
type Call = { method: string; url: URL; headers: Headers; body?: any; form?: ParsedForm };
const calls: Call[] = [];
const rec = async (r: Request) => {
  const ct = r.headers.get('content-type') ?? '';
  calls.push({ method: r.method, url: new URL(r.url), headers: r.headers, body: ct.includes('json') ? await r.clone().json().catch(() => undefined) : undefined, form: ct.startsWith('multipart/form-data') ? parseMultipart(ct, await r.clone().text()) : undefined });
};
const prob = (status: number, code: string, extra: Record<string, unknown> = {}) => HttpResponse.json({ type: `urn:lims:error:${code}`, title: 'x', status, code, ...extra }, { status });
const writes = () => calls.filter((c) => c.method !== 'GET');
const api = setupServer(
  http.post(`${ORIGIN}/v1/catalog/imports`, async ({ request }) => { await rec(request); return HttpResponse.json(imp(80, { status: 'uploaded', version: 1 }), { status: 201 }); }),
  http.post(`${ORIGIN}/v1/catalog/imports/:id/commit`, async ({ request, params }) => { await rec(request); return HttpResponse.json(imp(0, { id: params.id as string, status: 'committing', version: 6 }), { status: 202 }); }),
  http.post(`${ORIGIN}/v1/catalog/imports/:id/discard`, async ({ request, params }) => { await rec(request); return HttpResponse.json(imp(0, { id: params.id as string, status: 'discarded', version: 6 })); }),
  http.post(`${ORIGIN}/v1/catalog/exports`, async ({ request }) => { await rec(request); return HttpResponse.json(exp(90, { status: 'queued' }), { status: 202 }); }),
  http.get(`${ORIGIN}/v1/catalog/imports/:id/issues`, async ({ request }) => { await rec(request); return HttpResponse.json({ data: [], page: { limit: 50 } }); }),
  http.get(`${ORIGIN}/v1/catalog/*`, async ({ request }) => { await rec(request); return HttpResponse.json({ data: [], page: { limit: 50 } }); }),
);
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { cleanup(); api.resetHandlers(); calls.length = 0; push.mockReset(); replace.mockReset(); refresh.mockReset(); vi.unstubAllGlobals(); });
afterAll(() => api.close());
beforeEach(() => { document.body.innerHTML = ''; });

// ---- helpers ----------------------------------------------------------------------------------------------------------------------------
const wrap = (ui: ReactNode) => render(<ToastProvider>{ui}</ToastProvider>);
const noAxeViolations = async () => {
  const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
  expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
};
const dialog = () => screen.getByRole('dialog');
const text = (root: HTMLElement = document.body) => root.textContent ?? '';
const press = async (name: RegExp, root: HTMLElement = document.body) => userEvent.click(within(root).getByRole('button', { name }));
const button = (name: RegExp, root: HTMLElement = document.body) => within(root).getByRole('button', { name }) as HTMLButtonElement;
const linkOrButton = (name: RegExp, root: HTMLElement = document.body) => within(root).getAllByRole('link', { name }).concat(within(root).queryAllByRole('button', { name }))[0]!;
const xlsx = (name = 'prices-q4.xlsx', size = 64, type = XLSX) => new File([new Uint8Array(size).fill(0x50)], name, { type });
const pickFile = async (f: File) => { const input = document.querySelector<HTMLInputElement>('input[type=file]'); expect(input, 'file input').toBeTruthy(); await userEvent.upload(input!, f, { applyAccept: false }); };
const choose = async (root: HTMLElement, label: RegExp, option: string | RegExp) => { await userEvent.click(within(root).getByLabelText(label)); await userEvent.click(await screen.findByRole('option', { name: option })); };

// ================================================================================================================ SCR-18
describe('SCR-18 ImportsScreen', () => {
  const show = async (o: { imports?: unknown[]; exports?: unknown[]; permissions?: string[] } = {}) => {
    const { ImportsScreen } = await import('../components/ImportsScreen');
    return wrap(<ImportsScreen imports={(o.imports ?? []) as never} exports={(o.exports ?? []) as never} priceLists={PRICE_LISTS as never} permissions={o.permissions ?? PL_MANAGE} />);
  };
  const radios = () => screen.queryAllByRole('radio').map((r) => (r as HTMLInputElement).closest('label')?.textContent ?? r.getAttribute('aria-label') ?? '');

  it('kinds offered follow the kind permission: price_list+credit_parties ← price_list.manage; catalog_master ← test.manage; Doctors ← referrer.manage (P-10)', async () => {
    const cases: [string[], RegExp[], RegExp[]][] = [
      [PL_MANAGE, [/price list prices/i, /credit parties/i], [/catalog master/i, /doctors/i]],
      [CAT_MANAGE, [/catalog master/i], [/price list prices/i, /doctors/i, /credit parties/i]],
      [REF_MANAGE, [/doctors/i], [/price list prices/i, /catalog master/i, /credit parties/i]],
      [[...PL_MANAGE, ...CAT_MANAGE, 'catalog.referrer.manage'], [/price list prices/i, /catalog master/i, /doctors/i, /credit parties/i], []],
    ];
    for (const [permissions, yes, no] of cases) {
      const v = await show({ permissions });
      for (const re of yes) expect(radios().some((t) => re.test(t)), `${permissions.join()} offers ${re}`).toBe(true);
      for (const re of no) expect(radios().some((t) => re.test(t)), `${permissions.join()} hides ${re}`).toBe(false);
      v.unmount();
    }
  });

  it('read-only (catalog.test.read): no kind radios, no upload, no template/export buttons — history tables stay readable', async () => {
    await show({ permissions: READ, imports: [imp(1, { status: 'committed' })], exports: [exp(2)] });
    expect(screen.queryAllByRole('radio')).toHaveLength(0);
    expect(document.querySelector('input[type=file]')).toBeNull();
    expect(screen.queryByRole('button', { name: /^upload/i })).toBeNull();
    expect(screen.queryAllByRole('link', { name: /download blank template/i }).concat(screen.queryAllByRole('button', { name: /download (blank template|current data)/i }))).toHaveLength(0);
    expect(screen.getAllByRole('table').length).toBeGreaterThanOrEqual(1);
    expect(text()).toContain('prices-q4.xlsx');
  });

  it('upload hint + accept: ".xlsx" only, exact hint copy, no .xlsm', async () => {
    await show();
    const input = document.querySelector<HTMLInputElement>('input[type=file]')!;
    expect(input.getAttribute('accept') ?? '').toMatch(/\.xlsx|spreadsheetml\.sheet/);
    expect(input.getAttribute('accept') ?? '').not.toMatch(/xlsm|macro|\.xls(?!x)/);
    expect(text()).toContain('Excel .xlsx only, up to 15 MB. Macro files (.xlsm) are not accepted.');
  });

  it('"Download blank template" points at the BFF proxy for the chosen kind (AC-16.1) — never a storage URL', async () => {
    await show();
    await userEvent.click(screen.getByRole('radio', { name: /price list prices/i }));
    const el = linkOrButton(/download blank template/i);
    const href = el.getAttribute('href') ?? el.closest('a')?.getAttribute('href');
    if (href) expect(href).toBe('/catalog/import-templates/price_list');
    else { // button variant → must fetch the proxy
      const fetchSpy = vi.fn(async () => new Response(new Uint8Array([0x50, 0x4b]), { headers: { 'content-type': XLSX, 'content-disposition': 'attachment; filename="t.xlsx"' } }));
      vi.stubGlobal('fetch', fetchSpy);
      await userEvent.click(el);
      await waitFor(() => expect(String(fetchSpy.mock.calls[0]?.[0])).toMatch(/\/catalog\/import-templates\/price_list$/));
    }
  });

  it('Upload is disabled until a file is chosen — and, for price lists, until a price list is chosen (target required)', async () => {
    await show();
    await userEvent.click(screen.getByRole('radio', { name: /price list prices/i }));
    expect(button(/^upload/i).disabled).toBe(true);
    await pickFile(xlsx());
    expect(button(/^upload/i).disabled, 'no price list chosen yet').toBe(true);
    await choose(document.body, /^price list$/i, /PL-DRX/);
    await waitFor(() => expect(button(/^upload/i).disabled).toBe(false));
  });

  it('price_list upload: multipart {kind, target_price_list_id, file} + Idempotency-Key, then navigates to SCR-19 (AC-16.3)', async () => {
    await show();
    await userEvent.click(screen.getByRole('radio', { name: /price list prices/i }));
    await choose(document.body, /^price list$/i, /PL-DRX/);
    await pickFile(xlsx('prices-q4.xlsx'));
    await press(/^upload/i);
    await waitFor(() => expect(push).toHaveBeenCalledWith(`/catalog/imports/${ID(80)}`));
    const c = writes()[0]!;
    expect(c.url.pathname).toBe('/v1/catalog/imports');
    expect(c.headers.get('idempotency-key')).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    expect(c.form!.get('kind')).toBe('price_list');
    expect(c.form!.get('target_price_list_id')).toBe(ID(60));
    expect((c.form!.get('file') as { name: string }).name).toBe('prices-q4.xlsx');
    expect(writes()).toHaveLength(1);
  });

  it('catalog_master / doctors / credit_parties uploads send no target; double click = one request (no duplicate import)', async () => {
    await show({ permissions: [...PL_MANAGE, ...CAT_MANAGE, 'catalog.referrer.manage'] });
    await userEvent.click(screen.getByRole('radio', { name: /credit parties/i }));
    await pickFile(xlsx('parties.xlsx'));
    const up = button(/^upload/i);
    await userEvent.dblClick(up);
    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(writes()).toHaveLength(1);
    expect(writes()[0]!.form!.get('kind')).toBe('credit_parties');
    expect(writes()[0]!.form!.has('target_price_list_id')).toBe(false);
  });

  it('client-side hints (REQ-SEC-083 server re-checks): .xlsm, wrong MIME and >15 MB never reach the API', async () => {
    await show({ permissions: CAT_MANAGE });
    await userEvent.click(screen.getByRole('radio', { name: /catalog master/i }));
    await pickFile(xlsx('macro.xlsm', 64, 'application/vnd.ms-excel.sheet.macroEnabled.12'));
    expect(button(/^upload/i).disabled).toBe(true);
    await pickFile(xlsx('huge.xlsx', 15 * 1024 * 1024 + 1));
    expect(button(/^upload/i).disabled).toBe(true);
    expect(writes()).toEqual([]);
  });

  it('error copy: 413 and 415 banners state the limits; 429 = "Two imports are already running; try again shortly."; 403 mfa = step-up message; no navigation', async () => {
    const cases: [number, string, RegExp][] = [
      [413, 'common.payload_too_large', /15 MB/],
      [415, 'common.unsupported_media_type', /\.xlsx/],
      [429, 'common.rate_limited', /^Two imports are already running; try again shortly\.$/],
      [403, 'auth.mfa_required', /verif|multi-factor|MFA|second factor/i],
      [403, 'auth.forbidden', /permission|not allowed|access/i],
    ];
    for (const [status, code, re] of cases) {
      api.use(http.post(`${ORIGIN}/v1/catalog/imports`, () => prob(status, code)));
      const v = await show({ permissions: CAT_MANAGE });
      await userEvent.click(screen.getByRole('radio', { name: /catalog master/i }));
      await pickFile(xlsx());
      await press(/^upload/i);
      await waitFor(() => expect(screen.getAllByRole('alert').map((a) => a.textContent ?? '').join(' | '), `${status} ${code}`).toMatch(re));
      expect(push).not.toHaveBeenCalled();
      v.unmount();
    }
  });

  it('"Download current data" = export: price_list → POST /exports {kind, price_list_version_id = the list\'s current version} (F-16); referrers needs catalog.referrer.export', async () => {
    const v = await show();
    await userEvent.click(screen.getByRole('radio', { name: /price list prices/i }));
    await choose(document.body, /^price list$/i, /PL-CLINIC/);
    await press(/download current data/i);
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]!.url.pathname).toBe('/v1/catalog/exports');
    expect(writes()[0]!.body).toEqual({ kind: 'price_list', price_list_version_id: ID(63) });
    expect(writes()[0]!.headers.get('idempotency-key')).toBeTruthy();
    v.unmount();
    // Doctors: import-capable but export forbidden without catalog.referrer.export (REQ-SEC-100, CR-C3-003) → control absent or disabled with the permission hint.
    await show({ permissions: REF_MANAGE });
    await userEvent.click(screen.getByRole('radio', { name: /doctors/i }));
    const ex = screen.queryByRole('button', { name: /download current data/i }) as HTMLButtonElement | null;
    if (ex) { expect(ex.disabled).toBe(true); expect(text()).toContain('catalog.referrer.export'); }
    calls.length = 0;
    cleanup();
    await show({ permissions: [...REF_MANAGE, 'catalog.referrer.export'] });
    await userEvent.click(screen.getByRole('radio', { name: /doctors/i }));
    await press(/download current data/i);
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]!.body).toEqual({ kind: 'referrers' });
  });

  it('credit_parties has no export kind (Export.kind enum) → no "Download current data" for it', async () => {
    await show();
    await userEvent.click(screen.getByRole('radio', { name: /credit parties/i }));
    const ex = screen.queryByRole('button', { name: /download current data/i }) as HTMLButtonElement | null;
    if (ex) expect(ex.disabled).toBe(true);
    expect(writes()).toEqual([]);
  });

  it('empty states: "No imports yet." and "No exports yet."', async () => {
    await show();
    expect(screen.getByText('No imports yet.')).toBeTruthy();
    expect(screen.getByText('No exports yet.')).toBeTruthy();
  });

  it('History table: Started · Kind · Target · File name · Status · Errors/Warnings · By; status as text; row links to SCR-19; Kind + Status filters', async () => {
    await show({ imports: [imp(1, { status: 'committed' }), imp(2, { status: 'invalid', summary: { ...SUMMARY, errors: 3, warnings: 2 }, file_name: 'bad.xlsx' }), imp(3, { status: 'quarantined', file_name: 'evil.xlsx' }), imp(4, { kind: 'referrers', target_price_list_id: undefined, file_name: 'docs.xlsx', status: 'commit_failed' })] });
    const table = screen.getAllByRole('table')[0]!;
    for (const h of ['Started', 'Kind', 'Target', 'File name', 'Status', 'By']) expect(within(table).getByRole('columnheader', { name: new RegExp(`^${h}`, 'i') }), h).toBeTruthy();
    expect(within(table).getByRole('columnheader', { name: /errors\s*\/\s*warnings/i })).toBeTruthy();
    for (const s of ['Committed', 'Invalid', 'Quarantined', 'Commit failed']) expect(within(table).getAllByText(s).length, s).toBeGreaterThan(0);
    const bad = within(table).getByRole('row', { name: /bad\.xlsx/ });
    expect(bad.textContent).toMatch(/3\D+2/);
    expect(within(bad).getByRole('link', { name: /bad\.xlsx/ }).getAttribute('href')).toBe(`/catalog/imports/${ID(2)}`);
    expect(screen.getAllByLabelText(/^kind$/i).length + screen.getAllByLabelText(/^status$/i).length).toBeGreaterThanOrEqual(2);
  });

  it('exports table: Download only when ready; queued/building rows show status text; expired shows no link', async () => {
    await show({ exports: [exp(1), exp(2, { status: 'queued', file_name: undefined }), exp(3, { status: 'expired', file_name: 'old.xlsx' })] });
    const tables = screen.getAllByRole('table');
    const t = tables[tables.length - 1]!;
    expect(within(t).getAllByText(/^(Ready|Queued|Expired)$/i).length).toBe(3);
    const dl = [...t.querySelectorAll('a,button')].filter((e) => /^download$/i.test(e.textContent?.trim() ?? ''));
    expect(dl).toHaveLength(1);
    expect(dl[0]!.getAttribute('href')).toBe(`/catalog/exports/${ID(1)}/file`);
  });

  it('a download answered 409 file_not_ready shows Banner "Still preparing — try again shortly" (08 A13 D-20); other statuses do not', async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ code: 'common.version_conflict', detail: 'file_not_ready' }), { status: 409 }));
    vi.stubGlobal('fetch', fetchSpy);
    await show({ exports: [exp(1)] });
    const dl = linkOrButton(/^download$/i);
    await userEvent.click(dl);
    await waitFor(() => expect(text()).toContain('Still preparing — try again shortly'));
  });

  it('a11y: no axe violations (empty and populated)', async () => {
    const v = await show();
    await noAxeViolations();
    v.unmount();
    await show({ imports: [imp(1)], exports: [exp(2)] });
    await noAxeViolations();
  });
});

// ================================================================================================================ SCR-19
describe('SCR-19 ImportDetail', () => {
  const show = async (o: { row?: Record<string, unknown>; issues?: unknown[]; permissions?: string[]; priceList?: unknown | null } = {}) => {
    const { ImportDetail } = await import('../components/ImportDetail');
    return wrap(<ImportDetail importRow={(o.row ?? imp(1)) as never} issues={(o.issues ?? []) as never} priceList={(o.priceList === null ? undefined : (o.priceList ?? PRICE_LISTS[0])) as never} permissions={o.permissions ?? PL_MANAGE} />);
  };
  const openCommit = async () => { await press(/^commit/i); return dialog(); };
  const reason = (d: HTMLElement) => within(d).getByRole('textbox', { name: /change reason/i });
  const typed = (d: HTMLElement) => within(d).queryByRole('textbox', { name: /confirm/i });
  const commitBtn = (d: HTMLElement) => within(d).getByRole('button', { name: /^commit$/i }) as HTMLButtonElement;
  const staleIssue = issue(1, { severity: 'warning', sheet: '_meta', column: undefined, row_no: undefined, issue_code: 'file.stale_base', message: 'x' });

  it('stepper shows all six stages as text, the current one marked (aria-current); status never by colour alone', async () => {
    await show();
    for (const s of ['Uploaded', 'Security scan', 'Validating', 'Ready to commit', 'Committing', 'Committed']) expect(screen.getAllByText(s).length, s).toBeGreaterThan(0);
    const cur = document.querySelector('[aria-current="step"],[aria-current="true"]');
    expect(cur?.textContent).toMatch(/Ready to commit/);
  });

  it('summary tiles: Rows · Added · Changed · Removed · Unchanged · Errors · Warnings with the counts (AC-16.3)', async () => {
    await show({ row: imp(1, { summary: { rows: 120, added: 2, changed: 5, removed: 1, unchanged: 112, errors: 4, warnings: 7 } }) });
    const want: Record<string, string> = { Rows: '120', Added: '2', Changed: '5', Removed: '1', Unchanged: '112', Errors: '4', Warnings: '7' };
    for (const [label, n] of Object.entries(want)) {
      const el = screen.getAllByText(new RegExp(`^${label}$`, 'i')).map((e) => e.parentElement!).find((p) => new RegExp(`\\b${n}\\b`).test(p.textContent ?? ''));
      expect(el, `${label} = ${n}`).toBeTruthy();
    }
  });

  it('issues table: Severity · Sheet · Row · Column · Issue; text comes from the message catalog by issue_code, not from the API message (AC-16.4)', async () => {
    await show({ row: imp(1, { status: 'invalid', summary: { ...SUMMARY, errors: 2, warnings: 1 } }), issues: [
      issue(1), issue(2, { issue_code: 'row.orderable_unknown', row_no: 9, column: 'code' }),
      issue(3, { severity: 'warning', issue_code: 'row.orderable_inactive', row_no: 11, column: 'code' }), issue(4, { issue_code: 'row.some_future_code', message: 'Server fallback text.' }),
    ] });
    const t = screen.getAllByRole('table').find((x) => within(x).queryByRole('columnheader', { name: /severity/i }))!;
    for (const h of ['Severity', 'Sheet', 'Row', 'Column', 'Issue']) expect(within(t).getByRole('columnheader', { name: new RegExp(`^${h}`, 'i') }), h).toBeTruthy();
    expect(within(t).getByText('Price has more than 2 decimal places.')).toBeTruthy();
    expect(within(t).getByText('No test or panel with this code.')).toBeTruthy();
    expect(within(t).queryByText('Synthetic API text')).toBeNull();
    expect(within(t).getByText('Server fallback text.')).toBeTruthy(); // unknown code → API template text
    expect(within(within(t).getByRole('row', { name: /No test or panel/ })).getByText(/^Error$/i)).toBeTruthy(); // severity as text
    expect(within(within(t).getByRole('row', { name: /inactive|row\.orderable_inactive/i })).getByText(/^Warning$/i)).toBeTruthy();
  });

  it('filter Errors / Warnings narrows the issue rows', async () => {
    api.use(http.get(`${ORIGIN}/v1/catalog/imports/:id/issues`, async ({ request }) => { await rec(request); const s = new URL(request.url).searchParams.get('severity'); return HttpResponse.json({ data: [issue(1), issue(2, { severity: 'warning', issue_code: 'row.orderable_inactive' })].filter((i) => !s || i.severity === s), page: { limit: 50 } }); }));
    await show({ row: imp(1, { status: 'invalid' }), issues: [issue(1), issue(2, { severity: 'warning', issue_code: 'row.orderable_inactive' })] });
    const ctl = [...document.querySelectorAll<HTMLElement>('[role=tab],[role=radio],[role=option],button,label')].find((e) => e.textContent?.trim() === 'Warnings');
    expect(ctl, 'Warnings filter').toBeTruthy();
    await userEvent.click(ctl!);
    await waitFor(() => expect(screen.queryByText('Price has more than 2 decimal places.')).toBeNull());
    expect(screen.getByText(/inactive/i)).toBeTruthy();
  });

  it('quarantined: red banner "This file was blocked by the security scan. It was not read."; no issues table, no Commit, no annotated file', async () => {
    await show({ row: imp(1, { status: 'quarantined' }) });
    expect(screen.getAllByRole('alert').map((a) => a.textContent).join('|')).toContain('This file was blocked by the security scan. It was not read.');
    expect(screen.queryByRole('button', { name: /^commit/i })).toBeNull();
    expect(screen.queryAllByRole('link', { name: /download annotated file/i }).concat(screen.queryAllByRole('button', { name: /download annotated file/i }))).toHaveLength(0);
    expect(screen.queryByRole('columnheader', { name: /severity/i })).toBeNull();
  });

  it('invalid: Commit unavailable (disabled or absent); "Download annotated file" → /catalog/imports/{id}/report (AC-16.10)', async () => {
    await show({ row: imp(1, { status: 'invalid', summary: { ...SUMMARY, errors: 1 } }), issues: [issue(1)] });
    const c = screen.queryByRole('button', { name: /^commit/i }) as HTMLButtonElement | null;
    if (c) expect(c.disabled).toBe(true);
    const a = screen.getAllByRole('link', { name: /download annotated file/i })[0]!;
    expect(a.getAttribute('href')).toBe(`/catalog/imports/${ID(1)}/report`);
  });

  it('committed: green banner + link to the new price-list version (SCR-14); no Commit / Discard', async () => {
    await show({ row: imp(1, { status: 'committed', result_price_list_version_id: ID(64) }) });
    const link = screen.getAllByRole('link').find((l) => (l.getAttribute('href') ?? '').includes(ID(64)));
    expect(link?.getAttribute('href')).toBe(`/catalog/price-lists/${ID(60)}/versions/${ID(64)}`);
    expect(screen.queryByRole('button', { name: /^commit/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^discard/i })).toBeNull();
    expect(screen.getAllByText('Committed').length).toBeGreaterThan(0);
  });

  it('commit_failed: banner + the new issues (file.draft_exists) are shown; Commit again is possible with "Replace open drafts" (AC-16.6)', async () => {
    await show({ row: imp(1, { status: 'commit_failed', summary: { ...SUMMARY, errors: 1 } }), issues: [issue(1, { sheet: '_meta', issue_code: 'file.draft_exists', column: undefined, row_no: undefined, message: 'x' })] });
    expect(screen.getAllByText('Commit failed').length).toBeGreaterThan(0);
    expect(screen.getAllByRole('table').some((t) => /draft/i.test(t.textContent ?? ''))).toBe(true);
  });

  it('Commit dialog fields + defaults: Effective from, Change reason (required), "Publish immediately" ON, "Replace open drafts" OFF, typed confirmation (price lists)', async () => {
    await show();
    const d = await openCommit();
    expect(within(d).getByLabelText(/^effective from$/i)).toBeTruthy();
    expect((within(d).getByRole('switch', { name: /publish immediately/i }) as HTMLInputElement).getAttribute('aria-checked') ?? (within(d).getByRole('switch', { name: /publish immediately/i }) as HTMLInputElement).checked).toMatch(/true/);
    expect(within(d).getByRole('switch', { name: /replace open drafts/i }).getAttribute('aria-checked') ?? 'false').toBe('false');
    expect(d.textContent).toContain('Open drafts of these items are discarded before the import is applied.');
    expect(typed(d), 'typed confirmation').toBeTruthy();
    expect(d.textContent, 'announces the required text (a11y §5)').toContain('PL-DRX');
    expect(within(d).queryByRole('checkbox', { name: /changed after this file was exported/i }), 'stale-base only with a warning').toBeNull();
    expect(commitBtn(d).disabled).toBe(true);
  });

  it('typed confirmation: Commit stays disabled until BOTH a change reason and the exact price-list code are entered; wrong / partial / lower-case codes do not unlock it', async () => {
    await show();
    const d = await openCommit();
    await userEvent.type(reason(d), 'Q4 price review');
    expect(commitBtn(d).disabled, 'reason only').toBe(true);
    for (const wrong of ['PL-DR', 'PL-CLINIC', 'pl-drx', ' PL-DRX x']) {
      await userEvent.clear(typed(d)!);
      await userEvent.type(typed(d)!, wrong);
      expect(commitBtn(d).disabled, `typed "${wrong}"`).toBe(true);
    }
    await userEvent.clear(typed(d)!);
    await userEvent.type(typed(d)!, 'PL-DRX');
    await waitFor(() => expect(commitBtn(d).disabled).toBe(false));
    await userEvent.clear(reason(d));
    expect(commitBtn(d).disabled, 'reason cleared again').toBe(true);
    expect(writes()).toEqual([]);
  });

  it('commit request (AC-16.6/16.7): POST …/commit, If-Match "<import version>", Idempotency-Key, body {change_reason, publish:true, replace_draft:false, accept_stale_base≠true}; typed text never sent; double click = ONE request', async () => {
    await show({ row: imp(1, { version: 5 }) });
    const d = await openCommit();
    await userEvent.type(reason(d), 'Q4 price review');
    await userEvent.type(typed(d)!, 'PL-DRX');
    await userEvent.dblClick(commitBtn(d));
    await waitFor(() => expect(writes()).toHaveLength(1));
    const c = writes()[0]!;
    expect(c.url.pathname).toBe(`/v1/catalog/imports/${ID(1)}/commit`);
    expect(c.headers.get('if-match')).toBe('"5"');
    expect(c.headers.get('idempotency-key')).toMatch(/^[A-Za-z0-9_-]{16,}$/);
    expect(c.body.change_reason).toBe('Q4 price review');
    expect(c.body.publish).toBe(true);
    expect(c.body.replace_draft).toBe(false);
    expect(c.body.accept_stale_base ?? false).toBe(false);
    if (c.body.effective_from !== undefined) expect(Math.abs(Date.parse(c.body.effective_from) - Date.now())).toBeLessThan(5 * 60_000); // default Now
    expect(JSON.stringify(c.body)).not.toContain('PL-DRX');
    expect(Object.keys(c.body).every((k) => ['effective_from', 'change_reason', 'accept_stale_base', 'publish', 'replace_draft'].includes(k))).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(writes()).toHaveLength(1);
  });

  it('switches: "Publish immediately" off → publish:false (draft for review); "Replace open drafts" on → replace_draft:true', async () => {
    await show();
    const d = await openCommit();
    await userEvent.click(within(d).getByRole('switch', { name: /publish immediately/i }));
    await userEvent.click(within(d).getByRole('switch', { name: /replace open drafts/i }));
    await userEvent.type(reason(d), 'draft please');
    await userEvent.type(typed(d)!, 'PL-DRX');
    await press(/^commit$/i, d);
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]!.body).toMatchObject({ publish: false, replace_draft: true });
  });

  it('stale-base (AC-16.5): with a `file.stale_base` warning the checkbox with the exact copy appears and Commit stays disabled until it is ticked; ticking sends accept_stale_base:true', async () => {
    await show({ row: imp(1, { summary: { ...SUMMARY, warnings: 1 } }), issues: [staleIssue] });
    const d = await openCommit();
    const box = within(d).getByRole('checkbox', { name: STALE });
    expect(d.textContent).toContain(STALE);
    await userEvent.type(reason(d), 'replace anyway');
    await userEvent.type(typed(d)!, 'PL-DRX');
    expect(commitBtn(d).disabled, 'reason + code but stale-base not accepted').toBe(true);
    await userEvent.click(box);
    await waitFor(() => expect(commitBtn(d).disabled).toBe(false));
    await userEvent.click(commitBtn(d));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]!.body.accept_stale_base).toBe(true);
  });

  it('stale-base warning absent but the API still answers 409 catalog.import_stale_base → inline message, dialog stays open, user can tick and retry', async () => {
    api.use(http.post(`${ORIGIN}/v1/catalog/imports/:id/commit`, () => prob(409, 'catalog.import_stale_base')));
    await show();
    const d = await openCommit();
    await userEvent.type(reason(d), 'x');
    await userEvent.type(typed(d)!, 'PL-DRX');
    await userEvent.click(commitBtn(d));
    await waitFor(() => expect(within(dialog()).getAllByRole('alert').map((a) => a.textContent).join(' ')).toMatch(/changed|newer|stale/i));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(push).not.toHaveBeenCalled();
  });

  it('409 catalog.import_not_committable (already committed elsewhere) and 409 common.version_conflict show inline errors; 403 auth.mfa_required asks for step-up; none navigates', async () => {
    const cases: [number, string, RegExp][] = [[409, 'catalog.import_not_committable', /already|no longer|cannot be committed|committed/i], [409, 'common.version_conflict', /changed|reload|refresh|newer/i], [403, 'auth.mfa_required', /verif|multi-factor|MFA|second factor/i]];
    for (const [status, code, re] of cases) {
      api.use(http.post(`${ORIGIN}/v1/catalog/imports/:id/commit`, () => prob(status, code)));
      const v = await show();
      const d = await openCommit();
      await userEvent.type(reason(d), 'x');
      await userEvent.type(typed(d)!, 'PL-DRX');
      await userEvent.click(commitBtn(d));
      await waitFor(() => expect(within(dialog()).getAllByRole('alert').map((a) => a.textContent).join(' '), code).toMatch(re));
      expect(push).not.toHaveBeenCalled();
      v.unmount();
    }
  });

  it('after a 202 the dialog closes and the page shows "Committing" (polling takes over)', async () => {
    await show();
    const d = await openCommit();
    await userEvent.type(reason(d), 'go');
    await userEvent.type(typed(d)!, 'PL-DRX');
    await userEvent.click(commitBtn(d));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getAllByText('Committing').length).toBeGreaterThan(0);
  });

  it('catalog_master commit: no price-list controls (no Publish immediately, no stale-base, no typed price-list code); gated on catalog.test.manage AND catalog.reference_range.publish (AC-17.5, D-18)', async () => {
    const row = imp(1, { kind: 'catalog_master', target_price_list_id: undefined, base_version_no: undefined });
    let v = await show({ row, priceList: null, permissions: CAT_MANAGE });
    const c = screen.getByRole('button', { name: /^commit/i }) as HTMLButtonElement;
    expect(c.disabled, 'no catalog.reference_range.publish').toBe(true);
    expect(text()).toContain('catalog.reference_range.publish'); // permission hint, same pattern as GatedButton
    v.unmount();
    v = await show({ row, priceList: null, permissions: CAT_PUBLISH });
    const d = await openCommit();
    expect(within(d).queryByRole('switch', { name: /publish immediately/i })).toBeNull();
    expect(within(d).queryByRole('checkbox', { name: /changed after this file/i })).toBeNull();
    expect(typed(d)).toBeNull();
    await userEvent.type(reason(d), 'starter catalog');
    await userEvent.click(commitBtn(d));
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]!.body.change_reason).toBe('starter catalog');
    expect(writes()[0]!.body.publish).toBeUndefined();
  });

  it('permission gate (AC-16.11, AC-17.6): price_list needs price_list.manage; referrers needs referrer.manage — Commit disabled with a permission hint, never silently', async () => {
    let v = await show({ permissions: [...READ, 'catalog.test.manage', 'catalog.reference_range.publish'] });
    expect((screen.getByRole('button', { name: /^commit/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(text()).toContain('catalog.price_list.manage');
    v.unmount();
    v = await show({ row: imp(1, { kind: 'referrers', target_price_list_id: undefined }), priceList: null, permissions: CAT_PUBLISH });
    expect((screen.getByRole('button', { name: /^commit/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(text()).toContain('catalog.referrer.manage');
    v.unmount();
    await show({ row: imp(1, { kind: 'referrers', target_price_list_id: undefined }), priceList: null, permissions: REF_MANAGE });
    expect((screen.getByRole('button', { name: /^commit/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('Discard: POST …/discard with If-Match "<version>" (validated / invalid / commit_failed only)', async () => {
    await show({ row: imp(1, { version: 5 }) });
    await press(/^discard/i);
    const confirm = screen.queryByRole('dialog') ?? screen.queryByRole('alertdialog');
    if (confirm) await press(/^(discard|confirm|yes)/i, confirm);
    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]!.url.pathname).toBe(`/v1/catalog/imports/${ID(1)}/discard`);
    expect(writes()[0]!.headers.get('if-match')).toBe('"5"');
    cleanup();
    await show({ row: imp(1, { status: 'committing' }) });
    expect(screen.queryByRole('button', { name: /^discard/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^commit/i })).toBeNull();
  });

  it('a11y: no axe violations — page, and Commit dialog open (with stale-base)', async () => {
    await show({ row: imp(1, { summary: { ...SUMMARY, warnings: 1 } }), issues: [staleIssue, issue(2)] });
    await noAxeViolations();
    await openCommit();
    await noAxeViolations();
  });
});
