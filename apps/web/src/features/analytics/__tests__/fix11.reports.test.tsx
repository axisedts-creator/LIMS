// @vitest-environment jsdom
// T0D-FIX-11 (LD-455; founder order 2026-11-22 22:06 NPT), done_when (2) and (4) for /analytics/reports (hub) and /analytics/collections:
//   (2) no raw table with centred headers: every <table> on the screen is the kit DataTable (class lims-table), the chart's data table included.
//   (4) a failed api call (mocked 400 and 500) shows the kit inline error with the reference inside the page (title kept), never an empty section.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { HttpResponse } from 'msw';
import { hasAlert, norm, titles } from '@/__tests__/uidash1.helpers';
import { ALL, api, bySlug, resetApi, respond, session, show } from './an-t19.harness';

vi.mock('next/navigation', async () => (await import('./an-t19.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./an-t19.harness')).sessionMock);

beforeAll(() => api.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => { resetApi(); session.permissions = [...ALL]; });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const REF = '01933b6f-0a11-7e2b-8c55-1d2e3f405164';
const prob = (status: number, code: string) => HttpResponse.json({ type: `urn:lims:error:${code}`, title: 'Synthetic failure', status, code, request_id: REF }, { status });
const SCREENS = [
  { kind: 'hub', path: () => bySlug('income').paths[0]! },
  { kind: 'collections', path: () => '/v1/analytics/reports/collections' },
] as const;

describe.each(SCREENS)('$kind', (s) => {
  it('done_when 2: every table on the screen is the kit table (no raw table, no centred headers)', async () => {
    const { container } = await show(s.kind);
    const tables = [...container.querySelectorAll('table')];
    expect(tables.length, 'the screen has tables').toBeGreaterThan(0);
    const raw = tables.filter((t) => !t.classList.contains('lims-table')).map((t) => `${t.querySelector('caption')?.textContent ?? '(no caption)'}: ${t.className || '(no class)'}`);
    expect(raw, 'tables that are not the kit DataTable').toEqual([]);
  });

  it.each([[400, 'common.validation_failed'], [500, 'common.internal']])('done_when 4: API %i on the report read: title kept, ONE kit inline error with the reference, no figures', async (status, code) => {
    respond[s.path()] = () => prob(status, code);
    const { container } = await show(s.kind);
    expect(titles(container)).toHaveLength(1);
    const err = container.querySelectorAll('.lims-state.lims-tone-danger');
    expect(err, 'one inline error state').toHaveLength(1);
    expect(norm(err[0]!.querySelector('.lims-state-ref')?.textContent), 'the reference of the failed call').toContain(REF);
    expect(container.querySelectorAll('.lims-stat'), 'no tile drawn from a failed read').toHaveLength(0);
    expect(norm(container.textContent)).not.toMatch(/No data (yet|for this period)/);
    expect(hasAlert(container)).toBe(false);
  });
});
