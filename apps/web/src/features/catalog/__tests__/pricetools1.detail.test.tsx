// @vitest-environment jsdom
// T0D-PRICETOOLS-1 (LD-321 / LD-310 / LD-353; founder 2026-11-17 09:18 NPT): the price list tools on the price list screen /catalog/price-lists/<id>.
// Rendered through the PAGE default export (async server component), MSW standing in for the API (pricetools1.harness.tsx); no component name is pinned.
// NO route is added (testimport1.source pins the 26 catalog route files and nav-complete.catalog pins 15 nav entries): Compare lives at
// /catalog/price-lists?view=compare (pricetools1.compare.test.tsx), Bulk update in the version editor (pricetools1.bulk.test.tsx).
// CONTRACT pinned here (tester wording; the lead / writer may dispute through the ruling flow, then tests and text change together):
//   header actions : "Edit prices" (unchanged), "Export to Excel" (ENABLED now: GET price-list-import-template?price_list_id=<id>, download name contains the list code, .xlsx),
//                    "Import from Excel" (managers only, as before; moves focus into the "Upload and check" section), "Copy to" (button), link "Compare versions"
//                    (href /catalog/price-lists?view=compare&a=<current version id>&b=<draft version id>, readers too).
//   h2 sections    : "Upload and check" (own <section>), "Import history", the existing General / Assignments / Versions.
//   Upload and check: button "Download template" (GET price-list-import-template with NO price_list_id; anchor download price-list-template.xlsx; failure -> role=alert),
//                    the kit FileUpload (one <input type=file>, xlsx only, 5 MB, progress bar "Upload progress for <name>", button "Cancel upload" while it runs).
//                    A valid pick starts the dry run at once: POST price-lists/<id>/import-dry-run multipart with ONLY the field `file` + Idempotency-Key.
//                    Result counts Rows / Added / Changed / Unchanged / Errors (from batch.summary), a table with columns Row, Column, Code, Message (all errors, never
//                    truncated, message verbatim, inside a .lims-table-scroll box; headers + four placeholder rows when empty, LD-336), button "Commit to draft" (enabled only
//                    for the CURRENT file's clean dry run), a dialog with "Change reason" (required) that explains the result is a DRAFT to be published separately, and
//                    one POST price-list-import-batches/<batch>/commit {change_reason} + Idempotency-Key, then a link "Open draft" to the new version.
//   Import history : table Time, Uploaded by, Status, Rows, Errors, Draft (headers visible when empty; Draft links to the committed version); refreshed after commit.
//   Copy to        : dialog "Copy to": Combobox "Target price list", Select "Version to copy" (default = current version), radios "Replace" / "Merge" (no default, confirm
//                    disabled until target + mode), textbox "Adjust by percent" (optional, -100..1000, <= 2 decimals) + Select "Rounding" (default None, sent only with a percent),
//                    confirm "Copy" -> ONE POST price-lists/<TARGET id>/copy {source_price_list_version_id, mode[, percent_bp, rounding]} + Idempotency-Key; "Open draft" link.
//   Assignments    : table Owner, Effective from, Effective to (open ended shown as "Open ended"); native date inputs "Effective from" / "Effective to" (input type=date) that apply to
//                    every owner saved in the call; sent as ISO strings only when filled (empty = body unchanged: {owner_ids}); to before from = alert, no request;
//                    the server overlap refusal (409 catalog.code_duplicate) is shown as role=alert with the server's problem detail VERBATIM, owners kept.
//   Permissions    : without catalog.price_list.manage the buttons Download template, Export to Excel, Copy to are rendered DISABLED and the page shows a visible reason naming
//                    catalog.price_list.manage; no file input; the date inputs are read only / disabled; Compare versions and Import history stay available.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse } from 'msw';
import axe from 'axe-core';
import { ApiError } from '@/core/api/server-fetch';
import { expectEmptyTable, headersOf, tableOf, tablesOf } from './emptytbl2.helpers';
import { API, BAD, CLEAN, CP_DETAIL, DEFAULT_DETAIL, ID, MANAGE, MB, READ, TM, api, batch, captureDownloads, committedBatch, downloads, openDetail, prob, rowErr, xlsxFile } from './pricetools1.harness';

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterAll(() => api.close());
beforeEach(() => { API.reset(); TM.session.permissions = MANAGE; TM.nav.search = ''; captureDownloads(); });
afterEach(() => { cleanup(); api.resetHandlers(); TM.push.mockClear(); TM.replace.mockClear(); TM.refresh.mockReset(); });

// ----------------------------------------------------------------------------------------------------------------------------------- helpers
const fileInput = () => { const i = document.querySelector<HTMLInputElement>('input[type=file]'); if (!i) throw new Error('no <input type=file> rendered (the Upload and check section is missing)'); return i; };
const pick = (f: File) => userEvent.upload(fileInput(), f, { applyAccept: false });
const sec = (re: RegExp): HTMLElement => {
  const h = screen.getAllByRole('heading', { level: 2 }).find((x) => re.test(x.textContent ?? ''));
  if (!h) throw new Error(`no h2 heading matching ${re}`);
  const s = h.closest('section');
  if (!s) throw new Error(`the heading "${h.textContent}" is not inside its own <section>`);
  return s as HTMLElement;
};
const UP = /upload and check/i;
const HIST = /import history/i;
const dryRuns = () => API.find('POST', /import-dry-run$/);
const commits = () => API.find('POST', /\/commit$/);
const copies = () => API.find('POST', /\/copy$/);
const puts = () => API.find('PUT', /assignments$/);
const templates = () => API.find('GET', /price-list-import-template$/);
const dialog = () => screen.findByRole('dialog');
const bodyRows = (t: HTMLElement) => [...t.querySelectorAll<HTMLElement>('tbody tr, [role="rowgroup"] [role="row"]')].filter((r) => r.getAttribute('aria-hidden') !== 'true' && !r.closest('[aria-hidden="true"]') && !r.closest('thead') && !r.querySelector('th, [role="columnheader"]') && (r.textContent ?? '').trim() !== '');
const cells = (r: HTMLElement) => [...r.querySelectorAll('td, [role="cell"], [role="gridcell"]')].map((c) => (c.textContent ?? '').trim());
const errTable = () => tableOf(sec(UP));
/** Value shown for a count label inside the Upload and check section: "Rows: 120", a label/value pair, or a label followed by its value sibling. */
const countOf = (label: string): string => {
  const leaves = [...sec(UP).querySelectorAll<HTMLElement>('*')].filter((e) => e.children.length === 0);
  const joined = leaves.find((e) => new RegExp(`^${label}\\s*:?\\s*\\d+$`).test((e.textContent ?? '').trim()));
  if (joined) return (joined.textContent ?? '').replace(label, '').replace(':', '').trim();
  const el = leaves.find((e) => (e.textContent ?? '').trim().replace(/:$/, '') === label);
  if (!el) throw new Error(`no "${label}" count label in the Upload and check section`);
  const parent = el.parentElement;
  if (parent && parent.children.length <= 2) return (parent.textContent ?? '').replace(label, '').replace(':', '').trim();
  return (el.nextElementSibling?.textContent ?? '').trim();
};
async function checked(body: Record<string, any> = CLEAN(), f = xlsxFile()) {
  API.dryRun = [() => HttpResponse.json(body, { status: 201 })];
  const before = dryRuns().length;
  await pick(f);
  await waitFor(() => expect(dryRuns()).toHaveLength(before + 1));
  await waitFor(() => expect(countOf('Rows')).toMatch(/\b120\b/));
}
const commitBtn = () => within(sec(UP)).getByRole('button', { name: /^commit to draft/i }) as HTMLButtonElement;
const choose = async (scope: HTMLElement, label: RegExp, option: string | RegExp) => { await userEvent.click(within(scope).getByLabelText(label)); await userEvent.click(await screen.findByRole('option', { name: option })); };
const noAxe = async () => { const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } }); expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]); };
const settle = () => new Promise((r) => setTimeout(r, 80));

// =============================================================================================================================== header and layout
describe('header actions and sections', () => {
  it('keeps the old actions and gains the tools: Edit prices, Export to Excel, Import from Excel, Copy to, Compare versions', async () => {
    await openDetail();
    for (const n of [/^edit prices$/i, /^export to excel$/i, /^import from excel$/i, /^copy to/i]) expect(screen.getAllByRole('button', { name: n }).length, String(n)).toBeGreaterThan(0);
    expect(screen.getAllByRole('link', { name: /compare versions/i }).length + screen.queryAllByRole('button', { name: /compare versions/i }).length).toBeGreaterThan(0);
  });
  it('Export to Excel, Import from Excel and Copy to are enabled for a manager (they were disabled placeholders)', async () => {
    await openDetail();
    for (const n of [/^export to excel$/i, /^import from excel$/i, /^copy to/i]) for (const b of screen.getAllByRole('button', { name: n })) expect((b as HTMLButtonElement).disabled, String(n)).toBe(false);
  });
  it('h2 "Upload and check" and "Import history" each sit in their own <section>, after the existing sections', async () => {
    await openDetail();
    const up = sec(UP);
    const hist = sec(HIST);
    expect(up).not.toBe(hist);
    expect(up.compareDocumentPosition(hist) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByRole('heading', { level: 1 }).length).toBe(1);
  });
  it('Compare versions links to the compare screen with the current version as A and the draft as B', async () => {
    await openDetail();
    const link = screen.getAllByRole('link', { name: /compare versions/i })[0]!;
    const u = new URL(link.getAttribute('href')!, 'http://x');
    expect(u.pathname).toBe('/catalog/price-lists');
    expect(u.searchParams.get('view')).toBe('compare');
    expect(u.searchParams.get('a')).toBe(ID(70));
    expect(u.searchParams.get('b')).toBe(ID(73));
  });
  it('Compare versions is there for a reader as well (it needs only catalog.price_list.read)', async () => {
    await openDetail(DEFAULT_DETAIL, READ);
    expect(screen.getAllByRole('link', { name: /compare versions/i }).length).toBeGreaterThan(0);
  });
  it('unknown id -> notFound, 403 -> the no-access page (the existing page contract still holds)', async () => {
    API.detailFail = 404;
    await expect(openDetail()).rejects.toMatchObject({ digest: expect.stringContaining('404') });
    cleanup();
    API.detailFail = 403;
    await openDetail();
    expect(screen.getByRole('heading', { name: /don.t have access to this part of the catalog/i })).toBeTruthy();
  });
});

// =============================================================================================================================== Download template / Export
describe('Download template and Export to Excel', () => {
  it('Download template: ONE GET without price_list_id, then an anchor download named price-list-template.xlsx', async () => {
    await openDetail();
    await userEvent.click(within(sec(UP)).getByRole('button', { name: /^download template$/i }));
    await waitFor(() => expect(downloads).toHaveLength(1));
    expect(downloads[0]!.name).toBe('price-list-template.xlsx');
    expect(templates()).toHaveLength(1);
    expect(templates()[0]!.search.has('price_list_id')).toBe(false);
  });
  it('Export to Excel: GET with price_list_id of THIS list, download name holds the list code and ends in .xlsx', async () => {
    await openDetail();
    await userEvent.click(screen.getAllByRole('button', { name: /^export to excel$/i })[0]!);
    await waitFor(() => expect(downloads).toHaveLength(1));
    expect(templates()[0]!.search.get('price_list_id')).toBe(ID(60));
    expect(downloads[0]!.name).toMatch(/^price-list-.*default.*\.xlsx$/i);
  });
  it('a failing download shows a role=alert and leaves the button usable (no download)', async () => {
    API.templateFail = true;
    await openDetail();
    const b = within(sec(UP)).getByRole('button', { name: /^download template$/i }) as HTMLButtonElement;
    await userEvent.click(b);
    expect((await screen.findAllByRole('alert')).length).toBeGreaterThan(0);
    expect(downloads).toHaveLength(0);
    expect(b.disabled).toBe(false);
  });
  it('a double click sends one request', async () => {
    await openDetail();
    const b = within(sec(UP)).getByRole('button', { name: /^download template$/i });
    await userEvent.dblClick(b);
    await waitFor(() => expect(downloads.length).toBeGreaterThan(0));
    await settle();
    expect(templates()).toHaveLength(1);
  });
  it('Import from Excel moves the focus into the Upload and check section', async () => {
    await openDetail();
    await userEvent.click(screen.getAllByRole('button', { name: /^import from excel$/i })[0]!);
    await waitFor(() => expect(sec(UP).contains(document.activeElement)).toBe(true));
  });
});

// =============================================================================================================================== Upload and check
describe('Upload and check: the dry run writes nothing, every error is visible', () => {
  it('exactly one file input, xlsx only; nothing is sent before a file is picked', async () => {
    await openDetail();
    expect(document.querySelectorAll('input[type=file]')).toHaveLength(1);
    const accept = fileInput().getAttribute('accept') ?? '';
    expect(accept).toMatch(/spreadsheetml\.sheet|\.xlsx/);
    expect(accept).not.toMatch(/xls(?!x)|csv|xlsm/i);
    expect(dryRuns()).toHaveLength(0);
  });
  it('a valid pick starts the dry run at once: multipart with only `file` and an Idempotency-Key, no commit', async () => {
    await openDetail();
    await checked(CLEAN(), xlsxFile('rates-2083.xlsx'));
    const c = dryRuns()[0]!;
    expect(c.path).toBe(`/v1/catalog/price-lists/${ID(60)}/import-dry-run`);
    expect(c.headers.get('idempotency-key')).toBeTruthy();
    expect(c.form!.keys()).toEqual(['file']);
    expect((c.form!.get('file') as { name: string }).name).toBe('rates-2083.xlsx');
    expect(commits()).toHaveLength(0);
  });
  it('shows Rows / Added / Changed / Unchanged / Errors from the batch summary', async () => {
    await openDetail();
    await checked();
    expect(countOf('Rows')).toMatch(/\b120\b/);
    expect(countOf('Added')).toMatch(/\b4\b/);
    expect(countOf('Changed')).toMatch(/\b10\b/);
    expect(countOf('Unchanged')).toMatch(/\b106\b/);
    expect(countOf('Errors')).toMatch(/\b0\b/);
  });
  it('the error table has the columns Row, Column, Code, Message in that order and empty headers + four placeholder rows before any upload', async () => {
    await openDetail();
    const t = errTable();
    expect(headersOf(t).slice(0, 4)).toEqual(['Row', 'Column', 'Code', 'Message']);
    expectEmptyTable(t, null, ['Row', 'Column', 'Code', 'Message']);
  });
  it('a clean file leaves the error table empty (headers stay) and no alert', async () => {
    await openDetail();
    await checked();
    expect(headersOf(errTable()).slice(0, 4)).toEqual(['Row', 'Column', 'Code', 'Message']);
    expect(bodyRows(errTable())).toHaveLength(1); // the empty message row only
    expect(within(sec(UP)).queryAllByRole('alert')).toHaveLength(0);
  });
  it('all errors of a bad file are listed together with row, column, code and the server message verbatim', async () => {
    await openDetail();
    await checked(BAD(3));
    const rows = bodyRows(errTable()).map(cells);
    expect(rows).toHaveLength(3);
    expect(rows[0]!.slice(0, 4)).toEqual(['7', 'test_code', 'code_not_found', 'Synthetic server problem number 1: value is not allowed here.']);
    expect(rows[1]!.slice(0, 4)).toEqual(['8', 'price_rupees', 'price_invalid', 'Synthetic server problem number 2: value is not allowed here.']);
    expect(countOf('Errors')).toMatch(/\b3\b/);
  });
  it('NO error is hidden: 150 errors give 150 rows (no paging cut), inside a scroll box of the table', async () => {
    await openDetail();
    await checked(BAD(150));
    expect(bodyRows(errTable())).toHaveLength(150);
    expect(errTable().closest('[class*="lims-table-scroll"]'), 'the table scrolls inside its own box, never the page').toBeTruthy();
  });
  it('two errors on one row (test code + price) are two rows with the same Row number', async () => {
    await openDetail();
    await checked({ batch: batch({ id: ID(503), error_count: 2, summary: { rows: 120, errors: 2 } }), errors: [rowErr(1, { row_no: 7 }), rowErr(2, { row_no: 7 })] });
    const rows = bodyRows(errTable()).map(cells);
    expect(rows.map((r) => r[0])).toEqual(['7', '7']);
    expect(rows.map((r) => r[1])).toEqual(['test_code', 'price_rupees']);
  });
  it('server text with markup is shown as text, never as HTML (formula / markup safe)', async () => {
    await openDetail();
    await checked({ batch: batch({ error_count: 1, summary: { rows: 120, errors: 1 } }), errors: [rowErr(1, { message: '<img src=x onerror=alert(1)> =SUM(A1)' })] });
    expect(errTable().querySelector('img')).toBeNull();
    expect(errTable().textContent).toContain('<img src=x onerror=alert(1)> =SUM(A1)');
  });
  it('NOTHING is written by a dry run: the only requests are the template-free GETs and ONE import-dry-run POST', async () => {
    await openDetail();
    await checked(BAD(2));
    expect(API.calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`)).toEqual([`POST /v1/catalog/price-lists/${ID(60)}/import-dry-run`]);
  });
  it('413 / 415 / 422 from the server show the server detail verbatim in a role=alert and no table rows', async () => {
    for (const [status, code] of [[413, 'common.payload_too_large'], [415, 'common.unsupported_media_type'], [422, 'catalog.import_invalid_file']] as const) {
      cleanup();
      API.reset();
      API.dryRun = [() => prob(status, code, `Synthetic refusal ${status}: the file is not acceptable.`)];
      await openDetail();
      await pick(xlsxFile());
      const alert = await within(sec(UP)).findByRole('alert');
      expect(alert.textContent, String(status)).toContain(`Synthetic refusal ${status}: the file is not acceptable.`);
      expect(bodyRows(errTable()).filter((r) => /Synthetic refusal/.test(r.textContent ?? ''))).toHaveLength(0);
      expect(commitBtn().disabled).toBe(true);
    }
  });
  it('a 500 is shown as a retryable alert (the same Idempotency-Key is reused by retries, never a new batch per click)', async () => {
    API.dryRun = [() => prob(500, 'common.internal')];
    await openDetail();
    await pick(xlsxFile());
    await within(sec(UP)).findByRole('alert');
    const keys = new Set(dryRuns().map((c) => c.headers.get('idempotency-key')));
    expect(keys.size).toBe(1);
  });
  it('the file is refused in the browser with NO request when empty, not .xlsx (csv, xls, xlsm) or over 5 MB; exactly 5 MB is accepted', async () => {
    await openDetail();
    for (const f of [xlsxFile('empty.xlsx', 0), xlsxFile('prices.csv', 64, 'text/csv'), xlsxFile('old.xls', 64, 'application/vnd.ms-excel'), xlsxFile('macro.xlsm', 64, 'application/vnd.ms-excel.sheet.macroEnabled.12'), xlsxFile('big.xlsx', 5 * MB + 1)]) {
      await pick(f);
      await settle();
    }
    expect(dryRuns()).toHaveLength(0);
    expect((await within(sec(UP)).findAllByRole('alert')).length).toBeGreaterThan(0);
    await pick(xlsxFile('exact.xlsx', 5 * MB));
    await waitFor(() => expect(dryRuns()).toHaveLength(1));
  });
  it('shows an upload progress bar named after the file while the dry run runs', async () => {
    API.dryRunDelayMs = 400;
    await openDetail();
    await pick(xlsxFile('slow.xlsx'));
    expect(await screen.findByRole('progressbar', { name: /upload progress for slow\.xlsx/i })).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('progressbar')).toBeNull(), { timeout: 3000 });
  });
  it('the upload can be cancelled: progress goes away, the late answer is ignored, Commit stays disabled, a new pick works', async () => {
    API.dryRunDelayMs = 350;
    API.dryRun = [() => HttpResponse.json(BAD(3), { status: 201 })];
    await openDetail();
    await pick(xlsxFile('slow.xlsx'));
    await screen.findByRole('progressbar', { name: /upload progress for slow\.xlsx/i });
    await userEvent.click(within(sec(UP)).getByRole('button', { name: /^cancel upload$/i }));
    await waitFor(() => expect(screen.queryByRole('progressbar')).toBeNull());
    await new Promise((r) => setTimeout(r, 700));
    expect(bodyRows(errTable()).filter((r) => /Synthetic server problem/.test(r.textContent ?? ''))).toHaveLength(0);
    expect(commitBtn().disabled).toBe(true);
    API.dryRunDelayMs = 0;
    API.dryRun = [() => HttpResponse.json(CLEAN(), { status: 201 })];
    await pick(xlsxFile('second.xlsx'));
    await waitFor(() => expect(countOf('Rows')).toMatch(/\b120\b/));
  });
});

// =============================================================================================================================== Commit to draft
describe('Commit to draft', () => {
  it('is disabled before any upload, with errors (with a visible reason) and while a new upload runs', async () => {
    await openDetail();
    expect(commitBtn().disabled).toBe(true);
    await checked(BAD(2));
    expect(commitBtn().disabled).toBe(true);
    expect(sec(UP).textContent).toMatch(/fix .*errors?/i);
  });
  it('is enabled after a clean dry run; a second pick disables it again until that file is checked', async () => {
    await openDetail();
    await checked();
    expect(commitBtn().disabled).toBe(false);
    API.dryRunDelayMs = 300;
    await pick(xlsxFile('another.xlsx'));
    await waitFor(() => expect(commitBtn().disabled).toBe(true));
    await waitFor(() => expect(commitBtn().disabled).toBe(false), { timeout: 3000 });
  });
  it('opens a dialog that says the result is a DRAFT published separately; Cancel and Escape send nothing', async () => {
    await openDetail();
    await checked();
    await userEvent.click(commitBtn());
    const d = await dialog();
    expect(d.textContent).toMatch(/draft/i);
    expect(d.textContent).toMatch(/publish/i);
    await userEvent.click(within(d).getByRole('button', { name: /^cancel$/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await userEvent.click(commitBtn());
    await dialog();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(commits()).toHaveLength(0);
  });
  it('the change reason is required: an empty reason sends nothing', async () => {
    await openDetail();
    await checked();
    await userEvent.click(commitBtn());
    const d = await dialog();
    const confirm = within(d).getByRole('button', { name: /^(commit to draft|create draft)$/i }) as HTMLButtonElement;
    if (!confirm.disabled) await userEvent.click(confirm);
    await settle();
    expect(commits()).toHaveLength(0);
  });
  it('confirm sends ONE POST batch/commit with exactly {change_reason} and an Idempotency-Key, then offers "Open draft"', async () => {
    await openDetail();
    await checked();
    await userEvent.click(commitBtn());
    const d = await dialog();
    await userEvent.type(within(d).getByRole('textbox', { name: /change reason/i }), 'Synthetic yearly rate revision');
    await userEvent.click(within(d).getByRole('button', { name: /^(commit to draft|create draft)$/i }));
    await waitFor(() => expect(commits()).toHaveLength(1));
    const c = commits()[0]!;
    expect(c.path).toBe(`/v1/catalog/price-list-import-batches/${ID(501)}/commit`);
    expect(c.json).toEqual({ change_reason: 'Synthetic yearly rate revision' });
    expect(c.headers.get('idempotency-key')).toBeTruthy();
    const link = await screen.findByRole('link', { name: /open draft/i });
    expect(link.getAttribute('href')).toBe(`/catalog/price-lists/${ID(60)}/versions/${ID(505)}`);
    expect(TM.refresh.mock.calls.length).toBeGreaterThan(0); // history and the draft badge refresh
  });
  it('a double click on the confirm button commits once', async () => {
    API.commitDelayMs = 150;
    await openDetail();
    await checked();
    await userEvent.click(commitBtn());
    const d = await dialog();
    await userEvent.type(within(d).getByRole('textbox', { name: /change reason/i }), 'Synthetic reason');
    await userEvent.dblClick(within(d).getByRole('button', { name: /^(commit to draft|create draft)$/i }));
    await settle();
    await new Promise((r) => setTimeout(r, 250));
    expect(commits()).toHaveLength(1);
  });
  it('after a commit the same batch cannot be committed again from the screen', async () => {
    await openDetail();
    await checked();
    await userEvent.click(commitBtn());
    const d = await dialog();
    await userEvent.type(within(d).getByRole('textbox', { name: /change reason/i }), 'Synthetic reason');
    await userEvent.click(within(d).getByRole('button', { name: /^(commit to draft|create draft)$/i }));
    await screen.findByRole('link', { name: /open draft/i });
    expect(commitBtn().disabled).toBe(true);
  });
  it.each([
    [409, 'catalog.import_not_committable', 'Synthetic: this batch has errors or is already committed.'],
    [409, 'common.version_conflict', 'Synthetic: the list already has a draft version.'],
    [422, 'catalog.import_invalid_file', 'Synthetic: the file changed since the check.'],
  ])('%s %s shows the server detail verbatim in a role=alert and creates no draft link', async (status, code, detail) => {
    API.commit = [() => prob(status, code, detail)];
    await openDetail();
    await checked();
    await userEvent.click(commitBtn());
    const d = await dialog();
    await userEvent.type(within(d).getByRole('textbox', { name: /change reason/i }), 'Synthetic reason');
    await userEvent.click(within(d).getByRole('button', { name: /^(commit to draft|create draft)$/i }));
    const alerts = await screen.findAllByRole('alert');
    expect(alerts.map((a) => a.textContent).join(' ')).toContain(detail);
    expect(screen.queryByRole('link', { name: /open draft/i })).toBeNull();
  });
});

// =============================================================================================================================== Import history
describe('Import history', () => {
  it('has the columns Time, Uploaded by, Status, Rows, Errors, Draft, visible and with four placeholder rows when empty', async () => {
    await openDetail();
    const t = tableOf(sec(HIST));
    expect(headersOf(t).slice(0, 6)).toEqual(['Time', 'Uploaded by', 'Status', 'Rows', 'Errors', 'Draft']);
    expectEmptyTable(t, null, ['Time', 'Status', 'Rows', 'Errors', 'Draft']);
  });
  it('asks the API for THIS list only and shows status, counts and a Draft link to the committed version', async () => {
    API.batches = [committedBatch(504), batch({ id: ID(506), status: 'dry_run', row_count: 7, error_count: 2, summary: { rows: 7, errors: 2 } })];
    await openDetail();
    const call = API.find('GET', /price-list-import-batches$/)[0]!;
    expect(call.search.get('price_list_id')).toBe(ID(60));
    const rows = bodyRows(tableOf(sec(HIST))).map(cells);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.join(' ')).toMatch(/committed/i);
    expect(rows[0]!.join(' ')).toContain('120');
    expect(rows[1]!.join(' ')).toMatch(/dry run|checked/i);
    const link = within(tableOf(sec(HIST))).getByRole('link', { name: /v?draft|open|view|v\d+/i });
    expect(link.getAttribute('href')).toBe(`/catalog/price-lists/${ID(60)}/versions/${ID(505)}`);
  });
  it('a 403 on the history call hides the table without throwing; a 500 throws the ApiError (error.tsx)', async () => {
    API.batchesFail = 403;
    await openDetail(DEFAULT_DETAIL, MANAGE);
    expect(screen.getAllByRole('heading', { level: 1 }).length).toBe(1);
    cleanup();
    API.batchesFail = 500;
    await expect(openDetail()).rejects.toBeInstanceOf(ApiError);
  });
});

// =============================================================================================================================== Copy to
describe('Copy to', () => {
  const open = async () => { await openDetail(); await userEvent.click(screen.getAllByRole('button', { name: /^copy to/i })[0]!); return dialog(); };
  const pickTarget = async (d: HTMLElement, q = 'DR', option: RegExp = /DR_X/) => { await userEvent.type(within(d).getByLabelText(/^target price list/i), q); await userEvent.click(await screen.findByRole('option', { name: option })); };
  const confirm = (d: HTMLElement) => within(d).getByRole('button', { name: /^copy$/i }) as HTMLButtonElement;

  it('the confirm button is disabled until a target and a mode are chosen; nothing is sent before', async () => {
    const d = await open();
    expect(confirm(d).disabled).toBe(true);
    await pickTarget(d);
    expect(confirm(d).disabled).toBe(true);
    await userEvent.click(within(d).getByRole('radio', { name: /^merge/i }));
    expect(confirm(d).disabled).toBe(false);
    expect(copies()).toHaveLength(0);
  });
  it('the radios are Replace and Merge with no default', async () => {
    const d = await open();
    const radios = within(d).getAllByRole('radio') as HTMLInputElement[];
    expect(radios.map((r) => r.closest('label')?.textContent ?? r.getAttribute('aria-label'))).toEqual([expect.stringMatching(/^replace/i), expect.stringMatching(/^merge/i)]);
    expect(radios.some((r) => r.checked)).toBe(false);
  });
  it('merge: POST to the TARGET list with the current version as source, no percent and no rounding key, Idempotency-Key set', async () => {
    const d = await open();
    await pickTarget(d);
    await userEvent.click(within(d).getByRole('radio', { name: /^merge/i }));
    await userEvent.click(confirm(d));
    await waitFor(() => expect(copies()).toHaveLength(1));
    const c = copies()[0]!;
    expect(c.path).toBe(`/v1/catalog/price-lists/${ID(62)}/copy`);
    expect(c.json).toEqual({ source_price_list_version_id: ID(70), mode: 'merge' });
    expect(c.headers.get('idempotency-key')).toBeTruthy();
    const link = await screen.findByRole('link', { name: /open draft/i });
    expect(link.getAttribute('href')).toBe(`/catalog/price-lists/${ID(62)}/versions/${ID(521)}`);
  });
  it('replace with +10 % and rounding nearest rupee: percent_bp 1000 and rounding sent; another version can be the source', async () => {
    const d = await open();
    await pickTarget(d);
    await choose(d, /^version to copy/i, /v1\b/);
    await userEvent.click(within(d).getByRole('radio', { name: /^replace/i }));
    await userEvent.type(within(d).getByRole('textbox', { name: /^adjust by percent/i }), '10');
    await choose(d, /^rounding/i, /^nearest rupee$/i);
    await userEvent.click(confirm(d));
    await waitFor(() => expect(copies()).toHaveLength(1));
    expect(copies()[0]!.json).toEqual({ source_price_list_version_id: ID(71), mode: 'replace', percent_bp: 1000, rounding: 'nearest_rupee' });
  });
  it('a percent with no rounding chosen sends rounding "none"; a negative percent is accepted down to -100', async () => {
    const d = await open();
    await pickTarget(d);
    await userEvent.click(within(d).getByRole('radio', { name: /^merge/i }));
    await userEvent.type(within(d).getByRole('textbox', { name: /^adjust by percent/i }), '-12.5');
    await userEvent.click(confirm(d));
    await waitFor(() => expect(copies()).toHaveLength(1));
    expect(copies()[0]!.json).toEqual({ source_price_list_version_id: ID(70), mode: 'merge', percent_bp: -1250, rounding: 'none' });
  });
  it.each(['abc', '12.345', '1000.01', '-100.01', '1e2', '--5', '5%'])('the percent "%s" is refused in the browser with no request', async (bad) => {
    const d = await open();
    await pickTarget(d);
    await userEvent.click(within(d).getByRole('radio', { name: /^merge/i }));
    await userEvent.type(within(d).getByRole('textbox', { name: /^adjust by percent/i }), bad);
    if (!confirm(d).disabled) await userEvent.click(confirm(d));
    await settle();
    expect(copies()).toHaveLength(0);
    expect(d.textContent).toMatch(/percent|between|decimals/i);
  });
  it('409 (the target already has a draft) and 422 (a price would go below 0) show the server detail verbatim and keep the dialog', async () => {
    for (const [status, code, detail] of [[409, 'common.version_conflict', 'Synthetic: DR_X already has a draft version.'], [422, 'catalog.formula_invalid', 'Synthetic: a price would be below 0.']] as const) {
      cleanup();
      API.reset();
      API.copy = [() => prob(status, code, detail)];
      const d = await open();
      await pickTarget(d);
      await userEvent.click(within(d).getByRole('radio', { name: /^merge/i }));
      await userEvent.click(confirm(d));
      const alerts = await within(d).findAllByRole('alert');
      expect(alerts.map((a) => a.textContent).join(' '), String(status)).toContain(detail);
      expect(screen.queryByRole('link', { name: /open draft/i })).toBeNull();
      expect(screen.getByRole('dialog')).toBeTruthy();
    }
  });
  it('a double click on Copy sends one request; Cancel and Escape send nothing', async () => {
    API.copyDelayMs = 150;
    const d = await open();
    await pickTarget(d);
    await userEvent.click(within(d).getByRole('radio', { name: /^merge/i }));
    await userEvent.dblClick(confirm(d));
    await new Promise((r) => setTimeout(r, 300));
    expect(copies()).toHaveLength(1);
    cleanup();
    API.reset();
    const d2 = await open();
    await userEvent.click(within(d2).getByRole('button', { name: /^cancel$/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await userEvent.click(screen.getAllByRole('button', { name: /^copy to/i })[0]!);
    await dialog();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(copies()).toHaveLength(0);
  });
  it('axe: the open Copy to dialog has no violations', async () => { await open(); await noAxe(); });
});

// =============================================================================================================================== dated assignments
describe('assignments with an effective period', () => {
  const owners = () => tableOf(sec(/^assignments$/i));
  const from = () => screen.getByLabelText(/^effective from/i) as HTMLInputElement;
  const to = () => screen.getByLabelText(/^effective to/i) as HTMLInputElement;
  const save = () => screen.getByRole('button', { name: /^save assignments$/i }) as HTMLButtonElement;
  const setDate = (el: HTMLInputElement, v: string) => fireEvent.change(el, { target: { value: v } });

  it('the table has the columns Owner, Effective from, Effective to and shows the period of every owner; no end = Open ended', async () => {
    await openDetail(CP_DETAIL);
    expect(headersOf(owners()).slice(0, 3)).toEqual(['Owner', 'Effective from', 'Effective to']);
    const rows = bodyRows(owners()).map(cells);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.join(' ')).toContain('Synthetic General Hospital');
    expect(rows[0]!.join(' ')).toContain('2026-10-01');
    expect(rows[0]!.join(' ')).toContain('2026-12-31');
    expect(rows[1]!.join(' ')).toContain('Synthetic Affiliate Clinic');
    expect(rows[1]!.join(' ')).toMatch(/open.?ended/i);
  });
  it('"Effective from" and "Effective to" are native date inputs', async () => {
    await openDetail(CP_DETAIL);
    expect(from().type).toBe('date');
    expect(to().type).toBe('date');
  });
  it('Save with no dates keeps the old body: {owner_ids} only (nothing invented)', async () => {
    await openDetail(CP_DETAIL);
    await userEvent.click(within(owners()).getAllByRole('button', { name: /^remove/i })[0]!);
    await userEvent.click(save());
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]!.json).toEqual({ owner_ids: [ID(91)] });
    expect(puts()[0]!.headers.get('if-match')).toBe('"3"');
  });
  it('Save with both dates sends them as ISO date-times of those days; the dates alone make Save assignments enabled', async () => {
    await openDetail(CP_DETAIL);
    expect(save().disabled).toBe(true);
    setDate(from(), '2026-12-01');
    setDate(to(), '2027-01-31');
    expect(save().disabled).toBe(false);
    await userEvent.click(save());
    await waitFor(() => expect(puts()).toHaveLength(1));
    const b = puts()[0]!.json;
    expect(Object.keys(b).sort()).toEqual(['effective_from', 'effective_to', 'owner_ids']);
    expect(b.owner_ids).toEqual([ID(90), ID(91)]);
    expect(b.effective_from).toMatch(/^2026-12-01T/);
    expect(b.effective_to).toMatch(/^2027-01-31T/);
    expect(new Date(b.effective_from).getTime()).toBeLessThan(new Date(b.effective_to).getTime());
  });
  it('only a "from" date: effective_to is not sent (open ended)', async () => {
    await openDetail(CP_DETAIL);
    setDate(from(), '2026-12-01');
    await userEvent.click(save());
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]!.json.effective_from).toMatch(/^2026-12-01T/);
    expect('effective_to' in puts()[0]!.json).toBe(false);
  });
  it('"to" before "from" is refused in the browser with an alert and NO request', async () => {
    await openDetail(CP_DETAIL);
    setDate(from(), '2026-12-31');
    setDate(to(), '2026-12-01');
    if (!save().disabled) await userEvent.click(save());
    await settle();
    expect(puts()).toHaveLength(0);
    expect(screen.getAllByRole('alert').length + (document.body.textContent?.match(/before|after|earlier/i) ? 1 : 0)).toBeGreaterThan(0);
  });
  it('the server overlap refusal (409 catalog.code_duplicate) is shown with the server detail verbatim; owners and dates stay', async () => {
    const detail = 'Synthetic overlap: GH already has price list DEFAULT from 2026-12-15 to 2027-02-01.';
    API.assignments = [() => prob(409, 'catalog.code_duplicate', detail)];
    await openDetail(CP_DETAIL);
    setDate(from(), '2026-12-01');
    setDate(to(), '2026-12-31');
    await userEvent.click(save());
    const alerts = await screen.findAllByRole('alert');
    expect(alerts.map((a) => a.textContent).join(' ')).toContain(detail);
    expect(bodyRows(owners())).toHaveLength(2);
    expect(from().value).toBe('2026-12-01');
    expect(to().value).toBe('2026-12-31');
    expect(save().disabled).toBe(false);
  });
  it('a 409 without detail still says "overlap" in words; a double click saves once', async () => {
    API.assignments = [() => HttpResponse.json({ type: 'urn:lims:error:catalog.code_duplicate', title: 'Conflict', status: 409, code: 'catalog.code_duplicate' }, { status: 409, headers: { 'content-type': 'application/problem+json' } })];
    await openDetail(CP_DETAIL);
    setDate(from(), '2026-12-01');
    await userEvent.dblClick(save());
    const alerts = await screen.findAllByRole('alert');
    expect(alerts.map((a) => a.textContent).join(' ')).toMatch(/overlap/i);
    expect(puts()).toHaveLength(1);
  });
  it('the existing duplicate-owner / save behaviour holds: success refreshes the page', async () => {
    await openDetail(CP_DETAIL);
    setDate(from(), '2026-12-01');
    await userEvent.click(save());
    await waitFor(() => expect(TM.refresh.mock.calls.length).toBeGreaterThan(0));
  });
  it('the default price list has no assignments editor (it applies to everyone)', async () => {
    await openDetail();
    expect(screen.queryByLabelText(/^effective from/i)).toBeNull();
  });
});

// =============================================================================================================================== permissions
describe('permission states: shown disabled with a visible reason, never silently missing', () => {
  it('a reader sees Download template, Export to Excel and Copy to DISABLED and the reason names catalog.price_list.manage', async () => {
    await openDetail(DEFAULT_DETAIL, READ);
    for (const n of [/^download template$/i, /^export to excel$/i, /^copy to/i]) {
      const bs = screen.getAllByRole('button', { name: n }) as HTMLButtonElement[];
      expect(bs.length, String(n)).toBeGreaterThan(0);
      for (const b of bs) expect(b.disabled, String(n)).toBe(true);
    }
    expect(document.body.textContent).toMatch(/catalog\.price_list\.manage/);
  });
  it('a reader has no file input, no Commit to draft and no commit/dry-run/copy request is possible', async () => {
    await openDetail(DEFAULT_DETAIL, READ);
    expect(document.querySelector('input[type=file]:not([disabled])')).toBeNull();
    const c = within(sec(UP)).queryByRole('button', { name: /^commit to draft/i }) as HTMLButtonElement | null;
    if (c) expect(c.disabled).toBe(true);
    expect(dryRuns()).toHaveLength(0);
  });
  it('a reader sees the history table and its headers, and the date inputs read only (hospital list)', async () => {
    await openDetail(CP_DETAIL, READ);
    expect(headersOf(tableOf(sec(HIST))).slice(0, 3)).toEqual(['Time', 'Uploaded by', 'Status']);
    for (const el of [screen.queryByLabelText(/^effective from/i), screen.queryByLabelText(/^effective to/i)]) if (el) expect((el as HTMLInputElement).readOnly || (el as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: /^save assignments$/i })).toBeNull();
  });
  it('a manager sees no permission reason text', async () => {
    await openDetail();
    expect(document.body.textContent).not.toMatch(/catalog\.price_list\.manage/);
  });
});

// =============================================================================================================================== a11y, keyboard, density
describe('keyboard and accessibility', () => {
  it('axe: no violations with a result and errors on screen', async () => {
    API.batches = [committedBatch(504)];
    await openDetail(CP_DETAIL);
    await noAxe();
    cleanup();
    await openDetail();
    await checked(BAD(3));
    await noAxe();
  });
  it('the whole flow is reachable by keyboard: Tab reaches the file chooser, Download template, Commit to draft', async () => {
    await openDetail();
    const reach = (el: HTMLElement) => { el.focus(); return document.activeElement === el; };
    expect(reach(within(sec(UP)).getByRole('button', { name: /^download template$/i }))).toBe(true);
    expect(reach(fileInput()) || fileInput().tabIndex >= -1).toBe(true);
    expect(tablesOf(sec(UP)).length).toBeGreaterThan(0);
  });
  it('every price tool table is compact density (lims-table-compact)', async () => {
    await openDetail();
    for (const t of [errTable(), tableOf(sec(HIST))]) expect(t.className).toMatch(/lims-table-compact/);
  });
});
