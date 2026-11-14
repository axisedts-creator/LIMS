// @vitest-environment jsdom
// C11.T-21 — Report tab draft editor (04-UI-UX §3 Alt+R/Alt+S, §4.2.7; AC-07.2; REQ-SEC-088; TRD R1/R2). LD-140 (2026-11-13): kit components only, one primary button per page, status = tone + icon + word.
// ASSUMED (t21.harness.tsx header): reached through the CaseWorkspace seam by the tab name "Report"; fields found by visible label; Select = kit Select (button + role=option);
//   the Preview Card carries data-testid="report-preview" (kit Card forwards it); writes are server actions to the real API paths; after a successful write the page may refresh.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { http, HttpResponse } from 'msw';
import { ToastProvider } from '@lims/ui/components/Toast';
import { ID, ORIGIN, PERM_SIGN, api, draft, hit, problem, reportCase, resetHits, router, t21Defaults, template } from './t21.harness';

vi.mock('next/navigation', async () => (await import('./t21.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t21.harness')).sessionMock);

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { resetHits(); router.push.mockReset(); router.refresh.mockReset(); api.use(...t21Defaults); });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const mount = async (d: Record<string, unknown> = reportCase(), permissions = PERM_SIGN, templates: unknown[] = []) => {
  const { CaseWorkspace } = await import('../components/CaseWorkspace');
  return render(<ToastProvider><CaseWorkspace detail={d as never} permissions={permissions} templates={templates as never} /></ToastProvider>);
};
/** Open the Report tab and wait for the editor (or the empty state) to finish loading. */
const open = async (d: Record<string, unknown> = reportCase(), permissions = PERM_SIGN, templates: unknown[] = []) => {
  const r = await mount(d, permissions, templates);
  await userEvent.click(screen.getByRole('tab', { name: /^report$/i }));
  await waitFor(() => expect(screen.queryByText(/no report draft yet/i) ?? screen.queryByLabelText(/^gross/i)).toBeTruthy());
  return r;
};
const label = (re: RegExp) => screen.getByLabelText(re) as HTMLTextAreaElement;
const gross = () => label(/^gross/i);
const impression = () => label(/diagnosis \/ impression/i);
const btn = (re: RegExp, scope: HTMLElement = document.body) => within(scope).getByRole('button', { name: re }) as HTMLButtonElement;
const puts = () => hit('PUT', /\/cases\/[^/]+\/report-draft$/);
const preview = () => screen.getByTestId('report-preview');
const type = async (el: HTMLElement, s: string) => { await userEvent.click(el); await userEvent.paste(s); };

describe('empty state (R1 404)', () => {
  const none = () => api.use(http.get(`${ORIGIN}/v1/anatomic/cases/:id/report-draft`, () => problem('common.not_found', 404)));

  it('"No report draft yet." with [Start report]; [Start report] -> PUT report-draft with If-Match "0" and no Idempotency-Key', async () => {
    none();
    await open(reportCase({ open_draft: undefined }));
    expect(screen.getByText(/no report draft yet/i)).toBeTruthy();
    await userEvent.click(btn(/^start report$/i));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]!.headers.get('if-match')).toBe('"0"');
    expect(puts()[0]!.headers.get('idempotency-key')).toBeNull();
    await waitFor(() => expect(gross()).toBeTruthy()); // the editor replaces the empty state
  });

  it('without anatomic.case.work there is no [Start report]', async () => {
    none();
    await open(reportCase({ open_draft: undefined }), ['anatomic.case.read']);
    expect(screen.queryByRole('button', { name: /^start report$/i })).toBeNull();
  });
});

describe('layout and fields (§4.2.7)', () => {
  it('draft kind badge: "Initial report"; revision; "Amendment — reason: {display}" (reason display from C5 amendment_reasons)', async () => {
    await open();
    expect(screen.getAllByText(/^initial report$/i).length).toBeGreaterThan(0);
    cleanup();
    api.use(http.get(`${ORIGIN}/v1/anatomic/cases/:id/report-draft`, () => HttpResponse.json(draft({ kind: 'revision', change_reason_code: 'transcription_error' }))));
    await open();
    expect(screen.getAllByText(/^revision$/i).length).toBeGreaterThan(0);
    cleanup();
    api.use(http.get(`${ORIGIN}/v1/anatomic/cases/:id/report-draft`, () => HttpResponse.json(draft({ kind: 'amendment', change_reason_code: 'new_information' }))));
    await open();
    await waitFor(() => expect(document.body.textContent).toMatch(/Amendment\s*—\s*reason:\s*New clinical information/));
  });

  it('TextAreas show the saved text with counts and the spec maxima (20000 / 20000 / 8000 / 8000), plain text', async () => {
    api.use(http.get(`${ORIGIN}/v1/anatomic/cases/:id/report-draft`, () => HttpResponse.json(draft({ gross_text: 'Synthetic g', microscopy_text: 'Synthetic m', impression_text: 'Synthetic i', comment_text: 'Synthetic c' }))));
    await open();
    expect(gross().value).toBe('Synthetic g');
    expect(label(/^microscopy/i).value).toBe('Synthetic m');
    expect(impression().value).toBe('Synthetic i');
    expect(label(/^comment/i).value).toBe('Synthetic c');
    for (const [el, max] of [[gross(), '20000'], [label(/^microscopy/i), '20000'], [impression(), '8000'], [label(/^comment/i), '8000']] as const) expect(el.getAttribute('maxlength')).toBe(max);
    expect(document.body.textContent).toMatch(/11\s*\/\s*20000|11\s*\/\s*20,000/); // showCount
  });

  it('Diagnosis / impression is marked required in words; Gross is required for histology', async () => {
    await open();
    const t = document.body.textContent ?? '';
    expect(t).toMatch(/diagnosis \/ impression[\s\S]{0,40}required/i);
    expect(t).toMatch(/gross[\s\S]{0,40}required/i);
  });

  it('Ancillary results: one TextArea (<=2000) per COMPLETED stain order, labelled "{stain} on {block}"; requested orders get none; saved text is shown', async () => {
    api.use(http.get(`${ORIGIN}/v1/anatomic/cases/:id/report-draft`, () => HttpResponse.json(draft({ ancillary: [{ stain_order_id: ID(401), result_text: 'Synthetic PAS positive' }] }))));
    await open();
    const a = screen.getByLabelText(/periodic acid-schiff on SP26-000042-A1/i) as HTMLTextAreaElement;
    expect(a.value).toBe('Synthetic PAS positive');
    expect(a.getAttribute('maxlength')).toBe('2000');
    expect(screen.queryByLabelText(/cytokeratin 7/i)).toBeNull();
  });

  it('Slide assessments: read-only list of slides with "Include in report" on', async () => {
    await open();
    expect(document.body.textContent).toContain('SP26-000042-A1-S1');
    expect(document.body.textContent).not.toContain('SP26-000042-A1-S2');
  });

  it('Abnormal RadioGroup: Normal / Abnormal / Not stated (default Not stated); Critical finding Checkbox with the notify text', async () => {
    await open();
    expect((screen.getByRole('radio', { name: /^not stated$/i }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole('radio', { name: /^normal$/i })).toBeTruthy();
    expect(screen.getByRole('radio', { name: /^abnormal$/i })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: /critical or unexpected finding.*notify per lab protocol/i })).toBeTruthy();
  });

  it('read-only users (anatomic.case.read only) can read the draft but have no Save draft / Sign out / editable fields', async () => {
    await open(reportCase(), ['anatomic.case.read']);
    expect(screen.queryByRole('button', { name: /save draft/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^sign out$/i })).toBeNull();
    for (const t of Array.from(document.querySelectorAll('textarea'))) expect(t.readOnly || t.disabled).toBe(true);
  });
});

describe('Save draft (R2)', () => {
  it('PUT report-draft with If-Match "<draft version>", the full replacement body, flag/is_critical mapped from the radios/checkbox; no Idempotency-Key', async () => {
    await open();
    await type(gross(), 'Synthetic typed gross');
    await type(label(/^microscopy/i), 'Synthetic typed micro');
    await type(impression(), 'Synthetic typed impression');
    await type(label(/^comment/i), 'Synthetic typed comment');
    await type(screen.getByLabelText(/periodic acid-schiff on SP26-000042-A1/i), 'Synthetic PAS result');
    await userEvent.click(screen.getByRole('radio', { name: /^abnormal$/i }));
    await userEvent.click(screen.getByRole('checkbox', { name: /critical or unexpected finding/i }));
    await userEvent.click(btn(/save draft/i));
    await waitFor(() => expect(puts()).toHaveLength(1));
    const p = puts()[0]!;
    expect(p.headers.get('if-match')).toBe('"2"');
    expect(p.headers.get('idempotency-key')).toBeNull();
    expect(p.json).toMatchObject({ gross_text: 'Synthetic typed gross', microscopy_text: 'Synthetic typed micro', impression_text: 'Synthetic typed impression', comment_text: 'Synthetic typed comment', flag: 'A', is_critical: true, synoptic: [], image_ids: [], diagnosis_codes: [] });
    expect(p.json.ancillary).toEqual([{ stain_order_id: ID(401), result_text: 'Synthetic PAS result' }]);
    expect(Object.keys(p.json).sort()).toEqual(['ancillary', 'comment_text', 'diagnosis_codes', 'flag', 'gross_text', 'image_ids', 'impression_text', 'is_critical', 'microscopy_text', 'synoptic']);
  });

  it('flag: Normal -> "N", Not stated -> flag omitted', async () => {
    await open();
    await userEvent.click(screen.getByRole('radio', { name: /^normal$/i }));
    await userEvent.click(btn(/save draft/i));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]!.json.flag).toBe('N');
    await userEvent.click(screen.getByRole('radio', { name: /^not stated$/i }));
    await userEvent.click(btn(/save draft/i));
    await waitFor(() => expect(puts()).toHaveLength(2));
    expect('flag' in puts()[1]!.json).toBe(false);
    expect(puts()[1]!.headers.get('if-match')).toBe('"3"'); // version from the first response
  });

  it('Alt+S saves; Ctrl+Enter (kit Form submit) saves', async () => {
    await open();
    await type(impression(), 'Synthetic');
    fireEvent.keyDown(document, { key: 's', code: 'KeyS', altKey: true });
    await waitFor(() => expect(puts()).toHaveLength(1));
    await userEvent.click(impression());
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => expect(puts()).toHaveLength(2));
  });

  it('success toast "Draft saved"; the save button is not double-submitted', async () => {
    await open();
    await userEvent.dblClick(btn(/save draft/i));
    await waitFor(() => expect(screen.getAllByText(/draft saved/i).length).toBeGreaterThan(0));
    expect(puts()).toHaveLength(1);
  });

  it('409 common.version_conflict -> the shared "changed by someone else" banner with [Reload]', async () => {
    api.use(http.put(`${ORIGIN}/v1/anatomic/cases/:id/report-draft`, () => problem('common.version_conflict', 409)));
    await open();
    await userEvent.click(btn(/save draft/i));
    expect(await screen.findByText('This case was changed by someone else. Reload to see the latest version.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /^reload$/i }));
    expect(router.refresh).toHaveBeenCalled();
  });

  it('409 anatomic.signout_locked -> "This case is signed out. Use Revise/Amend or add an addendum."', async () => {
    api.use(http.put(`${ORIGIN}/v1/anatomic/cases/:id/report-draft`, () => problem('anatomic.signout_locked', 409)));
    await open();
    await userEvent.click(btn(/save draft/i));
    expect(await screen.findByText('This case is signed out. Use Revise/Amend or add an addendum.')).toBeTruthy();
  });

  it('403 auth.mfa_required on save -> step-up dialog "This action needs two-factor verification." [Verify now] [Cancel]; nothing is lost', async () => {
    api.use(http.put(`${ORIGIN}/v1/anatomic/cases/:id/report-draft`, () => problem('auth.mfa_required', 403)));
    await open();
    await type(impression(), 'Synthetic keep me');
    await userEvent.click(btn(/save draft/i));
    const d = await screen.findByRole('dialog');
    expect(d.textContent).toMatch(/two-factor verification/i);
    expect(within(d).getByRole('button', { name: /verify now/i })).toBeTruthy();
    await userEvent.click(within(d).getByRole('button', { name: /^cancel$/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(impression().value).toBe('Synthetic keep me');
  });

  it('anatomic.template_not_published / image_limit_reached map to the §8 copy, never a raw code or server detail', async () => {
    api.use(http.put(`${ORIGIN}/v1/anatomic/cases/:id/report-draft`, () => problem('anatomic.image_limit_reached', 422, { detail: 'internal-trace-xyz' })));
    await open();
    await userEvent.click(btn(/save draft/i));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    const t = document.body.textContent ?? '';
    expect(t).not.toContain('internal-trace-xyz');
    expect(t).not.toContain('anatomic.image_limit_reached');
  });
});

describe('Insert gross from parts', () => {
  it('empty Gross: inserts each part\'s gross text directly, no confirmation', async () => {
    await open(reportCase(), PERM_SIGN);
    await userEvent.click(btn(/insert gross from parts/i));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(gross().value).toContain('Synthetic gross of part A.');
    expect(puts()).toHaveLength(0); // nothing is sent until Save
  });

  it('non-empty Gross: ConfirmDialog before replacing; [Cancel] keeps the text, confirm replaces it', async () => {
    api.use(http.get(`${ORIGIN}/v1/anatomic/cases/:id/report-draft`, () => HttpResponse.json(draft({ gross_text: 'Synthetic existing gross' }))));
    await open();
    await userEvent.click(btn(/insert gross from parts/i));
    let d = await screen.findByRole('dialog');
    await userEvent.click(within(d).getByRole('button', { name: /^cancel$/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(gross().value).toBe('Synthetic existing gross');
    await userEvent.click(btn(/insert gross from parts/i));
    d = await screen.findByRole('dialog');
    await userEvent.click(within(d).getAllByRole('button').find((b) => !/cancel/i.test(b.textContent ?? ''))!);
    await waitFor(() => expect(gross().value).toContain('Synthetic gross of part A.'));
    expect(gross().value).not.toContain('Synthetic existing gross');
  });
});

describe('text templates (AC-07.2, 04-UI-UX §2)', () => {
  const tpl = [template('nm1', 'Synthetic normal microscopy text.', { section: 'microscopy' }), template('g1', 'Synthetic gross template.', { section: 'gross' })];
  const withTemplates = () => api.use(http.get(`${ORIGIN}/v1/anatomic/text-templates`, () => HttpResponse.json({ data: tpl, page: { limit: 50 } })));

  it('AC-07.2: typing ";nm1" then Tab in Microscopy inserts the template text at the cursor, client side; nothing is sent until Save', async () => {
    withTemplates();
    await open(reportCase(), PERM_SIGN, tpl);
    await userEvent.click(label(/^microscopy/i));
    await userEvent.keyboard(';nm1{Tab}');
    expect(label(/^microscopy/i).value).toBe('Synthetic normal microscopy text.');
    expect(label(/^microscopy/i).value).not.toContain(';nm1');
    expect(puts()).toHaveLength(0);
    expect(hit('POST', /./)).toHaveLength(0);
  });

  it('a template of another section is not expanded; unknown code leaves the text and shows the hint "No template ;zz9"', async () => {
    withTemplates();
    await open(reportCase(), PERM_SIGN, tpl);
    await userEvent.click(label(/^microscopy/i));
    await userEvent.keyboard(';g1{Tab}');
    expect(label(/^microscopy/i).value).not.toContain('Synthetic gross template.');
    await userEvent.clear(label(/^microscopy/i));
    await userEvent.keyboard(';zz9{Tab}');
    expect(label(/^microscopy/i).value).toContain(';zz9');
    expect(document.body.textContent).toContain('No template ;zz9');
  });
});

describe('images in report (picker)', () => {
  it('ready images only (checkbox per image, caption as label); processing image is not selectable', async () => {
    await open();
    expect(screen.getByRole('checkbox', { name: /synthetic caption 1/i })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: /synthetic caption 2/i })).toBeTruthy();
    const p = screen.queryByRole('checkbox', { name: /synthetic processing image/i }) as HTMLInputElement | null;
    expect(p === null || p.disabled).toBe(true);
  });

  it('order = print order: ticking 1 then 2, [Move up] on image 2 puts it first; saved image_ids follow that order', async () => {
    await open();
    await userEvent.click(screen.getByRole('checkbox', { name: /synthetic caption 1/i }));
    await userEvent.click(screen.getByRole('checkbox', { name: /synthetic caption 2/i }));
    const ups = screen.getAllByRole('button', { name: /move up/i }).filter((b) => !(b as HTMLButtonElement).disabled);
    await userEvent.click(ups[ups.length - 1]!);
    await userEvent.click(btn(/save draft/i));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]!.json.image_ids).toEqual([ID(502), ID(501)]);
  });

  it('the picker offers [Move up]/[Move down] IconButtons with accessible names and stops at the settings max_report_images', async () => {
    api.use(http.get(`${ORIGIN}/v1/anatomic/settings`, () => HttpResponse.json({ auto_accession_on_receipt: true, require_gross_complete_for_processing: false, default_routine_stain_code: 'HE', max_images_per_case: 50, max_report_images: 1, version: 1 })));
    await open();
    await userEvent.click(screen.getByRole('checkbox', { name: /synthetic caption 1/i }));
    await waitFor(() => expect((screen.getByRole('checkbox', { name: /synthetic caption 2/i }) as HTMLInputElement).disabled).toBe(true));
    expect(screen.getAllByRole('button', { name: /move down/i }).length).toBeGreaterThan(0);
  });

  it('thumbnails/captions are text (REQ-SEC-088); image src is the same-origin BFF route only', async () => {
    await open(reportCase({ images: [{ ...reportCase().images[0], caption: '<img src=x onerror=alert(1)>' }] }));
    expect(document.querySelector('img[src="x"]')).toBeNull();
    for (const i of Array.from(document.querySelectorAll('img'))) expect(i.getAttribute('src') ?? '').toMatch(/^\/anatomic\/images\//);
  });
});

describe('diagnosis codes (Combobox, <=20 chips)', () => {
  it('type -> loadOptions hits coded-sets/diagnoses/values?q=; choose adds a chip; remove deletes it; saved as [{code}] only', async () => {
    await open();
    const cb = screen.getByRole('combobox', { name: /diagnosis codes/i });
    await userEvent.click(cb);
    await userEvent.type(cb, 'one');
    await userEvent.click(await screen.findByRole('option', { name: /synthetic diagnosis one/i }));
    expect(hit('GET', /\/coded-sets\/diagnoses\/values$/).some((h) => new URLSearchParams(h.search).get('q') === 'one')).toBe(true);
    expect(screen.getByText(/synthetic diagnosis one/i)).toBeTruthy();
    await userEvent.click(btn(/save draft/i));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]!.json.diagnosis_codes).toEqual([{ code: 'D001' }]);
    await userEvent.click(screen.getByRole('button', { name: /remove.*synthetic diagnosis one/i }));
    expect(screen.queryByText(/synthetic diagnosis one/i)).toBeNull();
  });

  it('saved codes show as chips with their display text', async () => {
    api.use(http.get(`${ORIGIN}/v1/anatomic/cases/:id/report-draft`, () => HttpResponse.json(draft({ diagnosis_codes: [{ code: 'D002', display: 'Synthetic diagnosis two', system: 'synthetic' }] }))));
    await open();
    expect(screen.getByText(/synthetic diagnosis two/i)).toBeTruthy();
  });
});

describe('Preview (§4.2.7)', () => {
  it('read-only plain rendering with headings Gross, Microscopy, Diagnosis, Comment, Synoptic, Ancillary, Slides, Images, Codes; typed text appears as text', async () => {
    await open();
    await type(impression(), 'Synthetic live impression');
    const p = within(preview());
    for (const h of ['Gross', 'Microscopy', 'Diagnosis', 'Comment', 'Synoptic', 'Ancillary', 'Slides', 'Images', 'Codes']) expect(p.getByRole('heading', { name: new RegExp(`^${h}`, 'i') }), h).toBeTruthy();
    expect(p.getByText('Synthetic live impression')).toBeTruthy();
    expect(preview().querySelector('input,textarea,select')).toBeNull();
  });

  it('REQ-SEC-088: drafted text renders as text, never HTML', async () => {
    api.use(http.get(`${ORIGIN}/v1/anatomic/cases/:id/report-draft`, () => HttpResponse.json(draft({ gross_text: '<script>alert(1)</script>', impression_text: '<img src=x onerror=alert(2)>' }))));
    await open();
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect(preview().textContent).toContain('<script>alert(1)</script>');
  });
});

describe('unsaved changes (04-UI-UX §2)', () => {
  it('leaving the Report tab with edits asks "Discard unsaved changes?" [Stay] [Discard]; Stay keeps the text', async () => {
    await open();
    await type(impression(), 'Synthetic unsaved');
    await userEvent.click(screen.getByRole('tab', { name: /^overview$/i }));
    const d = await screen.findByRole('dialog');
    expect(d.textContent).toMatch(/discard unsaved changes\?/i);
    await userEvent.click(within(d).getByRole('button', { name: /^stay$/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(impression().value).toBe('Synthetic unsaved');
  });

  it('a clean editor leaves without asking', async () => {
    await open();
    await userEvent.click(screen.getByRole('tab', { name: /^overview$/i }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('a11y and shortcuts', () => {
  it('axe: no serious/critical violations on the editor', async () => {
    const { container } = await open();
    const r = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } }); // jsdom has no layout: contrast is checked elsewhere
    expect(r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)).toEqual([]);
  });

  it('Alt+R opens the Report tab', async () => {
    await mount();
    fireEvent.keyDown(document, { key: 'r', code: 'KeyR', altKey: true });
    await waitFor(() => expect(screen.getByRole('tab', { name: /^report$/i }).getAttribute('aria-selected')).toBe('true'));
  });

  it('exactly one primary button on the Report page (LD-140): [Sign out] for a signer; none for a read-only user', async () => {
    await open();
    expect(Array.from(document.querySelectorAll('button.lims-btn-primary')).map((b) => b.textContent?.trim())).toEqual(['Sign out']);
    cleanup();
    await open(reportCase(), ['anatomic.case.read']);
    expect(document.querySelectorAll('button.lims-btn-primary')).toHaveLength(0);
  });
});
