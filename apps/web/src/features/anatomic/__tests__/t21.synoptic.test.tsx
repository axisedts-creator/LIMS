// @vitest-environment jsdom
// C11.T-21 — Synoptic form in the Report tab (04-UI-UX §4.2.7 "Synoptic", §6 live region; TRD §4.5; REQ-SEC-088). Composed from kit fields only (04-UI-UX §5), definition-driven.
// ASSUMED: [Add synoptic] = button, opens a kit Select "Synoptic template" of published templates for the case kind (list = summaries, definition via GET /synoptic-templates/{id});
//   each instance is a Card titled with the template title; fields found by their visible labels; [Remove] per instance; saved values keyed by field key (string | number | boolean | string[]).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { http, HttpResponse } from 'msw';
import { ToastProvider } from '@lims/ui/components/Toast';
import { ID, ORIGIN, PERM_SIGN, api, draft, hit, page, reportCase, resetHits, router, synDefinition, synInstance, synSummary, synTemplate, t21Defaults } from './t21.harness';

vi.mock('next/navigation', async () => (await import('./t21.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t21.harness')).sessionMock);

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { resetHits(); router.push.mockReset(); router.refresh.mockReset(); api.use(...t21Defaults); });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const open = async (d: Record<string, unknown> = reportCase()) => {
  const { CaseWorkspace } = await import('../components/CaseWorkspace');
  render(<ToastProvider><CaseWorkspace detail={d as never} permissions={PERM_SIGN} templates={[]} /></ToastProvider>);
  await userEvent.click(screen.getByRole('tab', { name: /^report$/i }));
  await waitFor(() => expect(screen.queryByLabelText(/^gross/i)).toBeTruthy());
};
const withDraft = (over: Record<string, unknown>) => api.use(http.get(`${ORIGIN}/v1/anatomic/cases/:id/report-draft`, () => HttpResponse.json(draft(over))));
const btn = (re: RegExp, scope: HTMLElement = document.body) => within(scope).getByRole('button', { name: re }) as HTMLButtonElement;
const puts = () => hit('PUT', /\/cases\/[^/]+\/report-draft$/);
const instance = (title = /synthetic breast panel/i) => screen.getAllByText(title).map((e) => e.closest('.lims-card') as HTMLElement).filter(Boolean)[0]!;
const choose = async (scope: HTMLElement, lab: RegExp, option: RegExp) => {
  await userEvent.click(within(scope).getByRole('button', { name: lab }));
  await userEvent.click(await screen.findByRole('option', { name: option }));
};
const add = async (which = /synthetic breast panel/i) => {
  await userEvent.click(btn(/add synoptic/i));
  await userEvent.click(await screen.findByRole('option', { name: which }));
  await screen.findByLabelText(/tumour site/i);
};

describe('adding an instance', () => {
  it('[Add synoptic] lists PUBLISHED templates for the case kind (GET synoptic-templates?status=published&case_kind=histology), then loads the chosen definition', async () => {
    await open();
    await userEvent.click(btn(/add synoptic/i));
    expect(await screen.findByRole('option', { name: /synthetic breast panel/i })).toBeTruthy();
    expect(screen.getByRole('option', { name: /synthetic panel 2/i })).toBeTruthy();
    const list = hit('GET', /\/synoptic-templates$/)[0]!;
    const q = new URLSearchParams(list.search);
    expect(q.get('status')).toBe('published');
    expect(q.get('case_kind')).toBe('histology');
    await userEvent.click(screen.getByRole('option', { name: /synthetic breast panel/i }));
    await screen.findByLabelText(/tumour site/i);
    expect(hit('GET', new RegExp(`/synoptic-templates/${ID(1001)}$`))).toHaveLength(1);
    expect(puts()).toHaveLength(0); // nothing is sent until Save
  });

  it('a template whose list/get fails shows a plain message, not the raw code', async () => {
    api.use(http.get(`${ORIGIN}/v1/anatomic/synoptic-templates`, () => HttpResponse.json({ type: 'x', title: 'x', status: 500, code: 'common.internal' }, { status: 500 })));
    await open();
    await userEvent.click(btn(/add synoptic/i));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(document.body.textContent).not.toContain('common.internal');
  });

  it('at most 5 instances: [Add synoptic] is disabled at 5', async () => {
    withDraft({ synoptic: [1, 2, 3, 4, 5].map(() => synInstance(1, {})) });
    api.use(http.get(`${ORIGIN}/v1/anatomic/synoptic-templates`, () => page([synSummary(1)])));
    await open();
    expect(btn(/add synoptic/i).disabled).toBe(true);
  });
});

describe('field components by type (§4.2.7)', () => {
  it('text TextField (max_length), long_text TextArea (max_length), integer (min/max), decimal (unit as suffix), boolean Switch, single_select Select, multi_select Checkbox group, date DatePicker', async () => {
    await open();
    await add();
    const c = instance();
    const text = within(c).getByLabelText(/tumour site/i) as HTMLInputElement;
    expect(text.tagName).toBe('INPUT');
    expect(text.getAttribute('maxlength')).toBe('50');
    const long = within(c).getByLabelText(/tumour notes/i) as HTMLTextAreaElement;
    expect(long.tagName).toBe('TEXTAREA');
    expect(long.getAttribute('maxlength')).toBe('500');
    const int = within(c).getByLabelText(/size \(mm\)/i) as HTMLInputElement;
    expect(int.getAttribute('aria-valuemin') ?? int.getAttribute('min')).toBe('0');
    expect(int.getAttribute('aria-valuemax') ?? int.getAttribute('max')).toBe('300');
    expect(within(c).getByLabelText(/^weight/i)).toBeTruthy();
    expect(c.textContent).toMatch(/\bg\b/); // unit_text as suffix
    expect(within(c).getByRole('switch', { name: /multifocal/i })).toBeTruthy();
    expect(within(c).getByRole('button', { name: /grade/i })).toBeTruthy();
    const group = within(c).getByRole('group', { name: /margins involved/i });
    expect(within(group).getByRole('checkbox', { name: /superficial/i })).toBeTruthy();
    expect(within(group).getByRole('checkbox', { name: /deep/i })).toBeTruthy();
    expect(within(c).getByRole('group', { name: /excised on/i }) ?? within(c).getByLabelText(/excised on/i)).toBeTruthy();
  });

  it('required fields are marked in words ("(required)"), optional ones are not', async () => {
    await open();
    await add();
    const c = instance();
    expect(within(c).getByLabelText(/tumour site/i).hasAttribute('required') || within(c).getByLabelText(/tumour site/i).getAttribute('aria-required') === 'true').toBe(true);
    expect((c.textContent ?? '').match(/required/gi)?.length).toBe(2); // Tumour site + Grade (Necrosis extent is hidden); optional fields carry no marker
  });

  it('section headings render as headings; field labels and options are text (REQ-SEC-088)', async () => {
    api.use(http.get(`${ORIGIN}/v1/anatomic/synoptic-templates/:id`, () => HttpResponse.json(synTemplate(1, synDefinition({ sections: [{ key: 's', heading: '<b>Hostile</b> heading', fields: [{ key: 'f', label: '<img src=x onerror=alert(1)>', type: 'single_select', required: false, options: [{ code: 'a', display: '<script>alert(2)</script>' }] }] }] })))));
    await open();
    await userEvent.click(btn(/add synoptic/i));
    await userEvent.click(await screen.findByRole('option', { name: /synthetic breast panel/i }));
    await screen.findByText('<b>Hostile</b> heading');
    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('b')).toBeNull();
  });
});

describe('show_if (live) and the live region (§6)', () => {
  it('"Necrosis extent" is hidden until Multifocal is on; turning it on shows the field, focus stays on the Switch, a polite live region says "1 more field shown"', async () => {
    await open();
    await add();
    const c = instance();
    expect(within(c).queryByLabelText(/necrosis extent/i)).toBeNull();
    const sw = within(c).getByRole('switch', { name: /multifocal/i });
    await userEvent.click(sw);
    expect(await within(c).findByLabelText(/necrosis extent/i)).toBeTruthy();
    expect(document.activeElement).toBe(sw);
    const live = Array.from(document.querySelectorAll('[aria-live="polite"], [role="status"]')).map((e) => e.textContent).join(' ');
    expect(live).toMatch(/1 more fields? shown/i);
    await userEvent.click(sw);
    expect(within(c).queryByLabelText(/necrosis extent/i)).toBeNull();
  });

  it('values of a hidden field are not sent', async () => {
    await open();
    await add();
    const c = instance();
    const sw = within(c).getByRole('switch', { name: /multifocal/i });
    await userEvent.click(sw);
    await userEvent.type(await within(c).findByLabelText(/necrosis extent/i), 'Synthetic necrosis');
    await userEvent.click(sw); // hides it again
    await userEvent.type(within(c).getByLabelText(/tumour site/i), 'Synthetic site');
    await userEvent.click(btn(/save draft/i));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]!.json.synoptic[0].values).not.toHaveProperty('necrosis_extent');
  });
});

describe('save and reload', () => {
  it('Save sends synoptic:[{template_id, values}] typed per field (string | number | boolean | string[]), no title/version fields', async () => {
    await open();
    await add();
    const c = instance();
    await userEvent.type(within(c).getByLabelText(/tumour site/i), 'Synthetic site');
    await userEvent.type(within(c).getByLabelText(/tumour notes/i), 'Synthetic notes');
    await userEvent.type(within(c).getByLabelText(/size \(mm\)/i), '12');
    await userEvent.type(within(c).getByLabelText(/^weight/i), '1.25');
    await userEvent.click(within(c).getByRole('switch', { name: /multifocal/i }));
    await userEvent.type(await within(c).findByLabelText(/necrosis extent/i), 'Synthetic extent');
    await choose(c, /grade/i, /^grade 2$/i);
    await userEvent.click(within(within(c).getByRole('group', { name: /margins involved/i })).getByRole('checkbox', { name: /deep/i }));
    await userEvent.click(btn(/save draft/i));
    await waitFor(() => expect(puts()).toHaveLength(1));
    const s = puts()[0]!.json.synoptic;
    expect(s).toHaveLength(1);
    expect(Object.keys(s[0]).sort()).toEqual(['template_id', 'values']);
    expect(s[0].template_id).toBe(ID(1001));
    expect(s[0].values).toMatchObject({ site: 'Synthetic site', notes: 'Synthetic notes', multifocal: true, necrosis_extent: 'Synthetic extent', grade: 'g2', margins: ['deep'] });
    expect(Number(s[0].values.size_mm)).toBe(12);
    expect(typeof s[0].values.size_mm).toBe('number');
    expect(String(s[0].values.weight)).toBe('1.25');
  });

  it('a saved instance is re-rendered from ITS template version (draft values shown), not the newest one', async () => {
    withDraft({ synoptic: [synInstance(1, { site: 'Synthetic saved site', grade: 'g3', multifocal: false })] });
    await open();
    const c = instance();
    expect((within(c).getByLabelText(/tumour site/i) as HTMLInputElement).value).toBe('Synthetic saved site');
    expect(within(c).getByRole('button', { name: /grade 3/i })).toBeTruthy();
    expect(hit('GET', new RegExp(`/synoptic-templates/${ID(1001)}$`))).toHaveLength(1);
  });

  it('[Remove] drops the instance; the next Save sends synoptic: []', async () => {
    withDraft({ synoptic: [synInstance(1, { site: 'Synthetic saved site' })] });
    await open();
    await userEvent.click(btn(/^remove/i, instance()));
    expect(screen.queryByLabelText(/tumour site/i)).toBeNull();
    await userEvent.click(btn(/save draft/i));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]!.json.synoptic).toEqual([]);
  });

  it('422 anatomic.template_not_published on save -> a plain message (no raw code)', async () => {
    api.use(http.put(`${ORIGIN}/v1/anatomic/cases/:id/report-draft`, () => HttpResponse.json({ type: 'x', title: 'x', status: 422, code: 'anatomic.template_not_published' }, { status: 422 })));
    await open();
    await add();
    await userEvent.click(btn(/save draft/i));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toMatch(/template version is not published/i);
    expect(document.body.textContent).not.toContain('anatomic.template_not_published');
  });

  it('preview shows the synoptic section as "label: value" lines for the instance', async () => {
    withDraft({ synoptic: [synInstance(1, { site: 'Synthetic saved site', grade: 'g2' })] });
    await open();
    const p = screen.getByTestId('report-preview').textContent ?? '';
    expect(p).toContain('Synthetic breast panel');
    expect(p).toContain('Tumour site');
    expect(p).toContain('Synthetic saved site');
    expect(p).toContain('Grade 2'); // option display, not the code
  });
});

describe('a11y', () => {
  it('axe: no serious/critical violations with an instance on screen', async () => {
    withDraft({ synoptic: [synInstance(1, { site: 'x' })] });
    await open();
    const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
    expect(r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)).toEqual([]);
  });
});
