// @vitest-environment jsdom
// T0D-UISETTINGS-1 (LD-353 template 4 SETTINGS, rules 3, 6, 8): /payments/settings. Page with mocked read.server (rs-c15 fixtures), env production.
// Fails today because: separate Cards (eSewa, Khalti, Fonepay, Refunds and labels) each with its own Save: no kit SettingsForm, no tabs, no sticky bar, no dirty note;
// 501 / 500 on the read throw to error.tsx. Field names stay (secret key stays write-only: never prefilled).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { ToastProvider } from '@lims/ui/components/Toast';
import { ApiError } from '@/core/api/server-fetch';
import { expectDirtyState, expectErrorState, expectNotAvailable, expectSettingsForm } from '@/__tests__/uiset1.helpers';
import { accounts, paySettings } from './rs-c15.fixtures';

const PATH = '/payments/settings';
const state = vi.hoisted(() => ({ fail: undefined as unknown, perms: ['payments.merchant_config.read', 'payments.merchant_config.manage'] as string[] }));
process.env['LIMS_PAYMENTS_GATEWAY_ENV'] = 'production';
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/payments/settings',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({ getAccessToken: async () => 'jwt-synthetic', getShellSession: async () => ({ actor: { permissions: state.perms } }), getRequestPathname: async () => PATH }));
const { stub } = vi.hoisted(() => ({ stub: () => new Proxy({}, { get: (_t, k) => (k === 'then' || k === '__esModule' || typeof k === 'symbol' ? undefined : () => undefined) }) }));
vi.mock('@/features/payments/server/actions', stub);
vi.mock('@/features/payments/server/read.server', async () => {
  const f = await import('./rs-c15.fixtures');
  return {
    listMerchantAccounts: async () => { if (state.fail) throw state.fail; return f.accounts; },
    getPaymentSettings: async () => { if (state.fail) throw state.fail; return f.paySettings; },
  };
});
afterEach(() => { cleanup(); state.fail = undefined; });
void accounts; void paySettings;

async function mount() {
  const mod = await import('../../../app/(staff)/payments/settings/page');
  let el: unknown;
  try { el = await mod.default(); } catch (e) { expect.fail(`${PATH}: the page threw (${(e as Error).message}) instead of drawing ErrorState / NotAvailable inside the page`); }
  return render(<ToastProvider>{el as never}</ToastProvider>);
}

describe('/payments/settings', () => {
  it('kit SettingsForm: menu title, one tab per gateway plus "Refunds and labels", ONE Save in the sticky bar, every field kept', async () => {
    const { container } = await mount();
    await expectSettingsForm(container, { path: PATH, tabs: { include: ['Refunds and labels'], min: 3 }, names: ['esewa_product_code', 'khalti_website_url', 'refund_two_person_threshold', 'purchase_order_label'] });
  });

  it('dirty state: "Unsaved changes" only after an edit', async () => {
    const { container } = await mount();
    await expectDirtyState(container, PATH);
  });

  it('the secret key is write-only: the password input is empty and nothing of it is drawn as text', async () => {
    const { container } = await mount();
    for (const i of container.querySelectorAll<HTMLInputElement>('input[type="password"]')) expect(i.value).toBe('');
  });

  it('501 operation_pending: NotAvailable keeps the title', async () => {
    state.fail = new ApiError(501, { type: 'x', title: 'operation_pending', status: 501, code: 'operation_pending' } as never);
    const { container } = await mount();
    expectNotAvailable(container, PATH);
  });

  it('500: ErrorState in the page, title kept, Reference and Retry', async () => {
    state.fail = new ApiError(500, { type: 'x', title: 'common.internal', status: 500, code: 'common.internal', request_id: 'req-syn-0001' } as never);
    const { container } = await mount();
    expectErrorState(container, PATH);
  });
});
