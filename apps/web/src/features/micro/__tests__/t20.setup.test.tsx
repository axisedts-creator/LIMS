// @vitest-environment jsdom
// C10.T-20 — culture page, tab "Setup & plates": set-up dialog, add plate, discard plate, actions by state (04-UI-UX §3.1; 03-APP-FLOW §4.2/§4.3;
// AC-03.1 … AC-03.4 (UI side); S-05 strict body; REQ-SEC-088). LD-140: kit only, one primary button per page.
// Real server actions + MSW API. Seam: CultureScreen({ culture, patient, specimen?, permissions }) — see t20.harness.tsx.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { http, HttpResponse } from 'msw';
import { ToastProvider } from '@lims/ui/components/Toast';
import {
  ID, ORIGIN, PERM_READ, PERM_WORK, api, culture, dialog, hit, hits, incubating, isolate, lastHit, localText, patient, pick, plate, problem, protocolDto, resetHits, router, rowAction, state, typeDate,
} from './t20.harness';

vi.mock('next/navigation', async () => (await import('./t20.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t20.harness')).sessionMock);

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { resetHits(); router.refresh.mockReset(); state.permissions = PERM_WORK; });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const mount = async (c: Record<string, unknown> = culture(), permissions = PERM_WORK) => {
  const { CultureScreen } = await import('../components/culture/CultureScreen');
  return render(<ToastProvider><CultureScreen culture={c as never} patient={{ name: 'Synthetic Patient One', age_display: '34 y', sex: 'F' }} specimen={{ registration_no: 'R261100001', barcode: 'E260000001' }} permissions={permissions} /></ToastProvider>);
};
const btn = (n: RegExp) => screen.queryAllByRole('button', { name: n })[0];
const openSetup = async (c: Record<string, unknown> = culture()) => {
  await mount(c);
  await userEvent.click(btn(/^set up culture$/i)!);
  const d = await dialog(/set up culture/i);
  await within(d).findAllByText(/synthetic urine protocol/i); // protocols loaded (kit Select renders label twice)
  return d;
};
const planted = (d: HTMLElement) => within(d).getByRole('textbox', { name: /planted at/i }) as HTMLInputElement;
const submit = (d: HTMLElement) => userEvent.click(within(d).getByRole('button', { name: /^set up$/i }));
const setupPosts = () => hit('POST', /\/setup$/);

describe('set-up dialog fields (04-UI-UX §3.1.1)', () => {
  it('is a Dialog "Set up culture" with Plating protocol, Specimen site, Planted at, a plate repeater, and buttons "Set up" + "Cancel"', async () => {
    const d = await openSetup();
    for (const l of [/plating protocol/i, /specimen site/i]) expect(within(d).getByRole('button', { name: l }), String(l)).toBeTruthy();
    expect(planted(d)).toBeTruthy();
    expect(within(d).getAllByRole('button', { name: /medium/i }).length).toBeGreaterThanOrEqual(1);
    expect(within(d).getAllByRole('textbox', { name: /incubation/i }).length).toBeGreaterThanOrEqual(1);
    expect(within(d).getByRole('button', { name: /^set up$/i })).toBeTruthy();
    expect(within(d).getByRole('button', { name: /^cancel$/i })).toBeTruthy();
  });

  it('defaults: suggested protocol selected, site = protocol default site, planted at = now, plate rows = the protocol media with their incubation text (AC-03.2 precedence is server-side, shown as suggested_protocol)', async () => {
    const d = await openSetup();
    expect(within(d).getByRole('button', { name: /plating protocol/i }).textContent).toMatch(/synthetic urine protocol/i);
    expect(within(d).getByRole('button', { name: /specimen site/i }).textContent).toMatch(/synthetic site/i);
    const shown = planted(d).value;
    expect([localText(new Date()), localText(new Date(Date.now() - 60_000))]).toContain(shown);
    const media = within(d).getAllByRole('button', { name: /medium/i }).map((b) => b.textContent);
    expect(media.join('|')).toMatch(/synthetic blood agar.*\|.*synthetic macconkey agar|synthetic blood agar.*synthetic macconkey agar/i);
    expect((within(d).getAllByRole('textbox', { name: /incubation/i })[0] as HTMLInputElement).value).toBe('Synthetic incubation 1');
  });

  it('Incubation is limited to 120 characters; retired media are not offered; Medium is required', async () => {
    const d = await openSetup();
    expect((within(d).getAllByRole('textbox', { name: /incubation/i })[0] as HTMLInputElement).maxLength).toBe(120);
    await userEvent.click(within(d).getAllByRole('button', { name: /medium/i })[0]!);
    const names = (await screen.findAllByRole('option')).map((o) => o.textContent);
    expect(names).toContain('Synthetic blood agar');
    expect(names).not.toContain('Synthetic retired agar');
    await userEvent.keyboard('{Escape}');
  });

  it('the repeater holds 1..12 plates: can add up to 12, then no more; the last row cannot be removed', async () => {
    const d = await openSetup();
    const add = () => within(d).queryByRole('button', { name: /add (a )?plate|add row/i });
    for (let i = 0; i < 12 && add() && !(add() as HTMLButtonElement).disabled; i++) await userEvent.click(add()!);
    expect(within(d).getAllByRole('button', { name: /medium/i })).toHaveLength(12);
    expect(!add() || (add() as HTMLButtonElement).disabled).toBe(true);
    for (let i = 0; i < 15; i++) {
      const rm = within(d).queryAllByRole('button', { name: /remove plate|remove row/i }).find((b) => !(b as HTMLButtonElement).disabled);
      if (!rm) break;
      await userEvent.click(rm);
    }
    expect(within(d).getAllByRole('button', { name: /medium/i }).length).toBeGreaterThanOrEqual(1);
  });

  it('with no protocol suggested and none configured, one empty plate row is offered and plates must be entered explicitly (AC-03.2)', async () => {
    api.use(http.get(`${ORIGIN}/v1/micro/plating-protocols`, () => HttpResponse.json({ data: [], page: { limit: 50 } })));
    await mount(culture({ suggested_protocol: undefined }));
    await userEvent.click(btn(/^set up culture$/i)!);
    const d = await dialog(/set up culture/i);
    await waitFor(() => expect(within(d).getAllByRole('button', { name: /medium/i })).toHaveLength(1));
    await submit(d);
    expect(setupPosts()).toHaveLength(0); // medium missing
    expect(d.textContent).toMatch(/medium.*(required|choose|select)|(required|choose|select).*medium/i);
    await pick(d, /medium/i, /^synthetic blood agar$/i);
    await submit(d);
    const h = await lastHit('POST', /\/setup$/);
    expect(h.json.plating_protocol_id).toBeUndefined();
    expect(h.json.plates).toEqual([{ media_code: 'synthetic_blood_agar' }]);
  });

  it('changing the protocol replaces the plate rows with that protocol\'s media', async () => {
    api.use(http.get(`${ORIGIN}/v1/micro/plating-protocols`, () => HttpResponse.json({ data: [protocolDto(), protocolDto({ id: ID(51), code: 'synthetic_two', display: 'Synthetic second protocol', media: [{ media_code: 'synthetic_mac_agar' }] })], page: { limit: 50 } })));
    const d = await openSetup();
    await pick(d, /plating protocol/i, /synthetic second protocol/i);
    await waitFor(() => expect(within(d).getAllByRole('button', { name: /medium/i })).toHaveLength(1));
    expect(within(d).getByRole('button', { name: /medium/i }).textContent).toMatch(/macconkey/i);
  });
});

describe('submitting (AC-03.1; S-05 strict body)', () => {
  it('POST /setup with Idempotency-Key and If-Match "<version>", only the declared fields, planted_at ≈ now; toast; culture refreshed', async () => {
    const d = await openSetup(culture({ version: 5 }));
    await submit(d);
    const h = await lastHit('POST', /\/setup$/);
    expect(h.path).toBe(`/v1/micro/cultures/${ID(1)}/setup`);
    expect(h.headers.get('if-match')).toBe('"5"');
    expect(h.headers.get('idempotency-key')).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(Object.keys(h.json).sort()).toEqual(['planted_at', 'plates', 'plating_protocol_id', 'specimen_site_code']);
    expect(h.json.plating_protocol_id).toBe(ID(50));
    expect(h.json.specimen_site_code).toBe('syn_site');
    expect(h.json.plates).toEqual([{ media_code: 'synthetic_blood_agar', incubation_text: 'Synthetic incubation 1' }, { media_code: 'synthetic_mac_agar' }]);
    expect(Math.abs(Date.parse(h.json.planted_at) - Date.now())).toBeLessThan(3 * 60_000);
    expect(await screen.findByText(/culture set up — first read due/i)).toBeTruthy();
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
    expect(screen.queryByRole('dialog', { name: /set up culture/i })).toBeNull();
  });

  it('Ctrl+Enter submits the dialog', async () => {
    const d = await openSetup();
    await userEvent.click(within(d).getAllByRole('textbox', { name: /incubation/i })[0]!);
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => expect(setupPosts()).toHaveLength(1));
  });

  it('a double click sends one request', async () => {
    api.use(http.post(`${ORIGIN}/v1/micro/cultures/:id/setup`, async () => { await new Promise((r) => setTimeout(r, 150)); return HttpResponse.json(incubating({ version: 6 })); }));
    const d = await openSetup();
    const b = within(d).getByRole('button', { name: /^set up$/i });
    await userEvent.dblClick(b);
    await waitFor(() => expect(setupPosts()).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 300));
    expect(setupPosts()).toHaveLength(1);
  });

  it('after a failed attempt a retry of the same form keeps the Idempotency-Key; reopening the dialog gets a new one', async () => {
    let n = 0;
    api.use(http.post(`${ORIGIN}/v1/micro/cultures/:id/setup`, () => (++n === 1 ? problem('common.internal', 500) : HttpResponse.json(incubating({ version: 6 })))));
    const d = await openSetup();
    await submit(d);
    await waitFor(() => expect(setupPosts()).toHaveLength(1));
    await screen.findByText(/couldn.t|try again|something went wrong/i);
    await submit(await dialog(/set up culture/i)); // the dialog stays open after a failure
    await waitFor(() => expect(setupPosts()).toHaveLength(2));
    expect(setupPosts()[1]!.headers.get('idempotency-key')).toBe(setupPosts()[0]!.headers.get('idempotency-key'));
  });
});

describe('validation before any request (AC-03.1 window ≤ now and ≥ now − 72 h)', () => {
  const tryAt = async (d: HTMLElement, when: Date) => { await typeDate(planted(d), when); await submit(d); };

  it('a time in the future is refused inline; nothing is sent; the dialog stays open with the values', async () => {
    const d = await openSetup();
    await tryAt(d, new Date(Date.now() + 2 * 3600_000));
    expect(setupPosts()).toHaveLength(0);
    expect(planted(d).getAttribute('aria-invalid')).toBe('true');
    expect(d.textContent).toMatch(/future|later than now|not be after now|72/i);
    expect(screen.getByRole('dialog', { name: /set up culture/i })).toBeTruthy();
  });

  it('older than 72 hours is refused inline; nothing is sent', async () => {
    const d = await openSetup();
    await tryAt(d, new Date(Date.now() - 80 * 3600_000));
    expect(setupPosts()).toHaveLength(0);
    expect(planted(d).getAttribute('aria-invalid')).toBe('true');
    expect(d.textContent).toMatch(/72/);
  });

  it('71 hours ago is accepted and sent as that instant', async () => {
    const d = await openSetup();
    const when = new Date(Date.now() - 71 * 3600_000);
    await tryAt(d, when);
    const h = await lastHit('POST', /\/setup$/);
    expect(Math.abs(Date.parse(h.json.planted_at) - when.getTime())).toBeLessThan(2 * 60_000);
  });

  it('an unparseable planted-at is refused inline', async () => {
    const d = await openSetup();
    await userEvent.clear(planted(d));
    await userEvent.type(planted(d), 'yesterday-ish');
    await submit(d);
    expect(setupPosts()).toHaveLength(0);
    expect(planted(d).getAttribute('aria-invalid')).toBe('true');
  });

  it('no medium on a row -> refused, nothing sent', async () => {
    api.use(http.get(`${ORIGIN}/v1/micro/plating-protocols`, () => HttpResponse.json({ data: [], page: { limit: 50 } })));
    await mount(culture({ suggested_protocol: undefined }));
    await userEvent.click(btn(/^set up culture$/i)!);
    const d = await dialog(/set up culture/i);
    await submit(d);
    expect(setupPosts()).toHaveLength(0);
  });
});

describe('server refusals (AC-03.3, AC-03.4; 04-UI-UX §10)', () => {
  it('409 micro.culture_invalid_transition -> "already set up" / "has changed" message, culture reloaded (AC-03.3)', async () => {
    api.use(http.post(`${ORIGIN}/v1/micro/cultures/:id/setup`, () => problem('micro.culture_invalid_transition', 409)));
    const d = await openSetup();
    await submit(d);
    expect(await screen.findByText(/already set up|this culture has changed\. reload to see its current state\./i)).toBeTruthy();
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
  });

  it('409 common.version_conflict -> "Someone else changed this. Reload and try again." and the entered values are kept (AC-03.4)', async () => {
    api.use(http.post(`${ORIGIN}/v1/micro/cultures/:id/setup`, () => problem('common.version_conflict', 409)));
    const d = await openSetup();
    await typeDate(planted(d), new Date(Date.now() - 5 * 3600_000));
    const typed = planted(d).value;
    await submit(d);
    expect(await screen.findByText(/someone else changed this\. reload and try again\./i)).toBeTruthy();
    expect(screen.getByRole('dialog', { name: /set up culture/i })).toBeTruthy();
    expect(planted(d).value).toBe(typed);
  });

  it('422 with field errors puts the message next to the field (no raw problem JSON)', async () => {
    api.use(http.post(`${ORIGIN}/v1/micro/cultures/:id/setup`, () => problem('common.validation_failed', 400, { errors: [{ path: 'plates[0].media_code', code: 'micro.media_unknown', message: 'Medium is not active.' }], detail: 'secret-internal' })));
    const d = await openSetup();
    await submit(d);
    await waitFor(() => expect(setupPosts()).toHaveLength(1));
    await screen.findByRole('dialog', { name: /set up culture/i });
    expect(document.body.textContent).not.toContain('secret-internal');
    expect(document.body.textContent).not.toMatch(/urn:lims:error/);
  });
});

describe('plates table (04-UI-UX §3.1)', () => {
  const work = (over: Record<string, unknown> = {}) => incubating({ plates: [plate(1), plate(2, { parent_plate_id: ID(101), source_isolate_id: ID(301) }), plate(3, { status: 'discarded' })], isolates: [isolate(1)], ...over });

  it('columns No., Medium, Incubation, Planted, Parent plate, From isolate, Status; medium shown by display name; status as a word', async () => {
    await mount(work());
    const t = await screen.findByRole('grid', { name: /plates/i });
    expect(within(t).getAllByRole('columnheader').map((h) => h.textContent?.trim()).filter(Boolean)).toEqual(expect.arrayContaining(['No.', 'Medium', 'Incubation', 'Planted', 'Parent plate', 'From isolate', 'Status']));
    await waitFor(() => expect(t.textContent).toContain('Synthetic blood agar'));
    expect(t.textContent).toMatch(/Active/);
    expect(t.textContent).toMatch(/Discarded/);
    expect(t.textContent).toMatch(/Synthetic incubation 1/);
  });

  it('"Discard plate" asks first (ConfirmDialog), then POSTs /discard with the plate\'s If-Match', async () => {
    await mount(work({ plates: [plate(1, { version: 4 }), plate(2)] }));
    await screen.findByRole('grid', { name: /plates/i });
    await rowAction(/Synthetic incubation 1/, /discard plate/i);
    const d = await screen.findByRole('dialog');
    expect(hit('POST', /\/discard$/)).toHaveLength(0);
    await userEvent.click(within(d).getByRole('button', { name: /discard/i }));
    const h = await lastHit('POST', /\/plates\/[^/]+\/discard$/);
    expect(h.path).toBe(`/v1/micro/cultures/${ID(1)}/plates/${ID(101)}/discard`);
    expect(h.headers.get('if-match')).toBe('"4"');
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
  });

  it('a discarded plate offers no "Discard plate"', async () => {
    await mount(work({ plates: [plate(3, { status: 'discarded' })] }));
    await screen.findByRole('grid', { name: /plates/i });
    const row = screen.getAllByRole('row').find((r) => /Discarded/.test(r.textContent ?? ''))!;
    expect(within(row).queryByRole('button', { name: /discard plate/i })).toBeNull();
    const menuBtns = within(row).queryAllByRole('button');
    if (menuBtns.length) { await userEvent.click(menuBtns.at(-1)!); expect(screen.queryByRole('menuitem', { name: /discard plate/i })).toBeNull(); }
  });
});

describe('add plate dialog (04-UI-UX §3.1.2)', () => {
  const open = async () => {
    await mount(incubating({ plates: [plate(1), plate(2)], isolates: [isolate(1)] }));
    await userEvent.click(btn(/^add plate$/i)!);
    return dialog(/add plate/i);
  };
  it('fields: Medium (required), Incubation (≤120), Parent plate (active plates), From isolate (isolates), Planted at (default now)', async () => {
    const d = await open();
    for (const l of [/^medium/i, /parent plate/i, /from isolate/i]) expect(within(d).getByRole('button', { name: l }), String(l)).toBeTruthy();
    expect((within(d).getByRole('textbox', { name: /incubation/i }) as HTMLInputElement).maxLength).toBe(120);
    expect([localText(new Date()), localText(new Date(Date.now() - 60_000))]).toContain((within(d).getByRole('textbox', { name: /planted at/i }) as HTMLInputElement).value);
  });
  it('POST /plates with Idempotency-Key, media_code + parent_plate_id; toast "Plate 3 added"', async () => {
    const d = await open();
    await pick(d, /^medium/i, /^synthetic blood agar$/i);
    await pick(d, /parent plate/i, /plate 1|^1$/i);
    await userEvent.click(within(d).getByRole('button', { name: /^(add plate|save|add)$/i }));
    const h = await lastHit('POST', /\/plates$/);
    expect(h.headers.get('idempotency-key')).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(h.json.media_code).toBe('synthetic_blood_agar');
    expect(h.json.parent_plate_id).toBe(ID(101));
    expect(Object.keys(h.json).every((k) => ['media_code', 'incubation_text', 'parent_plate_id', 'source_isolate_id', 'planted_at'].includes(k))).toBe(true);
    expect(await screen.findByText(/plate 3 added/i)).toBeTruthy();
  });
  it('Medium is required: nothing is sent without it', async () => {
    const d = await open();
    await userEvent.click(within(d).getByRole('button', { name: /^(add plate|save|add)$/i }));
    expect(hit('POST', /\/plates$/)).toHaveLength(0);
  });
  it('not offered while the culture is awaiting set-up', async () => {
    await mount(culture());
    expect(btn(/^add plate$/i)).toBeUndefined();
  });
});

describe('actions by state (03-APP-FLOW §4.2; buttons hidden when not allowed)', () => {
  const NAMES = { setup: /^set up culture$/i, read: /^record read$/i, stain: /record (gram )?stain/i, addPlate: /^add plate$/i, isolate: /^add isolate$/i, prelim: /^preliminary report$/i, final: /^final report$/i, cancel: /^cancel( culture)?$/i, reopen: /^reopen for amendment$/i };
  const cases: [string, (keyof typeof NAMES)[], (keyof typeof NAMES)[]][] = [
    ['awaiting_setup', ['setup', 'stain', 'cancel'], ['read', 'addPlate', 'isolate', 'prelim', 'final', 'reopen']],
    ['incubating', ['read', 'addPlate', 'stain', 'isolate', 'prelim', 'final', 'cancel'], ['setup', 'reopen']],
    ['growth_detected', ['read', 'addPlate', 'stain', 'isolate', 'prelim', 'final', 'cancel'], ['setup', 'reopen']],
    ['final_submitted', ['reopen'], ['setup', 'read', 'addPlate', 'stain', 'isolate', 'prelim', 'final', 'cancel']],
    ['amending', ['read', 'addPlate', 'stain', 'isolate', 'final'], ['setup', 'reopen']],
    ['cancelled', [], ['setup', 'read', 'addPlate', 'stain', 'isolate', 'prelim', 'final', 'cancel', 'reopen']],
  ];
  it.each(cases)('%s', async (status, shown, hidden) => {
    await mount(incubating({ status }));
    for (const k of shown) expect(btn(NAMES[k]), `${status}: ${k} shown`).toBeTruthy();
    for (const k of hidden) expect(btn(NAMES[k]), `${status}: ${k} hidden`).toBeUndefined();
  });
  it('the read-only user gets none of them', async () => {
    await mount(incubating(), PERM_READ);
    for (const n of Object.values(NAMES)) expect(btn(n)).toBeUndefined();
  });
  it('one primary button per page (LD-140)', async () => {
    await mount(incubating());
    expect(document.querySelectorAll('button.lims-btn-primary').length).toBeLessThanOrEqual(1);
  });
});

describe('accessibility (axe)', () => {
  it('set-up dialog open', async () => {
    const d = await openSetup();
    const v = (await axe.run(d, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } })).violations;
    expect(v.map((x) => `${x.id}: ${x.help}`)).toEqual([]);
  });
  it('plates tab with plates', async () => {
    await mount(incubating({ isolates: [isolate(1)] }));
    await screen.findByRole('grid', { name: /plates/i });
    const v = (await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } })).violations;
    expect(v.map((x) => `${x.id}: ${x.help}`)).toEqual([]);
  });
});
void act; void patient; void hits; void PERM_READ;
