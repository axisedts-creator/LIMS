// @vitest-environment jsdom
// T0D-FINCTRL-1 done_when (5) — the discount request form (frontdesk DiscountDialog, additive): the reason dropdown from the tenant master, the requester
// limit and whether approval will be needed, all from getMyDiscountPolicy (GET /v1/billing/discount-policy/me). LD-321, LD-310. Synthetic data only.
// PINNED SEMANTICS (tester choice, writer may dispute): reasons come from the policy (billing master = source of the coded set); percent kind needs approval
// when percent_bp > own_limit.max_discount_bp, amount kind when amount_paisa > own_limit.max_discount_paisa; no own_limit = approval needed (server decides at submit).
// The form stays usable when the policy read fails (falls back to the existing frontdesk coded set; no limit hint). The submit payload is unchanged (additive).
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { ToastProvider } from '@lims/ui/components/Toast';
import { t } from '@/core/i18n/messages';

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }), usePathname: () => '/frontdesk/register', useSearchParams: () => new URLSearchParams() }));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: [], displayName: 'Synthetic Receptionist', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/frontdesk/register',
}));

const ORIGIN = 'http://api.test';
process.env.LIMS_ORIGIN_API = ORIGIN;

const policy = (o: Record<string, unknown> = {}) => ({
  own_limit: { max_discount_bp: 500, max_discount_paisa: 100000 },
  authority: { max_discount_bp: 2000, max_discount_paisa: 500000 },
  reasons: [{ code: 'PARTNER_FAMILY', name: 'Synthetic Partner Family', display_order: 1 }, { code: 'REGULAR_PATIENT', name: 'Synthetic Regular Patient', display_order: 2 }],
  ...o,
});
let policyHandler: () => Response | Promise<Response> = () => HttpResponse.json(policy());
const calls: { method: string; path: string }[] = [];
const api = setupServer(
  http.get(`${ORIGIN}/v1/billing/discount-policy/me`, ({ request }) => { calls.push({ method: request.method, path: new URL(request.url).pathname }); return policyHandler(); }),
  http.get(`${ORIGIN}/v1/frontdesk/coded-sets/discount_reasons`, () => HttpResponse.json({ data: [{ code: 'staff_family', display: 'Legacy Staff family', sort_order: 1 }] })),
);
beforeAll(() => api.listen({ onUnhandledFrame: 'error' }));
afterEach(() => { cleanup(); api.resetHandlers(); calls.length = 0; policyHandler = () => HttpResponse.json(policy()); vi.restoreAllMocks(); });
afterAll(() => api.close());

const money = (rupees: string) => new RegExp(`((NPR|Rs\\.)\\s?)?${rupees.replace(/[.,]/g, '\\$&')}`);
const open = async () => {
  const { DiscountDialog } = await import('@/features/frontdesk/components/DiscountDialog');
  const onApply = vi.fn();
  const onClose = vi.fn();
  render(<ToastProvider><DiscountDialog items={[]} onApply={onApply} onClose={onClose} /></ToastProvider>);
  return { dlg: await screen.findByRole('dialog'), onApply, onClose };
};
const pickReason = async (user: ReturnType<typeof userEvent.setup>, dlg: HTMLElement, option: RegExp) => {
  await user.click(within(dlg).getByRole('button', { name: /reason/i }));
  await user.click(await screen.findByRole('option', { name: option }));
};

describe('T0D-FINCTRL-1 discount request form — getMyDiscountPolicy', () => {
  it('reads the policy once and offers the tenant reasons by name, in display order', async () => {
    const user = userEvent.setup();
    const { dlg } = await open();
    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]).toEqual({ method: 'GET', path: '/v1/billing/discount-policy/me' });
    await user.click(within(dlg).getByRole('button', { name: /reason/i }));
    const names = (await screen.findAllByRole('option')).map((o) => o.textContent!.trim());
    expect(names).toEqual(['Synthetic Partner Family', 'Synthetic Regular Patient']);
  });

  it('the chosen reason is sent by its code; the payload shape is unchanged (additive form)', async () => {
    const user = userEvent.setup();
    const { dlg, onApply } = await open();
    await waitFor(() => expect(calls.length).toBe(1));
    await pickReason(user, dlg, /Synthetic Partner Family/);
    await user.type(within(dlg).getByLabelText(/discount percent/i), '4');
    await user.click(within(dlg).getByRole('button', { name: /apply discount/i }));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0]![0]).toEqual({ scope: 'bill', reason_code: 'PARTNER_FAMILY', kind: 'percent', percent_bp: 400 });
  });

  it('shows the requester limit as percent and rupees, and the approval authority when there is one', async () => {
    const { dlg } = await open();
    const label = await within(dlg).findByText(t('billing.discounts.form.own_limit'));
    expect(t('billing.discounts.form.own_limit')).not.toBe('billing.discounts.form.own_limit');
    expect(label.parentElement!.textContent).toMatch(/\b5(\.0{1,2})?\s?%/);
    expect(label.parentElement!.textContent).toMatch(money('1,000.00'));
    expect(label.parentElement!.textContent).not.toMatch(/100000|\b500\b/);
    const auth = within(dlg).getByText(t('billing.discounts.form.authority'));
    expect(auth.parentElement!.textContent).toMatch(/\b20(\.0{1,2})?\s?%/);
    expect(auth.parentElement!.textContent).toMatch(money('5,000.00'));
  });

  it('says whether approval will be needed and updates as the value changes: percent within / above the limit', async () => {
    const user = userEvent.setup();
    const { dlg } = await open();
    await within(dlg).findByText(t('billing.discounts.form.own_limit'));
    const pct = within(dlg).getByLabelText(/discount percent/i);
    await user.type(pct, '4');
    await waitFor(() => expect(within(dlg).getByText(t('billing.discounts.form.approval_not_needed'))).toBeTruthy());
    expect(within(dlg).queryByText(t('billing.discounts.form.approval_needed'))).toBeNull();
    await user.clear(pct);
    await user.type(pct, '6');
    await waitFor(() => expect(within(dlg).getByText(t('billing.discounts.form.approval_needed'))).toBeTruthy());
    expect(within(dlg).queryByText(t('billing.discounts.form.approval_not_needed'))).toBeNull();
    expect(t('billing.discounts.form.approval_needed')).not.toBe(t('billing.discounts.form.approval_not_needed'));
    await user.clear(pct);
    await user.type(pct, '5'); // exactly the limit is within it
    await waitFor(() => expect(within(dlg).getByText(t('billing.discounts.form.approval_not_needed'))).toBeTruthy());
  });

  it('amount kind compares rupees with the per bill ceiling (paisa)', async () => {
    const user = userEvent.setup();
    const { dlg } = await open();
    await within(dlg).findByText(t('billing.discounts.form.own_limit'));
    await user.click(within(dlg).getByRole('radio', { name: /^amount$/i }));
    const amount = within(dlg).getByLabelText(/discount amount/i);
    await user.type(amount, '900');
    await waitFor(() => expect(within(dlg).getByText(t('billing.discounts.form.approval_not_needed'))).toBeTruthy());
    await user.clear(amount);
    await user.type(amount, '1500');
    await waitFor(() => expect(within(dlg).getByText(t('billing.discounts.form.approval_needed'))).toBeTruthy());
  });

  it('a user without a personal limit sees that, and approval is needed', async () => {
    policyHandler = () => HttpResponse.json(policy({ own_limit: undefined, authority: undefined }));
    const user = userEvent.setup();
    const { dlg } = await open();
    await within(dlg).findByText(t('billing.discounts.form.no_limit'));
    expect(t('billing.discounts.form.no_limit')).not.toBe('billing.discounts.form.no_limit');
    await user.type(within(dlg).getByLabelText(/discount percent/i), '1');
    await waitFor(() => expect(within(dlg).getByText(t('billing.discounts.form.approval_needed'))).toBeTruthy());
    expect(within(dlg).queryByText(t('billing.discounts.form.authority'))).toBeNull();
  });

  it.each([
    ['403', () => HttpResponse.json({ type: 'urn:lims:error:auth.forbidden', title: 'Forbidden', status: 403, code: 'auth.forbidden', request_id: '01933b6f-0a11-7e2b-8c55-1d2e3f405162' }, { status: 403 })],
    ['500', () => HttpResponse.json({ type: 'urn:lims:error:common.internal', title: 'Internal', status: 500, code: 'common.internal', request_id: '01933b6f-0a11-7e2b-8c55-1d2e3f405162' }, { status: 500 })],
    ['network failure', () => HttpResponse.error()],
  ])('when the policy read fails (%s) the form still works: coded set reasons, no limit hint, no crash', async (_n, handler) => {
    policyHandler = handler as never;
    const user = userEvent.setup();
    const { dlg, onApply } = await open();
    await waitFor(() => expect(calls.length).toBe(1));
    await pickReason(user, dlg, /Legacy Staff family/);
    await user.type(within(dlg).getByLabelText(/discount percent/i), '3');
    expect(within(dlg).queryByText(t('billing.discounts.form.own_limit'))).toBeNull();
    expect(within(dlg).queryByText(t('billing.discounts.form.approval_needed'))).toBeNull();
    await user.click(within(dlg).getByRole('button', { name: /apply discount/i }));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0]![0]).toMatchObject({ reason_code: 'staff_family', percent_bp: 300 });
  });

  it('a reason is still required, and the hint never blocks Apply (the server decides)', async () => {
    const user = userEvent.setup();
    const { dlg, onApply } = await open();
    await within(dlg).findByText(t('billing.discounts.form.own_limit'));
    await user.type(within(dlg).getByLabelText(/discount percent/i), '50');
    await user.click(within(dlg).getByRole('button', { name: /apply discount/i }));
    expect(onApply).not.toHaveBeenCalled();
    await pickReason(user, dlg, /Synthetic Regular Patient/);
    await user.click(within(dlg).getByRole('button', { name: /apply discount/i }));
    expect(onApply).toHaveBeenCalledTimes(1); // 50 percent is above the limit: approval will be needed, still allowed to request
    expect(onApply.mock.calls[0]![0].percent_bp).toBe(5000);
  });

  it('is accessible (axe) with the hint shown', async () => {
    const { dlg } = await open();
    await within(dlg).findByText(t('billing.discounts.form.own_limit'));
    const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
    expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
  });
});
