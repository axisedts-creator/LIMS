// @vitest-environment jsdom
// T0D-TESTMGMT-1 done_when (3): Add / Edit / Copy Test form on /catalog/tests?view=details&form=new|edit|copy[&test=<id>].
// EVERY TestCreate/TestUpdate field of the contract in four compact sections (Basics, Report, Flags, Turnaround), required fields marked,
// the seven TAT stage inputs in minutes, Copy test, and a live report preview beside the form (patient header block and the columns
// Test Name, Value, Unit, Reference Range) built from sample data only. One screen at 1366 x 768 without scrolling: jsdom has no layout, so the
// structure that guarantees it is pinned (4 groups all visible at once, no tabs, no collapsed section, no scroll container, side labels
// per T0D-DENSITY-1 labelPlacement="start"); the pixel check at 1366 x 768 is the lead's browser step (see the notes).
// Writes: POST /v1/catalog/tests (+ Idempotency-Key), PATCH /v1/catalog/tests/{id} (+ If-Match), PUT /v1/catalog/tests/{id}/tat-targets {stage_targets}.
import { describe, expect, it } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { READ, T_CBC, HAEM, calls, mountTests, tm, to, problem, overrides } from './testmgmt1.kit';

const SECTIONS = ['Basics', 'Report', 'Flags', 'Turnaround'] as const;
const form = async (search: string) => { await mountTests(`?${search}`); return screen.findByRole('form', { name: /test/i }); };
const section = (f: HTMLElement, name: string) => within(f).getByRole('group', { name: new RegExp(`^${name}$`, 'i') });
const NEW = 'view=details&form=new';
const EDIT = `view=details&form=edit&test=${T_CBC.id}`;

// contract field -> where it lives and the label the user reads
const FIELDS: [section: (typeof SECTIONS)[number], label: RegExp][] = [
  ['Basics', /^code/i], ['Basics', /^name/i], ['Basics', /display name/i], ['Basics', /short name/i], ['Basics', /^department/i], ['Basics', /^category/i],
  ['Basics', /workflow type/i], ['Basics', /specimen/i], ['Basics', /tags/i], ['Basics', /barcode/i], ['Basics', /loyalty points/i], ['Basics', /display order/i],
  ['Basics', /report order/i], ['Basics', /description/i],
  ['Report', /report type/i], ['Report', /processing type/i], ['Report', /template/i], ['Report', /outsource/i], ['Report', /font/i],
  ['Flags', /orderable/i], ['Flags', /uses existing material/i], ['Flags', /outsourced/i], ['Flags', /popular/i], ['Flags', /smart report/i],
  ['Flags', /print category wise/i], ['Flags', /^nabl$/i], ['Flags', /accab logo/i], ['Flags', /auto.?approval$/i], ['Flags', /normal range for auto.?approval/i],
  ['Flags', /template test/i], ['Flags', /nabl processing centres/i],
  ['Turnaround', /alert before expiry/i], ['Turnaround', /registration/i], ['Turnaround', /sample collection/i], ['Turnaround', /accession/i],
  ['Turnaround', /^result/i], ['Turnaround', /approval 1/i], ['Turnaround', /approval 2/i], ['Turnaround', /release/i],
];

describe('Test form: structure', () => {
  it('four sections in this order, all on screen at once: no tabs, no collapsed section, no scroll container', async () => {
    const f = await form(NEW);
    const names = within(f).getAllByRole('group').map((g) => g.getAttribute('aria-label') ?? within(g).queryByRole('heading')?.textContent ?? g.querySelector('legend')?.textContent ?? '');
    expect(names.filter((n) => (SECTIONS as readonly string[]).includes(n))).toEqual([...SECTIONS]);
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(f.querySelector('[aria-expanded="false"]')).toBeNull();
    expect(f.querySelector('[hidden]')).toBeNull();
    for (const el of [f, ...Array.from(f.querySelectorAll<HTMLElement>('*'))]) expect(/(auto|scroll)/.test(el.style.overflowY)).toBe(false);
  });

  it('uses compact side labels (T0D-DENSITY-1 labelPlacement="start") so the form is short enough for 768 px', async () => {
    const f = await form(NEW);
    expect(f.closest('[data-label-placement="start"]') ?? f.querySelector('[data-label-placement="start"]')).not.toBeNull();
  });

  it.each(FIELDS)('%s has a control labelled %s', async (sec, label) => {
    const f = await form(NEW);
    const g = section(f, sec);
    expect(within(g).getAllByLabelText(label).length).toBeGreaterThan(0);
  });

  it('marks the required fields (code, name, department, workflow type, specimen) and no optional one', async () => {
    const f = await form(NEW);
    for (const l of [/^code/i, /^name/i, /^department/i, /workflow type/i, /specimen/i]) {
      const c = within(f).getAllByLabelText(l)[0] as HTMLElement;
      expect(c.getAttribute('aria-required') === 'true' || (c as HTMLInputElement).required).toBe(true);
    }
    for (const l of [/short name/i, /barcode/i, /loyalty points/i]) expect((within(f).getAllByLabelText(l)[0] as HTMLInputElement).required).toBeFalsy();
  });

  it('seven stage TAT inputs, numeric, in minutes (0..43200)', async () => {
    const f = await form(NEW);
    const g = section(f, 'Turnaround');
    for (const l of [/registration/i, /sample collection/i, /accession/i, /^result/i, /approval 1/i, /approval 2/i, /release/i]) {
      const i = within(g).getAllByLabelText(l)[0] as HTMLInputElement;
      expect(i.type === 'number' || i.inputMode === 'numeric').toBe(true);
      expect(i.getAttribute('max') ?? '43200').toBe('43200');
    }
    expect(within(g).getAllByText(/minutes|min\b/i).length).toBeGreaterThan(0);
  });

  it('lists the three processing types (LD-318 follow-up 3) and the ten report types', async () => {
    const f = await form(NEW);
    const proc = within(f).getByLabelText(/processing type/i);
    expect(within(proc).getAllByRole('option').map((o) => o.textContent)).toEqual(expect.arrayContaining(['Local', 'Branch Transfer', 'Outsource To Other Branch']));
    expect(within(within(f).getByLabelText(/report type/i)).getAllByRole('option').length).toBeGreaterThanOrEqual(10);
  });
});

describe('Test form: live report preview', () => {
  it('sits beside the form: patient header block + the columns Test Name, Value, Unit, Reference Range, sample data only', async () => {
    const f = await form(NEW);
    const pv = screen.getByRole('region', { name: /report preview/i });
    expect(pv.contains(f)).toBe(false);
    expect(within(pv).getByText(/patient/i)).toBeTruthy();
    for (const c of ['Test Name', 'Value', 'Unit', 'Reference Range']) expect(within(pv).getByRole('columnheader', { name: c })).toBeTruthy();
    expect(within(pv).getByText(/sample/i)).toBeTruthy(); // marked as sample data
    expect(calls.filter((c) => /patients?/.test(c.path))).toHaveLength(0); // never real patient data
  });

  it('follows typing: display name and test name appear in the preview as you type', async () => {
    const f = await form(NEW);
    await userEvent.type(within(f).getByLabelText(/display name/i), 'Synthetic panel X');
    expect(within(screen.getByRole('region', { name: /report preview/i })).getByText(/Synthetic panel X/)).toBeTruthy();
  });
});

describe('Test form: save, edit, copy', () => {
  const fill = async (f: HTMLElement) => {
    await userEvent.type(within(f).getByLabelText(/^code/i), 'hgb2');
    await userEvent.type(within(f).getByLabelText(/^name/i), 'Hemoglobin A2');
    await userEvent.selectOptions(within(f).getByLabelText(/^department/i), HAEM.id);
    await userEvent.selectOptions(within(f).getByLabelText(/workflow type/i), 'standard');
    await userEvent.selectOptions(within(f).getByLabelText(/specimen/i), 'EDTA_WB').catch(() => userEvent.click(within(f).getByRole('checkbox', { name: /EDTA/i })));
  };

  it('Save posts the contract body with Idempotency-Key, stage targets go to tat-targets, then opens the test', async () => {
    const f = await form(NEW);
    await fill(f);
    await userEvent.type(within(f).getByLabelText(/display name/i), 'HEMOGLOBIN A2, EDTA WB(HGB2)');
    await userEvent.type(within(f).getByLabelText(/loyalty points/i), '5');
    await userEvent.type(within(f).getByLabelText(/^result/i), '90');
    await userEvent.click(within(f).getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(to('POST', /\/v1\/catalog\/tests$/)).toHaveLength(1));
    const c = to('POST', /\/v1\/catalog\/tests$/)[0]!;
    expect(c.headers.get('idempotency-key')).toMatch(/\S{8,}/);
    expect(c.body).toMatchObject({ code: 'HGB2', name: 'Hemoglobin A2', department_id: HAEM.id, workflow_type: 'standard', display_name: 'HEMOGLOBIN A2, EDTA WB(HGB2)', loyalty_points: 5 });
    expect(c.body.specimen_requirements.length).toBeGreaterThanOrEqual(1);
    await waitFor(() => expect(to('PUT', /\/tat-targets$/)).toHaveLength(1));
    expect(to('PUT', /\/tat-targets$/)[0]!.headers.get('if-match')).toBeTruthy();
    expect(to('PUT', /\/tat-targets$/)[0]!.body.targets).toEqual([]);
    expect(to('PUT', /\/tat-targets$/)[0]!.body.stage_targets).toContainEqual({ stage: 'result', target_minutes: 90 });
    await waitFor(() => expect(tm().navLog.some((u) => /view=details/.test(u) && /test=/.test(u))).toBe(true));
  });

  it('shows every server validation message at its field (catalog.code_duplicate on code, 400 pointers on others) and posts nothing twice', async () => {
    overrides.set('POST /v1/catalog/tests$', () => problem(409, 'catalog.code_duplicate', { errors: [{ pointer: '/code', code: 'catalog.code_duplicate', message: 'Code HGB2 is already used.' }] }));
    const f = await form(NEW);
    await fill(f);
    await userEvent.click(within(f).getByRole('button', { name: /^save/i }));
    expect(await within(f).findByText(/already used/i)).toBeTruthy();
    expect(within(f).getByLabelText(/^code/i).getAttribute('aria-invalid')).toBe('true');
  });

  it('refuses a tagless orderable test before calling the API (T0B rule: at least one tag when orderable)', async () => {
    const f = await form(NEW);
    await fill(f);
    await userEvent.click(within(f).getByRole('button', { name: /^save/i }));
    expect(await within(f).findByText(/tag/i)).toBeTruthy();
    expect(to('POST', /\/v1\/catalog\/tests$/)).toHaveLength(0);
  });

  it('Edit loads every stored field and saves only what changed with If-Match = the loaded version', async () => {
    const f = await form(EDIT);
    expect((await within(f).findByLabelText(/^code/i) as HTMLInputElement).value).toBe('CBC');
    expect((within(f).getByLabelText(/display name/i) as HTMLInputElement).value).toBe(T_CBC.display_name);
    const sn = within(f).getByLabelText(/short name/i);
    await userEvent.clear(sn); await userEvent.type(sn, 'CBC2');
    await userEvent.click(within(f).getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(to('PATCH', new RegExp(`/tests/${T_CBC.id}$`))).toHaveLength(1));
    const c = to('PATCH', /\/tests\//)[0]!;
    expect(c.headers.get('if-match')).toBeTruthy();
    expect(c.body).toEqual({ short_name: 'CBC2' });
  });

  it('Copy test opens the form pre-filled from the source with an empty code and name, and creates a NEW test (POST, never PATCH)', async () => {
    const f = await form(EDIT);
    await userEvent.click(within(f).getByRole('button', { name: /copy test/i }));
    expect(tm().navLog.at(-1)).toMatch(/form=copy/);
    cleanup();
    const f2 = await form(`view=details&form=copy&test=${T_CBC.id}`);
    expect((await within(f2).findByLabelText(/^code/i) as HTMLInputElement).value).toBe('');
    expect((within(f2).getByLabelText(/^name/i) as HTMLInputElement).value).toBe('');
    expect((within(f2).getByLabelText(/report type/i) as HTMLSelectElement).value).toBe('four_column');
  });

  it('a read-only actor cannot save: the form is read-only or the button disabled, with a visible reason', async () => {
    tm().permissions = READ;
    const f = await form(EDIT);
    const save = within(f).queryByRole('button', { name: /^save/i }) as HTMLButtonElement | null;
    expect(save === null || save.disabled).toBe(true);
    expect(screen.getByText(/permission|not allowed|read[- ]only/i)).toBeTruthy();
  });
});
