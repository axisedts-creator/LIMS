// @vitest-environment jsdom
// C10.T-20 — culture page, tab "Reads & stains": observation Timeline + observation dialog (04-UI-UX §3.2; 03-APP-FLOW §4.4;
// AC-04.1 … AC-04.5 (UI side); REQ-SEC-088 free text as text nodes; S-05 strict body). The UI never decides culture state: it posts and refreshes.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { http, HttpResponse } from 'msw';
import { ToastProvider } from '@lims/ui/components/Toast';
import { HOURS_AGO, ID, ORIGIN, PERM_WORK, api, dialog, hit, incubating, lastHit, localText, obs, pick, plate, problem, resetHits, router, rowAction, state, typeDate } from './t20.harness';

vi.mock('next/navigation', async () => (await import('./t20.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t20.harness')).sessionMock);

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { resetHits(); router.refresh.mockReset(); state.permissions = PERM_WORK; });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const mount = async (c: Record<string, unknown> = incubating()) => {
  const { CultureScreen } = await import('../components/culture/CultureScreen');
  const r = render(<ToastProvider><CultureScreen culture={c as never} patient={{ name: 'Synthetic Patient One' }} specimen={null} permissions={PERM_WORK} /></ToastProvider>);
  await userEvent.click(screen.getByRole('tab', { name: /^reads & stains/i }));
  return r;
};
const btn = (n: RegExp) => screen.queryAllByRole('button', { name: n })[0];
const posts = () => hit('POST', /\/observations$/);
const save = (d: HTMLElement) => userEvent.click(within(d).getByRole('button', { name: /^save$/i }));
const type = (d: HTMLElement) => (name: RegExp) => within(d).getByRole('radio', { name });
const openRead = async () => { if (screen.queryAllByRole('tab').length === 0) await mount(); await userEvent.click(btn(/^record read$/i)!); return dialog(/observation|record read|plate read/i); };
const openStain = async () => { if (screen.queryAllByRole('tab').length === 0) await mount(); await userEvent.click(btn(/record (gram )?stain/i)!); return dialog(/observation|record stain|stain/i); };

describe('timeline (04-UI-UX §3.2)', () => {
  const list = [
    obs(1, { observed_at: HOURS_AGO(20), hours_since_planting: 10, recorded_by_display: 'Synthetic Tech One' }),
    obs(2, { kind: 'gram_stain', plate_id: undefined, growth_code: undefined, quantity_text: undefined, finding_text: 'Line one\nLine two', observed_at: HOURS_AGO(5), hours_since_planting: 25, recorded_by_display: 'Synthetic Tech Two' }),
  ];
  it('newest first; "{kind} · plate {n} · {growth} · {quantity}", actor, time, "{h} h after planting"', async () => {
    await mount(incubating({ observations: list }));
    const items = await screen.findAllByRole('listitem');
    const texts = items.map((i) => i.textContent ?? '');
    const iStain = texts.findIndex((t) => /Gram stain/.test(t));
    const iRead = texts.findIndex((t) => /Plate read/.test(t));
    expect(iStain).toBeGreaterThanOrEqual(0);
    expect(iRead).toBeGreaterThan(iStain);
    await waitFor(() => expect(texts[iRead]).toBeDefined());
    await waitFor(() => expect(document.body.textContent).toMatch(/Plate read · plate 1 · Synthetic growth · ≥10\^5 CFU\/mL/));
    expect(document.body.textContent).toContain('Synthetic Tech One');
    expect(document.body.textContent).toMatch(/10 h after planting/);
    expect(document.body.textContent).toMatch(/25 h after planting/);
  });
  it('finding text is a text node with line breaks preserved (pre-wrap), never HTML (REQ-SEC-088)', async () => {
    await mount(incubating({ observations: [obs(1, { kind: 'microscopy', finding_text: '<img src=x onerror="window.__x=1"><b>bold</b>\nsecond line' })] }));
    expect(document.querySelector('img[onerror]')).toBeNull();
    expect(document.querySelector('b')).toBeNull();
    const el = await screen.findByText(/second line/);
    expect(el.textContent).toContain('<b>bold</b>');
    expect(el.textContent).toContain('\n');
    expect((el as HTMLElement).className + el.parentElement!.className).toMatch(/pre|wrap|finding/i); // styling is by kit class, never an inline style (LD-140)
    expect((window as any).__x).toBeUndefined();
  });
  it('AC-04.4: a corrected observation is struck through with a "Corrected" badge; the correcting one is not', async () => {
    await mount(incubating({ observations: [obs(1, { is_corrected: true, finding_text: 'old wording' }), obs(2, { corrects_observation_id: ID(201), finding_text: 'new wording', kind: 'other', growth_code: undefined, plate_id: undefined })] }));
    const old = (await screen.findByText(/old wording/)).closest('li')!;
    expect(within(old).getByText(/^corrected$/i)).toBeTruthy();
    expect(old.querySelector('s, del, [class*="strike"], [class*="corrected"], [class*="line-through"]'), 'strikethrough').toBeTruthy();
    const fresh = screen.getByText(/new wording/).closest('li')!;
    expect(within(fresh).queryByText(/^corrected$/i)).toBeNull();
  });
  it('AC-04.4: "Correct" opens the dialog for a new observation carrying corrects_observation_id; a corrected entry cannot be corrected again; nothing edits in place', async () => {
    await mount(incubating({ observations: [obs(1, { is_corrected: true }), obs(2, { kind: 'other', plate_id: undefined, growth_code: undefined, finding_text: 'to be corrected', quantity_text: undefined })] }));
    const corrected = (await screen.findByText(/Corrected/)).closest('li')!;
    expect(within(corrected).queryByRole('button', { name: /^correct$/i })).toBeNull();
    const li = screen.getByText(/to be corrected/).closest('li')!;
    await userEvent.click(within(li).getByRole('button', { name: /^correct$/i }));
    const d = await dialog(/observation|correct/i);
    const finding = within(d).getByRole('textbox', { name: /finding/i }) as HTMLTextAreaElement;
    await userEvent.clear(finding);
    await userEvent.type(finding, 'corrected wording');
    await save(d);
    const h = await lastHit('POST', /\/observations$/);
    expect(h.json.corrects_observation_id).toBe(ID(202));
    expect(h.json.finding_text).toBe('corrected wording');
    expect(hit('PUT', /observations/)).toHaveLength(0);
    expect(hit('PATCH', /observations/)).toHaveLength(0);
  });
  it('empty state', async () => {
    await mount(incubating({ observations: [] }));
    expect(document.body.textContent).toMatch(/no (reads|observations)|nothing recorded/i);
  });
});

describe('observation dialog fields (04-UI-UX §3.2)', () => {
  it('Type is a RadioGroup Plate read / Gram stain / Microscopy / Other; "Record read" preselects Plate read, "Record stain / microscopy" preselects a stain type', async () => {
    const d = await openRead();
    expect(within(d).getAllByRole('radio').map((r) => (r as HTMLInputElement).labels?.[0]?.textContent?.trim())).toEqual(['Plate read', 'Gram stain', 'Microscopy', 'Other']);
    expect((type(d)(/plate read/i) as HTMLInputElement).checked).toBe(true);
    await userEvent.click(within(d).getByRole('button', { name: /^cancel$/i }));
    const s = await openStain();
    expect((type(s)(/plate read/i) as HTMLInputElement).checked).toBe(false);
    expect([/gram stain/i, /microscopy/i].some((n) => (type(s)(n) as HTMLInputElement).checked)).toBe(true);
  });
  it('Plate read shows Plate (active plates only) and Growth (active codes only); a stain shows Finding instead and no Growth', async () => {
    await mount(incubating({ plates: [plate(1), plate(2), plate(3, { status: 'discarded' })] }));
    const d = await openRead();
    await userEvent.click(within(d).getByRole('button', { name: /^plate/i }));
    const plates = (await screen.findAllByRole('option')).map((o) => o.textContent ?? '');
    expect(plates).toHaveLength(2);
    expect(plates.join('|')).not.toMatch(/\b3\b/);
    await userEvent.keyboard('{Escape}');
    expect(within(d).getByRole('button', { name: /growth/i })).toBeTruthy();
    await userEvent.click(type(d)(/gram stain/i));
    expect(within(d).queryByRole('button', { name: /growth/i })).toBeNull();
    const finding = within(d).getByRole('textbox', { name: /finding/i }) as HTMLTextAreaElement;
    expect(finding.maxLength).toBe(2000);
    expect(finding.rows).toBe(4);
  });
  it('Quantity is limited to 80 characters; Observed at defaults to now', async () => {
    const d = await openRead();
    expect((within(d).getByRole('textbox', { name: /quantity/i }) as HTMLInputElement).maxLength).toBe(80);
    expect([localText(new Date()), localText(new Date(Date.now() - 60_000))]).toContain((within(d).getByRole('textbox', { name: /observed at/i }) as HTMLInputElement).value);
  });
});

describe('recording (AC-04.1, AC-04.2, AC-04.3)', () => {
  it('plate read: POST /observations with Idempotency-Key and only the declared fields; success toast; culture refreshed (the server moves the state, AC-04.1)', async () => {
    const d = await openRead();
    await pick(d, /^plate/i, /1/);
    await pick(d, /growth/i, /^synthetic growth$/i);
    await userEvent.type(within(d).getByRole('textbox', { name: /quantity/i }), '≥10^5 CFU/mL');
    await save(d);
    const h = await lastHit('POST', /\/observations$/);
    expect(h.path).toBe(`/v1/micro/cultures/${ID(1)}/observations`);
    expect(h.headers.get('idempotency-key')).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(h.json).toMatchObject({ kind: 'plate_read', plate_id: ID(101), growth_code: 'synthetic_growth', quantity_text: '≥10^5 CFU/mL' });
    expect(Object.keys(h.json).every((k) => ['kind', 'plate_id', 'growth_code', 'quantity_text', 'finding_text', 'observed_at', 'corrects_observation_id'].includes(k))).toBe(true);
    expect(Math.abs(Date.parse(h.json.observed_at) - Date.now())).toBeLessThan(3 * 60_000);
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
    expect(await screen.findByText(/(read|observation) (recorded|saved)/i)).toBeTruthy();
  });
  it('AC-04.2: "no growth" is sent as that code; empty optional fields are omitted, not sent as ""', async () => {
    const d = await openRead();
    await pick(d, /^plate/i, /1/);
    await pick(d, /growth/i, /^no growth$/i);
    await save(d);
    const h = await lastHit('POST', /\/observations$/);
    expect(h.json.growth_code).toBe('no_growth');
    expect('quantity_text' in h.json).toBe(false);
    expect('finding_text' in h.json).toBe(false);
  });
  it('plate read without plate or growth is refused inline; nothing is sent', async () => {
    const d = await openRead();
    await save(d);
    expect(posts()).toHaveLength(0);
    await pick(d, /^plate/i, /1/);
    await save(d);
    expect(posts()).toHaveLength(0);
    expect(d.textContent).toMatch(/growth.*(required|choose|select)|(required|choose|select).*growth/i);
  });
  it.each([['Gram stain', /gram stain/i, 'gram_stain'], ['Microscopy', /^microscopy$/i, 'microscopy'], ['Other', /^other$/i, 'other']])('AC-04.3: %s needs a finding (1..2000); empty and whitespace-only are refused; a good one is sent as finding_text', async (_n, radio, kind) => {
    const d = await openRead();
    await userEvent.click(type(d)(radio));
    await save(d);
    expect(posts()).toHaveLength(0);
    const finding = within(d).getByRole('textbox', { name: /finding/i });
    await userEvent.type(finding, '   ');
    await save(d);
    expect(posts()).toHaveLength(0);
    expect(d.textContent).toMatch(/finding.*(required|enter)|(required|enter).*finding/i);
    await userEvent.clear(finding);
    await userEvent.type(finding, 'Synthetic gram-negative rods{Enter}second line');
    await save(d);
    const h = await lastHit('POST', /\/observations$/);
    expect(h.json.kind).toBe(kind);
    expect(h.json.finding_text).toBe('Synthetic gram-negative rods\nsecond line');
    expect('growth_code' in h.json).toBe(false);
  });
  it('a stain does not send the plate of a previously chosen plate read (no stale hidden fields)', async () => {
    const d = await openRead();
    await pick(d, /^plate/i, /1/);
    await pick(d, /growth/i, /^synthetic growth$/i);
    await userEvent.click(type(d)(/gram stain/i));
    await userEvent.type(within(d).getByRole('textbox', { name: /finding/i }), 'Synthetic finding');
    await save(d);
    const h = await lastHit('POST', /\/observations$/);
    expect('growth_code' in h.json).toBe(false);
  });
  it('observed at in the future is refused; for a plate read it may not be before the planting time', async () => {
    const d = await openRead();
    await pick(d, /^plate/i, /1/);
    await pick(d, /growth/i, /^no growth$/i);
    const at = within(d).getByRole('textbox', { name: /observed at/i });
    await typeDate(at, new Date(Date.now() + 3 * 3600_000));
    await save(d);
    expect(posts()).toHaveLength(0);
    expect(at.getAttribute('aria-invalid')).toBe('true');
    await typeDate(at, new Date(Date.now() - 60 * 3600_000)); // planted 30 h ago
    await save(d);
    expect(posts()).toHaveLength(0);
    expect(at.getAttribute('aria-invalid')).toBe('true');
  });
  it('a double click on Save sends one request', async () => {
    api.use(http.post(`${ORIGIN}/v1/micro/cultures/:id/observations`, async () => { await new Promise((r) => setTimeout(r, 150)); return HttpResponse.json(obs(2)); }));
    const d = await openRead();
    await pick(d, /^plate/i, /1/);
    await pick(d, /growth/i, /^no growth$/i);
    await userEvent.dblClick(within(d).getByRole('button', { name: /^save$/i }));
    await new Promise((r) => setTimeout(r, 400));
    expect(posts()).toHaveLength(1);
  });
});

describe('server refusals (AC-04.5; 04-UI-UX §10)', () => {
  const attempt = async () => {
    const d = await openStain();
    await userEvent.type(within(d).getByRole('textbox', { name: /finding/i }), 'Synthetic finding');
    await save(d);
    return d;
  };
  it('409 micro.report_final_locked -> "The final report has been sent. Reopen the culture to make changes."', async () => {
    api.use(http.post(`${ORIGIN}/v1/micro/cultures/:id/observations`, () => problem('micro.report_final_locked', 409)));
    await mount();
    await attempt();
    expect(await screen.findByText('The final report has been sent. Reopen the culture to make changes.')).toBeTruthy();
  });
  it('409 micro.culture_invalid_transition -> "This culture has changed. Reload to see its current state." (cancelled culture)', async () => {
    api.use(http.post(`${ORIGIN}/v1/micro/cultures/:id/observations`, () => problem('micro.culture_invalid_transition', 409)));
    await mount();
    await attempt();
    expect(await screen.findByText('This culture has changed. Reload to see its current state.')).toBeTruthy();
  });
  it('the dialog keeps what was typed after a refusal; no problem JSON or stack is shown', async () => {
    api.use(http.post(`${ORIGIN}/v1/micro/cultures/:id/observations`, () => problem('micro.report_final_locked', 409, { detail: 'secret-internal' })));
    await mount();
    const d = await attempt();
    await screen.findByText(/final report has been sent/i);
    expect((within(d).getByRole('textbox', { name: /finding/i }) as HTMLTextAreaElement).value).toBe('Synthetic finding');
    expect(document.body.textContent).not.toContain('secret-internal');
  });
  it('final_submitted and cancelled cultures offer no recording buttons or Correct actions', async () => {
    for (const status of ['final_submitted', 'cancelled']) {
      cleanup();
      await mount(incubating({ status, observations: [obs(1)] }));
      expect(btn(/^record read$/i)).toBeUndefined();
      expect(btn(/record (gram )?stain/i)).toBeUndefined();
      expect(screen.queryByRole('button', { name: /^correct$/i })).toBeNull();
    }
  });
});

describe('accessibility (axe)', () => {
  const run = async (el: HTMLElement) => (await axe.run(el, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } })).violations.map((v) => `${v.id}: ${v.help}`);
  it('timeline with a corrected entry', async () => {
    await mount(incubating({ observations: [obs(1, { is_corrected: true }), obs(2, { corrects_observation_id: ID(201) })] }));
    expect(await run(document.body)).toEqual([]);
  });
  it('observation dialog', async () => {
    const d = await openRead();
    expect(await run(d)).toEqual([]);
  });
});
void rowAction;
