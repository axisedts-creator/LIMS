// @vitest-environment jsdom
// T0D-PRINTCFG-1 done_when (1), (5), (6): the "Print and stationery" section of the reporting settings and of the billing settings.
// Reached through the page default exports of /reporting/settings and /billing/settings; no component or file name is pinned. ASSUMED contract (dispute if wrong):
//   region aria-label "Print and stationery" (also a heading). Tabs role=tab "Reports" | "Bills" | "Credit notes" (reporting settings opens on Reports, billing settings on Bills).
//   Select "Branch" (first option "Lab default"; the other options are the branch names of listBranches). Radio group, four radios named
//   "My own letterhead image", "Type my header and footer", "I print on my own pre-printed pad", "Plain with no header and no footer".
//   TextAreas "Header" and "Footer" each with a visible live counter "<n> of 8 lines". Integer fields "Blank space at the top (mm)" / "Blank space at the bottom (mm)"
//   (usable only in the pre-printed pad mode). Switch "Black and white". Select "Font size" (options 8 to 12). Button "Save print settings".
//   Preview: region aria-label "Preview" holding an iframe/object/embed/img whose URL contains /reporting/prints/<job id>/pdf once the previewPrintProfile job is ready,
//   and a "Preparing preview" text while it renders; a failed preview shows role=alert inside that region and never blocks editing.
//   Reads: listPrintProfiles (may be filtered by document_kind / branch_id), listBranches. A failing profile read must not take the page down (inline ErrorState + Retry).
//   Typed text is PLAIN TEXT: sent verbatim (no escaping), never injected as HTML, and < or > is refused in the browser (contract pattern of header_text).
//   Without reporting.settings.manage the Reports tab is read only; without billing.settings.manage the Bills and Credit notes tabs are read only (no Save, controls disabled).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  API, BRANCH_A, BRANCH_B, ID, MANAGE_BILL, MANAGE_BOTH, MANAGE_REPORT, JOB, allowedPreviewKeys, allowedProfileKeys, api, choose, openBillingSettings, openReportingSettings, previews, profile, puts,
} from './printcfg1.harness';

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { API.reset(); API.profiles = [profile()]; });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const user = () => userEvent.setup();
const section = async () => screen.findByRole('region', { name: /print and stationery/i });
const modes = ['my own letterhead image', 'type my header and footer', 'own pre-?printed pad', 'plain with no header and no footer'];
const radio = (s: HTMLElement, re: RegExp) => within(s).getByRole('radio', { name: re }) as HTMLInputElement;
const header = (s: HTMLElement) => within(s).getByLabelText(/^header/i) as HTMLTextAreaElement;
const footer = (s: HTMLElement) => within(s).getByLabelText(/^footer/i) as HTMLTextAreaElement;
const save = (s: HTMLElement) => within(s).queryByRole('button', { name: /save print settings/i }) as HTMLButtonElement | null;
const lastPut = () => puts().at(-1)!.json as Record<string, unknown>;
const disabled = (e: Element | null) => !!e && ((e as HTMLInputElement).disabled || e.getAttribute('aria-disabled') === 'true' || (e as HTMLInputElement).readOnly);

describe('structure (done_when 1)', () => {
  it('reporting settings: section, three document kind tabs (Reports first), branch picker on Lab default, four plain-word paper modes', async () => {
    await openReportingSettings(MANAGE_BOTH);
    const s = await section();
    expect(within(s).getByRole('heading', { name: /print and stationery/i })).toBeTruthy();
    expect(within(s).getAllByRole('tab').map((t) => t.textContent?.trim())).toEqual(['Reports', 'Bills', 'Credit notes']);
    expect(within(s).getByRole('tab', { name: /^reports$/i, selected: true })).toBeTruthy();
    expect(within(s).getByRole('button', { name: /branch/i }).textContent).toMatch(/lab default/i);
    expect(within(s).getAllByRole('radio').length).toBe(4);
    for (const m of modes) expect(radio(s, new RegExp(m, 'i'))).toBeTruthy();
    expect(within(s).getByRole('switch', { name: /black and white/i })).toBeTruthy();
    expect(within(s).getByRole('button', { name: /font size/i })).toBeTruthy();
  });

  it('billing settings has the same section and opens on Bills', async () => {
    await openBillingSettings(MANAGE_BOTH);
    const s = await section();
    expect(within(s).getAllByRole('tab').map((t) => t.textContent?.trim())).toEqual(['Reports', 'Bills', 'Credit notes']);
    expect(within(s).getByRole('tab', { name: /^bills$/i, selected: true })).toBeTruthy();
  });

  it('loads the stored lab default report profile into the controls', async () => {
    await openReportingSettings();
    const s = await section();
    await waitFor(() => expect(header(s).value).toBe('Synthetic Lab (SYNTHETIC)\nKathmandu'));
    expect(footer(s).value).toBe('Thank you (SYNTHETIC)');
    expect(radio(s, /type my header and footer/i).checked).toBe(true);
    expect(within(s).getAllByText(/\d+ of 8 lines/).map((e) => e.textContent)).toEqual(['2 of 8 lines', '1 of 8 lines']);
  });

  it('a read of the profiles that fails shows an inline error with Retry and does not take the page down', async () => {
    API.listFail = 500;
    await openReportingSettings();
    expect(screen.getByRole('region', { name: /reporting settings/i })).toBeTruthy();
    const s = await section();
    const retry = await within(s).findByRole('button', { name: /retry/i });
    API.listFail = undefined;
    await user().click(retry);
    await waitFor(() => expect(header(s).value).toContain('Synthetic Lab'));
  });
});

describe('header and footer boxes (done_when 1)', () => {
  it('live line counters per box update while typing', async () => {
    const u = user();
    await openReportingSettings();
    const s = await section();
    await waitFor(() => expect(header(s).value).not.toBe(''));
    await u.clear(header(s));
    await u.type(header(s), 'One{Enter}Two{Enter}Three');
    await u.clear(footer(s));
    expect(within(s).getAllByText(/\d+ of 8 lines/).map((e) => e.textContent)).toEqual(['3 of 8 lines', '0 of 8 lines']);
    await u.type(footer(s), 'Only');
    expect(within(s).getAllByText(/\d+ of 8 lines/).map((e) => e.textContent)).toEqual(['3 of 8 lines', '1 of 8 lines']);
  });

  it('nine lines are refused in the browser: message, Save does nothing, no request', async () => {
    const u = user();
    await openReportingSettings();
    const s = await section();
    await waitFor(() => expect(header(s).value).not.toBe(''));
    await u.clear(header(s));
    await u.type(header(s), Array.from({ length: 9 }, (_, i) => `L${i}`).join('{Enter}'));
    expect(within(s).getByText('9 of 8 lines')).toBeTruthy();
    expect(within(s).getByText(/at most 8 lines/i)).toBeTruthy();
    const b = save(s)!;
    if (!disabled(b)) await u.click(b);
    expect(puts().length).toBe(0);
  });

  it('a line of 121 characters is refused in the browser (120 characters per line)', async () => {
    const u = user();
    await openReportingSettings();
    const s = await section();
    await waitFor(() => expect(header(s).value).not.toBe(''));
    await u.clear(footer(s));
    await u.click(footer(s));
    await u.paste('x'.repeat(121));
    expect(within(s).getByText(/120 characters/i)).toBeTruthy();
    const b = save(s)!;
    if (!disabled(b)) await u.click(b);
    expect(puts().length).toBe(0);
  });

  it('exactly 120 characters on each of 8 lines is accepted and sent', async () => {
    const u = user();
    await openReportingSettings();
    const s = await section();
    await waitFor(() => expect(header(s).value).not.toBe(''));
    const text = Array.from({ length: 8 }, () => 'y'.repeat(120)).join('\n');
    await u.clear(header(s));
    await u.click(header(s));
    await u.paste(text);
    await u.click(save(s)!);
    await waitFor(() => expect(puts().length).toBe(1));
    expect(lastPut()['header_text']).toBe(text);
  });

  it('typed text is plain text: & quotes and apostrophes go out verbatim, never escaped or wrapped', async () => {
    const u = user();
    await openReportingSettings();
    const s = await section();
    await waitFor(() => expect(header(s).value).not.toBe(''));
    await u.clear(header(s));
    await u.click(header(s));
    await u.paste('Lab & Sons "Synthetic" O\'Neil 5 > 3'.replace('>', 'over'));
    await u.click(save(s)!);
    await waitFor(() => expect(puts().length).toBe(1));
    expect(lastPut()['header_text']).toBe('Lab & Sons "Synthetic" O\'Neil 5 over 3');
  });

  it('markup characters < and > are refused with a plain-text message and nothing is sent; nothing is injected into the page', async () => {
    const u = user();
    await openReportingSettings();
    const s = await section();
    await waitFor(() => expect(header(s).value).not.toBe(''));
    await u.clear(header(s));
    await u.click(header(s));
    await u.paste('<img src=x onerror=alert(1)>Lab');
    expect(within(s).getByText(/plain text|markup|< or >/i)).toBeTruthy();
    expect(document.querySelector('img[src="x"]')).toBeNull();
    const b = save(s)!;
    if (!disabled(b)) await u.click(b);
    expect(puts().length).toBe(0);
  });
});

describe('paper modes, blank space, black and white, font size (done_when 1)', () => {
  it('pre-printed pad mode: blank top and bottom mm fields are usable; elsewhere they are absent or disabled', async () => {
    const u = user();
    await openReportingSettings();
    const s = await section();
    await waitFor(() => expect(header(s).value).not.toBe(''));
    const field = (re: RegExp) => within(s).queryByLabelText(re) as HTMLInputElement | null;
    expect(!field(/blank space at the top/i) || disabled(field(/blank space at the top/i))).toBe(true);
    await u.click(radio(s, /own pre-?printed pad/i));
    const top = field(/blank space at the top/i)!;
    const bottom = field(/blank space at the bottom/i)!;
    expect(disabled(top)).toBe(false);
    await u.clear(top); await u.type(top, '45');
    await u.clear(bottom); await u.type(bottom, '25');
    await u.click(save(s)!);
    await waitFor(() => expect(puts().length).toBe(1));
    expect(lastPut()).toMatchObject({ document_kind: 'report', paper_mode: 'preprinted_paper', reserve_top_mm: 45, reserve_bottom_mm: 25 });
  });

  it('blank space beyond the contract range (top 0 to 80, bottom 0 to 60 mm) is refused, nothing is sent', async () => {
    const u = user();
    await openReportingSettings();
    const s = await section();
    await waitFor(() => expect(header(s).value).not.toBe(''));
    await u.click(radio(s, /own pre-?printed pad/i));
    const top = within(s).getByLabelText(/blank space at the top/i);
    await u.clear(top); await u.type(top, '81');
    const b = save(s)!;
    if (!disabled(b)) await u.click(b);
    expect(puts().length).toBe(0);
    await u.clear(top); await u.type(top, '80');
    const bottom = within(s).getByLabelText(/blank space at the bottom/i);
    await u.clear(bottom); await u.type(bottom, '61');
    if (!disabled(save(s)!)) await u.click(save(s)!);
    expect(puts().length).toBe(0);
  });

  it('black and white switch and font size picker are saved as grayscale and font_size_pt', async () => {
    const u = user();
    await openReportingSettings();
    const s = await section();
    await waitFor(() => expect(header(s).value).not.toBe(''));
    await u.click(within(s).getByRole('switch', { name: /black and white/i }));
    await choose(u, /font size/i, /^12/);
    await u.click(save(s)!);
    await waitFor(() => expect(puts().length).toBe(1));
    expect(lastPut()).toMatchObject({ grayscale: true, font_size_pt: 12 });
  });

  it('save sends exactly the contract fields of the lab default report profile (no branch_id, no recipient_type) and confirms', async () => {
    const u = user();
    await openReportingSettings();
    const s = await section();
    await waitFor(() => expect(header(s).value).not.toBe(''));
    await u.click(radio(s, /plain with no header and no footer/i));
    await u.click(save(s)!);
    await waitFor(() => expect(puts().length).toBe(1));
    const body = lastPut();
    expect(Object.keys(body).every((k) => allowedProfileKeys.includes(k))).toBe(true);
    expect(body).toMatchObject({ document_kind: 'report', paper_mode: 'plain' });
    expect(body).not.toHaveProperty('branch_id');
    expect(body).not.toHaveProperty('recipient_type');
    expect(await within(document.body).findByText(/saved/i)).toBeTruthy();
  });
});

describe('branch picker and document kind tabs (done_when 1)', () => {
  it('a branch with its own profile loads it; a branch without one says it uses the lab default; save carries branch_id', async () => {
    const u = user();
    API.profiles = [profile(), profile({ id: ID(302), branch_id: BRANCH_A, header_text: 'Kathmandu branch header', footer_text: '' })];
    await openReportingSettings();
    const s = await section();
    await waitFor(() => expect(header(s).value).toContain('Synthetic Lab'));
    await choose(u, /^branch/i, /Kathmandu/);
    await waitFor(() => expect(header(s).value).toBe('Kathmandu branch header'));
    await choose(u, /^branch/i, /Pokhara/);
    expect(await within(s).findByText(/uses the lab default/i)).toBeTruthy();
    await u.click(radio(s, /plain with no header and no footer/i));
    await u.click(save(s)!);
    await waitFor(() => expect(puts().length).toBe(1));
    expect(lastPut()).toMatchObject({ branch_id: BRANCH_B, document_kind: 'report', paper_mode: 'plain' });
  });

  it('Bills and Credit notes tabs edit their own profile and save with their own document_kind', async () => {
    const u = user();
    API.profiles = [profile(), profile({ id: ID(303), document_kind: 'invoice', paper_mode: 'plain', header_text: '', footer_text: '', grayscale: true })];
    await openReportingSettings(MANAGE_BOTH);
    const s = await section();
    await waitFor(() => expect(header(s).value).toContain('Synthetic Lab'));
    await u.click(within(s).getByRole('tab', { name: /^bills$/i }));
    await waitFor(() => expect(radio(s, /plain with no header and no footer/i).checked).toBe(true));
    expect((within(s).getByRole('switch', { name: /black and white/i }) as HTMLInputElement).checked).toBe(true);
    await u.click(radio(s, /type my header and footer/i));
    await u.click(save(s)!);
    await waitFor(() => expect(puts().length).toBe(1));
    expect(lastPut()).toMatchObject({ document_kind: 'invoice', paper_mode: 'typed_header_footer' });
    await u.click(within(s).getByRole('tab', { name: /credit notes/i }));
    await u.click(radio(s, /my own letterhead image/i));
    await u.click(save(s)!);
    await waitFor(() => expect(puts().length).toBe(2));
    expect(lastPut()).toMatchObject({ document_kind: 'credit_note', paper_mode: 'letterhead_image' });
  });

  it('keyboard: arrow keys move between the tabs and Enter on the focused Save button saves', async () => {
    const u = user();
    await openReportingSettings(MANAGE_BOTH);
    const s = await section();
    await waitFor(() => expect(header(s).value).not.toBe(''));
    within(s).getByRole('tab', { name: /^reports$/i }).focus();
    await u.keyboard('{ArrowRight}');
    expect(within(s).getByRole('tab', { name: /^bills$/i, selected: true })).toBeTruthy();
    await u.keyboard('{ArrowLeft}');
    save(s)!.focus();
    await u.keyboard('{Enter}');
    await waitFor(() => expect(puts().length).toBe(1));
  });
});

describe('server errors and permissions (done_when 1)', () => {
  for (const [status, code] of [[400, 'common.validation_failed'], [403, 'auth.forbidden'], [500, 'common.internal']] as const) {
    it(`a ${status} on save shows an alert, keeps what was typed, and a retry can succeed`, async () => {
      const u = user();
      API.putFail = { status, code };
      await openReportingSettings();
      const s = await section();
      await waitFor(() => expect(header(s).value).not.toBe(''));
      await u.clear(header(s));
      await u.type(header(s), 'Kept text');
      await u.click(save(s)!);
      expect((await within(s).findByRole('alert')).textContent?.trim().length).toBeGreaterThan(5);
      expect(header(s).value).toBe('Kept text');
      API.putFail = undefined;
      await u.click(save(s)!);
      await waitFor(() => expect(within(s).queryByRole('alert')).toBeNull());
      expect(lastPut()['header_text']).toBe('Kept text');
    });
  }

  it('reporting-only user: Reports tab editable, Bills and Credit notes tabs read only (no Save, controls disabled, no request)', async () => {
    const u = user();
    await openReportingSettings(MANAGE_REPORT);
    const s = await section();
    await waitFor(() => expect(header(s).value).not.toBe(''));
    expect(save(s)).toBeTruthy();
    for (const tab of [/^bills$/i, /credit notes/i]) {
      await u.click(within(s).getByRole('tab', { name: tab }));
      expect(save(s)).toBeNull();
      for (const r of within(s).getAllByRole('radio')) expect((r as HTMLInputElement).disabled).toBe(true);
      expect(disabled(header(s))).toBe(true);
      expect(disabled(footer(s))).toBe(true);
    }
    expect(puts().length).toBe(0);
  });

  it('finance-only user on billing settings: Bills editable, Reports read only', async () => {
    const u = user();
    await openBillingSettings(MANAGE_BILL);
    const s = await section();
    expect(save(s)).toBeTruthy();
    await u.click(within(s).getByRole('tab', { name: /^reports$/i }));
    expect(save(s)).toBeNull();
    for (const r of within(s).getAllByRole('radio')) expect((r as HTMLInputElement).disabled).toBe(true);
  });

  it('billing settings without billing.settings.manage: read only on every tab, never a PUT', async () => {
    const u = user();
    await openBillingSettings([]);
    const s = await section();
    for (const tab of [/^bills$/i, /credit notes/i, /^reports$/i]) {
      await u.click(within(s).getByRole('tab', { name: tab }));
      expect(save(s)).toBeNull();
      for (const r of within(s).getAllByRole('radio')) expect((r as HTMLInputElement).disabled).toBe(true);
    }
    expect(puts().length).toBe(0);
  });
});

describe('live A4 preview (done_when 1)', () => {
  it('previews on load, then once after a pause (debounced) with the latest text; body has contract fields only and synthetic data only', async () => {
    const u = user();
    API.previewReadyAfter = 1;
    await openReportingSettings();
    const s = await section();
    const region = within(s).getByRole('region', { name: /preview/i });
    await waitFor(() => expect(previews().length).toBeGreaterThanOrEqual(1), { timeout: 4000 });
    expect(within(region).getByText(/preparing preview/i)).toBeTruthy();
    await waitFor(() => expect(region.querySelector('iframe, object, embed, img')).toBeTruthy(), { timeout: 10000 });
    const el = region.querySelector('iframe, object, embed, img')!;
    expect(el.getAttribute('src') ?? el.getAttribute('data') ?? '').toContain(`/reporting/prints/${JOB}/pdf`);

    const before = previews().length;
    await u.clear(header(s));
    await u.type(header(s), 'Hello');
    await waitFor(() => expect(previews().at(-1)!.json.header_text).toBe('Hello'), { timeout: 4000 });
    expect(previews().length - before).toBeLessThanOrEqual(3); // 6 edits, one request per pause
    for (const p of previews()) {
      expect(Object.keys(p.json).every((k) => allowedPreviewKeys.includes(k))).toBe(true);
      expect(p.json).toMatchObject({ document_kind: 'report' });
      expect(p.headers.get('idempotency-key')?.length).toBeGreaterThan(8);
    }
    expect(new Set(previews().map((p) => p.headers.get('idempotency-key'))).size).toBe(previews().length); // a changed draft is a new request
  });

  it('a failed preview shows an alert inside the preview area and the editor keeps working', async () => {
    const u = user();
    API.previewFail = true;
    await openReportingSettings();
    const s = await section();
    const region = within(s).getByRole('region', { name: /preview/i });
    expect(await within(region).findByRole('alert', {}, { timeout: 6000 })).toBeTruthy();
    await u.click(radio(s, /plain with no header and no footer/i));
    await u.click(save(s)!);
    await waitFor(() => expect(puts().length).toBe(1));
  });

  it('the Bills tab previews the invoice kind', async () => {
    const u = user();
    await openReportingSettings(MANAGE_BOTH);
    const s = await section();
    await waitFor(() => expect(previews().length).toBeGreaterThanOrEqual(1), { timeout: 4000 });
    await u.click(within(s).getByRole('tab', { name: /^bills$/i }));
    await waitFor(() => expect(previews().at(-1)!.json.document_kind).toBe('invoice'), { timeout: 4000 });
  });
});
