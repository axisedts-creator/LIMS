// @vitest-environment jsdom
// T0D-FIX-5 (LD-447 done_when 4): /payments/settings must not crash when LIMS_PAYMENTS_GATEWAY_ENV is missing or invalid; it keeps the title and shows a "Not configured" panel.
// The validation stays EXACTLY "uat" or "production" (no trimming, no case folding, no third value). Permission is still checked first (a caller without
// payments.merchant_config.read gets notFound even when the env is bad). With a bad env the page makes no API read at all (nothing to show, nothing to leak).
// Fails now: the page throws Error('LIMS_PAYMENTS_GATEWAY_ENV must be "uat" or "production"').
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { ToastProvider } from '@lims/ui/components/Toast';
import { menuLabel } from '@/__tests__/uilist1.helpers';
import { accounts, paySettings } from './rs-c15.fixtures';

const PATH = '/payments/settings';
const KEY = 'LIMS_PAYMENTS_GATEWAY_ENV';
const state = vi.hoisted(() => ({ perms: ['payments.merchant_config.read', 'payments.merchant_config.manage'] as string[], reads: 0 }));
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
    listMerchantAccounts: async () => { state.reads++; return f.accounts; },
    getPaymentSettings: async () => { state.reads++; return f.paySettings; },
  };
});
afterEach(() => { cleanup(); delete process.env[KEY]; state.reads = 0; state.perms = ['payments.merchant_config.read', 'payments.merchant_config.manage']; });
void accounts; void paySettings;

async function mount() {
  const mod = await import('../../../app/(staff)/payments/settings/page');
  let el: unknown;
  try { el = await mod.default(); } catch (e) { expect.fail(`${PATH}: the page threw (${(e as Error).message}) instead of drawing a Not configured panel`); }
  return render(<ToastProvider>{el as never}</ToastProvider>);
}
const text = (root: Element) => (root.textContent ?? '').replace(/\s+/g, ' ').trim();

describe('/payments/settings with a bad LIMS_PAYMENTS_GATEWAY_ENV', () => {
  it.each([['missing', undefined], ['empty', ''], ['staging', 'staging'], ['upper case', 'UAT'], ['padded', ' uat'], ['production padded', 'production '], ['sandbox', 'sandbox']])(
    '%s: no throw; the title stays; a "Not configured" panel; no error state; no API read', async (_n, v) => {
      if (v !== undefined) process.env[KEY] = v;
      const { container } = await mount();
      expect([...container.querySelectorAll('h1')].map(text), 'the title stays').toEqual([menuLabel(PATH)]);
      expect(text(container)).toMatch(/not configured/i);
      expect(text(container)).not.toMatch(/something went wrong/i);
      expect(container.querySelectorAll('.lims-state.lims-tone-danger').length, 'not an error state').toBe(0);
      expect(container.querySelectorAll('input[type="password"]').length, 'no secret input is drawn').toBe(0);
      expect(state.reads, 'no merchant-account or settings read with a bad env').toBe(0);
    });

  it('the panel does not offer a way to pick the environment in the browser (the value comes from the deploy)', async () => {
    const { container } = await mount();
    expect(container.querySelectorAll('select, input[type="radio"]').length).toBe(0);
    expect(text(container)).not.toMatch(/\bsave\b/i);
  });

  it('permission first: without payments.merchant_config.read the page is notFound even when the env is bad', async () => {
    state.perms = [];
    const mod = await import('../../../app/(staff)/payments/settings/page');
    await expect(mod.default()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(state.reads).toBe(0);
  });
});

describe('/payments/settings with a valid LIMS_PAYMENTS_GATEWAY_ENV (control)', () => {
  it.each(['uat', 'production'])('%s: the settings form is drawn (no Not configured panel) and the API is read', async (v) => {
    process.env[KEY] = v;
    const { container } = await mount();
    expect([...container.querySelectorAll('h1')].map(text)).toEqual([menuLabel(PATH)]);
    expect(text(container)).not.toMatch(/not configured/i);
    expect(container.querySelectorAll('input[type="password"]').length, 'secret inputs are drawn').toBeGreaterThan(0);
    expect(state.reads).toBeGreaterThan(0);
  });
});
