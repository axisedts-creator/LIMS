// @vitest-environment jsdom
// C9.T-23 — Decisions `/quality/autoverify/decisions` (04-UI-UX §2.9; TRD #46/#47; 07-SECURITY P3: decisions only with quality.autoverify.read; opening the drawer = #47 = access-log `autoverify_decision.view` SERVER side).
// ASSUMED contract: autoverify/decisions/page.tsx = default async server component `Page({ searchParams })`. Search params (all optional): decided_at_from, decided_at_to (ISO UTC instants),
//   mode (live|shadow), decision (allow|deny), reason (one of the 9 reason codes), analyte_id, instrument_id (UUIDs). They are forwarded to #46 under the same names after a WHITELIST
//   (unknown/invalid values are dropped, never forwarded). Default period = today when no from/to; span > 31 days -> the page says so and makes NO API call.
//   A row opens a Drawer (click or Enter); the drawer reads #47 GET …/decisions/{id} (never before the user opens it) and shows inputs, QC status, link to the QC run, matched rule key.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  AN_K, AV, AV_MANAGE, AV_READ, DEC, DECISIONS, INST_A, QC_RUN, V_ACTIVE, api, axeClean, calls, callsTo, dataRows, decisionDetail, gridNamed, headersOf, hrefs, json, norm, pageText, problem,
  resetApi, routes, seedAv, show, showOrThrown,
} from './av-t23.harness';

vi.mock('next/navigation', async () => (await import('./av-t23.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./av-t23.harness')).sessionMock);

const PAGE = 'autoverify/decisions/page';
const LIST = `${AV}/decisions`;
const FROM = '2026-11-14T00:00:00.000Z';
const TO = '2026-11-15T00:00:00.000Z';
const sp = (o: Record<string, string> = {}) => ({ searchParams: { decided_at_from: FROM, decided_at_to: TO, ...o } });
const user = () => userEvent.setup();
const anyDialog = () => screen.queryByRole('dialog') ?? screen.queryByRole('complementary');

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { resetApi(AV_READ); seedAv(); routes[`GET ${LIST}/${DEC(1)}`] = json(decisionDetail(1)); routes[`GET ${LIST}/${DEC(2)}`] = json(decisionDetail(2)); routes[`GET ${LIST}/${DEC(3)}`] = json(decisionDetail(3)); });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

describe('access and errors', () => {
  it('without quality.autoverify.read: permission-denied state, NO API call', async () => {
    resetApi(['quality.qc_run.read']);
    await show(PAGE, sp());
    expect(pageText()).toMatch(/You don't have access to this page/);
    expect(calls).toHaveLength(0);
  });
  it('API 5xx rejects (error.tsx)', async () => {
    routes[`GET ${LIST}`] = () => problem('common.internal', 500);
    expect(await showOrThrown(PAGE, sp())).toBeTruthy();
  });
  it('empty result -> "No decisions in this period."', async () => {
    routes[`GET ${LIST}`] = json({ data: [], page: { limit: 50 } });
    await show(PAGE, sp());
    expect(pageText()).toContain('No decisions in this period.');
  });
});

describe('period and filters -> #46 query', () => {
  it('sends decided_at_from / decided_at_to / sort=-decided_at / a limit ≤ 200 and nothing else by default', async () => {
    await show(PAGE, sp());
    const q = callsTo('GET', LIST)[0]!.url.searchParams;
    expect(q.get('decided_at_from')).toBe(FROM);
    expect(q.get('decided_at_to')).toBe(TO);
    expect(['-decided_at', null]).toContain(q.get('sort'));
    expect(Number(q.get('limit') ?? 50)).toBeLessThanOrEqual(200);
    for (const k of ['mode', 'decision', 'reason', 'analyte_id', 'instrument_id', 'result_id', 'version_id']) expect(q.has(k), k).toBe(false);
  });
  it('no period given -> defaults to today (from < to, span ≤ 31 days), required by the API', async () => {
    await show(PAGE, { searchParams: {} });
    const q = callsTo('GET', LIST)[0]!.url.searchParams;
    const a = Date.parse(q.get('decided_at_from')!); const b = Date.parse(q.get('decided_at_to')!);
    expect(a).toBeLessThan(b);
    expect(b - a).toBeLessThanOrEqual(31 * 86400000);
  });
  it('valid filters are forwarded under the API names', async () => {
    await show(PAGE, sp({ mode: 'shadow', decision: 'deny', reason: 'qc_warning', analyte_id: AN_K, instrument_id: INST_A }));
    const q = callsTo('GET', LIST)[0]!.url.searchParams;
    expect([q.get('mode'), q.get('decision'), q.get('reason'), q.get('analyte_id'), q.get('instrument_id')]).toEqual(['shadow', 'deny', 'qc_warning', AN_K, INST_A]);
  });
  it.each([
    ['mode', 'both'], ['decision', 'maybe'], ['reason', "x'; drop table"], ['analyte_id', '../../etc'], ['instrument_id', 'not-a-uuid'], ['sort', 'decided_at;--'],
  ])('invalid %s=%j is dropped, never forwarded (injection / enum whitelist)', async (k, v) => {
    await show(PAGE, sp({ [k]: v }));
    const c = callsTo('GET', LIST);
    expect(c).toHaveLength(1);
    expect(c[0]!.url.searchParams.get(k)).not.toBe(v);
  });
  it('a period longer than 31 days is refused in words with NO API call', async () => {
    await show(PAGE, sp({ decided_at_to: '2026-12-20T00:00:00.000Z' }));
    expect(pageText()).toMatch(/31 days or less|at most 31 days|no more than 31 days/i);
    expect(callsTo('GET', LIST)).toHaveLength(0);
  });
  it('a reversed period (to before from) is refused with NO API call', async () => {
    await show(PAGE, sp({ decided_at_from: TO, decided_at_to: FROM }));
    expect(callsTo('GET', LIST)).toHaveLength(0);
    expect(pageText()).toMatch(/before|earlier|period/i);
  });
  it('the filter bar has period, mode, decision and reason controls (04-UI-UX §2.9)', async () => {
    await show(PAGE, sp());
    for (const l of [/mode/i, /decision/i, /reason/i]) expect(screen.queryAllByLabelText(l).length, String(l)).toBeGreaterThan(0);
    expect(screen.queryAllByLabelText(/period|from/i).length).toBeGreaterThan(0);
  });
});

describe('table (04-UI-UX §2.9)', () => {
  it('columns Decided at, Mode, Decision, Reasons, Analyte, Instrument, Version', async () => {
    await show(PAGE, sp());
    const h = headersOf(gridNamed(/decisions/i)).join('|');
    for (const c of ['Decided at', 'Mode', 'Decision', 'Reasons', 'Analyte', 'Instrument', 'Version']) expect(h).toContain(c);
  });
  it('mode and decision are WORDS; reasons use the plain labels, never the codes', async () => {
    await show(PAGE, sp());
    const rows = dataRows(gridNamed(/decisions/i)).map((r) => norm(r.textContent));
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatch(/Live/); expect(rows[0]).toMatch(/Allow/);
    expect(rows[1]).toMatch(/Shadow/); expect(rows[1]).toMatch(/Deny/);
    expect(rows[1]).toContain('Outside auto-verify limits'); expect(rows[1]).toContain('QC warning');
    for (const l of ['Critical', 'Delta failure', 'Instrument flag', 'QC out of control', 'No QC data', 'Manual or calculated result', 'No rule']) expect(rows[2]).toContain(l);
    expect(pageText()).not.toMatch(/outside_autoverify_limits|qc_out_of_control|delta_failure|manual_origin|rule_missing|instrument_flag\b/);
  });
  it('an allow row shows no reasons (allow ⇒ no reasons invariant is visible)', async () => {
    await show(PAGE, sp());
    const r0 = norm(dataRows(gridNamed(/decisions/i))[0]!.textContent);
    expect(r0).not.toMatch(/Outside auto-verify|QC warning|Critical|Delta failure|No rule|No QC data/);
  });
  it('axe clean', async () => { await show(PAGE, sp()); await axeClean(); });
  it('no patient identifiers are shown (result ids only)', async () => {
    await show(PAGE, sp());
    expect(pageText()).not.toMatch(/patient name|barcode|registration no|\bmrn\b/i);
  });
});

describe('row drawer (#47)', () => {
  it('opening the list reads NO decision detail (access-log entry is written only when a drawer opens)', async () => {
    await show(PAGE, sp());
    expect(calls.filter((c) => new RegExp(`${LIST}/[0-9a-f-]{36}$`).test(c.url.pathname))).toHaveLength(0);
  });
  it('click -> GET #47 once; drawer shows value, range flag, delta, critical, flags, resulted at, QC status + run link, matched rule key', async () => {
    const u = user();
    await show(PAGE, sp());
    await u.click(dataRows(gridNamed(/decisions/i))[1]!);
    await waitFor(() => expect(callsTo('GET', `${LIST}/${DEC(2)}`)).toHaveLength(1));
    const d = await screen.findByRole('dialog');
    const t = norm(d.textContent);
    expect(t).toContain('5.2');
    expect(t).toMatch(/Range flag\D{0,12}H\b/);
    expect(t).toMatch(/Delta check failed\D{0,12}No/i);
    expect(t).toMatch(/Critical\D{0,12}No/i);
    expect(t).toContain('SYN_FLAG');
    expect(t).toMatch(/Resulted at/i);
    expect(t).toMatch(/QC status\D{0,12}Warning/i);
    expect(t).toContain('K_ANY');
    expect(within(d).getByRole('link', { name: /qc run|open run/i }).getAttribute('href')).toBe(`/quality/qc-runs/${QC_RUN}`);
  });
  it('Enter on a focused row also opens it; Esc closes the drawer', async () => {
    const u = user();
    await show(PAGE, sp());
    dataRows(gridNamed(/decisions/i))[0]!.focus();
    await u.keyboard('{Enter}');
    await waitFor(() => expect(callsTo('GET', `${LIST}/${DEC(1)}`)).toHaveLength(1));
    await u.keyboard('{Escape}');
    await waitFor(() => expect(anyDialog()).toBeNull());
  });
  it('a decision with no matched rule / no instrument shows "—", not "undefined"', async () => {
    const u = user();
    await show(PAGE, sp());
    await u.click(dataRows(gridNamed(/decisions/i))[2]!);
    const d = await screen.findByRole('dialog');
    expect(norm(d.textContent)).not.toMatch(/undefined|null|NaN/);
  });
  it('#47 404 -> the drawer says the decision is gone, page stays usable', async () => {
    routes[`GET ${LIST}/${DEC(1)}`] = () => problem('common.not_found', 404);
    const u = user();
    await show(PAGE, sp());
    await u.click(dataRows(gridNamed(/decisions/i))[0]!);
    expect(await screen.findByText(/doesn't exist|isn't in your lab|no longer|couldn't load/i)).toBeTruthy();
    expect(gridNamed(/decisions/i)).toBeTruthy();
  });
});

describe('roles: manage holders see the same read-only screen (no write controls here)', () => {
  it('no Activate / Save / Retire buttons on the decisions page', async () => {
    resetApi(AV_MANAGE); seedAv();
    await show(PAGE, sp());
    expect(screen.queryByRole('button', { name: /activate|^save|retire|discard|simulation/i })).toBeNull();
    expect(hrefs().every((h) => !/\/undefined(\/|$)/.test(h))).toBe(true);
  });
});
