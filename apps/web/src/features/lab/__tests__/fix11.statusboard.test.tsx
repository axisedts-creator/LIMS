// @vitest-environment jsdom
// T0D-FIX-11 (LD-455; founder order 2026-11-22 22:06 NPT), /lab/status-board:
//   done_when (2) every <table> on the screen is the kit table (class lims-table), no raw table with centred headers;
//   done_when (4) the first board read failing (mocked 400 and 500) shows the kit inline error with the reference inside the page (title kept), not an empty board
//   that reads as "no registrations"; a 200 with no rows keeps the honest empty state; no permission = no api call (x-permission check first).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { ApiError } from '@/core/api/server-fetch';
import { t } from '@/core/i18n/messages';
import { hasAlert, norm, titles } from '@/__tests__/uidash1.helpers';

const h = vi.hoisted(() => ({ perms: ['lab.status_board.read'] as string[] }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/lab/status-board',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: h.perms, displayName: 'Synthetic Tech', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/lab/status-board',
}));
vi.mock('@/features/lab/server/read.server', () => ({ getStatusBoard: vi.fn() }));
vi.mock('@/features/frontdesk/server/read.server', () => ({ listCentres: vi.fn() }));
vi.mock('@/features/lab/server/actions', () => ({ getStatusBoardAction: vi.fn() }));

const REF = '01933b6f-0a11-7e2b-8c55-1d2e3f405165';
const CENTRE = '01a1a98a-ac40-7000-8000-000000000003';
const row = (n: number) => ({
  order_id: `01a1a98a-ac40-7000-8000-${String(500 + n).padStart(12, '0')}`, registration_no: `REG-8${String(n).padStart(5, '0')}`, centre_id: CENTRE,
  patient_display: { full_name: `Synthetic Patient ${n}`, age_sex: '30 Y / F' }, board_status: 'in_lab', rejected_specimens: 0, priority: 'routine', last_released_at: undefined,
});
const fail = (status: number, code: string) => new ApiError(status, { type: `urn:lims:error:${code}`, title: 'Synthetic failure', status, code, request_id: REF } as never);

async function page() {
  const { getStatusBoard } = await import('@/features/lab/server/read.server');
  const { listCentres } = await import('@/features/frontdesk/server/read.server');
  vi.mocked(listCentres).mockResolvedValue([{ id: CENTRE, name: 'Synthetic Centre A1' }] as never);
  const { default: StatusBoardPage } = await import('../../../app/(staff)/lab/status-board/page');
  return { getStatusBoard: vi.mocked(getStatusBoard), render: async () => render(await StatusBoardPage({ searchParams: Promise.resolve({}) })) };
}

beforeEach(() => { h.perms = ['lab.status_board.read']; });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('/lab/status-board', () => {
  it('done_when 2: every table on the screen is the kit table (no raw table, no centred headers)', async () => {
    const p = await page();
    p.getStatusBoard.mockResolvedValue({ data: [row(1), row(2)], page: { limit: 50 } } as never);
    const { container } = await p.render();
    const tables = [...container.querySelectorAll('table')];
    expect(tables.length).toBeGreaterThan(0);
    expect(tables.filter((x) => !x.classList.contains('lims-table')).map((x) => x.querySelector('caption')?.textContent ?? '(no caption)'), 'tables that are not the kit DataTable').toEqual([]);
    expect(norm(container.textContent)).toContain('REG-800001');
  });

  it.each([[400, 'common.validation_failed'], [500, 'common.internal']])('done_when 4: the first board read fails with %i: title kept, ONE kit inline error with the reference, not an empty board', async (status, code) => {
    const p = await page();
    p.getStatusBoard.mockRejectedValue(fail(status, code));
    const { container } = await p.render();
    expect(titles(container)).toEqual([t('lab.nav.status_board')]);
    const err = container.querySelectorAll('.lims-state.lims-tone-danger');
    expect(err, 'one inline error state').toHaveLength(1);
    expect(norm(err[0]!.querySelector('.lims-state-ref')?.textContent), 'the reference of the failed call').toContain(REF);
    expect(norm(container.textContent), 'a failed read never reads as "no data"').not.toContain('No registrations in this period.');
  });

  it('a 200 with no rows keeps the honest empty state and no error', async () => {
    const p = await page();
    p.getStatusBoard.mockResolvedValue({ data: [], page: { limit: 50 } } as never);
    const { container } = await p.render();
    expect(norm(container.textContent)).toContain('No registrations in this period.');
    expect(container.querySelectorAll('.lims-tone-danger')).toHaveLength(0);
    expect(hasAlert(container)).toBe(false);
  });

  it('x-permission first: without lab.status_board.read no board read is made and no data is shown', async () => {
    h.perms = [];
    const p = await page();
    const { container } = await p.render();
    expect(p.getStatusBoard).not.toHaveBeenCalled();
    expect(norm(container.textContent)).toContain("You don't have access to this screen.");
  });
});
