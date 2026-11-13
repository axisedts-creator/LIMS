// @vitest-environment jsdom
// C14.T20 — SR-04 "Texts" tab (04-UI-UX SR-04 Texts; AC-03.1–AC-03.7 UI side; 07-SECURITY REQ 088/089 + AB-9: staff web renders block text as text nodes only).
// done_when: "placeholder chips". ASSUMED contract (same page/shell as sr-t20.editor.test.tsx):
//   * Texts tab: blocks grouped under headings Findings (deranged) / Advice / Follow-up / Disclaimer / Score explanation (empty group: "No blocks yet"); each row shows block_key and the
//     text of the library language as TEXT. Buttons "Add text" (new) and per-row "Edit" / "Remove" (ConfirmDialog -> DELETE with If-Match "<version>", then router.refresh()).
//   * Editor = Drawer/Dialog with kit Form fields: Key (textbox, immutable after create) · Kind (Select, immutable after create) · English text (textarea, showCount) · Nepali text (textarea lang="ne")
//     · Author note. Allowed-placeholder chips (buttons named "{name}") for the selected kind; clicking one inserts "{name}" into the English text (the Nepali one when it is the focused text).
//     Chips per kind are exactly services/api/.../domain/placeholders.ts ALLOWED_PLACEHOLDERS; disclaimer / score_explanation have none.
//   * Live client checks (field error text, no request): digits ASCII or Devanagari (/digit|number/), unknown placeholder (/placeholder/ + the name), > 600 chars (/600/), a link / URL (/link|web address|url/).
//     Required: English text when the library language is English, Nepali text when Nepali (/required/). Key pattern ^[a-z][a-z0-9_.]{2,79}$.
//   * Create = POST #6 with Idempotency-Key, body {block_key, kind, text_en?, text_ne?, note?}; Edit = PUT #7 with If-Match "<block version>". Server `placeholders[]` of the response is not re-derived.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  BLOCKS, BLOCK_DERANGED, MANAGE, VER_APPROVED, VER_DRAFT, api, axeClean, blockDto, bodyOf, callsTo, json, mountEditorApi, norm, pageText, pick, problem, resetApi, router, routes, showEditor, versionDto, vp,
} from './sr-t20.harness';

vi.mock('next/navigation', async () => (await import('./sr-t20.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./sr-t20.harness')).sessionMock);

const B = vp(VER_DRAFT, '/blocks');
const CHIPS: Record<string, string[]> = {
  deranged: ['analyte_name', 'value', 'unit', 'ref_range', 'group_name'], advice: ['analyte_name', 'group_name'], followup: ['test_name', 'interval_days', 'group_name', 'analyte_name'], disclaimer: [], score_explanation: [],
};
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { resetApi(MANAGE); mountEditorApi(); routes[`POST ${B}`] = json(blockDto({ id: '01940e00-0000-7000-8000-000000000099', block_key: 'deranged.new.key' }), 201); });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const openTexts = async () => { await showEditor(); await userEvent.click(screen.getByRole('tab', { name: 'Texts' })); };
const openAdd = async () => { await openTexts(); await userEvent.click(screen.getByRole('button', { name: /add text/i })); return screen.findByRole('dialog'); };
const en = (d: HTMLElement) => within(d).getByRole('textbox', { name: /english text/i }) as HTMLTextAreaElement;
const key = (d: HTMLElement) => within(d).getByRole('textbox', { name: /^key/i }) as HTMLInputElement;
const chipNames = (d: HTMLElement) => within(d).queryAllByRole('button', { name: /^\{[a-z_]+\}$/ }).map((b) => norm(b.textContent));
const saveBtn = (d: HTMLElement) => within(d).getByRole('button', { name: /^(save|create|add)/i });
async function fillValid(d: HTMLElement, text = 'This is above the usual range.') {
  await userEvent.type(key(d), 'deranged.new.key');
  await pick(/kind/i, /findings|deranged/i);
  await userEvent.clear(en(d)); await userEvent.type(en(d), text);
}

describe('list grouped by kind', () => {
  it('shows the five kind headings, block keys and text as text; empty groups say "No blocks yet"', async () => {
    await openTexts();
    for (const h of ['Findings', 'Advice', 'Follow-up', 'Disclaimer', 'Score explanation']) expect(screen.getByRole('heading', { name: new RegExp(h, 'i') })).toBeTruthy();
    expect(pageText()).toContain('deranged.alt.high');
    expect(pageText()).toContain('{analyte_name} is above the reference range of your laboratory.');
    expect(pageText()).toMatch(/no blocks yet/i);
  });

  it('XSS corpus: <script> / <img onerror> in block text and note is inert text (AB-9)', async () => {
    const evil = '<img src=x onerror=alert(1)><script>alert(2)</script><a href="javascript:alert(3)">x</a>';
    mountEditorApi(VER_DRAFT, versionDto(), { blocks: [blockDto({ text_en: evil, note: evil, placeholders: [] })] });
    const { container } = await (async () => { await openTexts(); return { container: document.body }; })();
    expect(container.querySelector('script, img, a[href^="javascript"]')).toBeNull();
    expect(pageText()).toContain('<img src=x onerror=alert(1)>');
    await userEvent.click(screen.getByRole('button', { name: /^edit/i }));
    const d = await screen.findByRole('dialog');
    expect(en(d).value).toBe(evil);
    expect(d.querySelector('script, img')).toBeNull();
  });

  it('axe-clean with the editor open', async () => { await openAdd(); await axeClean(); });
});

describe('placeholder chips (done_when; AC-03.1, AC-03.4)', () => {
  it.each(Object.keys(CHIPS))('kind %s offers exactly its allowed placeholders', async (kind) => {
    const d = await openAdd();
    await pick(/kind/i, new RegExp(kind === 'deranged' ? 'findings|deranged' : kind.replace('_', '[ _]'), 'i'));
    expect(chipNames(d).sort()).toEqual(CHIPS[kind]!.map((n) => `{${n}}`).sort());
  });

  it('clicking a chip inserts {name} into the English text, keeping what was typed', async () => {
    const d = await openAdd();
    await pick(/kind/i, /findings|deranged/i);
    await userEvent.type(en(d), 'High ');
    await userEvent.click(within(d).getByRole('button', { name: '{analyte_name}' }));
    expect(en(d).value).toContain('{analyte_name}');
    expect(en(d).value.startsWith('High ')).toBe(true);
  });

  it('chips are keyboard operable (buttons, in the tab order)', async () => {
    const d = await openAdd();
    await pick(/kind/i, /advice/i);
    const chip = within(d).getByRole('button', { name: '{group_name}' });
    chip.focus(); await userEvent.keyboard('{Enter}');
    expect(en(d).value).toContain('{group_name}');
  });
});

describe('live client checks mirror the server (AC-03.2, AC-03.3, AC-03.4)', () => {
  it.each([
    ['ASCII digit', 'Value is 5 above range', /digit|number/i],
    ['Devanagari digit', 'मान ५ भन्दा माथि', /digit|number/i],
    ['unknown placeholder {dose}', 'Take {{dose} daily', /placeholder.*dose|dose.*placeholder|\{dose\}/i],
    ['placeholder not allowed for the kind ({test_name} in a finding)', '{{test_name} is high', /placeholder/i],
    ['link', 'See http://example.org for more', /link|web address|url/i],
  ])('%s -> field error, no POST', async (_n, text, re) => {
    const d = await openAdd();
    await fillValid(d, text);
    await userEvent.click(saveBtn(d));
    await waitFor(() => expect(d.textContent).toMatch(re));
    expect(callsTo('POST', B)).toHaveLength(0);
  });

  it('> 600 characters -> error mentioning 600, no POST (AC-03.2)', async () => {
    const d = await openAdd();
    await userEvent.type(key(d), 'deranged.long.text');
    await pick(/kind/i, /findings|deranged/i);
    await userEvent.click(en(d)); await userEvent.paste('a'.repeat(601));
    await userEvent.click(saveBtn(d));
    await waitFor(() => expect(d.textContent).toMatch(/600/));
    expect(callsTo('POST', B)).toHaveLength(0);
  });

  it('English library: English text is required; the key must match the pattern', async () => {
    const d = await openAdd();
    await userEvent.type(key(d), 'Bad Key!');
    await pick(/kind/i, /advice/i);
    await userEvent.click(saveBtn(d));
    await waitFor(() => expect(d.textContent).toMatch(/required|invalid|pattern|lowercase/i));
    expect(callsTo('POST', B)).toHaveLength(0);
  });

  it('the Nepali text area is lang="ne"; it is required (and English is not) when the library language is Nepali', async () => {
    mountEditorApi(VER_DRAFT, versionDto({ language: 'ne' }));
    const d = await openAdd();
    const ne = within(d).getByRole('textbox', { name: /nepali text/i });
    expect(ne.getAttribute('lang')).toBe('ne');
    await userEvent.type(key(d), 'advice.ne.test');
    await pick(/kind/i, /advice/i);
    await userEvent.click(saveBtn(d));
    await waitFor(() => expect(d.textContent).toMatch(/required/i));
    expect(callsTo('POST', B)).toHaveLength(0);
    await userEvent.type(ne, 'कृपया डाक्टरसँग सल्लाह लिनुहोस्।');
    await userEvent.click(saveBtn(d));
    await waitFor(() => expect(callsTo('POST', B)).toHaveLength(1));
    expect(bodyOf(callsTo('POST', B)[0]).text_ne).toBe('कृपया डाक्टरसँग सल्लाह लिनुहोस्।');
  });
});

describe('create / edit / remove (AC-03.1, AC-03.7)', () => {
  it('create POSTs {block_key, kind, text_en} with an Idempotency-Key, then refreshes', async () => {
    const d = await openAdd();
    await fillValid(d, '{{analyte_name} is above the reference range of your laboratory.');
    await userEvent.click(saveBtn(d));
    await waitFor(() => expect(callsTo('POST', B)).toHaveLength(1));
    const c = callsTo('POST', B)[0]!;
    expect(bodyOf(c)).toMatchObject({ block_key: 'deranged.new.key', kind: 'deranged', text_en: '{analyte_name} is above the reference range of your laboratory.' });
    expect(Object.keys(bodyOf(c)).every((k) => ['block_key', 'kind', 'text_en', 'text_ne', 'note'].includes(k))).toBe(true);
    expect(c.headers.get('idempotency-key')).toMatch(/\S{8,}/);
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
  });

  it('edit: key and kind are immutable; PUT carries If-Match "<block version>" and the new text', async () => {
    routes[`PUT ${B}/${BLOCK_DERANGED}`] = json(blockDto({ version: 3 }));
    await openTexts();
    const row = screen.getByText('deranged.alt.high').closest('tr, li, [role="row"]') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: /^edit/i }));
    const d = await screen.findByRole('dialog');
    expect((key(d) as HTMLInputElement).readOnly || key(d).disabled).toBe(true);
    await userEvent.clear(en(d)); await userEvent.type(en(d), 'Higher than your laboratory range.');
    await userEvent.click(saveBtn(d));
    await waitFor(() => expect(callsTo('PUT', `${B}/${BLOCK_DERANGED}`)).toHaveLength(1));
    const p = callsTo('PUT', `${B}/${BLOCK_DERANGED}`)[0]!;
    expect(p.headers.get('if-match')).toBe('"2"');
    expect(bodyOf(p).text_en).toBe('Higher than your laboratory range.');
    expect(bodyOf(p)).toMatchObject({ block_key: 'deranged.alt.high', kind: 'deranged' });
  });

  it('remove asks for confirmation, then DELETEs with If-Match (deactivation) and refreshes', async () => {
    routes[`DELETE ${B}/${BLOCK_DERANGED}`] = () => new Response(null, { status: 204 });
    await openTexts();
    const row = screen.getByText('deranged.alt.high').closest('tr, li, [role="row"]') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: /^(remove|delete|deactivate)/i }));
    expect(callsTo('DELETE', `${B}/${BLOCK_DERANGED}`)).toHaveLength(0);
    await userEvent.click(within(await screen.findByRole('alertdialog').catch(() => screen.findByRole('dialog'))).getByRole('button', { name: /^(remove|delete|deactivate|confirm|yes)/i }));
    await waitFor(() => expect(callsTo('DELETE', `${B}/${BLOCK_DERANGED}`)).toHaveLength(1));
    expect(callsTo('DELETE', `${B}/${BLOCK_DERANGED}`)[0]!.headers.get('if-match')).toBe('"2"');
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
  });

  it('server 409 library_invalid_transition on create -> "This version is no longer a draft."', async () => {
    routes[`POST ${B}`] = () => problem('smartreport.library_invalid_transition', 409);
    const d = await openAdd();
    await fillValid(d);
    await userEvent.click(saveBtn(d));
    await waitFor(() => expect(pageText()).toContain('This version is no longer a draft.'));
  });

  it('server 400 on /text_en (e.g. NFC / length) is shown at the field', async () => {
    routes[`POST ${B}`] = () => problem('common.validation_failed', 400, { errors: [{ path: '/text_en', code: 'too_long', detail: 'text is too long' }] });
    const d = await openAdd();
    await fillValid(d);
    await userEvent.click(saveBtn(d));
    await waitFor(() => expect(d.textContent).toMatch(/too long/i));
  });

  it('on a non-draft version the Texts tab has no add/edit/remove controls (AC-03.6 UI side)', async () => {
    mountEditorApi(VER_APPROVED, versionDto({ id: VER_APPROVED, status: 'approved' }));
    await showEditor(VER_APPROVED);
    await userEvent.click(screen.getByRole('tab', { name: 'Texts' }));
    expect(screen.queryByRole('button', { name: /add text|^edit|^remove/i })).toBeNull();
    expect(pageText()).toContain('deranged.alt.high');
    expect(BLOCKS.length).toBeGreaterThan(0);
  });
});
