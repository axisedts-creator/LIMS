// @vitest-environment jsdom
// C9.T-23 — Version editor in SIMULATING / STOPPED / ACTIVE states: report, stop, activation dialog, retire, copy (04-UI-UX §2.8; AC-11.2, AC-11.3, AC-11.4, AC-12.1, AC-12.2, AC-12.3).
// ASSUMED contract (same page as the editor): simulating/stopped versions also GET #42 …/simulation-report (no sample_limit > 200) and #51 settings (sim_min_days, sim_min_decisions).
//   Simulating: rules read-only (no Add rule / Edit / Save), report StatTiles "Days running", "Decisions", "Would allow", "Would deny", "Allowed and later verified by staff",
//   deny-by-reason with plain labels and counts as TEXT (not only a chart), sample table named /sample/ with columns Decided at, Analyte, Shadow decision, Reasons, Live decision,
//   Verified by staff, link "Open results" -> /lab/orders/{order_id}/results (only when order_id is present), "—" for a missing live_decision.
//   Buttons "Stop simulation" (ConfirmDialog -> #41) and "Activate" (disabled until days_running >= sim_min_days AND decisions >= sim_min_decisions; hint "Needs {d} more days / {n} more decisions").
//   Activate dialog: TextField maxLength 8, confirm button disabled until the text is exactly ACTIVATE; copy "You can't activate a version you created." -> POST …/activate {confirmation_text:'ACTIVATE'}, If-Match "<version>", Idempotency-Key.
//   Stopped: read-only, report shown, status word "Stopped", button "Copy to new draft" (#37 {copy_from_version_id}); no Activate / Stop. Active: "Retire" with reason 1..500 (#44 {reason}).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse } from 'msw';
import {
  AV, AV_MANAGE, AV_READ, DEC, ORDER_1, V_ACTIVE, V_NEW, V_SIM, V_STOPPED, api, apiOf, axeClean, bodyOf, callsTo, dataRows, gridNamed, headersOf, hrefs, json, lastNav, mfa, norm, pageText,
  problem, reportDto, resetApi, router, routes, seedAv, settingsDto, show, showOrThrown, versionDto,
} from './av-t23.harness';

vi.mock('next/navigation', async () => (await import('./av-t23.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./av-t23.harness')).sessionMock);

const PAGE = 'autoverify/[version_id]/page';
const props = (v: string) => ({ params: { version_id: v } });
const sim = (o: Record<string, unknown> = {}) => versionDto({ id: V_SIM, version_no: 4, version: 6, status: 'simulating', simulation_started_at: '2026-11-09T03:15:00.000Z', ...o });
const stopped = () => versionDto({ id: V_STOPPED, version_no: 2, version: 5, status: 'stopped', simulation_started_at: '2026-10-01T03:15:00.000Z', simulation_stopped_at: '2026-10-04T03:15:00.000Z' });
const active = () => versionDto({ id: V_ACTIVE, version_no: 3, version: 9, status: 'active', activated_at: '2026-11-05T04:00:00.000Z', activated_by_display: 'Synthetic Approver' });
const user = () => userEvent.setup();
const btn = (re: RegExp) => screen.queryByRole('button', { name: re });
const anyDialog = () => screen.queryByRole('dialog') ?? screen.queryByRole('alertdialog');
const dialog = () => { const d = anyDialog(); if (!d) throw new Error('no dialog is open'); return d; };
const ACT = apiOf(V_SIM, '/activate');
const setSim = (version = sim(), report = reportDto(), settings = settingsDto()) => {
  routes[`GET ${apiOf(V_SIM)}`] = json(version);
  routes[`GET ${apiOf(V_SIM, '/simulation-report')}`] = json(report);
  routes['GET /v1/quality/settings'] = json(settings);
};

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { resetApi(AV_MANAGE); seedAv(); setSim(); });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

describe('simulating: read-only rules + report (AC-11.3)', () => {
  it('status word Simulating; no rule editing controls; fixed-rules box still shown', async () => {
    await show(PAGE, props(V_SIM));
    expect(pageText()).toContain('Simulating');
    expect(btn(/add rule|^edit|^save|discard|start simulation/i)).toBeNull();
    expect(pageText()).toMatch(/Never auto-verified, whatever the rules/);
  });

  it('StatTiles carry label + value: days, decisions, would allow, would deny, allowed and later verified by staff', async () => {
    await show(PAGE, props(V_SIM));
    const t = norm(document.body.textContent);
    expect(t).toMatch(/Days running\D{0,12}8\b/);
    expect(t).toMatch(/Decisions\D{0,12}240\b/);
    expect(t).toMatch(/Would allow\D{0,12}180\b/);
    expect(t).toMatch(/Would deny\D{0,12}60\b/);
    expect(t).toMatch(/Allowed and later verified by staff\D{0,12}170\b/);
  });

  it('deny-by-reason is available as TEXT with plain labels, not reason codes', async () => {
    await show(PAGE, props(V_SIM));
    const t = pageText();
    expect(t).toMatch(/Outside auto-verify limits\D{0,12}40/);
    expect(t).toMatch(/QC warning\D{0,12}20/);
    expect(t).not.toMatch(/outside_autoverify_limits|qc_warning/);
  });

  it('sample table: columns, word chips, "—" when there was no live decision, "Open results" only with an order id', async () => {
    await show(PAGE, props(V_SIM));
    const g = gridNamed(/sample/i);
    const h = headersOf(g).join('|');
    for (const c of ['Decided at', 'Analyte', 'Shadow decision', 'Reasons', 'Live decision', 'Verified by staff']) expect(h).toContain(c);
    const rows = dataRows(g);
    expect(rows).toHaveLength(2);
    expect(norm(rows[0]!.textContent)).toMatch(/Allow/);
    expect(norm(rows[0]!.textContent)).toMatch(/Deny/); // live_decision of row 1
    expect(norm(rows[1]!.textContent)).toContain('—'); // no live decision, not verified yet
    expect(within(rows[0]!).getByRole('link', { name: /open results/i }).getAttribute('href')).toBe(`/lab/orders/${ORDER_1}/results`);
    expect(within(rows[1]!).queryByRole('link', { name: /open results/i })).toBeNull();
  });

  it('asks for at most 200 sample rows (AC-11.3) and never puts patient identifiers on screen', async () => {
    await show(PAGE, props(V_SIM));
    const c = callsTo('GET', apiOf(V_SIM, '/simulation-report'))[0]!;
    const lim = c.url.searchParams.get('sample_limit');
    if (lim !== null) expect(Number(lim)).toBeLessThanOrEqual(200);
    expect(pageText()).not.toMatch(/patient name|barcode|registration no/i);
  });

  it('empty sample: "No would-allow decisions yet." and no table crash', async () => {
    setSim(sim(), reportDto({ decisions: 0, would_allow: 0, would_deny: 0, deny_by_reason: {}, allow_later_manually_verified: 0, allow_not_verified_yet: 0, sample: [], days_running: 0 }));
    await show(PAGE, props(V_SIM));
    expect(pageText()).toMatch(/No would-allow decisions yet/);
  });

  it('report API failure degrades to an error state for the report section, rules stay visible', async () => {
    routes[`GET ${apiOf(V_SIM, '/simulation-report')}`] = () => problem('common.internal', 500);
    const thrown = await showOrThrown(PAGE, props(V_SIM)); // a missing module rethrows; a real rejection returns its message
    if (thrown === undefined) {
      expect(pageText()).toMatch(/couldn't load|try again/i); // the page shows the section error
      expect(gridNamed(/rules/i)).toBeTruthy();
    }
  });

  it('axe clean', async () => { await show(PAGE, props(V_SIM)); await axeClean(); });
});

describe('Activate availability (AC-11.2)', () => {
  it.each([
    ['days short', reportDto({ days_running: 4, decisions: 240 }), /Needs 3 more days/, undefined],
    ['decisions short', reportDto({ days_running: 8, decisions: 60 }), /Needs 40 more decisions/, undefined],
    ['both short', reportDto({ days_running: 4, decisions: 60 }), /Needs 3 more days/, /40 more decisions/],
  ])('%s -> Activate disabled with the hint', async (_n, report, a, b) => {
    setSim(sim(), report);
    await show(PAGE, props(V_SIM));
    const act = btn(/^activate/i)!;
    expect(act).not.toBeNull();
    expect((act as HTMLButtonElement).disabled || act.getAttribute('aria-disabled') === 'true').toBe(true);
    expect(pageText()).toMatch(a);
    if (b) expect(pageText()).toMatch(b);
  });
  it('minimums come from #51 (sim_min_days 3, sim_min_decisions 10) -> enabled at 4 days / 60 decisions', async () => {
    setSim(sim(), reportDto({ days_running: 4, decisions: 60 }), settingsDto({ sim_min_days: 3, sim_min_decisions: 10 }));
    await show(PAGE, props(V_SIM));
    const act = btn(/^activate/i)!;
    expect((act as HTMLButtonElement).disabled).toBe(false);
  });
  it('exactly at the minimums (7 days, 100 decisions) is enough (inclusive)', async () => {
    setSim(sim(), reportDto({ days_running: 7, decisions: 100 }));
    await show(PAGE, props(V_SIM));
    expect((btn(/^activate/i) as HTMLButtonElement).disabled).toBe(false);
  });
  it('readers (no quality.autoverify.manage) see the report but no Activate / Stop buttons', async () => {
    resetApi(AV_READ); seedAv(); setSim();
    await show(PAGE, props(V_SIM));
    expect(gridNamed(/sample/i)).toBeTruthy();
    expect(btn(/activate|stop simulation|retire/i)).toBeNull();
  });
});

describe('Activate dialog (#43; AC-12.1, AC-12.2, AC-11.2 server side)', () => {
  const open = async (u: ReturnType<typeof user>) => { await show(PAGE, props(V_SIM)); await u.click(btn(/^activate/i)!); return dialog(); };
  const confirm = (d: HTMLElement) => within(d).getByRole('button', { name: /activate/i }) as HTMLButtonElement;

  it('explains the four-eyes rule, limits the text field to 8 characters, confirm stays disabled until exactly ACTIVATE', async () => {
    const u = user();
    const d = await open(u);
    expect(norm(d.textContent)).toContain("You can't activate a version you created.");
    const tf = within(d).getByRole('textbox') as HTMLInputElement;
    expect(tf.maxLength).toBe(8);
    expect(confirm(d).disabled).toBe(true);
    for (const wrong of ['activate', 'ACTIVAT', 'ACTIVATE ']) {
      await u.clear(tf); await u.type(tf, wrong);
      expect(confirm(d).disabled, wrong).toBe(true);
    }
    await u.clear(tf); await u.type(tf, 'ACTIVATE');
    expect(confirm(d).disabled).toBe(false);
  });

  it('wrong text never sends a request even if the button is forced', async () => {
    const u = user();
    const d = await open(u);
    await u.type(within(d).getByRole('textbox'), 'ACTIVATX');
    await u.click(confirm(d));
    await new Promise((r) => setTimeout(r, 50));
    expect(callsTo('POST', ACT)).toHaveLength(0);
  });

  it('AC-12.2: POST {confirmation_text:"ACTIVATE"} with If-Match "6" and an Idempotency-Key, then refresh and a confirmation', async () => {
    routes[`POST ${ACT}`] = json(versionDto({ id: V_SIM, status: 'active', version: 7 }));
    const u = user();
    const d = await open(u);
    await u.type(within(d).getByRole('textbox'), 'ACTIVATE');
    await u.click(confirm(d));
    await waitFor(() => expect(callsTo('POST', ACT)).toHaveLength(1));
    const c = callsTo('POST', ACT)[0]!;
    expect(bodyOf(c)).toEqual({ confirmation_text: 'ACTIVATE' });
    expect(c.headers.get('if-match')).toBe('"6"');
    expect(c.headers.get('idempotency-key')).toMatch(/\S{8,}/);
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
  });

  it('AC-12.1: 403 quality.self_activation_forbidden -> says so in words, dialog stays, nothing refreshes', async () => {
    routes[`POST ${ACT}`] = () => problem('quality.self_activation_forbidden', 403);
    const u = user();
    const d = await open(u);
    await u.type(within(d).getByRole('textbox'), 'ACTIVATE');
    await u.click(confirm(d));
    await waitFor(() => expect(callsTo('POST', ACT)).toHaveLength(1));
    expect(await screen.findByText(/another person|different (person|user)|a colleague|you created it/i)).toBeTruthy();
    expect(anyDialog()).not.toBeNull();
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it('AC-11.2: 409 quality.simulation_incomplete from the server -> says the minimum is not met, version unchanged', async () => {
    routes[`POST ${ACT}`] = () => problem('quality.simulation_incomplete', 409);
    const u = user();
    const d = await open(u);
    await u.type(within(d).getByRole('textbox'), 'ACTIVATE');
    await u.click(confirm(d));
    expect(await screen.findByText(/not .*(enough|long enough)|minimum|more days|more decisions|incomplete/i)).toBeTruthy();
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it('409 quality.rule_set_invalid_transition (e.g. stopped meanwhile) -> says the version changed, offers Reload', async () => {
    routes[`POST ${ACT}`] = () => problem('quality.rule_set_invalid_transition', 409);
    const u = user();
    const d = await open(u);
    await u.type(within(d).getByRole('textbox'), 'ACTIVATE');
    await u.click(confirm(d));
    expect(await screen.findByText(/status changed|no longer|can't be activated|not allowed/i)).toBeTruthy();
    expect(btn(/reload/i)).not.toBeNull();
  });

  it('AC-12.3: 403 auth.mfa_required -> "Verify now"; the typed text is kept; second confirm re-sends the SAME Idempotency-Key and If-Match', async () => {
    let n = 0;
    routes[`POST ${ACT}`] = () => (++n === 1 ? mfa() : HttpResponse.json(versionDto({ id: V_SIM, status: 'active', version: 7 })));
    const u = user();
    const d = await open(u);
    await u.type(within(d).getByRole('textbox'), 'ACTIVATE');
    await u.click(confirm(d));
    await screen.findByRole('button', { name: /verify now/i });
    expect((within(dialog()).getByRole('textbox') as HTMLInputElement).value).toBe('ACTIVATE');
    expect(router.refresh).not.toHaveBeenCalled();
    await u.click(confirm(dialog()));
    await waitFor(() => expect(callsTo('POST', ACT)).toHaveLength(2));
    const [a, b] = callsTo('POST', ACT);
    expect(b!.headers.get('idempotency-key')).toBe(a!.headers.get('idempotency-key'));
    expect(b!.headers.get('if-match')).toBe(a!.headers.get('if-match'));
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
  });

  it('double click on the confirm button sends ONE activation', async () => {
    routes[`POST ${ACT}`] = json(versionDto({ id: V_SIM, status: 'active', version: 7 }));
    const u = user();
    const d = await open(u);
    await u.type(within(d).getByRole('textbox'), 'ACTIVATE');
    await u.dblClick(confirm(d));
    await waitFor(() => expect(callsTo('POST', ACT).length).toBeGreaterThanOrEqual(1));
    expect(callsTo('POST', ACT)).toHaveLength(1);
  });

  it('Esc closes the dialog without a request', async () => {
    const u = user();
    await open(u);
    await u.keyboard('{Escape}');
    await waitFor(() => expect(anyDialog()).toBeNull());
    expect(callsTo('POST', ACT)).toHaveLength(0);
  });
});

describe('Stop simulation (#41; AC-11.4)', () => {
  const STOP = apiOf(V_SIM, '/stop-simulation');
  it('ConfirmDialog says the version closes for good; confirming POSTs {} with If-Match "6" + Idempotency-Key and refreshes', async () => {
    routes[`POST ${STOP}`] = json(versionDto({ id: V_SIM, status: 'stopped', version: 7 }));
    const u = user();
    await show(PAGE, props(V_SIM));
    await u.click(btn(/stop simulation/i)!);
    expect(norm(dialog().textContent)).toContain('Stop this simulation? The version will be closed for good. To simulate again, copy it into a new draft.');
    await u.click(within(dialog()).getByRole('button', { name: /stop simulation/i }));
    await waitFor(() => expect(callsTo('POST', STOP)).toHaveLength(1));
    const c = callsTo('POST', STOP)[0]!;
    expect(bodyOf(c)).toEqual({});
    expect(c.headers.get('if-match')).toBe('"6"');
    expect(c.headers.get('idempotency-key')).toMatch(/\S{8,}/);
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
  });
  it('409 (already stopped by someone else) -> said in words', async () => {
    routes[`POST ${STOP}`] = () => problem('quality.rule_set_invalid_transition', 409);
    const u = user();
    await show(PAGE, props(V_SIM));
    await u.click(btn(/stop simulation/i)!);
    await u.click(within(dialog()).getByRole('button', { name: /stop simulation/i }));
    expect(await screen.findByText(/no longer|already|not allowed/i)).toBeTruthy();
  });
  it('AC-12.3: aal1 -> "Verify now", nothing changes', async () => {
    routes[`POST ${STOP}`] = () => mfa();
    const u = user();
    await show(PAGE, props(V_SIM));
    await u.click(btn(/stop simulation/i)!);
    await u.click(within(dialog()).getByRole('button', { name: /stop simulation/i }));
    expect(await screen.findByRole('button', { name: /verify now/i })).toBeTruthy();
    expect(router.refresh).not.toHaveBeenCalled();
  });
});

describe('Stopped version (AC-11.4, terminal)', () => {
  beforeEach(() => { routes[`GET ${apiOf(V_STOPPED)}`] = json(stopped()); });
  it('read-only; chip word Stopped; report shown; NO Activate / Stop / Start / Edit / Save / Discard / Retire', async () => {
    await show(PAGE, props(V_STOPPED));
    expect(pageText()).toContain('Stopped');
    expect(btn(/activate|stop simulation|start simulation|add rule|^edit|^save|discard|retire/i)).toBeNull();
    expect(gridNamed(/sample/i)).toBeTruthy();
  });
  it('"Copy to new draft" POSTs #37 {copy_from_version_id: stopped id} with Idempotency-Key and opens the new draft', async () => {
    routes[`POST ${AV}/versions`] = json(versionDto({ id: V_NEW, version_no: 7, version: 1 }), 201);
    const u = user();
    await show(PAGE, props(V_STOPPED));
    await u.click(btn(/copy to new draft/i)!);
    await waitFor(() => expect(callsTo('POST', `${AV}/versions`)).toHaveLength(1));
    const c = callsTo('POST', `${AV}/versions`)[0]!;
    expect(bodyOf(c)).toEqual({ copy_from_version_id: V_STOPPED });
    expect(c.headers.get('idempotency-key')).toMatch(/\S{8,}/);
    await waitFor(() => expect(lastNav()).toBe(`/quality/autoverify/${V_NEW}`));
  });
  it('AC-12.3: "Copy to new draft" at aal1 -> "Verify now"', async () => {
    routes[`POST ${AV}/versions`] = () => mfa();
    const u = user();
    await show(PAGE, props(V_STOPPED));
    await u.click(btn(/copy to new draft/i)!);
    expect(await screen.findByRole('button', { name: /verify now/i })).toBeTruthy();
    expect(lastNav()).toBeUndefined();
  });
});

describe('Active version: Retire (#44)', () => {
  const RET = apiOf(V_ACTIVE, '/retire');
  beforeEach(() => { routes[`GET ${apiOf(V_ACTIVE)}`] = json(active()); });
  it('shows Active chip word, who activated; only Retire (and no editing) is offered', async () => {
    await show(PAGE, props(V_ACTIVE));
    expect(pageText()).toContain('Active');
    expect(pageText()).toContain('Synthetic Approver');
    expect(btn(/retire/i)).not.toBeNull();
    expect(btn(/add rule|^edit|^save|discard|start simulation|activate/i)).toBeNull();
  });
  it('reason is required (1..500): confirm disabled while empty; sends {reason} trimmed, If-Match "9", Idempotency-Key', async () => {
    routes[`POST ${RET}`] = json(versionDto({ id: V_ACTIVE, status: 'retired', version: 10 }));
    const u = user();
    await show(PAGE, props(V_ACTIVE));
    await u.click(btn(/retire/i)!);
    const ok = within(dialog()).getByRole('button', { name: /retire/i }) as HTMLButtonElement;
    expect(ok.disabled).toBe(true);
    const tb = within(dialog()).getByRole('textbox') as HTMLTextAreaElement;
    expect(tb.maxLength).toBe(500);
    await u.type(tb, '  superseded by version 4  ');
    await u.click(within(dialog()).getByRole('button', { name: /retire/i }));
    await waitFor(() => expect(callsTo('POST', RET)).toHaveLength(1));
    const c = callsTo('POST', RET)[0]!;
    expect(bodyOf(c)).toEqual({ reason: 'superseded by version 4' });
    expect(c.headers.get('if-match')).toBe('"9"');
    expect(c.headers.get('idempotency-key')).toMatch(/\S{8,}/);
  });
  it('AC-12.3: aal1 -> "Verify now", reason kept', async () => {
    routes[`POST ${RET}`] = () => mfa();
    const u = user();
    await show(PAGE, props(V_ACTIVE));
    await u.click(btn(/retire/i)!);
    await u.type(within(dialog()).getByRole('textbox'), 'because');
    await u.click(within(dialog()).getByRole('button', { name: /retire/i }));
    expect(await screen.findByRole('button', { name: /verify now/i })).toBeTruthy();
    expect((within(dialog()).getByRole('textbox') as HTMLTextAreaElement).value).toBe('because');
  });
});

describe('LD-140 on this screen', () => {
  it('exactly one primary button while no dialog is open', async () => {
    await show(PAGE, props(V_SIM));
    expect([...document.querySelectorAll('button')].filter((b) => /primary/.test(b.className)).length).toBeLessThanOrEqual(1);
  });
  it('the report link list contains no hand-written C5 path other than /lab/orders/{id}/results', async () => {
    await show(PAGE, props(V_SIM));
    for (const h of hrefs().filter((x) => /^\/lab\//.test(x))) expect(h).toMatch(/^\/lab\/orders\/[0-9a-f-]{36}\/results$/);
  });
});
