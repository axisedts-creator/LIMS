// @vitest-environment jsdom
// T0D-FIX-11 (LD-455; founder order 2026-11-22 22:06 NPT), done_when (3) and (4): /analytics/referral-incentive.
//   403 common.feature_disabled (by design, the feature stays off): the kit empty state "This report is switched off for your lab." and no error page, no figure.
//   Any other failure (400, 403 with another code, 500): the kit inline error WITH the reference, inside the page (title kept); never an empty section.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { hasAlert, norm, titles } from '@/__tests__/uidash1.helpers';
import { api, problem, resetApi, routes, show } from './an-t20.harness';

vi.mock('next/navigation', async () => (await import('./an-t20.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./an-t20.harness')).sessionMock);

const PAGE = 'referral-incentive/page';
const PATH = 'GET /v1/analytics/reports/referral-incentive';
const REF = '01933b6f-0a11-7e2b-8c55-1d2e3f405163';
const MESSAGE = 'This report is switched off for your lab.';

beforeAll(() => api.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => resetApi(['analytics.referral_report.read']));
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

describe('referral report: feature off is a calm empty state (done_when 3)', () => {
  it('403 common.feature_disabled: kit empty state with the exact message, no alert, no danger tone, no reference', async () => {
    routes[PATH] = () => problem('common.feature_disabled', 403, { request_id: REF });
    const { container } = await show(PAGE);
    expect(titles(container)).toHaveLength(1);
    const state = [...container.querySelectorAll('.lims-state')].find((s) => norm(s.textContent).includes(MESSAGE));
    expect(state, `kit empty state "${MESSAGE}" in: ${norm(container.textContent)}`).toBeTruthy();
    expect(state!.classList.contains('lims-tone-danger')).toBe(false);
    expect(hasAlert(container)).toBe(false);
    expect(container.querySelectorAll('.lims-tone-danger')).toHaveLength(0);
    expect(norm(container.textContent)).not.toMatch(/not enabled for your lab|could not be loaded|Reference/i);
  });
});

describe('referral report: any other failure is an inline error with the reference (done_when 3, 4)', () => {
  it.each([
    [400, 'common.validation_failed'],
    [403, 'auth.forbidden'],
    [500, 'common.internal'],
  ])('API %i %s: title kept, ONE kit inline error with the reference, no switched-off message, no figures', async (status, code) => {
    routes[PATH] = () => problem(code, status, { request_id: REF });
    const { container } = await show(PAGE);
    expect(titles(container)).toHaveLength(1);
    const err = container.querySelectorAll('.lims-state.lims-tone-danger');
    expect(err, 'one inline error state').toHaveLength(1);
    expect(norm(err[0]!.querySelector('.lims-state-ref')?.textContent), 'the reference of the failed call').toContain(REF);
    expect(norm(container.textContent)).not.toContain(MESSAGE);
    expect(container.querySelectorAll('.lims-stat')).toHaveLength(0);
  });
});
