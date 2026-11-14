// @vitest-environment jsdom
// RS-C15 — visual regression snapshots of the key screens (10-DESIGN-SYSTEM s7.4 "RS tasks record snapshots of their key screens"; LD-170).
// These are a REGRESSION BASELINE, not proof the look is right (design review does that). The WRITER records them once, LAST, after the other rs-c15 tests pass:
//   pnpm --dir apps/web exec vitest run --config src/features/payments/__tests__/vitest.rs-c15.config.ts -u rs-c15.screens
// into __snapshots__/rs-c15.screens.test.tsx.snap (LD-170 lets the writer/debugger keep that file). With CI=true a missing snapshot FAILS, which is the state today.
// Do not edit a test or the implementation just to make a snapshot match. DOM is serialised (not pixels): react-aria generated ids are normalised.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  U, accounts, holdReasons, intentCodes, intentDetail, norm, paySettings, reconCodes, reconFindings, reconRuns, reconStats, refundCodes, refunds, reviewIntents, worksheets, wrap,
} from './rs-c15.fixtures';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/payments/review',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: [], displayName: 'Synthetic Finance', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/payments/review',
}));

afterEach(cleanup);
const ALL = ['payments.reconciliation.read', 'payments.intent.resolve', 'payments.refund.request', 'payments.refund.approve', 'payments.merchant_config.manage'];
const snap = (el: Element) => expect(norm(el.innerHTML)).toMatchSnapshot();

describe('RS-C15 key-screen snapshots', () => {
  it('Payment review queue', async () => {
    const { ReviewQueue } = await import('../components/ReviewQueue');
    const v = wrap(<ReviewQueue intents={reviewIntents as never} permissions={ALL} centres={[]} holdReasons={holdReasons} />);
    snap(v.container);
  });

  it('Reconciliation: Runs tab', async () => {
    const { ReconciliationView } = await import('../components/ReconciliationView');
    const v = wrap(<ReconciliationView runs={reconRuns as never} findings={reconFindings as never} stats={reconStats} permissions={ALL} codes={reconCodes as never} />);
    snap(v.container);
  });

  it('Reconciliation: Open findings tab', async () => {
    const { ReconciliationView } = await import('../components/ReconciliationView');
    const v = wrap(<ReconciliationView runs={reconRuns as never} findings={reconFindings as never} stats={reconStats} permissions={ALL} codes={reconCodes as never} />);
    await userEvent.click(screen.getByRole('tab', { name: /open findings/i }));
    await screen.findByRole('grid', { name: /open findings/i });
    snap(v.container);
  });

  it('Payment detail (timeline)', async () => {
    const { IntentDetailView } = await import('../components/IntentDetailView');
    const v = wrap(<IntentDetailView intent={intentDetail as never} permissions={ALL} codes={intentCodes} />);
    snap(v.container);
  });

  it('Payment detail: Refunds tab', async () => {
    const { IntentDetailView } = await import('../components/IntentDetailView');
    const v = wrap(<IntentDetailView intent={intentDetail as never} permissions={ALL} codes={intentCodes} />);
    await userEvent.click(screen.getByRole('tab', { name: /^refunds$/i }));
    await screen.findByRole('grid', { name: /^refunds$/i });
    snap(v.container);
  });

  it('Refunds list', async () => {
    const { RefundsList } = await import('../components/RefundsList');
    const v = wrap(<RefundsList refunds={refunds as never} permissions={ALL} currentMembershipId={U(95)} codes={refundCodes} thresholdPaisa={0} />);
    snap(v.container);
  });

  it('Static QR worksheets', async () => {
    const { StaticQrView } = await import('../components/StaticQrView');
    const v = wrap(<StaticQrView worksheets={worksheets as never} permissions={ALL} centres={[{ id: U(3), name: 'Synthetic Centre' }]} />);
    snap(v.container);
  });

  it('Gateway settings', async () => {
    const { SettingsView } = await import('../components/SettingsView');
    const v = wrap(<SettingsView environment="production" accounts={accounts as never} settings={paySettings as never} permissions={ALL} />);
    snap(v.container);
  });
});
