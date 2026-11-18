// @vitest-environment jsdom
// T0D-TESTIMPORT-1 (LD-318 / LD-310 / LD-353; founder 2026-11-17 08:58 NPT): the Excel "Import tests" screen of the catalog area. Rendered through the PAGE
// default export of /catalog/imports (async server component), MSW standing in for the API (testimport1.harness.tsx). NO route is added (rs-c2 / route pin in
// testimport1.source.test.ts), so the screen lives at /catalog/imports?view=tests; the plain /catalog/imports stays the price list / master import screen.
// CONTRACT pinned here (names the spec fixes are copied; everything else is the tester's wording, listed for the lead):
//   entry      : /catalog/imports (default view) shows the link "Import tests" -> /catalog/imports?view=tests to users holding catalog.test.manage only
//                (listCatalogImports / template / validate / commit all need that permission). ?view=tests: GET /v1/catalog/test-import-batches 403 -> the
//                CatalogForbidden page (no throw); 500 -> the ApiError is thrown (error.tsx); an unknown ?view falls back to the default view.
//   one screen : h1 "Import tests"; four h2 steps in this order, each inside its own <section>: "Download template", "Choose file", "Validate", "Commit";
//                then h2 "Import history" with its table. Result summary after a commit = h2 "Import result" in its own section.
//   step 1     : button "Download template" + the visible file name test-import-template-v1.xlsx (the template version); click -> GET
//                /v1/catalog/test-import-template once, then a programmatic anchor download named test-import-template-v1.xlsx. No new route: the bytes come through a
//                server action. A failure shows a role=alert and leaves the button usable.
//   step 2     : the kit FileUpload (one <input type=file>, accept = the xlsx MIME only, drag and drop, progress bar "Upload progress for <name>", 3 retries on 5xx
//                with the SAME Idempotency-Key, no retry on 4xx), maxBytes 5 MB (5242880 exactly accepted, +1 refused), empty / csv / xls / xlsm refused with NO request.
//                A valid pick starts the dry run at once: POST multipart (file, mode) with an Idempotency-Key. Mode radios "Create only" (default) / "Update existing";
//                Update shows a visible role=alert|status|note warning naming "existing tests" and "draft". Server text (problem detail) is shown verbatim.
//   step 3     : counts Tests / Parameters / Ranges / Panels / Errors (parameters = analytes); the errors table with columns Sheet, Row, Column, Problem (headers
//                visible when empty, LD-336 four placeholder rows), the server message verbatim in Problem, filter textbox "Filter errors" (any column), pages of 25
//                with buttons Previous / Next, and a button "Download errors file" (disabled without errors; GET .../{batch}/errors-file, anchor .xlsx download).
//   step 4     : button "Commit" disabled until the CURRENT file + mode validated with zero errors (also disabled while uploading, after a mode change, after
//                commit). It opens a dialog: what will be created as drafts (counts) and the sentence "a pathologist must publish the drafts before the tests can be
//                ordered"; Cancel / Escape send nothing; confirm sends ONE POST .../{id}/commit {confirm:true} with If-Match "<version>" and an Idempotency-Key.
//   result     : created counts, the words "drafts" and "pathologist must publish", a link per previewed test (name = its code) to /catalog/tests?q=<CODE>.
//   history    : table columns File, Uploaded by, Time, Mode, Tests, Parameters, Ranges, Errors, Status, Committed at (visible when empty, LD-336); refreshed after
//                a validation and after a commit (router.refresh() or a second GET of the list).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse } from 'msw';
import axe from 'axe-core';
import { ApiError } from '@/core/api/server-fetch';
import { expectEmptyTable, headersOf, tableOf, tablesOf } from './emptytbl2.helpers';
import { API, BAD, CLEAN, ID, MANAGE, MB, READ, TEMPLATE_FILE, TM, XLSX, api, batch, captureDownloads, downloads, err, openPage, openTests, prob, xlsxFile } from './testimport1.harness';

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterAll(() => api.close());
beforeEach(() => { API.reset(); TM.session.permissions = MANAGE; TM.nav.search = ''; captureDownloads(); });
afterEach(() => { cleanup(); api.resetHandlers(); TM.push.mockClear(); TM.replace.mockClear(); TM.refresh.mockReset(); });

// ----------------------------------------------------------------------------------------------------------------------------------- helpers
const fileInput = () => document.querySelector<HTMLInputElement>('input[type=file]')!;
const pick = (f: File) => userEvent.upload(fileInput(), f, { applyAccept: false });
const step = (re: RegExp): HTMLElement => {
  const h = screen.getAllByRole('heading', { level: 2 }).find((x) => re.test(x.textContent ?? ''));
  if (!h) throw new Error(`no h2 step heading matching ${re}`);
  const s = h.closest('section');
  if (!s) throw new Error(`the heading "${h.textContent}" is not inside its own <section>`);
  return s as HTMLElement;
};
const S = { template: /download template/i, choose: /choose file/i, validate: /^\s*(\d\.?\s*)?validate/i, commit: /^\s*(\d\.?\s*)?commit/i, history: /import history/i, result: /import result/i };
const validates = () => API.count('POST', /test-import-batches$/);
const commits = () => API.count('POST', /\/commit$/);
const commitBtn = () => within(step(S.commit)).getByRole('button', { name: /^commit/i }) as HTMLButtonElement;
const settle = () => new Promise((r) => setTimeout(r, 60));
const dialog = () => screen.findByRole('dialog');
const confirmBtn = (d: HTMLElement) => within(d).getByRole('button', { name: /^(commit|commit import|create drafts)$/i });

/** Header -> text of one body row (kit table, <th>/<td> or role=columnheader/cell). */
const bodyRows = (t: HTMLElement) => [...t.querySelectorAll<HTMLElement>('tbody tr, [role="rowgroup"] [role="row"]')].filter((r) => r.getAttribute('aria-hidden') !== 'true' && !r.closest('[aria-hidden="true"]') && !r.closest('thead') && !r.querySelector('th, [role="columnheader"]') && (r.textContent ?? '').trim() !== '');
const cells = (r: HTMLElement) => [...r.querySelectorAll('td, [role="cell"], [role="gridcell"]')].map((c) => (c.textContent ?? '').trim());
const errTable = () => tableOf(step(S.validate));
/** The value shown for a count label: "Tests: 2" in one element, a label + value pair (dt/dd, span/strong, tile), or a label followed by its value sibling. */
const countOf = (label: string): string => {
  const leaves = [...step(S.validate).querySelectorAll<HTMLElement>('*')].filter((e) => e.children.length === 0);
  const joined = leaves.find((e) => new RegExp(`^${label}\\s*:?\\s*\\d+$`).test((e.textContent ?? '').trim()));
  if (joined) return (joined.textContent ?? '').replace(label, '').replace(':', '').trim();
  const el = leaves.find((e) => (e.textContent ?? '').trim().replace(/:$/, '') === label);
  if (!el) throw new Error(`no "${label}" count label in the Validate step`);
  const parent = el.parentElement;
  if (parent && parent.children.length <= 2) return (parent.textContent ?? '').replace(label, '').replace(':', '').trim();
  return (el.nextElementSibling?.textContent ?? '').trim();
};
/** Upload a valid file and wait until the dry run answered. */
async function validated(body: Record<string, any> = CLEAN(), f = xlsxFile()) {
  API.validate = [() => HttpResponse.json(body, { status: 201 })];
  await pick(f);
  await waitFor(() => expect(validates()).toHaveLength(1));
  await waitFor(() => expect(countOf('Tests')).toMatch(/\b2\b/));
}
const noAxe = async () => { const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } }); expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]); };

// =============================================================================================================================== entry
describe('entry: no new route, the screen is /catalog/imports?view=tests', () => {
  it('the default /catalog/imports keeps the price list import and links to "Import tests" for managers', async () => {
    await openPage('');
    expect(screen.getByText(/what do you want to import/i)).toBeTruthy();
    const link = screen.getByRole('link', { name: /^import tests$/i });
    expect(link.getAttribute('href')).toBe('/catalog/imports?view=tests');
  });
  it('a reader (no catalog.test.manage) gets no "Import tests" link', async () => {
    await openPage('', READ);
    expect(screen.queryByRole('link', { name: /^import tests$/i })).toBeNull();
  });
  it('an unknown ?view value falls back to the default view and never throws', async () => {
    await openPage('view=%3Cscript%3E');
    expect(screen.getByText(/what do you want to import/i)).toBeTruthy();
  });
  it('403 on the history call shows the no-access page, no throw', async () => {
    API.listFail = 403;
    await openTests(READ);
    expect(screen.getByRole('heading', { name: /don.t have access to this part of the catalog/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /download template/i })).toBeNull();
  });
  it('500 on the history call throws the ApiError (error.tsx)', async () => {
    API.listFail = 500;
    await expect(openTests()).rejects.toBeInstanceOf(ApiError);
  });
});

// =============================================================================================================================== one screen, four steps
describe('one screen with four steps', () => {
  it('h1 "Import tests", then the four step headings in order, each in its own section, then the history', async () => {
    await openTests();
    expect(screen.getByRole('heading', { level: 1, name: /import tests/i })).toBeTruthy();
    const heads = [S.template, S.choose, S.validate, S.commit, S.history].map((re) => screen.getAllByRole('heading', { level: 2 }).find((h) => re.test(h.textContent ?? ''))!);
    heads.forEach((h, i) => {
      expect(h, `step heading ${i}`).toBeTruthy();
      if (i) expect(heads[i - 1]!.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_FOLLOWING, `step ${i} comes after step ${i - 1}`).toBeTruthy();
    });
    expect(new Set(heads.map((h) => h.closest('section'))).size, 'five different sections').toBe(5);
  });
  it('the controls sit in their step: template button, file input, errors table + counts, commit button', async () => {
    await openTests();
    expect(within(step(S.template)).getByRole('button', { name: /download template/i })).toBeTruthy();
    expect(step(S.choose).contains(fileInput())).toBe(true);
    expect(tablesOf(step(S.validate))).toHaveLength(1);
    expect(commitBtn()).toBeTruthy();
  });
  it('is axe clean before and after a validation with errors', async () => {
    await openTests();
    await noAxe();
    await validated(BAD(3));
    await noAxe();
  });
});

// =============================================================================================================================== step 1
describe('step 1: download template', () => {
  it('shows the file name with the template version', async () => {
    await openTests();
    expect(step(S.template).textContent).toContain(TEMPLATE_FILE);
  });
  it('click: one GET of the template, then an anchor download with the versioned name', async () => {
    await openTests();
    await userEvent.click(within(step(S.template)).getByRole('button', { name: /download template/i }));
    await waitFor(() => expect(downloads.length).toBe(1));
    expect(downloads[0]!.name).toBe(TEMPLATE_FILE);
    expect(API.count('GET', /test-import-template$/)).toHaveLength(1);
  });
  it('keyboard: Enter on the focused button downloads', async () => {
    await openTests();
    within(step(S.template)).getByRole('button', { name: /download template/i }).focus();
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(downloads.length).toBe(1));
  });
  it('a failing download shows a role=alert (no crash, no raw status) and the button stays usable', async () => {
    API.templateFail = true;
    await openTests();
    const b = within(step(S.template)).getByRole('button', { name: /download template/i }) as HTMLButtonElement;
    await userEvent.click(b);
    await waitFor(() => expect(within(step(S.template)).getByRole('alert')).toBeTruthy());
    expect(downloads).toHaveLength(0);
    expect(b.disabled).toBe(false);
  });
});

// =============================================================================================================================== step 2
describe('step 2: choose file (client side checks, drag and drop, mode)', () => {
  it('one file input accepting only the xlsx MIME; the hint names .xlsx and 5 MB', async () => {
    await openTests();
    expect(document.querySelectorAll('input[type=file]')).toHaveLength(1);
    expect(fileInput().getAttribute('accept')).toBe(XLSX);
    expect(fileInput().multiple).toBe(false);
    expect(step(S.choose).textContent).toMatch(/\.xlsx/i);
    expect(step(S.choose).textContent).toMatch(/5 ?MB/i);
  });
  it.each([
    ['tests.csv', 'text/csv'],
    ['tests.xls', 'application/vnd.ms-excel'],
    ['tests.xlsm', 'application/vnd.ms-excel.sheet.macroEnabled.12'],
    ['tests.pdf', 'application/pdf'],
  ])('refuses %s (%s) before sending: message, no request', async (name, type) => {
    await openTests();
    await pick(xlsxFile(name, 64, type));
    expect(await screen.findByText(new RegExp(`${name.replace('.', '\\.')}.*not allowed`, 'i'))).toBeTruthy();
    await settle();
    expect(validates()).toHaveLength(0);
    expect(commitBtn().disabled).toBe(true);
  });
  it('refuses a file of 5 MB + 1 byte: "larger than 5 MB", no request', async () => {
    await openTests();
    await pick(xlsxFile('big.xlsx', 5 * MB + 1));
    expect(await screen.findByText(/big\.xlsx is larger than 5 MB/i)).toBeTruthy();
    await settle();
    expect(validates()).toHaveLength(0);
  });
  it('accepts a file of exactly 5 MB', async () => {
    await openTests();
    await pick(xlsxFile('edge.xlsx', 5 * MB));
    await waitFor(() => expect(validates()).toHaveLength(1));
  });
  it('refuses an empty file, no request', async () => {
    await openTests();
    await pick(xlsxFile('empty.xlsx', 0));
    expect(await screen.findByText(/empty\.xlsx is empty/i)).toBeTruthy();
    await settle();
    expect(validates()).toHaveLength(0);
  });
  it('drag and drop starts the dry run like browsing does', async () => {
    await openTests();
    const zone = fileInput().closest('.lims-file-upload')!;
    fireEvent.drop(zone, { dataTransfer: { files: [xlsxFile('dropped.xlsx')] } });
    await waitFor(() => expect(validates()).toHaveLength(1));
    expect((validates()[0]!.form!.get('file') as { name: string }).name).toBe('dropped.xlsx');
  });

  it('the mode switch: Create only is the default, Update existing shows a visible warning, going back removes it', async () => {
    await openTests();
    const create = screen.getByRole('radio', { name: /create only/i }) as HTMLInputElement;
    const update = screen.getByRole('radio', { name: /update existing/i }) as HTMLInputElement;
    expect(create.checked).toBe(true);
    expect(update.checked).toBe(false);
    expect(screen.queryAllByRole('alert').concat(screen.queryAllByRole('status'), screen.queryAllByRole('note')).filter((e) => /existing tests/i.test(e.textContent ?? ''))).toHaveLength(0);
    await userEvent.click(update);
    const warn = screen.queryAllByRole('alert').concat(screen.queryAllByRole('status'), screen.queryAllByRole('note')).find((e) => /existing tests/i.test(e.textContent ?? ''));
    expect(warn, 'a visible warning naming "existing tests"').toBeTruthy();
    expect(warn!.textContent).toMatch(/draft/i);
    await userEvent.click(create);
    expect(screen.queryAllByRole('alert').concat(screen.queryAllByRole('status'), screen.queryAllByRole('note')).filter((e) => /existing tests/i.test(e.textContent ?? ''))).toHaveLength(0);
  });
  it('keyboard: arrow keys move between the two modes', async () => {
    await openTests();
    (screen.getByRole('radio', { name: /create only/i }) as HTMLInputElement).focus();
    await userEvent.keyboard('{ArrowDown}');
    expect((screen.getByRole('radio', { name: /update existing/i }) as HTMLInputElement).checked).toBe(true);
  });
});

describe('step 2: the upload request', () => {
  it('POSTs multipart with the file name, mode create_only and an Idempotency-Key', async () => {
    await openTests();
    await pick(xlsxFile('my tests.xlsx'));
    await waitFor(() => expect(validates()).toHaveLength(1));
    const c = validates()[0]!;
    expect((c.form!.get('file') as { name: string }).name).toBe('my tests.xlsx');
    expect(c.form!.get('mode')).toBe('create_only');
    expect(c.headers.get('idempotency-key') ?? '').toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(c.headers.get('content-type')).toMatch(/^multipart\/form-data; boundary=/);
  });
  it('Update existing sends mode=update', async () => {
    await openTests();
    await userEvent.click(screen.getByRole('radio', { name: /update existing/i }));
    await pick(xlsxFile());
    await waitFor(() => expect(validates()).toHaveLength(1));
    expect(validates()[0]!.form!.get('mode')).toBe('update');
  });
  it('shows an upload progress bar named after the file while the dry run runs', async () => {
    API.validateDelayMs = 500;
    await openTests();
    await pick(xlsxFile('slow.xlsx'));
    expect(await screen.findByRole('progressbar', { name: /upload progress for slow\.xlsx/i })).toBeTruthy();
    expect(commitBtn().disabled, 'no commit while the dry run runs').toBe(true);
    await waitFor(() => expect(countOf('Tests')).toMatch(/\b2\b/));
  });
  it('a 5xx is retried with the SAME Idempotency-Key and then succeeds (one result, no duplicate)', async () => {
    await openTests();
    API.validate = [() => prob(500, 'common.internal'), () => prob(500, 'common.internal'), () => HttpResponse.json(CLEAN(), { status: 201 })];
    await pick(xlsxFile());
    await waitFor(() => expect(validates()).toHaveLength(3), { timeout: 8000 });
    expect(new Set(validates().map((c) => c.headers.get('idempotency-key'))).size, 'one key for every attempt of one pick').toBe(1);
    await waitFor(() => expect(countOf('Tests')).toMatch(/\b2\b/));
  }, 20_000);
  it('picking another file uses a NEW Idempotency-Key', async () => {
    await openTests();
    await pick(xlsxFile('one.xlsx'));
    await waitFor(() => expect(validates()).toHaveLength(1));
    await pick(xlsxFile('two.xlsx'));
    await waitFor(() => expect(validates()).toHaveLength(2));
    expect(validates()[0]!.headers.get('idempotency-key')).not.toBe(validates()[1]!.headers.get('idempotency-key'));
  });
  it.each([
    [422, 'catalog.import_invalid_file'],
    [422, 'catalog.import_template_outdated'],
    [413, 'catalog.import_too_large'],
    [403, 'auth.forbidden'],
  ])('a %i %s is final (one request), its server text is shown verbatim, and nothing can be committed', async (status, code) => {
    API.validate = [() => prob(status, code, `Synthetic refusal text for ${code}: fix the file and try again.`)];
    await openTests();
    await pick(xlsxFile());
    expect(await screen.findByText(`Synthetic refusal text for ${code}: fix the file and try again.`)).toBeTruthy();
    await settle();
    expect(validates()).toHaveLength(1);
    expect(commitBtn().disabled).toBe(true);
    expect(within(step(S.template)).getByRole('button', { name: /download template/i })).toBeTruthy();
  });
});

// =============================================================================================================================== step 3
describe('step 3: validate (counts, errors table, errors file)', () => {
  it('before any file: the five counts are shown as zero and the errors table keeps its four column names (empty table rows)', async () => {
    await openTests();
    for (const l of ['Tests', 'Parameters', 'Ranges', 'Panels', 'Errors']) expect(countOf(l), l).toMatch(/^(0|—)$/);
    const t = errTable();
    expectEmptyTable(t, null, ['Sheet', 'Row', 'Column', 'Problem']);
    expect(headersOf(t)).toEqual(['Sheet', 'Row', 'Column', 'Problem']);
  });
  it('a clean file: counts of tests, parameters, ranges, panels and zero errors; the headers stay, the message says there is no error', async () => {
    await openTests();
    await validated(CLEAN());
    expect(countOf('Tests')).toMatch(/\b2\b/);
    expect(countOf('Parameters')).toMatch(/\b5\b/);
    expect(countOf('Ranges')).toMatch(/\b7\b/);
    expect(countOf('Panels')).toMatch(/\b1\b/);
    expect(countOf('Errors')).toMatch(/\b0\b/);
    expectEmptyTable(errTable(), /no errors/i, ['Sheet', 'Row', 'Column', 'Problem']);
  });
  it('a rejected file lists EVERY error with sheet, row, column and the server message verbatim', async () => {
    await openTests();
    await validated(BAD(3));
    expect(countOf('Errors')).toMatch(/\b3\b/);
    const rows = bodyRows(errTable());
    expect(rows).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      const e = err(i + 1);
      const c = cells(rows[i]!);
      expect(c, `row ${i}`).toEqual([e.sheet, String(e.row), e.column, e.message]);
    }
  });
  it('error text is rendered as text, never as markup', async () => {
    await openTests();
    const evil = err(1, { message: '<img src=x onerror=alert(1)> <b>bold</b>' });
    await validated({ ...BAD(1), errors: [evil] });
    const row = bodyRows(errTable())[0]!;
    expect(row.querySelector('img, b, script')).toBeNull();
    expect(row.textContent).toContain('<img src=x onerror=alert(1)>');
  });
  it('is paged: 25 rows a page, Next / Previous, Next disabled on the last page', async () => {
    await openTests();
    await validated(BAD(60));
    expect(bodyRows(errTable())).toHaveLength(25);
    expect(cells(bodyRows(errTable())[0]!)[3]).toContain('number 1:');
    const step3 = step(S.validate);
    const next = () => within(step3).getByRole('button', { name: /^next/i }) as HTMLButtonElement;
    const prev = () => within(step3).getByRole('button', { name: /^previous/i }) as HTMLButtonElement;
    expect(prev().disabled).toBe(true);
    await userEvent.click(next());
    expect(bodyRows(errTable())).toHaveLength(25);
    expect(cells(bodyRows(errTable())[0]!)[3]).toContain('number 26:');
    await userEvent.click(next());
    expect(bodyRows(errTable())).toHaveLength(10);
    expect(next().disabled).toBe(true);
    await userEvent.click(prev());
    expect(cells(bodyRows(errTable())[0]!)[3]).toContain('number 26:');
  });
  it('is filterable ("Filter errors", any column) and a filter with no match keeps the headers and says so', async () => {
    await openTests();
    await validated(BAD(60));
    const f = within(step(S.validate)).getByRole('textbox', { name: /filter errors/i });
    await userEvent.type(f, 'Reference Ranges');
    const rows = bodyRows(errTable());
    expect(rows).toHaveLength(25);
    for (const r of rows) expect(cells(r)[0]).toBe('Reference Ranges');
    await userEvent.clear(f);
    await userEvent.type(f, 'number 59:');
    expect(bodyRows(errTable())).toHaveLength(1);
    await userEvent.clear(f);
    await userEvent.type(f, 'zzz-no-such-text');
    expectEmptyTable(errTable(), /no .*match/i, ['Sheet', 'Row', 'Column', 'Problem']);
  });
  it('"Download errors file": disabled without errors; with errors it fetches the file of THIS batch and downloads an .xlsx', async () => {
    await openTests();
    const btn = () => within(step(S.validate)).getByRole('button', { name: /download errors file/i }) as HTMLButtonElement;
    expect(btn().disabled).toBe(true);
    await validated(CLEAN());
    expect(btn().disabled).toBe(true);
    await validated(BAD(3), xlsxFile('bad.xlsx'));
    await waitFor(() => expect(countOf('Errors')).toMatch(/\b3\b/));
    expect(btn().disabled).toBe(false);
    await userEvent.click(btn());
    await waitFor(() => expect(downloads.length).toBe(1));
    expect(downloads[0]!.name).toMatch(/\.xlsx$/i);
    const g = API.count('GET', /errors-file$/);
    expect(g).toHaveLength(1);
    expect(g[0]!.path).toBe(`/v1/catalog/test-import-batches/${ID(2)}/errors-file`);
  });
  it('picking a second file replaces the first result (old errors and counts are gone)', async () => {
    await openTests();
    await validated(BAD(3));
    API.validate = [() => HttpResponse.json(CLEAN({ id: ID(3) }), { status: 201 })];
    await pick(xlsxFile('fixed.xlsx'));
    await waitFor(() => expect(validates()).toHaveLength(2));
    await waitFor(() => expect(countOf('Errors')).toMatch(/\b0\b/));
    expect(bodyRows(errTable())).toHaveLength(0);
    expect(commitBtn().disabled).toBe(false);
  });
});

// =============================================================================================================================== step 4
describe('step 4: commit', () => {
  it('is disabled with no file and while the file has errors', async () => {
    await openTests();
    expect(commitBtn().disabled).toBe(true);
    await validated(BAD(3));
    await waitFor(() => expect(countOf('Errors')).toMatch(/\b3\b/));
    expect(commitBtn().disabled).toBe(true);
  });
  it('is enabled only for a validated file with zero errors', async () => {
    await openTests();
    await validated(CLEAN());
    expect(commitBtn().disabled).toBe(false);
  });
  it('a rejected status with an empty error list still cannot be committed (status decides, not the list)', async () => {
    await openTests();
    await validated({ ...CLEAN(), batch: batch({ status: 'rejected', counts: { tests: 2, analytes: 5, ranges: 7, panels: 1, errors: 0 } }) });
    expect(commitBtn().disabled).toBe(true);
  });
  it('changing the mode after the dry run disables the commit again (the validated batch is of the other mode)', async () => {
    await openTests();
    await validated(CLEAN());
    expect(commitBtn().disabled).toBe(false);
    await userEvent.click(screen.getByRole('radio', { name: /update existing/i }));
    expect(commitBtn().disabled).toBe(true);
    expect(commits()).toHaveLength(0);
  });

  it('the confirm dialog says exactly what is created as drafts and who must publish', async () => {
    await openTests();
    await validated(CLEAN());
    await userEvent.click(commitBtn());
    const d = await dialog();
    const text = d.textContent ?? '';
    expect(text).toMatch(/draft/i);
    expect(text).toMatch(/\b2\s+tests?\b/i);
    expect(text).toMatch(/\b5\s+parameters?\b/i);
    expect(text).toMatch(/\b7\s+(reference\s+)?ranges?\b/i);
    expect(text).toMatch(/\b1\s+panels?\b/i);
    expect(text).toMatch(/a pathologist must publish the drafts before the tests can be ordered/i);
    expect(within(d).getByRole('button', { name: /^cancel$/i })).toBeTruthy();
  });
  it('Update existing: the dialog says it adds new draft versions to existing tests', async () => {
    await openTests();
    await userEvent.click(screen.getByRole('radio', { name: /update existing/i }));
    await validated(CLEAN({ mode: 'update' }));
    await userEvent.click(commitBtn());
    const d = await dialog();
    expect(d.textContent).toMatch(/existing tests?/i);
    expect(d.textContent).toMatch(/new draft versions?/i);
    expect(d.textContent).toMatch(/pathologist must publish/i);
  });
  it('Cancel sends nothing', async () => {
    await openTests();
    await validated(CLEAN());
    await userEvent.click(commitBtn());
    await userEvent.click(within(await dialog()).getByRole('button', { name: /^cancel$/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await settle();
    expect(commits()).toHaveLength(0);
  });
  it('keyboard: Enter opens the dialog, Escape closes it without a request and focus returns to the Commit button', async () => {
    await openTests();
    await validated(CLEAN());
    commitBtn().focus();
    await userEvent.keyboard('{Enter}');
    expect(await dialog()).toBeTruthy();
    expect(document.activeElement && (await dialog()).contains(document.activeElement), 'focus moves into the dialog').toBe(true);
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(commits()).toHaveLength(0);
    await waitFor(() => expect(document.activeElement).toBe(commitBtn()));
  });
  it('confirm: ONE POST /commit {confirm:true} with If-Match "<version>" and an Idempotency-Key, even on a double click', async () => {
    await openTests();
    await validated(CLEAN({ version: 4 }));
    await userEvent.click(commitBtn());
    const go = confirmBtn(await dialog());
    await userEvent.dblClick(go);
    await waitFor(() => expect(commits()).toHaveLength(1));
    await settle();
    expect(commits()).toHaveLength(1);
    const c = commits()[0]!;
    expect(c.path).toBe(`/v1/catalog/test-import-batches/${ID(1)}/commit`);
    expect(c.json).toEqual({ confirm: true });
    expect(c.headers.get('if-match')).toBe('"4"');
    expect(c.headers.get('idempotency-key') ?? '').toMatch(/^[A-Za-z0-9_-]{16,64}$/);
  });
  it('after the commit: the result summary, links to the drafts to review, no second commit, history refreshed', async () => {
    await openTests();
    await validated(CLEAN());
    await userEvent.click(commitBtn());
    await userEvent.click(confirmBtn(await dialog()));
    const res = await waitFor(() => step(S.result));
    const text = res.textContent ?? '';
    expect(text).toMatch(/\b2\s+tests?\b/i);
    expect(text).toMatch(/\b5\s+parameters?\b/i);
    expect(text).toMatch(/\b7\s+(reference\s+)?ranges?\b/i);
    expect(text).toMatch(/\b1\s+panels?\b/i);
    expect(text).toMatch(/drafts?/i);
    expect(text).toMatch(/pathologist must publish/i);
    for (const code of ['HB', 'CBC']) {
      const a = within(res).getByRole('link', { name: new RegExp(`\\b${code}\\b`) });
      expect(a.getAttribute('href')).toBe(`/catalog/tests?q=${code}`);
    }
    expect(commitBtn().disabled, 'a committed batch cannot be committed again').toBe(true);
    await waitFor(() => expect(TM.refresh.mock.calls.length > 0 || API.count('GET', /test-import-batches$/).length >= 2, 'history refreshed').toBe(true));
  });
  it.each([
    [409, 'catalog.import_batch_expired'],
    [409, 'catalog.import_already_committed'],
    [409, 'catalog.import_has_errors'],
    [409, 'common.version_conflict'],
  ])('a %i %s shows the server text, no result summary, and the page keeps working', async (status, code) => {
    API.commit = [() => prob(status, code, `Synthetic commit refusal for ${code}.`)];
    await openTests();
    await validated(CLEAN());
    await userEvent.click(commitBtn());
    await userEvent.click(confirmBtn(await dialog()));
    expect(await screen.findByText(`Synthetic commit refusal for ${code}.`)).toBeTruthy();
    expect(screen.queryByRole('heading', { level: 2, name: S.result })).toBeNull();
    expect(commits()).toHaveLength(1);
  });
});

// =============================================================================================================================== history
describe('import history', () => {
  const HEAD = ['File', 'Uploaded by', 'Time', 'Mode', 'Tests', 'Parameters', 'Ranges', 'Errors', 'Status', 'Committed at'];
  const histTable = () => tableOf(step(S.history));
  it('shows its ten column names with the empty-table rows when there is no import yet', async () => {
    await openTests();
    expectEmptyTable(histTable(), null, HEAD);
    expect(headersOf(histTable())).toEqual(HEAD);
  });
  it('lists every batch: file, uploader, time, mode, counts, errors, status, committed at', async () => {
    API.history = [
      batch({ id: ID(11), file_name: 'first.xlsx', status: 'committed', mode: 'create_only', committed_at: '2026-11-17T11:00:00.000Z', committed_by: ID(900) }),
      batch({ id: ID(12), file_name: 'second.xlsx', status: 'rejected', mode: 'update', counts: { tests: 3, analytes: 4, ranges: 5, panels: 0, errors: 9 }, created_by: ID(901) }),
      batch({ id: ID(13), file_name: 'third.xlsx', status: 'expired' }),
      batch({ id: ID(14), file_name: 'fourth.xlsx', status: 'validated' }),
    ];
    await openTests();
    const rows = bodyRows(histTable());
    expect(rows).toHaveLength(4);
    const by = (r: HTMLElement) => Object.fromEntries(HEAD.map((h, i) => [h, cells(r)[i]]));
    const a = by(rows[0]!);
    expect(a['File']).toBe('first.xlsx');
    expect(a['Uploaded by']).toContain(ID(900).slice(0, 8));
    expect(a['Time']).toMatch(/17\/11\/2026/);
    expect(a['Mode']).toMatch(/^create only$/i);
    expect([a['Tests'], a['Parameters'], a['Ranges'], a['Errors']]).toEqual(['2', '5', '7', '0']);
    expect(a['Status']).toMatch(/^committed$/i);
    expect(a['Committed at']).toMatch(/17\/11\/2026/);
    const b = by(rows[1]!);
    expect(b['Mode']).toMatch(/^update existing$/i);
    expect([b['Tests'], b['Parameters'], b['Ranges'], b['Errors']]).toEqual(['3', '4', '5', '9']);
    expect(b['Status']).toMatch(/^rejected$/i);
    expect(b['Uploaded by']).toContain(ID(901).slice(0, 8));
    expect(b['Committed at']).not.toMatch(/\d{2}\/\d{2}\/\d{4}/);
    expect(by(rows[2]!)['Status']).toMatch(/^expired$/i);
    expect(by(rows[3]!)['Status']).toMatch(/^validated$/i);
  });
  it('a file name is shown as text (no markup) and cut off cells carry a title', async () => {
    API.history = [batch({ file_name: '<b>x</b>-' + 'long'.repeat(20) + '.xlsx' })];
    await openTests();
    const row = bodyRows(histTable())[0]!;
    expect(row.querySelector('b')).toBeNull();
    expect(row.textContent).toContain('<b>x</b>-');
    expect([...row.querySelectorAll('[title]')].some((e) => (e.getAttribute('title') ?? '').includes('<b>x</b>-')), 'title attribute on the cut off file cell').toBe(true);
  });
  it('is refreshed after a validation (a new batch exists): router.refresh() or a second list call', async () => {
    await openTests();
    await pick(xlsxFile());
    await waitFor(() => expect(validates()).toHaveLength(1));
    await waitFor(() => expect(TM.refresh.mock.calls.length > 0 || API.count('GET', /test-import-batches$/).length >= 2).toBe(true));
  });
});
