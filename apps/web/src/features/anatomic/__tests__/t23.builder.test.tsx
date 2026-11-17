// @vitest-environment jsdom
// C11.T-23 — Synoptic template editor /anatomic/config/templates/{template_id|new}: builder (left) + live preview (right) (04-UI-UX §4.7; AC-08.1, AC-08.2, AC-08.3 UI side; REQ-SEC-088 plain text only; 07-SECURITY "malicious template with script").
// done_when: "Builder produces definitions accepted by T-03 validator" -> every body this UI sends is run through the REAL validator (services/api .../domain/synoptic.ts, pure, no imports) and must be ok.
// LD-140 (2026-11-13): kit components only, one primary button per page ([Save draft]), status = tone + icon + word.
// PINNED SEAMS (writer: make these exist; see also the t23.harness.tsx header)
//   Header controls: textbox "Template key" (only while new; existing templates show the key as text), textbox "Title", checkboxes "Histology" "Cytology" "IHC" "Molecular" (applies_to_case_kinds), buttons [Add section] and [Save draft] (primary).
//   Section i (0-based) = element [data-section-index="i"] with textbox "Section heading", buttons "Move section up" / "Move section down" and [Add field]; the section key is DERIVED from the heading:
//     lower-case, every run of non [a-z0-9] -> "_", trimmed of "_", prefixed "s_" when it does not start with a letter, cut to 40, made unique with a numeric suffix ("clinical_data", "margins", "margins_2").
//   Field table rows (role row) show the key as text; row buttons "Edit field <key>". [Add field] / Edit field open a Drawer (dialog) with: textboxes Key, Label, Help text, Unit, Min, Max, Max length (numeric only for numeric types, as in the validator),
//     spinbutton Decimals (decimal only), Select "Type" (options Text, Long text, Integer, Decimal, Boolean|Yes/No, Single select, Multi select, Date), switch "Required", options editor (select types): [Add option] adds textboxes "Option code" and "Option display",
//     Select "Show if field" (earlier boolean / select fields only) and Select "Equals" (Yes/No for a boolean trigger, the option display for a select trigger). Buttons [Save field] and [Cancel]. Empty optional values are omitted from the definition.
//   The drawer refuses (stays open, nothing added) what the validator would refuse: bad/duplicate key, no options on a select, duplicate option code, min > max.
//   Preview = element [data-preview] headed "Preview": plain-text section headings, one control per visible field labelled by its label, "(required)" text, unit/help text, show_if fields rendered only while visible, polite live region "{n} more fields shown".
//   Save: new -> POST /synoptic-templates {template_key, definition} + Idempotency-Key, then router.replace|push('/anatomic/config/templates/<id>'); existing -> PUT {definition} with If-Match "<version>" and no Idempotency-Key.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { http } from 'msw';
import { ToastProvider } from '@lims/ui/components/Toast';
import { validateSynopticDefinition } from '../../../../../../services/api/src/modules/anatomic/domain/synoptic';
import { IDEM_RE, ID, ORIGIN, PERM_CONFIG, PERM_WORK, TPL, api, definition, hit, hits, problem, resetHits, router, state, t23Defaults, tpl, type Def } from './t23.harness';

vi.mock('next/navigation', async () => (await import('./t23.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t23.harness')).sessionMock);

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { resetHits(); router.push.mockReset(); router.replace.mockReset(); router.refresh.mockReset(); state.permissions = PERM_CONFIG; api.use(...t23Defaults); });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const editor = async (id: string = TPL) => {
  const mod = await import('../../../app/(staff)/anatomic/config/templates/[template_id]/page');
  return render(<ToastProvider>{await mod.default({ params: Promise.resolve({ template_id: id }) } as never)}</ToastProvider>);
};
const text = () => document.body.textContent ?? '';
const dialog = () => screen.getByRole('dialog');
const btn = (re: RegExp, scope: HTMLElement = document.body) => within(scope).getByRole('button', { name: re }) as HTMLButtonElement;
const choose = async (scope: HTMLElement, label: RegExp, option: RegExp) => {
  await userEvent.click(within(scope).getByRole('button', { name: label }));
  await userEvent.click(await screen.findByRole('option', { name: option }));
};
const input = (scope: HTMLElement, re: RegExp) => ([...within(scope).queryAllByRole('textbox', { name: re }), ...within(scope).queryAllByRole('spinbutton', { name: re })][0] ?? within(scope).getByLabelText(re)) as HTMLInputElement;
const type = async (scope: HTMLElement, re: RegExp, v: string) => { const el = input(scope, re); await userEvent.clear(el); if (v) await userEvent.type(el, v); };
const sectionEl = (i: number) => document.querySelector(`[data-section-index="${i}"]`) as HTMLElement;
const preview = () => document.querySelector('[data-preview]') as HTMLElement;
const fieldRow = (key: string) => screen.getAllByRole('row').find((r) => new RegExp(`(^|[^a-z0-9_])${key}([^a-z0-9_]|$)`).test(r.textContent ?? ''))!;
const puts = () => hit('PUT', /^\/v1\/anatomic\/synoptic-templates\/[^/]+$/);
const posts = () => hit('POST', /^\/v1\/anatomic\/synoptic-templates$/);
const lastDef = (): Def => { const h = [...puts(), ...posts()].at(-1)!; return h.json.definition as Def; };
const ok = (def: unknown) => { const r = validateSynopticDefinition(def); expect(r.ok ? [] : (r as { errors: unknown[] }).errors).toEqual([]); };
const saveDraft = () => userEvent.click(btn(/^save draft$/i));
const axeRun = async () => (await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } })).violations.map((x) => `${x.id}: ${x.help}`);

const TYPE_RE: Record<string, RegExp> = { text: /^text$/i, long_text: /^long text$/i, integer: /^integer$/i, decimal: /^decimal$/i, boolean: /^(boolean|yes.?no)/i, single_select: /^single select$/i, multi_select: /^multi select$/i, date: /^date$/i };
type Spec = { key: string; label: string; type?: string; required?: boolean; help?: string; unit?: string; min?: string; max?: string; decimals?: string; maxLength?: string; options?: [string, string][]; showIf?: [RegExp, RegExp] };
const fillField = async (s: Spec) => {
  const d = dialog();
  await type(d, /^key/i, s.key);
  await type(d, /^label/i, s.label);
  if (s.type) await choose(d, /type/i, TYPE_RE[s.type]!);
  if (s.required) await userEvent.click(within(d).getByRole('switch', { name: /required/i }));
  if (s.help) await type(d, /help text/i, s.help);
  if (s.unit) await type(d, /^unit/i, s.unit);
  if (s.min) await type(d, /^min/i, s.min);
  if (s.max) await type(d, /^max(?! length)/i, s.max);
  if (s.decimals) await type(d, /decimals/i, s.decimals);
  if (s.maxLength) await type(d, /max length/i, s.maxLength);
  for (const [code, display] of s.options ?? []) {
    await userEvent.click(btn(/add option/i, d));
    await userEvent.type(within(d).getAllByRole('textbox', { name: /option code/i }).at(-1)!, code);
    await userEvent.type(within(d).getAllByRole('textbox', { name: /option display/i }).at(-1)!, display);
  }
  if (s.showIf) { await choose(d, /show if/i, s.showIf[0]); await choose(d, /equals/i, s.showIf[1]); }
};
const addField = async (section: number, s: Spec) => { await userEvent.click(btn(/add field/i, sectionEl(section))); await fillField(s); await userEvent.click(btn(/^save field$/i, dialog())); };
const editField = async (key: string, s: Partial<Spec>) => {
  await userEvent.click(btn(/^edit field/i, fieldRow(key)));
  const d = dialog();
  if (s.label) await type(d, /^label/i, s.label);
  if (s.type) await choose(d, /type/i, TYPE_RE[s.type]!);
  if (s.showIf) { await choose(d, /show if/i, s.showIf[0]); await choose(d, /equals/i, s.showIf[1]); }
  await userEvent.click(btn(/^save field$/i, d));
};
const touch = async () => { await type(document.body, /^title/i, 'Synthetic colon checklist v2'); }; // makes the draft dirty
const withDef = (def: Def, over: Record<string, unknown> = {}) => api.use(http.get(`${ORIGIN}/v1/anatomic/synoptic-templates/:id`, () => Response.json(tpl(over, def))));

describe('page states and access', () => {
  it('a draft loads from GET /synoptic-templates/{id}: key as text, title and case kind filled, two sections, five field rows, notice text', async () => {
    await editor();
    expect(hit('GET', new RegExp(`/synoptic-templates/${TPL}$`))).toHaveLength(1);
    expect(input(document.body, /^title/i).value).toBe('Synthetic colon checklist');
    expect(text()).toContain('syn_colon');
    expect(within(document.body).queryAllByRole('textbox', { name: /template key/i })).toHaveLength(0);
    expect((screen.getByRole('checkbox', { name: /histology/i }) as HTMLInputElement).checked).toBe(true);
    expect(input(sectionEl(0), /section heading/i).value).toBe('Tumour');
    expect(input(sectionEl(1), /section heading/i).value).toBe('Lymph nodes');
    expect(['site', 'size_mm', 'grade', 'nodes_sampled', 'nodes_n'].map((k) => !!fieldRow(k))).toEqual([true, true, true, true, true]);
    expect(text()).toContain('Write your own checklists. Do not copy protocol text you do not have rights to.');
  });

  it('"new" opens a blank builder without any GET; the Template key box is there', async () => {
    await editor('new');
    expect(hits.filter((h) => h.method === 'GET' && /synoptic-templates\//.test(h.path))).toHaveLength(0);
    expect(input(document.body, /template key/i)).toBeTruthy();
    expect(screen.queryAllByRole('row').filter((r) => !within(r).queryAllByRole('columnheader').length)).toHaveLength(0);
  });

  it.each(['not-a-uuid', '../../settings', `${ID(1)}/publish`, ''])('template_id %j -> notFound() and no API call (REQ-SEC-026/027)', async (id) => {
    await expect(editor(id)).rejects.toThrow('NEXT_NOT_FOUND');
    expect(hits).toHaveLength(0);
  });

  it.each([404, 400])('%i from the API -> notFound()', async (status) => {
    api.use(http.get(`${ORIGIN}/v1/anatomic/synoptic-templates/:id`, () => problem(status === 404 ? 'common.not_found' : 'common.validation_failed', status)));
    await expect(editor()).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('403 -> no-access state without any template content; 500 rejects (error.tsx)', async () => {
    api.use(http.get(`${ORIGIN}/v1/anatomic/synoptic-templates/:id`, () => problem('auth.forbidden', 403)));
    await editor();
    expect(text()).toMatch(/permission/i);
    expect(text()).not.toContain('Tumour');
    cleanup();
    api.use(http.get(`${ORIGIN}/v1/anatomic/synoptic-templates/:id`, () => problem('common.internal', 500)));
    await expect(editor()).rejects.toBeTruthy();
  });

  it('without anatomic.config.manage: no-access state, no builder controls, no write request', async () => {
    state.permissions = PERM_WORK;
    await editor();
    expect(text()).toMatch(/permission/i);
    expect(screen.queryByRole('button', { name: /save draft|add section/i })).toBeNull();
    expect(hits.filter((h) => h.method !== 'GET')).toHaveLength(0);
  });

  it.each(['published', 'retired'])('a %s template is read-only: banner "Published templates can\'t be changed. Create a new version.", no Save draft / Add section / Add field / Edit field, no editable inputs; the preview still renders', async (status) => {
    api.use(http.get(`${ORIGIN}/v1/anatomic/synoptic-templates/:id`, () => Response.json(tpl({ status, published_at: '2026-11-01T08:30:00.000Z' }))));
    await editor();
    expect(text()).toContain("Published templates can't be changed. Create a new version.");
    expect(screen.queryByRole('button', { name: /save draft|add section|add field|edit field|move section/i })).toBeNull();
    const editable = Array.from(document.querySelectorAll('input:not([disabled]):not([readonly]), textarea:not([disabled]):not([readonly])')).filter((el) => !preview().contains(el));
    expect(editable).toHaveLength(0);
    expect(preview().textContent).toContain('Tumour');
    expect(text()).toContain(status === 'published' ? 'Published' : 'Retired');
  });
});

describe('live preview', () => {
  it('renders every section heading and visible field label as plain text, "(required)" marks, unit and help text', async () => {
    withDef(definition({ sections: [{ key: 'tumour', heading: 'Tumour', fields: [
      { key: 'site', label: 'Tumour site', type: 'text', required: true, help_text: 'Synthetic help' },
      { key: 'size_mm', label: 'Tumour size', type: 'decimal', required: true, unit_text: 'mm' },
      { key: 'note', label: 'Note', type: 'long_text', required: false },
    ] }] }));
    await editor();
    const p = preview();
    expect(within(p).getByRole('heading', { name: 'Tumour' })).toBeTruthy();
    for (const l of [/tumour site/i, /tumour size/i, /^note/i]) expect(within(p).queryAllByLabelText(l).length, String(l)).toBeGreaterThan(0);
    expect(p.textContent).toContain('(required)');
    expect(p.textContent).toContain('Synthetic help');
    expect(p.textContent).toContain('mm');
    expect((p.textContent!.match(/\(required\)/g) ?? []).length).toBe(2);
  });

  it('show_if fields appear only while their trigger matches; the polite live region says "1 more fields shown" (04-UI-UX §6)', async () => {
    await editor();
    const p = preview();
    expect(within(p).queryAllByLabelText(/nodes positive/i)).toHaveLength(0);
    await userEvent.click(within(p).getAllByLabelText(/nodes sampled/i)[0]!);
    expect(within(p).queryAllByLabelText(/nodes positive/i).length).toBeGreaterThan(0);
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toMatch(/1 more fields? shown/i);
  });

  it('typed-in (not yet saved) changes show up in the preview immediately and nothing is sent', async () => {
    await editor();
    await addFieldQuick();
    expect(preview().textContent).toContain('Margin status');
    expect(hits.filter((h) => h.method !== 'GET')).toHaveLength(0);
  });

  it('labels with markup are shown as TEXT: no element is created, nothing executes (07-SECURITY malicious template)', async () => {
    withDef(definition({ sections: [{ key: 'a', heading: '<img src=x onerror=alert(1)>', fields: [{ key: 'f', label: '<b>bold</b> <script>alert(1)</script>', type: 'text', required: false, help_text: '<i>help</i>' }] }] }));
    await editor();
    const p = preview();
    expect(p.querySelector('img, b, i, script')).toBeNull();
    expect(p.textContent).toContain('<b>bold</b>');
    expect(p.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});
const addFieldQuick = () => addField(0, { key: 'margin', label: 'Margin status', type: 'single_select', options: [['clear', 'Clear'], ['involved', 'Involved']] });

describe('builder: edits produce definitions the T-03 validator accepts (done_when)', () => {
  it('lossless: open a valid draft, change only the title, [Save draft] -> PUT {definition} = the original with the new title; If-Match "6", no Idempotency-Key; validator ok', async () => {
    await editor();
    await touch();
    await saveDraft();
    const [h, ...rest] = puts();
    expect(rest).toHaveLength(0);
    expect(h!.json).toEqual({ definition: { ...definition(), title: 'Synthetic colon checklist v2' } });
    expect(h!.headers.get('if-match')).toBe('"6"');
    expect(h!.headers.get('idempotency-key')).toBeNull();
    ok(h!.json.definition);
  });

  it('add a single_select with two options to section 0: the new field is appended, exact keys only (no empty strings, no undefined), validator ok', async () => {
    await editor();
    await addFieldQuick();
    await saveDraft();
    const f = lastDef().sections[0]!.fields.at(-1);
    expect(f).toEqual({ key: 'margin', label: 'Margin status', type: 'single_select', required: false, options: [{ code: 'clear', display: 'Clear' }, { code: 'involved', display: 'Involved' }] });
    expect(lastDef().sections[0]!.fields).toHaveLength(4);
    ok(lastDef());
  });

  it('numeric field: decimal with unit, min, max, decimals -> DecimalString min/max, integer decimals; text field with help and max length', async () => {
    await editor();
    await addField(1, { key: 'ratio', label: 'Ratio', type: 'decimal', required: true, unit: '%', min: '0', max: '100.5', decimals: '2', help: 'Synthetic help' });
    await addField(1, { key: 'comment_t', label: 'Comment', type: 'text', maxLength: '200' });
    await saveDraft();
    const fs = lastDef().sections[1]!.fields;
    expect(fs.at(-2)).toEqual({ key: 'ratio', label: 'Ratio', type: 'decimal', required: true, help_text: 'Synthetic help', unit_text: '%', min: '0', max: '100.5', decimals: 2 });
    expect(fs.at(-1)).toEqual({ key: 'comment_t', label: 'Comment', type: 'text', required: false, max_length: 200 });
    ok(lastDef());
  });

  it('show_if on a boolean trigger sends equals as a real boolean; on a select trigger, the option CODE', async () => {
    await editor();
    await addField(1, { key: 'detail_b', label: 'Detail', type: 'text', showIf: [/nodes sampled/i, /^yes$/i] });
    await addField(1, { key: 'detail_g', label: 'Grade note', type: 'text', showIf: [/^grade/i, /moderately/i] });
    await saveDraft();
    const fs = lastDef().sections[1]!.fields;
    expect(fs.at(-2)!['show_if']).toEqual({ field_key: 'nodes_sampled', equals: true });
    expect(fs.at(-1)!['show_if']).toEqual({ field_key: 'grade', equals: 'g2' });
    ok(lastDef());
  });

  it('the Show-if trigger list holds only EARLIER boolean/select fields: for "nodes_n" Grade and Nodes sampled; for the first field none', async () => {
    await editor();
    await userEvent.click(btn(/^edit field/i, fieldRow('nodes_n')));
    await userEvent.click(within(dialog()).getByRole('button', { name: /show if/i }));
    const names = screen.getAllByRole('option').map((o) => o.textContent ?? '');
    expect(names.filter((n) => /grade|nodes sampled/i.test(n))).toHaveLength(2);
    for (const bad of [/tumour site/i, /tumour size/i, /nodes positive/i]) expect(names.some((n) => bad.test(n)), String(bad)).toBe(false);
    cleanup();
    await editor();
    await userEvent.click(btn(/^edit field/i, fieldRow('site')));
    const d = dialog();
    const trig = within(d).queryAllByRole('button', { name: /show if/i })[0];
    if (trig) { await userEvent.click(trig); expect(screen.queryAllByRole('option').filter((o) => /grade|nodes sampled|tumour|nodes/i.test(o.textContent ?? ''))).toHaveLength(0); }
  });

  it('AC-08.1: a NEW template with 2 sections and 5 fields -> POST {template_key, definition} + Idempotency-Key, no If-Match; validator ok; then the editor of the stored draft opens', async () => {
    await editor('new');
    await type(document.body, /template key/i, 'syn_new');
    await type(document.body, /^title/i, 'Synthetic new checklist');
    await userEvent.click(screen.getByRole('checkbox', { name: /histology/i }));
    await userEvent.click(btn(/add section/i));
    await type(sectionEl(0), /section heading/i, 'Clinical data');
    await userEvent.click(btn(/add section/i));
    await type(sectionEl(1), /section heading/i, 'Margins');
    await addField(0, { key: 'site', label: 'Site', type: 'text', required: true });
    await addField(0, { key: 'count_n', label: 'Count', type: 'integer', min: '0' });
    await addField(0, { key: 'involved', label: 'Involved', type: 'boolean' });
    await addField(1, { key: 'status', label: 'Status', type: 'single_select', options: [['clear', 'Clear'], ['involved', 'Involved']] });
    await addField(1, { key: 'seen_on', label: 'Seen on', type: 'date' });
    await saveDraft();
    const [h, ...rest] = posts();
    expect(rest).toHaveLength(0);
    expect(h!.headers.get('idempotency-key')).toMatch(IDEM_RE);
    expect(h!.headers.get('if-match')).toBeNull();
    expect(h!.json).toEqual({
      template_key: 'syn_new',
      definition: {
        schema_version: 1, title: 'Synthetic new checklist', applies_to_case_kinds: ['histology'],
        sections: [
          { key: 'clinical_data', heading: 'Clinical data', fields: [
            { key: 'site', label: 'Site', type: 'text', required: true },
            { key: 'count_n', label: 'Count', type: 'integer', required: false, min: '0' },
            { key: 'involved', label: 'Involved', type: 'boolean', required: false },
          ] },
          { key: 'margins', heading: 'Margins', fields: [
            { key: 'status', label: 'Status', type: 'single_select', required: false, options: [{ code: 'clear', display: 'Clear' }, { code: 'involved', display: 'Involved' }] },
            { key: 'seen_on', label: 'Seen on', type: 'date', required: false },
          ] },
        ],
      },
    });
    ok(h!.json.definition);
    await vi.waitFor(() => expect([...router.replace.mock.calls, ...router.push.mock.calls].flat()).toContain(`/anatomic/config/templates/${ID(1799)}`));
  });

  it('awkward section headings ("3D margins", "Margins!", "Margins", "!!!") still give valid, unique section keys', async () => {
    await editor('new');
    await type(document.body, /template key/i, 'syn_odd');
    await type(document.body, /^title/i, 'Synthetic odd');
    await userEvent.click(screen.getByRole('checkbox', { name: /cytology/i }));
    const headings = ['3D margins', 'Margins!', 'Margins', '!!!'];
    for (const [i, h] of headings.entries()) {
      await userEvent.click(btn(/add section/i));
      await type(sectionEl(i), /section heading/i, h);
      await addField(i, { key: `f${i}`, label: `Field ${i}`, type: 'text' });
    }
    await saveDraft();
    const def = lastDef();
    expect(def.sections.map((s) => s.heading)).toEqual(headings);
    expect(new Set(def.sections.map((s) => s.key)).size).toBe(4);
    ok(def);
  });

  it('a section heading cleared to "" is not sent (validator: heading 1-200); no POST/PUT leaves the browser with an invalid definition', async () => {
    await editor();
    await type(sectionEl(0), /section heading/i, '');
    await saveDraft();
    for (const h of [...puts(), ...posts()]) ok(h.json.definition);
    expect(puts().length + posts().length).toBe(0);
  });

  it('an empty new template (no key, no title, no case kind, no section) sends nothing', async () => {
    await editor('new');
    await saveDraft();
    expect(hits.filter((h) => h.method !== 'GET')).toHaveLength(0);
  });

  it.each(['Bad Key', 'UPPER', '1abc', 'a-b', 'x'.repeat(41)])('template key %j is rejected (^[a-z][a-z0-9_]{0,39}$): nothing sent', async (key) => {
    await editor('new');
    await type(document.body, /template key/i, key);
    await type(document.body, /^title/i, 'Synthetic');
    await userEvent.click(screen.getByRole('checkbox', { name: /histology/i }));
    await userEvent.click(btn(/add section/i));
    await type(sectionEl(0), /section heading/i, 'S');
    await addField(0, { key: 'f', label: 'F', type: 'text' });
    await saveDraft();
    expect(posts()).toHaveLength(0);
  });

  it('reorder: [Move section down] on a section whose fields nobody depends on swaps the sections; the result is valid', async () => {
    await editor();
    await userEvent.click(btn(/move section down/i, sectionEl(0)));
    await saveDraft();
    expect(lastDef().sections.map((s) => s.key)).toEqual(['nodes', 'tumour']);
    ok(lastDef());
  });

  it('reorder never breaks "show_if must name an EARLIER field": moving the section with the trigger below its dependent is blocked or repaired; whatever is sent validates', async () => {
    const def = definition();
    def.sections[1]!.fields.push({ key: 'grade_note', label: 'Grade note', type: 'text', required: false, show_if: { field_key: 'grade', equals: 'g1' } });
    withDef(def);
    await editor();
    const down = btn(/move section down/i, sectionEl(0));
    if (!down.disabled) await userEvent.click(down);
    await touch();
    await saveDraft();
    expect(puts()).toHaveLength(1); // the title edit is legitimate: the draft must still be saveable
    for (const h of puts()) ok(h.json.definition);
  });

  it('changing the type of a trigger field (Nodes sampled: Boolean -> Text) never leaves a dangling show_if: whatever is sent validates', async () => {
    await editor();
    await userEvent.click(btn(/^edit field/i, fieldRow('nodes_sampled')));
    await choose(dialog(), /type/i, TYPE_RE['text']!);
    await userEvent.click(btn(/^save field$/i, dialog()));
    if (screen.queryByRole('dialog')) {
      expect(within(dialog()).getByText(/show if|nodes positive|depends|used by/i)).toBeTruthy(); // blocked: the user is told why
      return;
    }
    await saveDraft();
    for (const h of puts()) ok(h.json.definition);
    expect(puts().length > 0 || /show if|nodes positive|depends|used by/i.test(text())).toBe(true); // either saved valid, or refused with a reason
  });

  it('edit an existing field label: only that label changes, everything else (min, max, decimals, unit, options, show_if) survives the round trip', async () => {
    await editor();
    await editField('size_mm', { label: 'Tumour size (largest)' });
    await saveDraft();
    const d = lastDef();
    expect(d.sections[0]!.fields[1]).toEqual({ key: 'size_mm', label: 'Tumour size (largest)', type: 'decimal', required: true, unit_text: 'mm', min: '0', max: '300', decimals: 1 });
    expect(d.sections[1]!.fields[1]).toEqual(definition().sections[1]!.fields[1]);
    ok(d);
  });
});

describe('builder: the drawer refuses what the validator refuses (AC-08.2 prevented at the source)', () => {
  const open = async () => { await editor(); await userEvent.click(btn(/add field/i, sectionEl(0))); return dialog(); };
  const trySave = async (s: Spec) => { await fillField(s); await userEvent.click(btn(/^save field$/i, dialog())); };
  const nothingAdded = () => { expect(screen.getByRole('dialog')).toBeTruthy(); expect(screen.queryAllByRole('row').filter((r) => /zz_/.test(r.textContent ?? ''))).toHaveLength(0); };

  it.each(['Zz_Upper', '1zz', 'zz-dash', 'zz key', 'z'.repeat(41)])('field key %j is rejected (^[a-z][a-z0-9_]{0,39}$)', async (key) => {
    await open();
    await trySave({ key, label: 'Zz', type: 'text' });
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(fieldRows().some((r) => r.textContent?.includes('Zz'))).toBe(false);
  });
  const fieldRows = () => screen.queryAllByRole('row');

  it('AC-08.2 duplicate field key ("site" is taken, also across sections) is rejected with a message; nothing is added', async () => {
    await open();
    await trySave({ key: 'site', label: 'Another site', type: 'text' });
    nothingAdded();
    expect(within(dialog()).getByText(/already|duplicate|unique/i)).toBeTruthy();
    await userEvent.click(btn(/^cancel$/i, dialog()));
    await userEvent.click(btn(/add field/i, sectionEl(1)));
    await trySave({ key: 'grade', label: 'Another grade', type: 'text' });
    expect(within(dialog()).getByText(/already|duplicate|unique/i)).toBeTruthy();
  });

  it('AC-08.2 a single_select / multi_select without options is rejected', async () => {
    await open();
    await trySave({ key: 'zz_sel', label: 'Zz select', type: 'single_select' });
    expect(within(dialog()).getByText(/at least one/i)).toBeTruthy();
    expect(fieldRows().some((r) => r.textContent?.includes('zz_sel'))).toBe(false);
    expect(hits.filter((h) => h.method !== 'GET')).toHaveLength(0);
  });

  it('duplicate option codes are rejected', async () => {
    await open();
    await trySave({ key: 'zz_sel', label: 'Zz select', type: 'multi_select', options: [['a', 'A'], ['a', 'Another A']] });
    expect(within(dialog()).getByText(/already|duplicate|unique/i)).toBeTruthy();
    expect(fieldRows().some((r) => r.textContent?.includes('zz_sel'))).toBe(false);
  });

  it('min greater than max is rejected for numeric fields', async () => {
    await open();
    await trySave({ key: 'zz_num', label: 'Zz number', type: 'integer', min: '10', max: '2' });
    expect(within(dialog()).getByText(/lower than min|greater than max|min.*≤.*max/i)).toBeTruthy();
    expect(fieldRows().some((r) => r.textContent?.includes('zz_num'))).toBe(false);
  });

  it('min / max / decimals / max length only exist for the types the validator allows them for', async () => {
    await open();
    const d = dialog();
    await choose(d, /type/i, TYPE_RE['boolean']!);
    for (const re of [/^min/i, /^max(?! length)/i, /decimals/i, /max length/i, /option code/i]) expect(within(d).queryAllByRole('textbox', { name: re }).length + within(d).queryAllByRole('spinbutton', { name: re }).length, String(re)).toBe(0);
    await choose(d, /type/i, TYPE_RE['decimal']!);
    expect(input(d, /decimals/i)).toBeTruthy();
    expect(within(d).queryAllByRole('spinbutton', { name: /max length/i }).length + within(d).queryAllByRole('textbox', { name: /max length/i }).length).toBe(0);
  });

  it('Cancel leaves the template as it was', async () => {
    await open();
    await fillField({ key: 'zz_x', label: 'Zz x', type: 'text' });
    await userEvent.click(btn(/^cancel$/i, dialog()));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(fieldRows().some((r) => r.textContent?.includes('zz_x'))).toBe(false);
  });
});

describe('save errors (AC-08.2 server side, §8 copy)', () => {
  it('422 anatomic.template_invalid: Banner "The template has errors. Fix the highlighted items." and each errors[].message shown on the item its path names', async () => {
    api.use(http.put(`${ORIGIN}/v1/anatomic/synoptic-templates/:id`, () => problem('anatomic.template_invalid', 422, { errors: [
      { path: '/definition/sections/0/fields/1/key', message: 'duplicate field key' },
      { path: '/definition/sections/1/heading', message: 'string of 1-200 characters' },
    ] })));
    await editor();
    await touch();
    await saveDraft();
    expect(await screen.findByText('The template has errors. Fix the highlighted items.')).toBeTruthy();
    expect(within(fieldRow('size_mm')).getByText(/duplicate field key/)).toBeTruthy();
    expect(within(sectionEl(1)).getByText(/1-200 characters/)).toBeTruthy();
  });

  it('409 common.immutable_record (published meanwhile) -> "Published templates can\'t be changed. Create a new version."', async () => {
    api.use(http.put(`${ORIGIN}/v1/anatomic/synoptic-templates/:id`, () => problem('common.immutable_record', 409)));
    await editor();
    await touch();
    await saveDraft();
    expect(await screen.findByText(/Published templates can.t be changed/)).toBeTruthy();
  });

  it('409 common.version_conflict -> warning Banner with [Reload]; the typed changes are kept until reload', async () => {
    api.use(http.put(`${ORIGIN}/v1/anatomic/synoptic-templates/:id`, () => problem('common.version_conflict', 409)));
    await editor();
    await touch();
    await saveDraft();
    expect(await screen.findByText(/changed by someone else/i)).toBeTruthy();
    expect(input(document.body, /^title/i).value).toBe('Synthetic colon checklist v2');
    await userEvent.click(btn(/^reload$/i));
    expect(router.refresh).toHaveBeenCalled();
  });

  it('403 auth.mfa_required -> step-up dialog with [Verify now]; the draft stays in the form', async () => {
    api.use(http.put(`${ORIGIN}/v1/anatomic/synoptic-templates/:id`, () => problem('auth.mfa_required', 403)));
    await editor();
    await touch();
    await saveDraft();
    expect(await screen.findByText('This action needs two-factor verification.')).toBeTruthy();
    expect(screen.getByRole('button', { name: /verify now/i })).toBeTruthy();
    expect(input(document.body, /^title/i).value).toBe('Synthetic colon checklist v2');
  });

  it('a double click on [Save draft] sends one request', async () => {
    await editor();
    await touch();
    await userEvent.dblClick(btn(/^save draft$/i));
    expect(puts()).toHaveLength(1);
  });
});

describe('page rules (LD-140, 04-UI-UX §6)', () => {
  it('exactly one primary button: [Save draft]', async () => {
    await editor();
    expect(Array.from(document.querySelectorAll('.lims-btn-primary')).map((b) => b.textContent?.trim())).toEqual(['Save draft']);
  });

  it('axe: editor with preview, and the field drawer, have no violations', async () => {
    await editor();
    expect(await axeRun()).toEqual([]);
    await userEvent.click(btn(/add field/i, sectionEl(0)));
    expect(await axeRun()).toEqual([]);
  });

  it('every input in the builder has a visible label (04-UI-UX §6): no input without an accessible name', async () => {
    await editor();
    await userEvent.click(btn(/add field/i, sectionEl(0)));
    const bad = Array.from(dialog().querySelectorAll('input:not([type=hidden]), textarea')).filter((el) => !(el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || (el as HTMLInputElement).labels?.length));
    expect(bad).toHaveLength(0);
  });
});
