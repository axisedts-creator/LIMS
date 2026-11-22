// @vitest-environment jsdom
// T0D-BUILD-5 (founder order 2026-11-22 22:06 NPT; LD-455), whole pages through the real server composers and MSW (api = fixture, no outside provider):
//  A. /quality/tat-alerts: names from the lookups the page already calls (C3 listDepartments, C2 listCentres), 'at least N' when the api says there is a next page.
//  B. /quality/autoverify (done_when 5): getAutoverifyRuleSet 404 common.not_found = "no rule set yet" (contract summary says so: "404 when none yet") -> kit empty state
//     'No auto-verification rules yet.' and NO control that turns auto-verification on (it stays OFF by design); every other failure -> kit inline ErrorState inside the page
//     (page title kept) with 'Reference: <request_id>' of the problem; never the empty state, never a thrown page, never the raw message or the token.
//  C. the notes the task must leave behind (gaps are written down, not invented).
// Harness: quality-t24 (MSW + session mock); the three mocks below point at it.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { HttpResponse } from 'msw';
import { CENTRE_1, CENTRE_2, TAT, TAT_ROWS, api, calls, callsTo, json, norm, pageText, problem, resetApi, routes, settingsDto, show, showOrThrown, tatPage } from './quality-t24.harness';

vi.mock('next/navigation', async () => (await import('./quality-t24.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./quality-t24.harness')).sessionMock);

const AV_RULE_SET = '/v1/quality/autoverify/rule-set';
const AV_READ = ['quality.autoverify.read'];
const AV_MANAGE = ['quality.autoverify.read', 'quality.autoverify.manage'];
const REQ_ID = '01a20347-aa1c-7818-bbaa-aaaaaaaaaaaa'; // synthetic request id
const EMPTY = 'No auto-verification rules yet.';

beforeAll(() => api.listen({ onUnhandledFrame: 'error' }));
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

// ---------------------------------------------------------------- A. TAT page
describe('/quality/tat-alerts through the page composer', () => {
  beforeEach(() => resetApi(['quality.tat_alert.read']));
  const grid = () => screen.getAllByRole('grid').find((g) => g.getAttribute('aria-label') === 'TAT alerts')!;
  const rowOf = (code: string) => [...grid().querySelectorAll('[role="row"]')].find((r) => norm(r.textContent).includes(code))!;
  const col = (name: string) => [...grid().querySelectorAll('[role="columnheader"]')].findIndex((h) => norm(h.textContent) === name);

  it('Department and Centre columns show the names from the lookups, not ids', async () => {
    await show('tat-alerts/page');
    const gloc = rowOf('GLU'); // CENTRE_1
    const tsh = rowOf('TSH'); // CENTRE_2
    expect(norm(gloc.children[col('Department')]!.textContent)).toBe('Biochemistry');
    expect(norm(gloc.children[col('Centre')]!.textContent)).toBe('Synthetic Centre One');
    expect(norm(tsh.children[col('Centre')]!.textContent)).toBe('Synthetic Centre Two');
    expect(grid().querySelector(`[title="${CENTRE_1}"]`)).toBeNull();
    expect(grid().querySelector(`[title="${CENTRE_2}"]`)).toBeNull();
  });
  it('a lookup that fails keeps the page and falls back to the id for that column only', async () => {
    routes['GET /v1/identity/centres'] = () => problem('common.internal', 500);
    await show('tat-alerts/page');
    const gloc = rowOf('GLU');
    expect(norm(gloc.children[col('Department')]!.textContent)).toBe('Biochemistry');
    expect(gloc.children[col('Centre')]!.querySelector(`[title="${CENTRE_1}"]`)).not.toBeNull();
  });
  it("the api says there is a next page: the tiles read 'at least N' and the Next button is on", async () => {
    routes[`GET ${TAT}`] = json(tatPage(TAT_ROWS, { page: { limit: 50, next_cursor: 'cursor-next-synthetic' } }));
    await show('tat-alerts/page');
    expect(pageText()).toMatch(/at least\s*2\b/i); // two breached rows on the page (GLU, NAK)
    expect(screen.getByRole('button', { name: /next/i }).hasAttribute('disabled')).toBe(false);
  });
  it('last page: plain counts, no "at least"', async () => {
    await show('tat-alerts/page');
    expect(pageText()).not.toMatch(/at least/i);
  });
  it('still one list call to the api per render (the totals add no call, no fan-out over pages)', async () => {
    routes[`GET ${TAT}`] = json(tatPage(TAT_ROWS, { page: { limit: 50, next_cursor: 'cursor-next-synthetic' } }));
    await show('tat-alerts/page');
    expect(callsTo('GET', TAT)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- B. auto-verification overview
describe('/quality/autoverify: 404 = no rule set yet; every other failure is shown in the page', () => {
  const PAGE = 'autoverify/page';
  beforeEach(() => { resetApi(AV_MANAGE); routes['GET /v1/quality/settings'] = json(settingsDto({ auto_verification_enabled: false })); });
  const state = () => document.querySelector('.lims-state');
  const danger = () => document.querySelector('.lims-state.lims-tone-danger');
  const controls = () => [...screen.queryAllByRole('button'), ...screen.queryAllByRole('link')].map((e) => norm(e.textContent));

  it('404 common.not_found: the kit empty state says "No auto-verification rules yet." and nothing is shown as an error', async () => {
    routes[`GET ${AV_RULE_SET}`] = () => problem('common.not_found', 404);
    await show(PAGE);
    expect(state(), 'kit state block').not.toBeNull();
    expect(norm(document.body.textContent)).toContain(EMPTY);
    expect(danger()).toBeNull();
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(pageText()).not.toMatch(/couldn't load|Reference:/i);
  });
  it('404: auto-verification stays OFF by design: no button or link that turns it on', async () => {
    routes[`GET ${AV_RULE_SET}`] = () => problem('common.not_found', 404);
    await show(PAGE);
    expect(controls().filter((t) => /turn on|switch on|enable|start auto|activate|go live/i.test(t))).toEqual([]);
    expect(callsTo('PUT', '/v1/quality/settings')).toHaveLength(0);
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });
  it('404 for a reader without manage: the empty state, and no "New version" button', async () => {
    resetApi(AV_READ);
    routes['GET /v1/quality/settings'] = json(settingsDto());
    routes[`GET ${AV_RULE_SET}`] = () => problem('common.not_found', 404);
    await show(PAGE);
    expect(norm(document.body.textContent)).toContain(EMPTY);
    expect(screen.queryByRole('button', { name: /new version/i })).toBeNull();
  });
  it('404 and the settings read also fails (reader without qc_run.read): still the empty state, never an error', async () => {
    routes[`GET ${AV_RULE_SET}`] = () => problem('common.not_found', 404);
    routes['GET /v1/quality/settings'] = () => problem('auth.forbidden', 403);
    await show(PAGE);
    expect(norm(document.body.textContent)).toContain(EMPTY);
    expect(danger()).toBeNull();
  });
  it('a rule set that exists does NOT show the empty state', async () => {
    routes[`GET ${AV_RULE_SET}`] = json({ id: '01a1a98a-ac40-7000-8000-0000000c5000', version: 1, versions: [] });
    await show(PAGE);
    expect(norm(document.body.textContent)).not.toContain(EMPTY);
  });

  it.each([
    [500, 'common.internal'],
    [503, 'common.dependency_unavailable'],
    [400, 'common.validation_failed'],
    [429, 'common.rate_limited'],
  ])('%i %s: kit inline error with the reference, inside the page (no throw, no empty state, page title kept)', async (status, code) => {
    routes[`GET ${AV_RULE_SET}`] = () => problem(code, status, { request_id: REQ_ID });
    expect(await showOrThrown(PAGE), 'the page must render the error itself, not throw to error.tsx').toBeUndefined();
    expect(danger(), 'kit ErrorState (tone danger)').not.toBeNull();
    expect(norm(danger()!.textContent)).toMatch(new RegExp(`Reference:\\s*${REQ_ID}`));
    expect(norm(document.body.textContent)).not.toContain(EMPTY);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toMatch(/auto-verification/i);
  });
  it('the error shows neither the raw problem message, nor the status line, nor the token', async () => {
    routes[`GET ${AV_RULE_SET}`] = () => problem('common.internal', 500, { request_id: REQ_ID, detail: 'select * from quality.autoverify_rule_set failed at 10.0.0.7' });
    await showOrThrown(PAGE);
    const t = norm(document.body.textContent);
    expect(t).not.toMatch(/select \* from|10\.0\.0\.7|common\.internal|\(500\)/);
    expect(document.body.innerHTML).not.toContain('jwt-synthetic');
  });
  it('an answer that is not a problem document (gateway page): inline error, no "undefined" reference', async () => {
    routes[`GET ${AV_RULE_SET}`] = () => new HttpResponse('<html>Bad gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } });
    expect(await showOrThrown(PAGE)).toBeUndefined();
    expect(danger()).not.toBeNull();
    expect(norm(document.body.textContent)).not.toMatch(/undefined|Bad gateway/);
  });
  it('without quality.autoverify.read: permission-denied state, NO api call (the check still comes first)', async () => {
    await new Promise((r) => setTimeout(r, 100)); // let a request still in flight from the previous test land before the call log is cleared
    resetApi([]);
    await show(PAGE);
    expect(pageText()).toMatch(/You don't have access to this page/);
    expect(calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([]);
  });
});

// ---------------------------------------------------------------- C. the notes the task leaves behind
describe('notes/T0D-BUILD-5-left.md records the gaps instead of inventing', () => {
  const left = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', '..', '.orchestra', 'notes', 'T0D-BUILD-5-left.md');
  it('exists and names the missing total on listTatAlerts', () => {
    expect(existsSync(left), `${left} must be written by the writer (done_when 2: no total/count field in listTatAlerts)`).toBe(true);
    const t = readFileSync(left, 'utf8');
    expect(t).toMatch(/listTatAlerts/);
    expect(t).toMatch(/total|count/i);
  });
});
