// @vitest-environment jsdom
// RS-C7 — visual regression snapshots of the key screens (10-DESIGN-SYSTEM s7.4: "RS tasks record snapshots of their key screens"). Markup-level (DOM) snapshots, ids normalised, Date frozen.
// LD-170: this test does NOT write the snapshot. The WRITER records __tests__/__snapshots__/rs-c7.screens.test.tsx.snap ONCE, LAST, after the screens are restyled and the behaviour tests pass:
//   pnpm --dir apps/web exec vitest run --config src/features/instruments/__tests__/vitest.rs-c7.config.ts -u rs-c7.screens
// Under CI=true a missing snapshot fails (right reason now: nothing recorded). A snapshot recorded from the implementation is a regression baseline, not proof that the look is right.
// Screens: instrument link cards, message log table, rejected uploads table, instrument overview with the commissioning stepper.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { ReactNode } from 'react';
import { ToastProvider } from '@lims/ui/components/Toast';
import { AGENTS_PICK, CENTRES, DRIVERS, INSTRUMENT_PICK, MANAGE, MESSAGES, ORIGIN, REJECTIONS, ROWS, full, normalise } from './rs-c7.fixtures';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/instruments/instruments',
  useSearchParams: () => new URLSearchParams(''),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: [], displayName: 'Synthetic Manager', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/instruments/instruments',
}));
process.env.LIMS_ORIGIN_API = ORIGIN;

const api = setupServer(http.all(`${ORIGIN}/*`, () => HttpResponse.json({})));
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-14T09:00:00.000Z')); });
afterEach(() => { vi.useRealTimers(); cleanup(); api.resetHandlers(); localStorage.clear(); });
afterAll(() => api.close());

const wrap = (ui: ReactNode) => render(<ToastProvider>{ui}</ToastProvider>);

describe('RS-C7 key screens (DOM snapshots)', () => {
  it('instruments: link cards (state dot + word, last message, unmapped)', async () => {
    const { InstrumentsList } = await import('../components/InstrumentsList');
    const { container } = wrap(<InstrumentsList instruments={ROWS as never} permissions={MANAGE} centres={CENTRES} agents={AGENTS_PICK as never} drivers={DRIVERS as never} />);
    await screen.findByRole('region', { name: 'Instruments' });
    expect(normalise(container)).toMatchSnapshot();
  });

  it('messages: log table with the existing columns', async () => {
    const { MessagesList } = await import('../components/MessagesList');
    const { container } = wrap(<MessagesList messages={MESSAGES as never} rejections={REJECTIONS as never} instruments={INSTRUMENT_PICK as never} agents={AGENTS_PICK as never} permissions={MANAGE} />);
    await screen.findByRole('grid', { name: /^messages$/i });
    expect(normalise(container)).toMatchSnapshot();
  });

  it('messages: rejected uploads table', async () => {
    const { MessagesList } = await import('../components/MessagesList');
    const { container } = wrap(<MessagesList messages={MESSAGES as never} rejections={REJECTIONS as never} instruments={INSTRUMENT_PICK as never} agents={AGENTS_PICK as never} permissions={MANAGE} />);
    await userEvent.setup({ delay: null }).click(screen.getByRole('tab', { name: 'Rejected uploads' }));
    await screen.findByRole('grid', { name: /rejected uploads/i });
    expect(normalise(container)).toMatchSnapshot();
  });

  it('instrument overview: commissioning checklist stepper (two of four done)', async () => {
    const { InstrumentDetail } = await import('../components/InstrumentDetail');
    const { container } = wrap(
      <InstrumentDetail
        instrument={full({ state: 'commissioning', go_live_checklist: { manual_reference_confirmed: true, sample_comparison_done: true, qc_comparison_done: false, mappings_reviewed: false } }) as never}
        agents={AGENTS_PICK as never}
        drivers={DRIVERS as never}
        permissions={MANAGE}
      />,
    );
    await screen.findByRole('region', { name: /commissioning checklist/i });
    expect(normalise(container)).toMatchSnapshot();
  });
});
