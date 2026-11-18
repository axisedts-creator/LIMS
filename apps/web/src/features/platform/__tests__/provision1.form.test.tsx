// @vitest-environment jsdom
// PLATFORM-PROVISION-1 (LD-275, LD-29): the Provision tenant form collects and sends contract_acceptance (tos + dpa), as the contract and the service require.
// Assumed labels (dispute if wrong): section heading "Contract acceptance"; fields "ToS version", "DPA version", "Accepted by (name)", "Accepted by (title)",
// "Accepted at" (input type datetime-local, default now, sent as UTC ISO). One acceptor and one time for both documents. No legal version string is hard coded.
// The body the form sends must equal provision1.payload.json (the same file the API contract test validates through the real request validation).
// Expected now: the labels do not exist, so every case here (and the filled-in cases of t26.tenants) fails.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse } from 'msw';
import { P, api, apiCalls, bodyOf, callsTo, problem, resetApi, routes, show, tenantDto, T_GAMMA, SUPER, SUPPORT } from './t26.harness';

vi.mock('next/navigation', async () => (await import('./t26.harness')).navigationMock);
vi.mock('next/cache', async () => (await import('./t26.harness')).cacheMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t26.harness')).sessionMock);

beforeAll(() => api.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => resetApi(SUPER));
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const POST = `${P}/tenants`;
const FIXTURE = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'provision1.payload.json'), 'utf8'));
const OK = () => HttpResponse.json(tenantDto(T_GAMMA, 'synthetic_gamma', 'provisioning'), { status: 201 });
const submit = () => screen.getByRole('button', { name: /^provision tenant$/i });
const L = { tos: /tos version/i, dpa: /dpa version/i, name: /accepted by \(name\)/i, title: /accepted by \(title\)/i, at: /accepted at/i };
const field = (re: RegExp) => screen.getByLabelText(re) as HTMLInputElement;

async function fillTenant(u: ReturnType<typeof userEvent.setup>) {
  await u.type(screen.getByLabelText(/^tenant code/i), 'synthetic_gamma');
  await u.type(screen.getByLabelText(/^legal name/i), 'Synthetic Gamma Pvt. Ltd.');
  await u.type(screen.getByLabelText(/^display name/i), 'Synthetic Gamma Lab');
  await u.type(screen.getByLabelText(/branch code/i), 'MAIN');
  await u.type(screen.getByLabelText(/branch name/i), 'Main Branch');
  await u.type(screen.getByLabelText(/centre code/i), 'C01');
  await u.type(screen.getByLabelText(/centre name/i), 'Main Centre');
  await u.selectOptions(screen.getByLabelText(/centre type/i), 'own');
  await u.type(screen.getByLabelText(/administrator email/i), 'admin@synthetic-gamma.example.test');
  await u.type(screen.getByLabelText(/administrator full name/i), 'Synthetic Admin');
}
async function fillContract(u: ReturnType<typeof userEvent.setup>, skip: keyof typeof L | undefined = undefined) {
  const v = FIXTURE.contract_acceptance;
  if (skip !== 'tos') await u.type(field(L.tos), v.tos.version);
  if (skip !== 'dpa') await u.type(field(L.dpa), v.dpa.version);
  if (skip !== 'name') await u.type(field(L.name), v.tos.accepted_by_name);
  if (skip !== 'title') await u.type(field(L.title), v.tos.accepted_by_title);
}
async function fillAll(skip?: keyof typeof L) { const u = userEvent.setup(); await fillTenant(u); await fillContract(u, skip); return u; }

describe('Contract acceptance section (LD-29)', () => {
  it('has a "Contract acceptance" section with the five fields, all required; one acceptor and one time for both documents', async () => {
    await show('tenants/new/page');
    expect(screen.getByRole('heading', { name: /^contract acceptance$/i })).toBeTruthy();
    for (const re of Object.values(L)) expect((field(re) as HTMLInputElement).required, String(re)).toBe(true);
    for (const re of [L.name, L.title, L.at]) expect(screen.getAllByLabelText(re), String(re)).toHaveLength(1);
  });

  it('client limits mirror the service: version 32, name 120, title 80; accepted at is a date-time input', async () => {
    await show('tenants/new/page');
    expect(field(L.tos).maxLength).toBe(32);
    expect(field(L.dpa).maxLength).toBe(32);
    expect(field(L.name).maxLength).toBe(120);
    expect(field(L.title).maxLength).toBe(80);
    expect(field(L.at).type).toBe('datetime-local');
    await userEvent.setup().type(field(L.tos), 'v'.repeat(33));
    expect(field(L.tos).value).toBe('v'.repeat(32));
  });

  it('no legal version string is hard coded: the version fields start empty (the operator types them)', async () => {
    await show('tenants/new/page');
    expect(field(L.tos).value).toBe('');
    expect(field(L.dpa).value).toBe('');
    expect(field(L.name).value).toBe('');
    expect(field(L.title).value).toBe('');
  });

  it('accepted at defaults to now (within a few minutes of the clock)', async () => {
    const before = Date.now();
    await show('tenants/new/page');
    const t = new Date(field(L.at).value).getTime();   // datetime-local value is local wall time without zone; Date parses it as local
    expect(Number.isNaN(t)).toBe(false);
    expect(Math.abs(t - before)).toBeLessThan(5 * 60_000);
  });
});

describe('Provision tenant sends contract_acceptance (LD-29, LD-275)', () => {
  it('the body equals the fixture the API contract test validates; snake_case keys exactly as the contract names them; accepted_at is the default now, in UTC', async () => {
    routes[`POST ${POST}`] = OK;
    const t0 = Date.now();
    await show('tenants/new/page');
    const u = await fillAll();
    await u.click(submit());
    await waitFor(() => expect(callsTo('POST', POST)).toHaveLength(1));
    const call = callsTo('POST', POST)[0]!;
    const b = bodyOf(call);
    expect(Object.keys(b.contract_acceptance).sort()).toEqual(['dpa', 'tos']);
    for (const d of ['tos', 'dpa']) expect(Object.keys(b.contract_acceptance[d]).sort()).toEqual(['accepted_at', 'accepted_by_name', 'accepted_by_title', 'version']);
    // one acceptor and one instant for both documents
    expect(b.contract_acceptance.dpa.accepted_at).toBe(b.contract_acceptance.tos.accepted_at);
    expect(b.contract_acceptance.dpa.accepted_by_name).toBe(b.contract_acceptance.tos.accepted_by_name);
    expect(b.contract_acceptance.dpa.accepted_by_title).toBe(b.contract_acceptance.tos.accepted_by_title);
    const at: string = b.contract_acceptance.tos.accepted_at;
    expect(at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/);           // the service isoUtc / contract IsoUtc
    expect(Math.abs(Date.parse(at) - t0)).toBeLessThan(5 * 60_000);
    for (const d of ['tos', 'dpa']) b.contract_acceptance[d].accepted_at = FIXTURE.contract_acceptance[d].accepted_at;
    expect(b).toEqual(FIXTURE);
    expect(call.headers.get('idempotency-key')).toMatch(/^[A-Za-z0-9_-]{16,}$/);
  });

  it('an accepted at typed by the operator is sent as the UTC instant of that local time', async () => {
    routes[`POST ${POST}`] = OK;
    await show('tenants/new/page');
    const u = await fillAll();
    fireEvent.change(field(L.at), { target: { value: '2026-11-16T17:08' } });
    await u.click(submit());
    await waitFor(() => expect(callsTo('POST', POST)).toHaveLength(1));
    const b = bodyOf(callsTo('POST', POST)[0]);
    const want = new Date('2026-11-16T17:08').toISOString();
    expect(b.contract_acceptance.tos.accepted_at).toBe(want);
    expect(b.contract_acceptance.dpa.accepted_at).toBe(want);
  });

  it.each([['tos', 'ToS version'], ['dpa', 'DPA version'], ['name', 'accepted by (name)'], ['title', 'accepted by (title)']] as const)(
    'a missing %s (%s) is refused in the form with an error and no API call', async (skip) => {
      await show('tenants/new/page');
      const u = await fillAll(skip);
      await u.click(submit());
      expect(callsTo('POST', POST)).toHaveLength(0);
      expect(apiCalls()).toBe(0);
      expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
      expect(field(L[skip]).getAttribute('aria-invalid') === 'true' || screen.getAllByRole('alert').some((a) => (a.textContent ?? '').length > 0)).toBe(true);
    });

  it('a cleared accepted at is refused with no API call', async () => {
    await show('tenants/new/page');
    const u = await fillAll();
    fireEvent.change(field(L.at), { target: { value: '' } });
    await u.click(submit());
    expect(callsTo('POST', POST)).toHaveLength(0);
    expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
  });

  it('whitespace-only acceptor name or title is refused (the action trims, like the service string rule)', async () => {
    await show('tenants/new/page');
    const u = userEvent.setup();
    await fillTenant(u);
    await u.type(field(L.tos), 'SYNTH-TOS-A'); await u.type(field(L.dpa), 'SYNTH-DPA-B');
    await u.type(field(L.name), '   '); await u.type(field(L.title), '   ');
    await u.click(submit());
    expect(callsTo('POST', POST)).toHaveLength(0);
  });

  it('single flight: a double click sends one request carrying the acceptance', async () => {
    let release!: () => void;
    routes[`POST ${POST}`] = () => new Promise<Response>((res) => { release = () => res(OK()); });
    await show('tenants/new/page');
    const u = await fillAll();
    await u.dblClick(submit());
    await waitFor(() => expect(callsTo('POST', POST).length).toBeGreaterThan(0));
    release();
    await waitFor(() => expect(screen.getByText('Invitation sent')).toBeTruthy());
    expect(callsTo('POST', POST)).toHaveLength(1);
    expect(bodyOf(callsTo('POST', POST)[0]).contract_acceptance).toBeDefined();
  });

  it('idempotency: a 503 retry reuses the Idempotency-Key and the same acceptance; a 400 refusal gets a new key', async () => {
    let n = 0;
    routes[`POST ${POST}`] = () => (++n === 1 ? problem('common.dependency_unavailable', 503) : n === 2 ? problem('common.validation_failed', 400) : OK());
    await show('tenants/new/page');
    const u = await fillAll();
    await u.click(submit());
    await waitFor(() => expect(callsTo('POST', POST)).toHaveLength(1));
    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThan(0));
    await u.click(submit());
    await waitFor(() => expect(callsTo('POST', POST)).toHaveLength(2));
    const [c1, c2] = callsTo('POST', POST);
    expect(c2!.headers.get('idempotency-key')).toBe(c1!.headers.get('idempotency-key'));
    expect(bodyOf(c2).contract_acceptance).toEqual(bodyOf(c1).contract_acceptance);
    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThan(0));
    await u.click(submit());
    await waitFor(() => expect(callsTo('POST', POST)).toHaveLength(3));
    expect(callsTo('POST', POST)[2]!.headers.get('idempotency-key')).not.toBe(c2!.headers.get('idempotency-key'));
  });

  it('a 400 from the API shows the request reference', async () => {
    routes[`POST ${POST}`] = () => problem('common.validation_failed', 400);
    await show('tenants/new/page');
    const u = await fillAll();
    await u.click(submit());
    await waitFor(() => expect(document.body.textContent).toContain('req-t26-0001'));
  });
});

describe('provisionTenantAction validates and forwards contract_acceptance (the browser can call actions directly)', () => {
  const acc = () => ({ version: 'SYNTH-TOS-A', accepted_by_name: 'Synthetic Signer', accepted_by_title: 'Managing Director', accepted_at: '2026-11-16T12:00:00.000Z' });
  const input = (over: Record<string, unknown> = {}) => {
    const { timezone: _t, ...rest } = FIXTURE;
    return { ...rest, contract_acceptance: { tos: acc(), dpa: { ...acc(), version: 'SYNTH-DPA-B' } }, ...over } as any;
  };
  const KEY = 'k'.repeat(24);
  const run = async (i: unknown) => (await import('../actions')).provisionTenantAction(i as never, KEY);

  it('forwards the acceptance with snake_case keys and nothing else added', async () => {
    routes[`POST ${POST}`] = OK;
    const r = await run(input());
    expect(r.ok).toBe(true);
    const b = bodyOf(callsTo('POST', POST)[0]);
    expect(b.contract_acceptance).toEqual({ tos: acc(), dpa: { ...acc(), version: 'SYNTH-DPA-B' } });
  });

  it.each([
    ['no contract_acceptance', () => { const i = input(); delete i.contract_acceptance; return i; }],
    ['no dpa', () => { const i = input(); delete i.contract_acceptance.dpa; return i; }],
    ['no acceptor title', () => { const i = input(); delete i.contract_acceptance.tos.accepted_by_title; return i; }],
    ['empty version', () => { const i = input(); i.contract_acceptance.dpa.version = ''; return i; }],
    ['version of 33 characters', () => { const i = input(); i.contract_acceptance.tos.version = 'v'.repeat(33); return i; }],
    ['name of 121 characters', () => { const i = input(); i.contract_acceptance.tos.accepted_by_name = 'n'.repeat(121); return i; }],
    ['title of 81 characters', () => { const i = input(); i.contract_acceptance.dpa.accepted_by_title = 't'.repeat(81); return i; }],
    ['accepted_at with an offset', () => { const i = input(); i.contract_acceptance.tos.accepted_at = '2026-11-16T17:08:00+05:45'; return i; }],
    ['an extra key in the acceptance', () => { const i = input(); i.contract_acceptance.tos.signed_by_ip = '203.0.113.5'; return i; }],
  ])('refuses %s with 400 common.validation_failed and makes no API call', async (_n, make) => {
    const r = await run(make());
    expect(r).toMatchObject({ ok: false, status: 400, code: 'common.validation_failed' });
    expect(apiCalls()).toBe(0);
  });

  it('still refuses a caller without platform.tenant.manage before any validation work or API call', async () => {
    resetApi(SUPPORT);
    expect(await run(input())).toMatchObject({ ok: false, status: 403 });
    expect(apiCalls()).toBe(0);
  });
});
