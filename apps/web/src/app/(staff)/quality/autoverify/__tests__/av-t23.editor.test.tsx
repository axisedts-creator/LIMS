// @vitest-environment jsdom
// C9.T-23 — Version editor `/quality/autoverify/{version_id}`, DRAFT state (04-UI-UX §2.8; AC-10.1, AC-10.2, AC-10.3, AC-12.3).
// ASSUMED contract: autoverify/[version_id]/page.tsx = default async server component `Page({ params })`. Reads #38 GET …/versions/{id} (+ #51 settings).
//   Malformed id -> notFound() with NO API call; API 404 -> copy "This version doesn't exist or isn't in your lab.".
//   Needs quality.autoverify.read (checked before any call). Write controls need quality.autoverify.manage.
//   Draft: DataTable named /rules/ (Key, Test, Analyte, Instrument, Enabled, Limits, Flags); button "Add rule"; each row has an "Edit" button opening a Drawer
//   (fields by label: Key, Lower limit, Upper limit, N/L/H checkboxes, Enabled, "Allow when QC shows a warning", "Instrument flags to ignore", Note). The drawer's "Save" sends the WHOLE
//   definition as #39 PUT …/versions/{id} {definition} with If-Match "<version>" (no Idempotency-Key is required for PUT). Buttons "Start simulation" (ConfirmDialog -> #40) and "Discard draft"
//   (ConfirmDialog -> #45). #39 422 quality.rule_set_invalid errors[] {path,code,message}: the message is shown next to the row/field; #39 409 quality.rule_set_invalid_transition
//   (AC-10.3) -> "This version can no longer be edited." and the page offers Reload. 403 auth.mfa_required -> warning Banner with "Verify now", form input kept.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse } from 'msw';
import {
  AN_K, AV_MANAGE, AV_READ, INST_A, RULES, TEST_K, V_DRAFT, api, apiOf, axeClean, bodyOf, calls, callsTo, dataRows, gridNamed, headersOf, json, mfa, norm, pageText, problem,
  resetApi, router, routes, rule, seedAv, show, showOrThrown, versionDto,
} from './av-t23.harness';

vi.mock('next/navigation', async () => (await import('./av-t23.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./av-t23.harness')).sessionMock);

const PAGE = 'autoverify/[version_id]/page';
const props = (v = V_DRAFT) => ({ params: { version_id: v } });
const URL_V = apiOf(V_DRAFT);
const COPY_404 = "This version doesn't exist or isn't in your lab.";
const user = () => userEvent.setup();
const btn = (re: RegExp) => screen.queryByRole('button', { name: re });
const anyDialog = () => screen.queryByRole('dialog') ?? screen.queryByRole('alertdialog');
const dialog = () => { const d = anyDialog(); if (!d) throw new Error('no dialog is open'); return d; };

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { resetApi(AV_MANAGE); seedAv(); });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

async function openEdit(u: ReturnType<typeof user>, row = 0) {
  await show(PAGE, props());
  const g = gridNamed(/rules/i);
  await u.click(within(dataRows(g)[row]!).getByRole('button', { name: /edit/i }));
  return dialog();
}
const sentRules = (c: unknown) => bodyOf(c as never).definition.rules as Record<string, unknown>[];

describe('access and errors', () => {
  it('without quality.autoverify.read: permission-denied state, NO API call', async () => {
    resetApi([]);
    await show(PAGE, props());
    expect(pageText()).toMatch(/You don't have access to this page/);
    expect(calls).toHaveLength(0);
  });
  it.each(['../x', 'not-a-uuid', ''])('malformed id %j -> notFound() and NO API call', async (id) => {
    const err = await showOrThrown(PAGE, props(id));
    expect(err).toMatch(/NEXT_NOT_FOUND/);
    expect(calls).toHaveLength(0);
  });
  it('API 404 (also another tenant\'s id) -> the exact "doesn\'t exist or isn\'t in your lab" copy', async () => {
    routes[`GET ${URL_V}`] = () => problem('common.not_found', 404);
    const err = await showOrThrown(PAGE, props());
    if (err) expect(err).toMatch(/NEXT_NOT_FOUND/); else expect(pageText()).toContain(COPY_404);
  });
  it('API 5xx rejects (error.tsx)', async () => {
    routes[`GET ${URL_V}`] = () => problem('common.internal', 500);
    expect(await showOrThrown(PAGE, props())).toBeTruthy();
  });
});

describe('draft view (04-UI-UX §2.8)', () => {
  it('title, Draft chip word, fixed-rules box verbatim', async () => {
    await show(PAGE, props());
    expect(screen.getByRole('heading', { level: 1 }).textContent).toMatch(/Version 5/);
    expect(pageText()).toContain('Draft');
    expect(norm(document.body.textContent)).toContain(
      "Never auto-verified, whatever the rules: critical results, delta-check failures, results without an instrument (manual or calculated), results while QC is out of control or missing. Auto-verification replaces only the technologist's first verification; a pathologist always approves.",
    );
  });

  it('rules table: key, limits, flags, "Any instrument", note-less rule renders; axe clean', async () => {
    await show(PAGE, props());
    const g = gridNamed(/rules/i);
    const h = headersOf(g).join('|');
    for (const c of ['Key', 'Analyte', 'Instrument', 'Enabled', 'Limits']) expect(h).toContain(c);
    const rows = dataRows(g).map((r) => norm(r.textContent));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('K_ANY');
    expect(rows[0]).toMatch(/3\.5\D+5\.1/);
    expect(rows[0]).toMatch(/Any instrument/);
    expect(rows[1]).toContain('NA_I1');
    expect(rows[1]).toMatch(/135\D+145/);
    expect(rows[1]).not.toMatch(/Any instrument/);
    await axeClean();
  });

  it('a rule with enabled=false says what it does in words', async () => {
    routes[`GET ${URL_V}`] = json(versionDto({ definition: { schema_version: 1, rules: [rule({ enabled: false })] }, rule_count: 1 }));
    await show(PAGE, props());
    expect(pageText()).toMatch(/Never auto-verify this analyte on this instrument/);
  });

  it('manage holders see Add rule, Start simulation, Discard draft; readers see none of them and no Edit buttons', async () => {
    await show(PAGE, props());
    for (const n of [/add rule/i, /start simulation/i, /discard/i]) expect(btn(n), String(n)).not.toBeNull();
    cleanup();
    resetApi(AV_READ); seedAv();
    await show(PAGE, props());
    expect(btn(/add rule|start simulation|discard|edit|activate|stop simulation|retire/i)).toBeNull();
    expect(gridNamed(/rules/i)).toBeTruthy();
  });
});

describe('edit a rule (AC-10.1 -> #39 replace draft)', () => {
  beforeEach(() => { routes[`PUT ${URL_V}`] = json(versionDto({ version: 4 })); });

  it('drawer shows the spec fields with the rule\'s values', async () => {
    const u = user();
    const d = await openEdit(u, 0);
    expect((within(d).getByLabelText(/^key/i) as HTMLInputElement).value).toBe('K_ANY');
    expect((within(d).getByLabelText(/lower limit/i) as HTMLInputElement).value).toBe('3.5');
    expect((within(d).getByLabelText(/upper limit/i) as HTMLInputElement).value).toBe('5.1');
    expect((within(d).getByLabelText(/^N\b/) as HTMLInputElement).checked).toBe(true);
    expect((within(d).getByLabelText(/^L\b/) as HTMLInputElement).checked).toBe(false);
    expect((within(d).getByLabelText(/^H\b/) as HTMLInputElement).checked).toBe(false);
    expect(within(d).getByLabelText(/allow when qc shows a warning/i)).toBeTruthy();
    expect(within(d).getByLabelText(/instrument flags to ignore/i)).toBeTruthy();
    expect((within(d).getByLabelText(/^note/i) as HTMLInputElement).value).toBe('Synthetic potassium rule');
  });

  it('Save sends the WHOLE definition (both rules, schema_version 1) with If-Match "3", changed limit, exact DSL shape, no extra keys', async () => {
    const u = user();
    const d = await openEdit(u, 0);
    const hi = within(d).getByLabelText(/upper limit/i);
    await u.clear(hi); await u.type(hi, '5.0');
    await u.click(within(d).getByLabelText(/^L\b/));
    await u.click(within(d).getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(callsTo('PUT', URL_V)).toHaveLength(1));
    const c = callsTo('PUT', URL_V)[0]!;
    expect(c.headers.get('if-match')).toBe('"3"');
    expect(Object.keys(bodyOf(c))).toEqual(['definition']);
    expect(bodyOf(c).definition.schema_version).toBe(1);
    const rules = sentRules(c);
    expect(rules).toHaveLength(2);
    expect(rules[0]).toEqual({ ...RULES[0], limits: { low: '3.5', high: '5.0' }, allowed_range_flags: ['N', 'L'] });
    expect(rules[1]).toEqual(RULES[1]); // untouched rule is sent back unchanged
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
  });

  it('keeps limits as DecimalStrings (never JSON numbers) and drops an emptied optional bound', async () => {
    const u = user();
    const d = await openEdit(u, 0);
    const lo = within(d).getByLabelText(/lower limit/i);
    await u.clear(lo);
    await u.click(within(d).getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(callsTo('PUT', URL_V)).toHaveLength(1));
    const lim = sentRules(callsTo('PUT', URL_V)[0])[0]!['limits'] as Record<string, unknown>;
    expect(lim).toEqual({ high: '5.1' });
  });

  it.each([
    ['both limits empty (one bound is required)', async (d: HTMLElement, u: ReturnType<typeof user>) => { await u.clear(within(d).getByLabelText(/lower limit/i)); await u.clear(within(d).getByLabelText(/upper limit/i)); }],
    ['low greater than high', async (d: HTMLElement, u: ReturnType<typeof user>) => { const lo = within(d).getByLabelText(/lower limit/i); await u.clear(lo); await u.type(lo, '9'); }],
    ['no range flag chosen', async (d: HTMLElement, u: ReturnType<typeof user>) => { await u.click(within(d).getByLabelText(/^N\b/)); }],
    ['key with a space or too long', async (d: HTMLElement, u: ReturnType<typeof user>) => { const k = within(d).getByLabelText(/^key/i); await u.clear(k); await u.type(k, 'bad key!'); }],
    ['duplicate key', async (d: HTMLElement, u: ReturnType<typeof user>) => { const k = within(d).getByLabelText(/^key/i); await u.clear(k); await u.type(k, 'NA_I1'); }],
    ['limit that is not a decimal', async (d: HTMLElement, u: ReturnType<typeof user>) => { const k = within(d).getByLabelText(/upper limit/i); await u.clear(k); await u.type(k, '1e3'); }],
  ])('client-side validation (AC-10.2): %s -> no PUT, message in words, drawer stays open', async (_n, mutate) => {
    const u = user();
    const d = await openEdit(u, 0);
    await mutate(d, u);
    await u.click(within(d).getByRole('button', { name: /^save/i }));
    await new Promise((r) => setTimeout(r, 50));
    expect(callsTo('PUT', URL_V)).toHaveLength(0);
    expect(anyDialog()).not.toBeNull();
    expect(d.querySelector('[role="alert"], [aria-invalid="true"]')).not.toBeNull();
  });

  it('"L" and "H" are offered but LL / HH / A are not (04-UI-UX §2.8; DSL: LL/HH/A are never allowed)', async () => {
    const u = user();
    const d = await openEdit(u, 0);
    expect(within(d).queryByLabelText(/^(LL|HH|A)\b/)).toBeNull();
  });

  it('instrument-flag chips: ≤ 20 and each ≤ 16 characters (the 17th character is refused)', async () => {
    const u = user();
    const d = await openEdit(u, 1);
    const f = within(d).getByLabelText(/instrument flags to ignore/i) as HTMLInputElement;
    await u.type(f, 'ABCDEFGHIJKLMNOPQR{enter}');
    await u.click(within(d).getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(callsTo('PUT', URL_V)).toHaveLength(1));
    const flags = sentRules(callsTo('PUT', URL_V)[0])[1]!['instrument_flags_allowed'] as string[];
    expect(flags.every((x) => x.length <= 16)).toBe(true);
    expect(flags).toContain('SYN_FLAG');
  });

  it('server 422 quality.rule_set_invalid (AC-10.2): errors[] are shown by row, nothing is lost, drawer stays', async () => {
    routes[`PUT ${URL_V}`] = () => problem('quality.rule_set_invalid', 422, { errors: [{ path: '/definition/rules/0/limits/low', code: 'common.validation_failed', message: 'low must not exceed high' }] });
    const u = user();
    const d = await openEdit(u, 0);
    await u.click(within(d).getByRole('button', { name: /^save/i }));
    expect(await screen.findByText(/low must not exceed high/)).toBeTruthy();
    expect(anyDialog()).not.toBeNull();
    expect((within(dialog()).getByLabelText(/lower limit/i) as HTMLInputElement).value).toBe('3.5');
  });

  it('server 409 quality.rule_set_invalid_transition (AC-10.3): says the version can no longer be edited, offers Reload', async () => {
    routes[`PUT ${URL_V}`] = () => problem('quality.rule_set_invalid_transition', 409);
    const u = user();
    const d = await openEdit(u, 0);
    await u.click(within(d).getByRole('button', { name: /^save/i }));
    expect(await screen.findByText(/can no longer be edited|no longer a draft/i)).toBeTruthy();
    expect(btn(/reload/i)).not.toBeNull();
  });

  it('409 common.version_conflict (someone saved first): Banner + Reload, input kept', async () => {
    routes[`PUT ${URL_V}`] = () => problem('common.version_conflict', 409);
    const u = user();
    const d = await openEdit(u, 0);
    await u.click(within(d).getByRole('button', { name: /^save/i }));
    expect(await screen.findByText(/changed by someone else|reload/i)).toBeTruthy();
    expect((within(dialog()).getByLabelText(/upper limit/i) as HTMLInputElement).value).toBe('5.1');
  });
});

describe('add rule', () => {
  it('default key is generated as R{n+1}; defaults: Any instrument, enabled, flag N, QC warning off', async () => {
    routes[`PUT ${URL_V}`] = json(versionDto({ version: 4 }));
    const u = user();
    await show(PAGE, props());
    await u.click(btn(/add rule/i)!);
    const d = dialog();
    expect((within(d).getByLabelText(/^key/i) as HTMLInputElement).value).toBe('R3');
    expect((within(d).getByLabelText(/^N\b/) as HTMLInputElement).checked).toBe(true);
    expect(within(d).getByLabelText(/test/i)).toBeTruthy();
    expect(within(d).getByLabelText(/analyte/i)).toBeTruthy();
    expect(norm(d.textContent)).toMatch(/Any instrument/);
  });
});

describe('Start simulation (#40) and Discard (#45)', () => {
  it('Start simulation: ConfirmDialog, then POST {} with If-Match "3" and an Idempotency-Key; page refreshes', async () => {
    routes[`POST ${apiOf(V_DRAFT, '/start-simulation')}`] = json(versionDto({ status: 'simulating', version: 4 }));
    const u = user();
    await show(PAGE, props());
    await u.click(btn(/start simulation/i)!);
    await u.click(within(dialog()).getByRole('button', { name: /start simulation/i }));
    await waitFor(() => expect(callsTo('POST', apiOf(V_DRAFT, '/start-simulation'))).toHaveLength(1));
    const c = callsTo('POST', apiOf(V_DRAFT, '/start-simulation'))[0]!;
    expect(bodyOf(c)).toEqual({});
    expect(c.headers.get('if-match')).toBe('"3"');
    expect(c.headers.get('idempotency-key')).toMatch(/\S{8,}/);
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
  });
  it('Start simulation 409 (another version is already simulating): said in words, no refresh', async () => {
    routes[`POST ${apiOf(V_DRAFT, '/start-simulation')}`] = () => problem('quality.rule_set_invalid_transition', 409);
    const u = user();
    await show(PAGE, props());
    await u.click(btn(/start simulation/i)!);
    await u.click(within(dialog()).getByRole('button', { name: /start simulation/i }));
    expect(await screen.findByText(/another version is already simulating|can't be started|not allowed/i)).toBeTruthy();
    expect(router.refresh).not.toHaveBeenCalled();
  });
  it('Discard: ConfirmDialog, then POST {} with If-Match, returns to the overview', async () => {
    routes[`POST ${apiOf(V_DRAFT, '/discard')}`] = json(versionDto({ status: 'discarded', version: 4 }));
    const u = user();
    await show(PAGE, props());
    await u.click(btn(/discard/i)!);
    await u.click(within(dialog()).getByRole('button', { name: /discard/i }));
    await waitFor(() => expect(callsTo('POST', apiOf(V_DRAFT, '/discard'))).toHaveLength(1));
    const c = callsTo('POST', apiOf(V_DRAFT, '/discard'))[0]!;
    expect(bodyOf(c)).toEqual({});
    expect(c.headers.get('if-match')).toBe('"3"');
    await waitFor(() => expect(router.push.mock.calls.concat(router.replace.mock.calls).flat()).toContain('/quality/autoverify'));
  });
});

describe('AC-12.3 — every write on this screen survives 403 auth.mfa_required (aal1) without losing input', () => {
  const OPS: [string, string, string, (u: ReturnType<typeof user>) => Promise<void>][] = [
    ['#39 Save', 'PUT', URL_V, async (u) => { const d = await openEdit(u, 0); await u.click(within(d).getByRole('button', { name: /^save/i })); }],
    ['#40 Start simulation', 'POST', apiOf(V_DRAFT, '/start-simulation'), async (u) => { await show(PAGE, props()); await u.click(btn(/start simulation/i)!); await u.click(within(dialog()).getByRole('button', { name: /start simulation/i })); }],
    ['#45 Discard', 'POST', apiOf(V_DRAFT, '/discard'), async (u) => { await show(PAGE, props()); await u.click(btn(/discard/i)!); await u.click(within(dialog()).getByRole('button', { name: /discard/i })); }],
  ];
  it.each(OPS)('%s', async (_n, method, path, drive) => {
    routes[`${method} ${path}`] = () => mfa();
    await drive(user());
    await waitFor(() => expect(callsTo(method, path)).toHaveLength(1));
    expect(await screen.findByRole('button', { name: /verify now/i })).toBeTruthy();
    expect(router.refresh).not.toHaveBeenCalled();
    expect(pageText()).toMatch(/confirm your identity|verify/i);
  });
  it('after step-up the retry is the same request again: ONE retry, same If-Match, success refreshes', async () => {
    let n = 0;
    routes[`PUT ${URL_V}`] = () => (++n === 1 ? mfa() : HttpResponse.json(versionDto({ version: 4 })));
    const u = user();
    const d = await openEdit(u, 0);
    await u.click(within(d).getByRole('button', { name: /^save/i }));
    await screen.findByRole('button', { name: /verify now/i });
    await u.click(within(dialog()).getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(callsTo('PUT', URL_V)).toHaveLength(2));
    const [a, b] = callsTo('PUT', URL_V);
    expect(b!.headers.get('if-match')).toBe(a!.headers.get('if-match'));
    expect(b!.body).toBe(a!.body);
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
  });
});

describe('route use of identifiers', () => {
  it('rule rows keep ids only in the request body (test_id / analyte_id / instrument_id pass through unchanged)', async () => {
    routes[`PUT ${URL_V}`] = json(versionDto({ version: 4 }));
    const u = user();
    const d = await openEdit(u, 1);
    await u.click(within(d).getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(callsTo('PUT', URL_V)).toHaveLength(1));
    const r = sentRules(callsTo('PUT', URL_V)[0])[1]!;
    expect(r['instrument_id']).toBe(INST_A);
    expect(r['test_id']).toBe(TEST_K);
    expect(AN_K).toBeTruthy();
  });
  it('a failing catalog lookup (C3 down) does not break the editor: rows still render by key', async () => {
    await show(PAGE, props());
    expect(dataRows(gridNamed(/rules/i))).toHaveLength(2);
  });
});
