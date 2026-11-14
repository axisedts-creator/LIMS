// @vitest-environment jsdom
// RS-C5 — visual regression snapshots of the key screens (10-DESIGN-SYSTEM s7.4: "RS tasks record snapshots of their key screens"). Markup-level (DOM) snapshots, ids normalised, Date frozen.
// LD-170: this test does NOT write the snapshot. The WRITER records __tests__/__snapshots__/rs-c5.screens.test.tsx.snap ONCE, LAST, after the screens are restyled and the behaviour tests pass:
//   pnpm --dir apps/web exec vitest run --config src/features/lab/__tests__/vitest.rs-c5.config.ts -u rs-c5.screens
// Under CI=true a missing snapshot fails (right reason now: nothing recorded). A snapshot recorded from the implementation is a regression baseline, not proof that the look is right.
// Screens: receive (scan box + tabs with counts), collect/dispatch (tabs with counts), worklist with the right panel open, result entry (three tracks, source chip, delta).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { ReactNode } from 'react';
import { ToastProvider } from '@lims/ui/components/Toast';
import { CENTRES, CENTRE_A, DEPT, ORIGIN, REASONS, analytes, id, normalise, threeStateGrid, worklistItem } from './rs-c5.fixtures';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/lab/x',
  useSearchParams: () => new URLSearchParams(''),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: [], displayName: 'Synthetic Tech', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/lab/x',
}));
process.env.LIMS_ORIGIN_API = ORIGIN;

const api = setupServer(
  http.get(`${ORIGIN}/v1/lab/worklist-items`, () => HttpResponse.json({ data: [worklistItem(1, { priority: 'urgent' }), worklistItem(2)], page: { limit: 50 } })),
  http.get(`${ORIGIN}/v1/instruments/instruments`, () => HttpResponse.json({ data: [{ id: id(0x1a), display_name: 'Synthetic Analyser A' }], page: { limit: 50 } })),
);
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-14T09:00:00.000Z')); });
afterEach(() => { vi.useRealTimers(); cleanup(); api.resetHandlers(); localStorage.clear(); });
afterAll(() => api.close());

const wrap = (ui: ReactNode) => render(<ToastProvider>{ui}</ToastProvider>);

describe('RS-C5 key screens (DOM snapshots)', () => {
  it('receive: scan box, location, session-log tabs with counts', async () => {
    localStorage.setItem('lims.lab.receive.location', CENTRE_A);
    const { ReceiveScreen } = await import('../components/ReceiveScreen');
    const { container } = wrap(<ReceiveScreen centres={CENTRES} rejectionReasons={REASONS} recollectionDefault={false} permissions={['lab.specimen.receive', 'lab.specimen.reject', 'lab.specimen.read']} />);
    await screen.findByRole('tablist', { name: /session log/i });
    expect(normalise(container)).toMatchSnapshot();
  });

  it('collect / dispatch: tabs with counts', async () => {
    const { CollectDispatch } = await import('../components/CollectDispatch');
    const { container } = wrap(<CollectDispatch permissions={['lab.specimen.collect', 'lab.specimen.read']} />);
    await screen.findByRole('tablist');
    expect(normalise(container)).toMatchSnapshot();
  });

  it('worklist: table with the right panel open on the first sample', async () => {
    const { WorklistPage } = await import('../components/worklists/WorklistPage');
    const { container } = wrap(<WorklistPage departmentId={DEPT} permissions={['lab.worklist.read', 'lab.worksheet.manage']} />);
    const btn = await screen.findByRole('button', { name: /^Enter results E2600000101 CBC$/ });
    await userEvent.setup({ delay: null }).click(btn);
    await waitFor(() => expect(screen.getByRole('complementary', { name: /result entry/i }).textContent).toContain('1 of 3 resulted'));
    expect(normalise(container)).toMatchSnapshot();
  });

  it('result entry: three-step tracks (Entered / Senior technician / Pathologist), source chip, delta', async () => {
    const { ResultGrid } = await import('../components/grid/ResultGrid');
    const { container } = wrap(
      <ResultGrid data={threeStateGrid() as never} analytes={analytes} permissions={['lab.result.read', 'lab.result.enter', 'lab.result.verify', 'lab.result.approve']} patientId={id(7777)} returnReasons={[]} amendmentReasons={[]} />,
    );
    await screen.findByRole('region', { name: /progress.*CBC/i });
    expect(normalise(container)).toMatchSnapshot();
  });
});
