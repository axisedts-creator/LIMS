// @vitest-environment jsdom
// T0D-BUILD-2 (LD-447, done_when 4): /partners/settings on kit inputs. Synthetic data, saveSettingsAction and getSettings mocked (no network).
// Pins: Save sends ALL 10 PartnerSettings fields with the ETag of the GET as If-Match; one success toast; every failure is an error TOAST (tone danger) in plain words
// (never the raw code); the new contract codes partners.setting_out_of_range and common.precondition_required have their own text; a caller with read but not manage sees the
// values read only (no Save, inputs read only, saveSettingsAction never called); a caller without partners.partner.read gets the permission notice and no read call.
// Fails today because: errorText() has no entry for partners.setting_out_of_range / common.precondition_required (generic "Something went wrong") and a failed save is only an in-page banner, not a toast.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '@lims/ui/components/Toast';
import { settings } from './t16.fixtures';

const h = vi.hoisted(() => ({
  perms: ['partners.partner.read', 'partners.partner.manage'] as string[],
  save: vi.fn(),
  get: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: h.refresh, back: vi.fn() }),
  usePathname: () => '/partners/settings',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({ getAccessToken: async () => 'jwt-synthetic', getShellSession: async () => ({ actor: { permissions: h.perms } }), getRequestPathname: async () => '/partners/settings' }));
vi.mock('@/features/partners/server/actions', () => ({ saveSettingsAction: (...a: unknown[]) => h.save(...a) }));
vi.mock('@/features/partners/server/read.server', () => ({ getSettings: (...a: unknown[]) => h.get(...a) }));

const KEYS = ['access_slip_enabled', 'consent_statement', 'consent_text_version', 'default_conversion_mode', 'draft_ttl_days', 'include_default_price_list', 'max_lines_per_manifest',
  'pickup_max_days_ahead', 'report_download_daily_cap_per_user', 'require_mapped_referrer'];

beforeEach(() => {
  h.perms = ['partners.partner.read', 'partners.partner.manage'];
  h.save.mockReset().mockResolvedValue({ ok: true, data: settings() });
  h.get.mockReset().mockImplementation(async () => ({ settings: settings(), etag: '"3"' }));
  h.refresh.mockReset();
});
afterEach(() => cleanup());

async function mount() {
  const mod = await import('../../../app/(staff)/partners/settings/page');
  const el = await mod.default();
  return render(<ToastProvider>{el as never}</ToastProvider>);
}
const failure = (code: string, status: number) => h.save.mockResolvedValue({ ok: false, code, status });
async function saveWithEdit() {
  const user = userEvent.setup();
  const version = screen.getByLabelText(/consent text version/i);
  await user.clear(version);
  await user.type(version, 'v9');
  await user.click(screen.getByRole('button', { name: /save settings/i }));
  return user;
}
const dangerToasts = () => [...document.querySelectorAll('.lims-toast[data-tone="danger"]')].map((t) => (t.textContent ?? '').replace(/\s+/g, ' ').trim());

describe('/partners/settings save', () => {
  it('Save sends the whole object (the 10 contract fields, edit applied) with the ETag of the GET as If-Match, then one success toast and a refresh', async () => {
    await mount();
    await saveWithEdit();
    await waitFor(() => expect(h.save).toHaveBeenCalledTimes(1));
    const [body, etag] = h.save.mock.calls[0]!;
    expect(Object.keys(body as object).sort()).toEqual(KEYS);
    expect(body).toMatchObject({ consent_text_version: 'v9', max_lines_per_manifest: 200, draft_ttl_days: 14, default_conversion_mode: 'on_receipt' });
    expect(etag).toBe('"3"');
    await waitFor(() => expect([...document.querySelectorAll('.lims-toast')].filter((t) => /saved/i.test(t.textContent ?? ''))).toHaveLength(1));
    expect(h.refresh).toHaveBeenCalled();
    expect(dangerToasts()).toEqual([]);
  });

  it.each([
    ['common.version_conflict', 409, /changed by someone else|reload/i],
    ['common.precondition_required', 428, /reload|refresh|try again/i],
    ['partners.setting_out_of_range', 422, /range|allowed|between/i],
    ['common.validation_failed', 400, /check|invalid|value/i],
    ['auth.forbidden', 403, /permission/i],
  ])('%s (HTTP %s) is an error toast in plain words, not the raw code, and no success toast', async (code, status, words) => {
    failure(code, status);
    await mount();
    await saveWithEdit();
    await waitFor(() => expect(dangerToasts().length).toBeGreaterThan(0));
    const text = dangerToasts().join(' ');
    expect(text).toMatch(words);
    expect(text).not.toContain(code);
    expect(text).not.toMatch(/something went wrong/i);
    expect([...document.querySelectorAll('.lims-toast')].filter((t) => /saved/i.test(t.textContent ?? ''))).toEqual([]);
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it('a failed save keeps the edit on screen (the form is not reset) and Save can be pressed again', async () => {
    failure('common.version_conflict', 409);
    await mount();
    await saveWithEdit();
    await waitFor(() => expect(dangerToasts().length).toBeGreaterThan(0));
    expect((screen.getByLabelText(/consent text version/i) as HTMLInputElement).value).toBe('v9');
    expect((screen.getByRole('button', { name: /save settings/i }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('/partners/settings read only and permission', () => {
  it('read without manage: values shown, inputs read only, no Save button, no save call', async () => {
    h.perms = ['partners.partner.read'];
    h.get.mockImplementation(async () => ({ settings: settings({ max_lines_per_manifest: 120, consent_text_version: 'v7' }), etag: '"3"' }));
    await mount();
    expect(screen.queryByRole('button', { name: /save/i })).toBeNull();
    expect((screen.getByLabelText(/consent text version/i) as HTMLInputElement).value).toBe('v7');
    expect((screen.getByLabelText(/max samples per manifest/i) as HTMLInputElement).value).toMatch(/120/);
    for (const label of [/consent text version/i, /max samples per manifest/i, /draft expiry/i, /pickup days ahead/i, /daily report downloads/i]) {
      const el = screen.getByLabelText(label) as HTMLInputElement;
      expect(el.readOnly || el.disabled, `${label} must not be editable`).toBe(true);
    }
    for (const sw of screen.getAllByRole('switch')) expect((sw as HTMLInputElement).disabled || sw.getAttribute('aria-disabled') === 'true' || (sw as HTMLInputElement).readOnly).toBe(true);
    expect(h.save).not.toHaveBeenCalled();
  });

  it('without partners.partner.read: the permission notice, no form, and the settings are not even read', async () => {
    h.perms = [];
    await mount();
    expect(screen.getByText(/do not have permission/i)).toBeTruthy();
    expect(screen.queryByLabelText(/consent text version/i)).toBeNull();
    expect(h.get).not.toHaveBeenCalled();
  });

  it('the contract defaults of a new tenant (200 with defaults, ETag "1") draw a usable form, not an empty or error state', async () => {
    h.get.mockImplementation(async () => ({ settings: settings({ max_lines_per_manifest: 200, draft_ttl_days: 30, pickup_max_days_ahead: 7, report_download_daily_cap_per_user: 500, consent_text_version: 'partner-v1' }), etag: '"1"' }));
    await mount();
    expect((screen.getByLabelText(/consent text version/i) as HTMLInputElement).value).toBe('partner-v1');
    expect(screen.getByRole('button', { name: /save settings/i })).toBeTruthy();
    await userEvent.setup().click(screen.getByRole('button', { name: /save settings/i }));
    await waitFor(() => expect(h.save).toHaveBeenCalledTimes(1));
    expect(h.save.mock.calls[0]![1]).toBe('"1"');
  });
});
