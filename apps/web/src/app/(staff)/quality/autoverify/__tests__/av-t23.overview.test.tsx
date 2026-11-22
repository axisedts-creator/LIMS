// @vitest-environment jsdom
// C9.T-23 — Auto-verification overview `/quality/autoverify` (04-UI-UX §2.7; AC-10.1 create draft, AC-12.3 aal2 on #37).
// ASSUMED contract (the writer must follow): autoverify/page.tsx = default async server component `Page({ searchParams })`.
//   Reads #36 GET /v1/quality/autoverify/rule-set and #51 GET /v1/quality/settings (auto_verification_enabled). Needs quality.autoverify.read, checked BEFORE any API call;
//   without it: "You don't have access to this page", no call. #36 404 common.not_found = no rule set yet (empty state, NOT an error page).
//   "New version" (only with quality.autoverify.manage) opens a dialog: radios "Copy the active version" / "Copy another version" (+ Select) / "Start empty".
//   Confirm -> server action -> POST /v1/quality/autoverify/versions with Idempotency-Key and body {copy_from_version_id} or {definition:{schema_version:1,rules:[]}}; 201 -> router.push('/quality/autoverify/{id}').
//   403 auth.mfa_required -> warning Banner with a "Verify now" button; dialog and input stay; pressing confirm again re-sends with the SAME Idempotency-Key. 422 quality.rule_set_invalid -> danger text in the dialog.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse } from 'msw';
import {
  AV, AV_MANAGE, AV_READ, V_ACTIVE, V_DRAFT, V_NEW, V_SIM, V_STOPPED, api, axeClean, bodyOf, calls, callsTo, dataRows, gridNamed, headersOf, hrefs, json, lastNav, mfa, norm, pageText,
  problem, resetApi, routes, ruleSetDto, seedAv, settingsDto, show, showOrThrown, versionDto,
} from './av-t23.harness';

vi.mock('next/navigation', async () => (await import('./av-t23.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./av-t23.harness')).sessionMock);

const PAGE = 'autoverify/page';
const user = () => userEvent.setup();
const btn = (re: RegExp) => screen.queryByRole('button', { name: re });
const dialog = () => { const d = screen.queryByRole('dialog') ?? screen.queryByRole('alertdialog'); if (!d) throw new Error('no dialog is open'); return d; };

beforeAll(() => api.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => { resetApi(AV_MANAGE); seedAv(); });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

describe('access and errors', () => {
  it('without quality.autoverify.read: permission-denied state and NO API call', async () => {
    resetApi([]);
    await show(PAGE);
    expect(pageText()).toMatch(/You don't have access to this page/);
    expect(calls).toHaveLength(0);
  });
  it('quality.qc_run.read alone is not enough (autoverify has its own read permission)', async () => {
    resetApi(['quality.qc_run.read']);
    await show(PAGE);
    expect(pageText()).toMatch(/You don't have access to this page/);
    expect(calls).toHaveLength(0);
  });
  it('#36 404 = no rule set yet: the page renders (no throw) and manage holders can still create the first version', async () => {
    routes[`GET ${AV}/rule-set`] = () => problem('common.not_found', 404);
    await show(PAGE);
    expect(btn(/new version/i)).not.toBeNull();
    expect(screen.queryByText(/couldn't load/i)).toBeNull();
  });
  // T0D-BUILD-5 (LD-455, founder 2026-11-22 22:06 NPT) replaces "API 5xx rejects so error.tsx takes over": a failed call is shown inside the page
  // (kit inline error with the reference), never as a thrown page or an empty section. The 404 / other-failure matrix is in features/quality/__tests__/t0dbuild5.pages.test.tsx.
  it('API 5xx: the page renders the kit inline error with the reference instead of throwing', async () => {
    routes[`GET ${AV}/rule-set`] = () => problem('common.internal', 500, { request_id: '01a20347-aa1c-7818-bbaa-bbbbbbbbbbbb' });
    expect(await showOrThrown(PAGE)).toBeUndefined();
    expect(pageText()).toMatch(/Reference:\s*01a20347-aa1c-7818-bbaa-bbbbbbbbbbbb/);
  });
});

describe('content (04-UI-UX §2.7)', () => {
  it.each([[true, /Auto-verification is ON for your lab/], [false, /Auto-verification is OFF for your lab/]])('status line from #51 (enabled=%s) with the Admin pointer', async (on, re) => {
    routes['GET /v1/quality/settings'] = json(settingsDto({ auto_verification_enabled: on }));
    await show(PAGE);
    expect(pageText()).toMatch(re);
    expect(pageText()).toMatch(/Admin › Tenant settings/);
  });

  it('Active card: version number, who/when activated, rule count; Simulating card links to its report', async () => {
    await show(PAGE);
    const t = pageText();
    expect(t).toMatch(/Active version/i);
    expect(t).toContain('Synthetic Approver');
    expect(t).toMatch(/\b12 rules\b/);
    expect(t).toMatch(/Simulating version/i);
    expect(btn(/open report/i) ?? screen.queryByRole('link', { name: /open report/i })).not.toBeNull();
    expect(hrefs()).toContain(`/quality/autoverify/${V_SIM}`);
  });

  it('versions table: columns of 04-UI-UX §2.7, newest first, status shown as a WORD, each row links to the editor', async () => {
    await show(PAGE);
    const g = gridNamed(/versions/i);
    const h = headersOf(g).join('|');
    for (const c of ['Version', 'Status', 'Rules', 'Created by', 'Simulation period', 'Activated by']) expect(h).toContain(c);
    const rows = dataRows(g).map((r) => norm(r.textContent));
    expect(rows).toHaveLength(6);
    ['Discarded', 'Draft', 'Simulating', 'Active', 'Stopped', 'Retired'].forEach((w, i) => expect(rows[i]).toContain(w));
    expect(rows[3]).toContain('Synthetic Approver');
    const links = hrefs();
    for (const v of [V_DRAFT, V_SIM, V_ACTIVE, V_STOPPED]) expect(links).toContain(`/quality/autoverify/${v}`);
  });

  it('a "Decisions" link goes to /quality/autoverify/decisions', async () => {
    await show(PAGE);
    expect(hrefs()).toContain('/quality/autoverify/decisions');
  });

  it('axe clean', async () => { await show(PAGE); await axeClean(); });
});

describe('roles', () => {
  it('a reader (autoverify.read only) sees the data but no "New version" button', async () => {
    resetApi(AV_READ); seedAv();
    await show(PAGE);
    expect(gridNamed(/versions/i)).toBeTruthy();
    expect(btn(/new version/i)).toBeNull();
  });
  it('at most ONE primary button on the page (LD-140)', async () => {
    await show(PAGE);
    const primaries = [...document.querySelectorAll('button')].filter((b) => /primary/.test(b.className));
    expect(primaries.length).toBeLessThanOrEqual(1);
  });
});

describe('New version (#37, AC-10.1)', () => {
  const POST = `${AV}/versions`;
  beforeEach(() => { routes[`POST ${POST}`] = json(versionDto({ id: V_NEW, version_no: 7, version: 1 }), 201); });

  it('copy the active version -> POST {copy_from_version_id: active} with Idempotency-Key, then opens the new draft', async () => {
    const u = user();
    await show(PAGE);
    await u.click(btn(/new version/i)!);
    await u.click(within(dialog()).getByRole('radio', { name: /copy the active version/i }));
    await u.click(within(dialog()).getByRole('button', { name: /^(create|create draft|create version)$/i }));
    await waitFor(() => expect(callsTo('POST', POST)).toHaveLength(1));
    const c = callsTo('POST', POST)[0]!;
    expect(bodyOf(c)).toEqual({ copy_from_version_id: V_ACTIVE });
    expect(c.headers.get('idempotency-key')).toMatch(/\S{8,}/);
    await waitFor(() => expect(lastNav()).toBe(`/quality/autoverify/${V_NEW}`));
  });

  it('copy ANOTHER version -> the chosen version id is sent (a stopped version can be copied, AC-11.4)', async () => {
    const u = user();
    await show(PAGE);
    await u.click(btn(/new version/i)!);
    await u.click(within(dialog()).getByRole('radio', { name: /copy another version/i }));
    await u.selectOptions(within(dialog()).getByRole('combobox'), V_STOPPED);
    await u.click(within(dialog()).getByRole('button', { name: /^(create|create draft|create version)$/i }));
    await waitFor(() => expect(callsTo('POST', POST)).toHaveLength(1));
    expect(bodyOf(callsTo('POST', POST)[0])).toEqual({ copy_from_version_id: V_STOPPED });
  });

  it('start empty -> POST {definition:{schema_version:1, rules:[]}} and NOT copy_from_version_id (exactly one of the two)', async () => {
    const u = user();
    await show(PAGE);
    await u.click(btn(/new version/i)!);
    await u.click(within(dialog()).getByRole('radio', { name: /start empty/i }));
    await u.click(within(dialog()).getByRole('button', { name: /^(create|create draft|create version)$/i }));
    await waitFor(() => expect(callsTo('POST', POST)).toHaveLength(1));
    expect(bodyOf(callsTo('POST', POST)[0])).toEqual({ definition: { schema_version: 1, rules: [] } });
  });

  it('422 quality.rule_set_invalid keeps the dialog open and says so in words', async () => {
    routes[`POST ${POST}`] = () => problem('quality.rule_set_invalid', 422, { errors: [{ path: '/definition/rules/0/key', code: 'common.validation_failed', message: 'duplicate key' }] });
    const u = user();
    await show(PAGE);
    await u.click(btn(/new version/i)!);
    await u.click(within(dialog()).getByRole('radio', { name: /copy the active version/i }));
    await u.click(within(dialog()).getByRole('button', { name: /^(create|create draft|create version)$/i }));
    await waitFor(() => expect(callsTo('POST', POST)).toHaveLength(1));
    expect(await screen.findByText(/rule set is not valid|isn't valid|invalid/i)).toBeTruthy();
    expect(dialog()).toBeTruthy();
    expect(lastNav()).toBeUndefined();
  });

  it('403 auth.mfa_required (aal1, AC-12.3): step-up prompt with "Verify now", nothing created, same Idempotency-Key on the retry', async () => {
    let n = 0;
    routes[`POST ${POST}`] = () => (++n === 1 ? mfa() : HttpResponse.json(versionDto({ id: V_NEW, version_no: 7, version: 1 }), { status: 201 }));
    const u = user();
    await show(PAGE);
    await u.click(btn(/new version/i)!);
    await u.click(within(dialog()).getByRole('radio', { name: /copy the active version/i }));
    await u.click(within(dialog()).getByRole('button', { name: /^(create|create draft|create version)$/i }));
    await waitFor(() => expect(callsTo('POST', POST)).toHaveLength(1));
    expect(await screen.findByRole('button', { name: /verify now/i })).toBeTruthy();
    expect(lastNav()).toBeUndefined();
    await u.click(within(dialog()).getByRole('button', { name: /^(create|create draft|create version)$/i }));
    await waitFor(() => expect(callsTo('POST', POST)).toHaveLength(2));
    const [a, b] = callsTo('POST', POST);
    expect(b!.headers.get('idempotency-key')).toBe(a!.headers.get('idempotency-key'));
    await waitFor(() => expect(lastNav()).toBe(`/quality/autoverify/${V_NEW}`));
  });

  it('a double click on confirm sends ONE request (race: two drafts must not be created)', async () => {
    const u = user();
    await show(PAGE);
    await u.click(btn(/new version/i)!);
    await u.click(within(dialog()).getByRole('radio', { name: /copy the active version/i }));
    const ok = within(dialog()).getByRole('button', { name: /^(create|create draft|create version)$/i });
    await u.dblClick(ok);
    await waitFor(() => expect(callsTo('POST', POST).length).toBeGreaterThanOrEqual(1));
    expect(callsTo('POST', POST)).toHaveLength(1);
  });
});

describe('no rule-set yet: "Copy the active version" is not offered', () => {
  it('first-ever version can only start empty', async () => {
    routes[`GET ${AV}/rule-set`] = json(ruleSetDto({ active_version_id: undefined, simulating_version_id: undefined, versions: [] }));
    const u = user();
    await show(PAGE);
    await u.click(btn(/new version/i)!);
    const r = within(dialog()).queryByRole('radio', { name: /copy the active version/i });
    expect(r === null || (r as HTMLInputElement).disabled).toBe(true);
  });
});
