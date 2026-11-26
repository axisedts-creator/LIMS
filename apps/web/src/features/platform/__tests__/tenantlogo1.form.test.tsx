// @vitest-environment jsdom
// CR TENANT-LOGO-1: the Provision tenant form takes an optional lab logo. The tenant is created first (the provision body is unchanged);
// the logo then goes to POST /platform/tenants/{that tenant id}/branding-assets as multipart (kind=logo + file). A bad file is refused
// in the browser before anything is created; a failed upload never hides that the tenant exists and can be sent again. Synthetic data only.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse } from 'msw';
import { P, api, apiCalls, callsTo, problem, resetApi, routes, show, tenantDto, T_BETA, T_GAMMA, SUPER, SUPPORT } from './t26.harness';
import { uploadTenantLogoAction } from '../actions';

vi.mock('next/navigation', async () => (await import('./t26.harness')).navigationMock);
vi.mock('next/cache', async () => (await import('./t26.harness')).cacheMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t26.harness')).sessionMock);

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => resetApi(SUPER));
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const POST = `${P}/tenants`;
const LOGO = `${P}/tenants/${T_GAMMA}/branding-assets`;
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const pngFile = (name = 'synthetic-lab.png') => new File([PNG_BYTES], name, { type: 'image/png' });
const created = () => HttpResponse.json(tenantDto(T_GAMMA, 'synthetic_gamma', 'provisioning'), { status: 201 });
const stored = () => HttpResponse.json({ asset_id: T_BETA, kind: 'logo', width: 40, height: 12, sha256: 'a'.repeat(64), scan_state: 'clean' }, { status: 201 });
const logoInput = () => screen.getByLabelText(/^lab logo/i) as HTMLInputElement;
const submit = () => screen.getByRole('button', { name: /^provision tenant$/i });

async function fill() {
  const u = userEvent.setup();
  await u.type(screen.getByLabelText(/^tenant code/i), 'synthetic_gamma');
  await u.type(screen.getByLabelText(/^legal name/i), 'Synthetic Gamma Pvt. Ltd.');
  await u.type(screen.getByLabelText(/^display name/i), 'Synthetic Gamma Lab');
  await u.type(screen.getByLabelText(/branch code/i), 'MAIN');
  await u.type(screen.getByLabelText(/branch name/i), 'Main Branch');
  await u.type(screen.getByLabelText(/centre code/i), 'C01');
  await u.type(screen.getByLabelText(/centre name/i), 'Main Centre');
  await u.type(screen.getByLabelText(/administrator email/i), 'admin@synthetic-gamma.example.test');
  await u.type(screen.getByLabelText(/administrator full name/i), 'Synthetic Admin');
  await u.type(screen.getByLabelText(/tos version/i), 'DEMO-TOS-1');
  await u.type(screen.getByLabelText(/dpa version/i), 'DEMO-DPA-1');
  await u.type(screen.getByLabelText(/accepted by \(name\)/i), 'Synthetic Signer');
  await u.type(screen.getByLabelText(/accepted by \(title\)/i), 'Managing Director');
  return u;
}

describe('Provision tenant: lab logo field', () => {
  it('is an optional file field for PNG or JPEG', async () => {
    await show('tenants/new/page');
    expect(logoInput().type).toBe('file'); expect(logoInput().required).toBe(false);
    expect(logoInput().accept).toContain('image/png'); expect(logoInput().accept).toContain('image/jpeg');
  });

  it('with a logo: the tenant is created, then the logo is sent for THAT tenant id as multipart kind=logo with its own idempotency key', async () => {
    routes[`POST ${POST}`] = created; routes[`POST ${LOGO}`] = stored;
    await show('tenants/new/page'); const u = await fill();
    await u.upload(logoInput(), pngFile());
    await u.click(submit());
    await waitFor(() => expect(screen.getByText(/logo saved/i)).toBeTruthy());
    expect(callsTo('POST', POST)).toHaveLength(1);
    const up = callsTo('POST', LOGO); expect(up).toHaveLength(1);
    expect(up[0]!.headers.get('content-type')).toMatch(/^multipart\/form-data; boundary=/);
    expect(up[0]!.headers.get('idempotency-key')).toMatch(/^[0-9a-f-]{32,36}$/i);
    expect(up[0]!.headers.get('idempotency-key')).not.toBe(callsTo('POST', POST)[0]!.headers.get('idempotency-key'));
    expect(up[0]!.body).toMatch(/name="kind"\r\n\r\nlogo\r\n/);
    expect(up[0]!.body).toMatch(/name="file"; filename="synthetic-lab\.png"\r\nContent-Type: image\/png/);
    // the provision body carries no logo field (TenantProvisionRequest is additionalProperties: false)
    expect(Object.keys(JSON.parse(callsTo('POST', POST)[0]!.body!))).not.toContain('logo');
    expect(apiCalls()).toBe(2);
  });

  it('without a logo: only the tenant is created; no branding call, no logo line', async () => {
    routes[`POST ${POST}`] = created;
    await show('tenants/new/page'); const u = await fill();
    await u.click(submit());
    await waitFor(() => expect(screen.getByText(/invitation sent/i)).toBeTruthy());
    expect(callsTo('POST', LOGO)).toHaveLength(0); expect(screen.queryByText(/logo saved|logo not saved/i)).toBeNull(); expect(apiCalls()).toBe(1);
  });

  it.each([
    ['a file that is not PNG or JPEG', new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' })],
    ['a file over 2 MB', new File([new Uint8Array(2 * 1024 * 1024 + 1)], 'big.png', { type: 'image/png' })],
    ['an empty file', new File([], 'empty.png', { type: 'image/png' })],
  ])('%s is refused in the form: an error is shown and NOTHING is sent (no tenant is created)', async (_n, file) => {
    routes[`POST ${POST}`] = created; routes[`POST ${LOGO}`] = stored;
    await show('tenants/new/page'); const u = await fill();
    fireEvent.change(logoInput(), { target: { files: [file] } });
    expect(screen.getByText(/logo must be a png or jpeg image of at most 2 mb/i)).toBeTruthy();
    await u.click(submit());
    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThan(0));
    expect(apiCalls()).toBe(0); expect(screen.queryByText(/provisioned/i)).toBeNull();
  });

  it('upload refused by the API: the tenant is still reported as provisioned, the failure is shown, and "Upload logo again" retries for the same tenant', async () => {
    routes[`POST ${POST}`] = created; routes[`POST ${LOGO}`] = () => problem('common.upload_quarantined', 422);
    await show('tenants/new/page'); const u = await fill();
    await u.upload(logoInput(), pngFile());
    await u.click(submit());
    await waitFor(() => expect(screen.getByText(/logo not saved/i)).toBeTruthy());
    expect(screen.getByRole('heading', { name: /synthetic_gamma provisioned/i })).toBeTruthy();
    expect(callsTo('POST', POST)).toHaveLength(1);
    routes[`POST ${LOGO}`] = stored;
    await u.click(screen.getByRole('button', { name: /upload logo again/i }));
    await waitFor(() => expect(screen.getByText(/logo saved/i)).toBeTruthy());
    expect(callsTo('POST', LOGO)).toHaveLength(2); expect(callsTo('POST', POST)).toHaveLength(1);   // the tenant is never created twice
    const keys = callsTo('POST', LOGO).map((c) => c.headers.get('idempotency-key')); expect(keys[0]).not.toBe(keys[1]);
  });
});

describe('uploadTenantLogoAction re-checks everything on the server (the browser can call it directly)', () => {
  const form = (f: Blob | string = pngFile()) => { const d = new FormData(); d.set('file', f); return d; };
  const KEY = '0193a5c0-0000-7000-8000-00000000abcd';
  it('platform support (no platform.tenant.manage) -> 403, no API call', async () => {
    resetApi(SUPPORT);
    expect(await uploadTenantLogoAction(T_GAMMA, form(), KEY)).toMatchObject({ ok: false, status: 403 }); expect(apiCalls()).toBe(0);
  });
  it.each([['not a uuid', 'synthetic_gamma'], ['path traversal', `${T_GAMMA}/../${T_BETA}`], ['query injection', `${T_GAMMA}?tenant_id=${T_BETA}`], ['empty', '']])(
    'tenant id %s -> 400, no API call (the id is the only tenant selector and must be a plain UUID)', async (_n, id) => {
      expect(await uploadTenantLogoAction(id, form(), KEY)).toMatchObject({ ok: false, status: 400 }); expect(apiCalls()).toBe(0);
    });
  it('a missing file or a bad idempotency key -> 400, no API call', async () => {
    expect(await uploadTenantLogoAction(T_GAMMA, form('not-a-file'), KEY)).toMatchObject({ ok: false, status: 400 });
    expect(await uploadTenantLogoAction(T_GAMMA, form(), 'nope')).toMatchObject({ ok: false, status: 400 });
    expect(apiCalls()).toBe(0);
  });
  it('over 2 MB -> 413 and a non-image type -> 415, no API call', async () => {
    expect(await uploadTenantLogoAction(T_GAMMA, form(new File([new Uint8Array(2 * 1024 * 1024 + 1)], 'big.png', { type: 'image/png' })), KEY)).toMatchObject({ ok: false, status: 413 });
    expect(await uploadTenantLogoAction(T_GAMMA, form(new File(['%PDF-1.7'], 'doc.pdf', { type: 'application/pdf' })), KEY)).toMatchObject({ ok: false, status: 415 });
    expect(apiCalls()).toBe(0);
  });
  it('a hostile filename cannot break out of its multipart header', async () => {
    routes[`POST ${LOGO}`] = stored;
    await uploadTenantLogoAction(T_GAMMA, form(pngFile('x"\r\nContent-Disposition: form-data; name="kind"\r\n\r\nsignature.png')), KEY);
    const body = callsTo('POST', LOGO)[0]!.body!;
    expect(body.match(/name="kind"/g)).toHaveLength(1); expect(body).toMatch(/name="kind"\r\n\r\nlogo\r\n/); expect(body).not.toMatch(/\r\n\r\nsignature/);
  });
});
