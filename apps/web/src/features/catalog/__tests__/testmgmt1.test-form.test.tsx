// @vitest-environment jsdom
// T0D-TESTMGMT-1 item (3) — Add / Edit Test form with EVERY contract field in four compact sections, Copy test, live report preview.
// LD-318, LD-318 follow-up (1): code and display name are SUGGESTED the way ElabAssist does (NAME, SPECIMEN(CODE)); both stay editable.
// No route is added. Add = /catalog/tests?new=1 (role=dialog "New test", the form cattests1 already pins, extended). Edit = /catalog/tests/{id}?tab=general.
// CONTRACT pinned here:
//   sections   : four groups with the headings Basics, Report, Flags, Turnaround, each a section/fieldset/group carrying data-columns="3..6";
//                the one-screen model (1366 x 768, compact rows 28 px + 10 px gap) is computed from those attributes, see FITS below.
//   labels     : see FIELDS; required (aria-required or required): Code, Name, Department, Workflow type, Specimen type only.
//   preview    : region named "Report preview" AFTER the form in the same data-layout="form-with-preview" wrapper; patient header block
//                (labels Patient, Age / Sex, Sample, Date) + table with columns Test Name, Value, Unit, Reference Range; SAMPLE data only.
//   create     : POST /v1/catalog/tests (Idempotency-Key; numbers are numbers, tags an array, empty optional fields omitted), then, when any
//                stage minutes were entered, PUT /v1/catalog/tests/{id}/tat-targets {targets: [], stage_targets: [7 x {stage, target_minutes}]}.
//   edit       : PATCH /v1/catalog/tests/{id} with If-Match = version and ONLY the changed fields; stage minutes via the PUT above (targets = the
//                current tat_targets mapped to {priority, segment, target_seconds}); needs catalog.test.manage, else disabled + a visible reason.
//   copy       : button "Copy test" on the edit form -> address /catalog/tests?new=1&copy=<id>; that page prefills every field but Code.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { api, BIOC, calls, callsTo, EDTA, HAEM, ID, lastAddress, loadTests, MANAGE, READ, reset, S, show, TM, testDetail } from './testmgmt1.harness';

const FULL = testDetail(1, 'HB', 'Hemoglobin', {
  short_name: 'Hb', display_name: 'Hemoglobin, EDTA whole blood(HB)', tags: ['anaemia', 'cbc'], barcode_text: 'HB-01', loyalty_points: 5, display_order: 12, description: 'Oxygen carrier',
  report_type: 'four_column', processing_type: 'local', template_ref: 'TPL-1', outsource_name: '', is_outsourced: false, is_popular: true, smart_report: false, print_category_wise: true, nabl: true,
  accab_logo: false, auto_approval_enabled: true, use_normal_range_for_auto_approval: false, template_test: false, nabl_processing_centres: ['Centre A'], font: 'Arial', alert_before_expiry_minutes: 30,
  tat_targets: [{ priority: 'routine', segment: 'total', target_seconds: 14400 }],
  stage_targets: [{ stage: 'registration', target_minutes: 10 }, { stage: 'sample_collection', target_minutes: 30 }, { stage: 'accession', target_minutes: 45 }, { stage: 'result', target_minutes: 120 }, { stage: 'approval_1', target_minutes: 150 }, { stage: 'approval_2', target_minutes: 180 }, { stage: 'release', target_minutes: 240 }],
});

type Field = { key: string; label: RegExp };
const FIELDS: Record<'Basics' | 'Report' | 'Flags' | 'Turnaround', Field[]> = {
  Basics: [
    { key: 'code', label: /^code/i }, { key: 'name', label: /^name/i }, { key: 'display_name', label: /^display name/i }, { key: 'short_name', label: /^short name/i },
    { key: 'department_id', label: /^department/i }, { key: 'category_id', label: /^category/i }, { key: 'workflow_type', label: /^workflow type/i }, { key: 'specimen', label: /^specimen/i },
    { key: 'tags', label: /^tags/i }, { key: 'barcode_text', label: /^barcode/i }, { key: 'loyalty_points', label: /^loyalty/i }, { key: 'display_order', label: /^display order/i },
    { key: 'description', label: /^description/i }, { key: 'font', label: /^font/i },
  ],
  Report: [
    { key: 'report_type', label: /^report type/i }, { key: 'processing_type', label: /^processing type/i }, { key: 'template_ref', label: /^template$/i }, { key: 'outsource_name', label: /^outsource/i },
    { key: 'nabl_processing_centres', label: /^nabl processing cent/i }, { key: 'report_order', label: /^report order/i },
  ],
  Flags: [
    { key: 'is_orderable', label: /^orderable/i }, { key: 'uses_existing_material', label: /^uses existing material/i }, { key: 'is_outsourced', label: /^outsourced/i }, { key: 'is_popular', label: /^popular/i },
    { key: 'smart_report', label: /^smart report/i }, { key: 'print_category_wise', label: /^print category wise/i }, { key: 'nabl', label: /^nabl$/i }, { key: 'accab_logo', label: /^accab logo/i },
    { key: 'auto_approval_enabled', label: /^auto approval/i }, { key: 'use_normal_range_for_auto_approval', label: /^use normal range/i }, { key: 'template_test', label: /^template test/i },
  ],
  Turnaround: [
    { key: 'registration', label: /^registration/i }, { key: 'sample_collection', label: /^sample collection/i }, { key: 'accession', label: /^accession/i }, { key: 'result', label: /^result/i },
    { key: 'approval_1', label: /^approval 1/i }, { key: 'approval_2', label: /^approval 2/i }, { key: 'release', label: /^release/i }, { key: 'alert_before_expiry_minutes', label: /^alert before expiry/i },
  ],
};
const STAGES = ['registration', 'sample_collection', 'accession', 'result', 'approval_1', 'approval_2', 'release'];

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterAll(() => api.close());
beforeEach(() => { reset(); loadTests(FULL); });
afterEach(() => { cleanup(); api.resetHandlers(); });

const section = (name: string, root: HTMLElement = document.body) => {
  const h = within(root).getByRole('heading', { name: new RegExp(`^${name}$`, 'i') });
  const s = h.closest('section, fieldset, [role="group"], [role="region"]') as HTMLElement | null;
  if (!s) throw new Error(`no group around heading ${name}`);
  return s;
};
const choose = async (scope: HTMLElement, label: RegExp, option: RegExp) => {
  await userEvent.click(within(scope).getByLabelText(label));
  await userEvent.click(await screen.findByRole('option', { name: option }));
};
const openNew = async (search = 'new=1') => { await show('tests', { search }); return screen.findByRole('dialog', { name: /new test/i }); };
const openEdit = async (t = FULL) => { await show('test', { params: { test_id: String(t['id']) }, search: 'tab=general' }); return screen.findByRole('heading', { name: /^basics$/i }).then(() => document.body); };

describe('four sections hold every field (item 3)', () => {
  it.each(Object.keys(FIELDS) as (keyof typeof FIELDS)[])('Add Test: section %s has its fields', async (sec) => {
    const dlg = await openNew();
    expect(within(dlg).getAllByRole('heading').map((h) => h.textContent?.trim())).toEqual(expect.arrayContaining(['Basics', 'Report', 'Flags', 'Turnaround']));
    const s = section(sec, dlg);
    for (const f of FIELDS[sec]) expect(within(s).getByLabelText(f.label), `${sec}/${f.key}`).toBeTruthy();
  });
  it('Edit Test: the same four sections with the same fields, prefilled from the test', async () => {
    const root = await openEdit();
    for (const sec of Object.keys(FIELDS) as (keyof typeof FIELDS)[]) for (const f of FIELDS[sec]) expect(within(section(sec, root)).getByLabelText(f.label), `${sec}/${f.key}`).toBeTruthy();
    expect((within(section('Basics', root)).getByLabelText(/^short name/i) as HTMLInputElement).value).toBe('Hb');
    expect((within(section('Basics', root)).getByLabelText(/^loyalty/i) as HTMLInputElement).value).toBe('5');
    expect((within(section('Turnaround', root)).getByLabelText(/^release/i) as HTMLInputElement).value).toBe('240');
    expect((within(section('Turnaround', root)).getByLabelText(/^registration/i) as HTMLInputElement).value).toBe('10');
  });
  it('required fields are marked, optional ones are not', async () => {
    const dlg = await openNew();
    const req = (re: RegExp) => { const el = within(dlg).getByLabelText(re); return el.hasAttribute('required') || el.getAttribute('aria-required') === 'true' || !!el.closest('[aria-required="true"]'); };
    for (const re of [/^code/i, /^name/i, /^department/i, /^workflow type/i, /^specimen/i]) expect(req(re), String(re)).toBe(true);
    for (const re of [/^short name/i, /^barcode/i, /^loyalty/i, /^description/i, /^release/i, /^report type/i]) expect(req(re), String(re)).toBe(false);
  });
  it('the seven stage TAT inputs are numeric minutes (0..43200)', async () => {
    const dlg = await openNew();
    const s = section('Turnaround', dlg);
    for (const f of FIELDS.Turnaround.slice(0, 7)) {
      const el = within(s).getByLabelText(f.label) as HTMLInputElement;
      expect(el.getAttribute('inputmode') === 'numeric' || el.type === 'number' || el.getAttribute('role') === 'spinbutton', f.key).toBe(true);
      expect(s.textContent).toMatch(/minutes/i);
    }
  });
  it('the whole form fits one screen at 1366 x 768 (compact model: heading 24 + rows x 38 px; budget 768 - top bar 48 - page header 56 - padding 32)', async () => {
    const dlg = await openNew();
    let height = 0;
    for (const sec of Object.keys(FIELDS)) {
      const s = section(sec, dlg);
      const cols = Number(s.getAttribute('data-columns'));
      expect(cols, `${sec} data-columns`).toBeGreaterThanOrEqual(3);
      expect(cols).toBeLessThanOrEqual(6);
      const controls = s.querySelectorAll('input:not([type=hidden]), textarea, select, button[aria-haspopup], [role=combobox], [role=checkbox], [role=switch]').length;
      height += 24 + Math.ceil(controls / cols) * 38;
    }
    height += 38 + 8; // action row + gap
    expect(height).toBeLessThanOrEqual(768 - 48 - 56 - 32);
    expect(dlg.querySelector('[style*="overflow"]')).toBeNull(); // no inner scroller
  });
  it('the form passes axe', async () => {
    await openNew();
    const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
    expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
  });
});

describe('live report preview (item 3)', () => {
  it('sits beside the form in one wrapper, with the patient header block and the four columns', async () => {
    const dlg = await openNew();
    const wrap = dlg.querySelector('[data-layout="form-with-preview"]') as HTMLElement;
    expect(wrap).toBeTruthy();
    const prev = within(wrap).getByRole('region', { name: /report preview/i });
    expect(wrap.querySelector('form')!.compareDocumentPosition(prev) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    for (const l of [/patient/i, /age\s*\/\s*sex/i, /sample/i, /date/i]) expect(prev.textContent).toMatch(l);
    expect(within(prev).getAllByRole('columnheader').map((h) => h.textContent?.trim())).toEqual(['Test Name', 'Value', 'Unit', 'Reference Range']);
  });
  it('shows SAMPLE data only (no real patient), and the test name follows what is typed', async () => {
    const dlg = await openNew();
    const prev = within(dlg).getByRole('region', { name: /report preview/i });
    expect(prev.textContent).toMatch(/sample|synthetic|demo/i);
    await userEvent.type(within(dlg).getByLabelText(/^name/i), 'Ferritin');
    await waitFor(() => expect(within(prev).getByRole('table').textContent).toMatch(/Ferritin/));
    await userEvent.type(within(dlg).getByLabelText(/^display name/i), 'Serum ferritin');
    await waitFor(() => expect(within(prev).getByRole('table').textContent).toMatch(/Serum ferritin/));
  });
});

describe('suggestions (LD-318 follow-up 1)', () => {
  it('display name is suggested as NAME, SPECIMEN(CODE) once name, specimen and code are known; it stays editable and is not overwritten after an edit', async () => {
    const dlg = await openNew();
    await userEvent.type(within(dlg).getByLabelText(/^code/i), 'fer');
    await userEvent.type(within(dlg).getByLabelText(/^name/i), 'Ferritin');
    await choose(dlg, /^specimen/i, /serum/i);
    const dn = within(dlg).getByLabelText(/^display name/i) as HTMLInputElement;
    await waitFor(() => expect(dn.value).toBe('Ferritin, Serum(FER)'));
    await userEvent.clear(dn);
    await userEvent.type(dn, 'My own title');
    await userEvent.type(within(dlg).getByLabelText(/^name/i), ' level');
    expect(dn.value).toBe('My own title');
  });
});

describe('create (item 3)', () => {
  const fill = async (dlg: HTMLElement) => {
    await userEvent.type(within(dlg).getByLabelText(/^code/i), 'fer');
    await userEvent.type(within(dlg).getByLabelText(/^name/i), 'Ferritin');
    await choose(dlg, /^department/i, /biochemistry/i);
    await choose(dlg, /^workflow type/i, /^standard$/i);
    await choose(dlg, /^specimen/i, /serum/i);
  };
  const save = (dlg: HTMLElement) => userEvent.click(within(dlg).getByRole('button', { name: /^(save|create test)$/i }));

  it('sends typed values (numbers are numbers, tags an array), then the seven stage targets, then opens the new test', async () => {
    const dlg = await openNew();
    await fill(dlg);
    await userEvent.type(within(dlg).getByLabelText(/^loyalty/i), '7');
    await userEvent.type(within(dlg).getByLabelText(/^tags/i), 'iron,anaemia{Enter}');
    await choose(dlg, /^report type/i, /three column/i);
    await choose(dlg, /^processing type/i, /branch transfer/i);
    await userEvent.click(within(dlg).getByLabelText(/^smart report/i));
    for (const [i, f] of FIELDS.Turnaround.slice(0, 7).entries()) await userEvent.type(within(dlg).getByLabelText(f.label), String((i + 1) * 10));
    await save(dlg);
    await waitFor(() => expect(callsTo('POST', /^\/v1\/catalog\/tests$/)).toHaveLength(1));
    const c = callsTo('POST', /^\/v1\/catalog\/tests$/)[0]!;
    expect(c.headers.get('idempotency-key')).toBeTruthy();
    expect(c.body).toMatchObject({ code: 'FER', name: 'Ferritin', department_id: BIOC.id, workflow_type: 'standard', loyalty_points: 7, report_type: 'three_column', processing_type: 'branch_transfer', smart_report: true, specimen_requirements: [{ specimen_type_id: ID(12), is_preferred: true }] });
    expect([...c.body.tags].sort()).toEqual(['anaemia', 'iron']);
    for (const k of ['barcode_text', 'description', 'font', 'template_ref', 'outsource_name']) expect(c.body, k).not.toHaveProperty(k); // empty optional fields are omitted, never ''
    await waitFor(() => expect(callsTo('PUT', /\/tat-targets$/)).toHaveLength(1));
    const p = callsTo('PUT', /\/tat-targets$/)[0]!;
    expect(p.body.targets).toEqual([]);
    expect(p.body.stage_targets).toEqual(STAGES.map((stage, i) => ({ stage, target_minutes: (i + 1) * 10 })));
    await waitFor(() => expect(TM.navLog.some((u) => u.split('?')[0] === `/catalog/tests/${ID(1900)}`)).toBe(true));
  });
  it('no stage minutes typed: no tat-targets request', async () => {
    const dlg = await openNew();
    await fill(dlg);
    await save(dlg);
    await waitFor(() => expect(callsTo('POST', /^\/v1\/catalog\/tests$/)).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 150));
    expect(callsTo('PUT', /\/tat-targets$/)).toHaveLength(0);
  });
  it.each([
    ['loyalty points below 0', /^loyalty/i, '-1'],
    ['stage minutes above 43200', /^release/i, '43201'],
    ['alert before expiry above 525600', /^alert before expiry/i, '525601'],
  ])('client validation: %s -> field error, no request', async (_n, label, value) => {
    const dlg = await openNew();
    await fill(dlg);
    await userEvent.type(within(dlg).getByLabelText(label), value);
    await save(dlg);
    await new Promise((r) => setTimeout(r, 150));
    expect(callsTo('POST', /^\/v1\/catalog\/tests$/)).toEqual([]);
    expect(within(dlg).getByLabelText(label).getAttribute('aria-invalid')).toBe('true');
  });
  it('display name shorter than 3 characters and more than 20 tags are refused before any request', async () => {
    const dlg = await openNew();
    await fill(dlg);
    const dn = within(dlg).getByLabelText(/^display name/i);
    await userEvent.clear(dn);
    await userEvent.type(dn, 'ab');
    await userEvent.type(within(dlg).getByLabelText(/^tags/i), Array.from({ length: 21 }, (_, i) => `t${i}`).join(',') + '{Enter}');
    await save(dlg);
    await new Promise((r) => setTimeout(r, 150));
    expect(callsTo('POST', /^\/v1\/catalog\/tests$/)).toEqual([]);
    expect(dn.getAttribute('aria-invalid')).toBe('true');
  });
  it('server 422 on /tags ("at least one tag") is shown on the Tags field; the form stays open', async () => {
    S.failNext = { method: 'POST', re: /^\/v1\/catalog\/tests$/, status: 422, code: 'common.validation_failed', errors: [{ path: '/tags', code: 'required', message: 'An orderable test needs at least one tag' }] };
    const dlg = await openNew();
    await fill(dlg);
    await save(dlg);
    expect(await within(dlg).findByText('An orderable test needs at least one tag')).toBeTruthy();
    expect(within(dlg).getByLabelText(/^tags/i).getAttribute('aria-invalid')).toBe('true');
    expect(TM.navLog.filter((u) => u.startsWith('/catalog/tests/'))).toEqual([]);
  });
  it('tat-targets failing after the test was created: the user is told, the created test is not created twice', async () => {
    S.failNext = { method: 'PUT', re: /\/tat-targets$/, status: 422, code: 'common.validation_failed' };
    const dlg = await openNew();
    await fill(dlg);
    await userEvent.type(within(dlg).getByLabelText(/^release/i), '60');
    await save(dlg);
    await waitFor(() => expect(callsTo('PUT', /\/tat-targets$/)).toHaveLength(1));
    expect(await screen.findByText(/turnaround|stage/i)).toBeTruthy();
    expect(callsTo('POST', /^\/v1\/catalog\/tests$/)).toHaveLength(1);
  });
  it('a reader cannot create: the form is not offered, or Save is disabled with a visible reason', async () => {
    TM.session.permissions = READ;
    await show('tests', { search: 'new=1' });
    const dlg = screen.queryByRole('dialog');
    if (dlg) {
      const b = within(dlg).queryByRole('button', { name: /^(save|create test)$/i });
      expect(!b || b.hasAttribute('disabled')).toBe(true);
      expect(dlg.textContent).toMatch(/catalog\.test\.manage|permission/i);
    } else expect(document.body.textContent).toMatch(/catalog\.test\.manage|permission/i);
  });
});

describe('edit (item 3)', () => {
  it('sends only what changed with If-Match; stage minutes go to tat-targets with the existing routine/urgent targets kept', async () => {
    const root = await openEdit();
    await userEvent.clear(within(root).getByLabelText(/^barcode/i));
    await userEvent.type(within(root).getByLabelText(/^barcode/i), 'HB-02');
    await userEvent.clear(within(root).getByLabelText(/^release/i));
    await userEvent.type(within(root).getByLabelText(/^release/i), '300');
    await userEvent.click(within(root).getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(callsTo('PATCH', /^\/v1\/catalog\/tests\//)).toHaveLength(1));
    const c = callsTo('PATCH', /^\/v1\/catalog\/tests\//)[0]!;
    expect(c.path).toBe(`/v1/catalog/tests/${FULL['id']}`);
    expect(c.body).toEqual({ barcode_text: 'HB-02' });
    expect(c.headers.get('if-match')).toMatch(/3/);
    await waitFor(() => expect(callsTo('PUT', /\/tat-targets$/)).toHaveLength(1));
    const p = callsTo('PUT', /\/tat-targets$/)[0]!;
    expect(p.body.targets).toEqual([{ priority: 'routine', segment: 'total', target_seconds: 14400 }]);
    expect(p.body.stage_targets).toHaveLength(7);
    expect(p.body.stage_targets.find((s: any) => s.stage === 'release')).toEqual({ stage: 'release', target_minutes: 300 });
  });
  it('clearing an optional text field is sent as unset[], not as an empty string', async () => {
    const root = await openEdit();
    await userEvent.clear(within(root).getByLabelText(/^description/i));
    await userEvent.click(within(root).getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(callsTo('PATCH', /^\/v1\/catalog\/tests\//)).toHaveLength(1));
    expect(callsTo('PATCH', /^\/v1\/catalog\/tests\//)[0]!.body).toEqual({ unset: ['description'] });
  });
  it('no change -> no request', async () => {
    const root = await openEdit();
    await userEvent.click(within(root).getByRole('button', { name: /^save/i }));
    await new Promise((r) => setTimeout(r, 150));
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });
  it('a reader sees the values but every field is disabled and a reason names catalog.test.manage', async () => {
    TM.session.permissions = READ;
    const root = await openEdit();
    for (const sec of ['Basics', 'Flags', 'Turnaround']) for (const el of section(sec, root).querySelectorAll('input, textarea')) expect((el as HTMLInputElement).disabled || (el as HTMLInputElement).readOnly, `${sec} ${(el as HTMLInputElement).name}`).toBe(true);
    expect(root.textContent).toMatch(/catalog\.test\.manage/);
  });
  it('Copy test opens the add form prefilled with the same values and no code', async () => {
    const root = await openEdit();
    await userEvent.click(within(root).getByRole('button', { name: /^copy test$/i }));
    const u = lastAddress()!;
    expect(u.pathname).toBe('/catalog/tests');
    expect(u.searchParams.get('new')).toBe('1');
    expect(u.searchParams.get('copy')).toBe(FULL['id']);
    cleanup();
    const dlg = await openNew(u.search);
    expect((within(dlg).getByLabelText(/^code/i) as HTMLInputElement).value).toBe('');
    expect((within(dlg).getByLabelText(/^short name/i) as HTMLInputElement).value).toBe('Hb');
    expect((within(dlg).getByLabelText(/^barcode/i) as HTMLInputElement).value).toBe('HB-01');
    expect((within(dlg).getByLabelText(/^release/i) as HTMLInputElement).value).toBe('240');
    expect((within(dlg).getByLabelText(/^name/i) as HTMLInputElement).value).toMatch(/Hemoglobin/);
    expect(callsTo('POST', /^\/v1\/catalog\/tests$/)).toEqual([]); // copying alone creates nothing
  });
});
void HAEM; void EDTA; void MANAGE;
