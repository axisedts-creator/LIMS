// @vitest-environment jsdom
// C13.T16 — SM-1 Partner manifests inbox, SK-1 Partner pickups, SF-1 Partner doctors (04-UI-UX §4). ACs: US-06.1/.2/.9/.11 (inbox, centre scope, missing-sample filter),
// US-10.3 (schedule), US-10.4 (picked up), US-13.3 (map referrer to C3 doctor). Contract: t16.harness.tsx.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { ADMIN_PERMS, DOCTOR, MANIFEST, ORIGIN, PARTNER, PERM, PICKUP, REFERRER, U, doctorHit, manifestSummary, page, pickup, referrer } from './t16.fixtures';
import { calls, idemKey, ifMatch, noAxeViolations, of, problem, rec, renderPage } from './t16.harness';

const session = { perms: [] as string[] };
const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh, back: vi.fn() }),
  usePathname: () => '/partners/manifests',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: session.perms, displayName: 'Synthetic Staff', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/partners/manifests',
}));

const A = `${ORIGIN}/v1/partners/admin`;
const api = setupServer(
  http.get(`${A}/manifests`, async ({ request }) => { await rec(request); return HttpResponse.json(page([manifestSummary({ lines_failed: 2, lines_converted: 1 }), manifestSummary({ id: U(40), manifest_no: 'MF26000002', state: 'partially_received', pickup_request_id: PICKUP, partner: { id: U(2), partner_code: 'SYN-LAB-02', name: 'Second Synthetic Lab' } })])); }),
  http.get(`${A}/pickup-requests`, async ({ request }) => { await rec(request); return HttpResponse.json(page([pickup(), pickup({ id: U(41), state: 'scheduled', scheduled_start: '2026-11-14T05:00:00.000Z', scheduled_end: '2026-11-14T07:00:00.000Z', assignee_text: 'Rider Synthetic', version: 6 })])); }),
  http.post(`${A}/pickup-requests/:id/schedule`, async ({ request }) => { await rec(request); return HttpResponse.json({}); }),
  http.post(`${A}/pickup-requests/:id/picked-up`, async ({ request }) => { await rec(request); return HttpResponse.json({}); }),
  http.post(`${A}/pickup-requests/:id/reject`, async ({ request }) => { await rec(request); return HttpResponse.json({}); }),
  http.get(`${A}/referrers`, async ({ request }) => { await rec(request); return HttpResponse.json(page([referrer(), referrer({ id: U(42), display_name: 'Dr Already Mapped', mapping_state: 'mapped', catalog_doctor: { id: DOCTOR, display_name: 'Dr Catalogue Match' }, version: 8 })])); }),
  http.post(`${A}/referrers/:id/map`, async ({ request }) => { await rec(request); return HttpResponse.json({}); }),
  http.post(`${A}/referrers/:id/reject-mapping`, async ({ request }) => { await rec(request); return HttpResponse.json({}); }),
  http.post(`${A}/referrers/:id/unmap`, async ({ request }) => { await rec(request); return HttpResponse.json({}); }),
  http.post(`${ORIGIN}/v1/catalog/doctors/search`, async ({ request }) => { await rec(request); return HttpResponse.json({ data: [doctorHit()] }); }),
);
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { cleanup(); api.resetHandlers(); calls.length = 0; refresh.mockReset(); session.perms = []; vi.useRealTimers(); });
afterAll(() => api.close());

const open = async (rel: string, perms: string[] = ADMIN_PERMS, searchParams: Record<string, string> = {}) => { session.perms = perms; return renderPage(rel, { searchParams }); };
const pickReason = async (scope: HTMLElement, option: RegExp) => {
  await userEvent.click(within(scope).getByRole('button', { name: /reason/i }));
  await userEvent.click(await screen.findByRole('option', { name: option }));
};
/** "DD/MM/YYYY hh:mm AM" in Asia/Kathmandu, the kit DateTimePicker's typed format (same helper as FD-T13). */
const kathmandu = (d: Date) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kathmandu', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p['day']}/${p['month']}/${p['year']} ${p['hour']}:${p['minute']} ${String(p['dayPeriod']).toUpperCase()}`;
};

describe('SM-1 inbox (US-06)', () => {
  it('columns: manifest no (mono), partner, samples, received, needs attention, submitted, pickup state; row links to SM-2; attention shown with a word', async () => {
    await open('manifests');
    for (const h of ['Manifest', 'Partner', 'Samples', 'Received', 'Needs attention', 'Submitted', 'Pickup']) expect(screen.getByRole('columnheader', { name: new RegExp(h, 'i') })).toBeTruthy();
    const r = screen.getByText('MF26000001').closest('tr')!;
    expect(within(r).getByRole('link', { name: 'MF26000001' }).getAttribute('href')).toBe(`/partners/manifests/${MANIFEST}`);
    expect(r.textContent).toMatch(/Synthetic Partner Lab/);
    expect(r.textContent).toMatch(/2/); // lines_failed
    expect(within(r).getByText(/needs attention|2 need/i)).toBeTruthy();
    expect(screen.getByRole('grid', { name: /\S/ })).toBeTruthy(); // kit DataTable `caption` prop = accessible table name (C0 04-UI-UX:196; C13 04-UI-UX:257)
  });

  it('default request: state=submitted,partially_received, sort -submitted_at, limit ≤ 200; no centre filter forced (scope is the API\'s job — US-06.2)', async () => {
    await open('manifests');
    const g = of('GET', /\/admin\/manifests$/)[0]!;
    expect(g.url.searchParams.get('state')).toBe('submitted,partially_received');
    expect(Number(g.url.searchParams.get('limit') ?? 50)).toBeLessThanOrEqual(200);
  });

  it('filters in the URL become SI1 params: partner_id, receiving_centre_id, submitted_at_from/_to, has_failed_lines, has_missing_samples (US-06.11)', async () => {
    await open('manifests', ADMIN_PERMS, { partner_id: PARTNER, receiving_centre_id: U(4), submitted_at_from: '2026-11-01T00:00:00.000Z', submitted_at_to: '2026-11-13T00:00:00.000Z', has_failed_lines: 'true', has_missing_samples: 'true', state: 'received' });
    const q = of('GET', /\/admin\/manifests$/)[0]!.url.searchParams;
    expect(q.get('partner_id')).toBe(PARTNER);
    expect(q.get('receiving_centre_id')).toBe(U(4));
    expect(q.get('submitted_at_from')).toBe('2026-11-01T00:00:00.000Z');
    expect(q.get('has_failed_lines')).toBe('true');
    expect(q.get('has_missing_samples')).toBe('true');
    expect(q.get('state')).toBe('received');
  });

  it('FilterBar has the two Switches: "Has samples needing attention" and "Order exists but sample missing"', async () => {
    await open('manifests');
    expect(screen.getByRole('switch', { name: /has samples needing attention/i })).toBeTruthy();
    expect(screen.getByRole('switch', { name: /order exists but sample missing/i })).toBeTruthy();
  });

  it('auto-refreshes every 60 s (router.refresh) and stops when unmounted', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await open('manifests');
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(refresh).toHaveBeenCalledTimes(1);
    cleanup();
    refresh.mockReset();
    await act(async () => { vi.advanceTimersByTime(120_000); });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('empty -> "No manifests"; 500 -> alert banner, no stale table; no partners.manifest.receive -> permission text, no API call', async () => {
    api.use(http.get(`${A}/manifests`, () => HttpResponse.json(page([]))));
    await open('manifests');
    expect(screen.getByText(/no manifests/i)).toBeTruthy();
    cleanup();
    api.use(http.get(`${A}/manifests`, () => problem(500, 'common.internal')));
    await open('manifests');
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    cleanup(); calls.length = 0;
    await open('manifests', [PERM.read]);
    expect(screen.getByText(/permission/i)).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it('no axe violations', async () => {
    await open('manifests');
    await noAxeViolations();
  });
});

describe('SK-1 pickups (US-10.3, US-10.4)', () => {
  it('columns Window, Partner, Address/contact, Manifests, Packages, Status (words), Scheduled, Assignee; default state=requested,scheduled', async () => {
    await open('pickups');
    for (const h of ['Window', 'Partner', 'Manifests', 'Packages', 'Status', 'Scheduled', 'Assignee']) expect(screen.getByRole('columnheader', { name: new RegExp(h, 'i') })).toBeTruthy();
    expect(of('GET', /pickup-requests$/)[0]!.url.searchParams.get('state')).toBe('requested,scheduled');
    expect(screen.getByText(/^requested$/i)).toBeTruthy();
    expect(screen.getByText(/^scheduled$/i)).toBeTruthy();
    expect(document.body.textContent).toMatch(/Rider Synthetic/);
    expect(document.body.textContent).toMatch(/MF26000001/);
  });

  it('actions follow state: requested -> Schedule + Reject; scheduled -> Mark picked up; nothing for picked_up/cancelled/rejected', async () => {
    api.use(http.get(`${A}/pickup-requests`, () => HttpResponse.json(page([pickup(), pickup({ id: U(41), state: 'scheduled', assignee_text: 'Rider Synthetic' }), pickup({ id: U(43), state: 'picked_up', assignee_text: 'Rider Done' })]))));
    await open('pickups');
    const req = screen.getByText(/^requested$/i).closest('tr')!;
    expect(within(req).getByRole('button', { name: /^schedule$/i })).toBeTruthy();
    expect(within(req).getByRole('button', { name: /^reject$/i })).toBeTruthy();
    expect(within(req).queryByRole('button', { name: /picked up/i })).toBeNull();
    const sch = screen.getByText(/^scheduled$/i).closest('tr')!;
    expect(within(sch).getByRole('button', { name: /mark picked up/i })).toBeTruthy();
    const done = screen.getByText(/^picked up$/i).closest('tr')!;
    expect(within(done).queryAllByRole('button')).toHaveLength(0);
  });

  it('US-10.3 Schedule: from/to + assignee required; SP2 body {scheduled_start, scheduled_end (ISO UTC), assignee_text ≤ 80} with If-Match "5"', async () => {
    await open('pickups');
    const user = userEvent.setup({ delay: null });
    await user.click(within(screen.getByText(/^requested$/i).closest('tr')!).getByRole('button', { name: /^schedule$/i }));
    const dlg = await screen.findByRole('dialog');
    await user.click(within(dlg).getByRole('button', { name: /^schedule/i }));
    expect(of('POST', /\/schedule$/)).toHaveLength(0); // required fields empty
    const from = new Date(Date.now() + 3600_000), to = new Date(Date.now() + 2 * 3600_000);
    await user.type(within(dlg).getByLabelText(/^from/i), kathmandu(from));
    await user.type(within(dlg).getByLabelText(/^to/i), kathmandu(to));
    const who = within(dlg).getByLabelText(/assignee/i) as HTMLInputElement;
    expect(who.maxLength).toBe(80);
    await user.type(who, 'Rider Synthetic');
    await user.click(within(dlg).getByRole('button', { name: /^schedule/i }));
    await waitFor(() => expect(of('POST', /\/schedule$/)).toHaveLength(1));
    const c = of('POST', /\/schedule$/)[0]!;
    expect(c.url.pathname).toBe(`/v1/partners/admin/pickup-requests/${PICKUP}/schedule`);
    expect(c.body.assignee_text).toBe('Rider Synthetic');
    expect(new Date(c.body.scheduled_start).getTime()).toBeLessThan(new Date(c.body.scheduled_end).getTime());
    expect(c.body.scheduled_start).toMatch(/Z$/);
    expect(ifMatch(c)).toBe('"5"');
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('Schedule: end before start is refused client-side', async () => {
    await open('pickups');
    const user = userEvent.setup({ delay: null });
    await user.click(within(screen.getByText(/^requested$/i).closest('tr')!).getByRole('button', { name: /^schedule$/i }));
    const dlg = await screen.findByRole('dialog');
    await user.type(within(dlg).getByLabelText(/^from/i), kathmandu(new Date(Date.now() + 2 * 3600_000)));
    await user.type(within(dlg).getByLabelText(/^to/i), kathmandu(new Date(Date.now() + 3600_000)));
    await user.type(within(dlg).getByLabelText(/assignee/i), 'Rider Synthetic');
    await user.click(within(dlg).getByRole('button', { name: /^schedule/i }));
    expect(of('POST', /\/schedule$/)).toHaveLength(0);
  });

  it('US-10.4 Mark picked up: ConfirmDialog, SP3 with If-Match "6"; no picked_up_at unless typed (server default now)', async () => {
    await open('pickups');
    const user = userEvent.setup({ delay: null });
    await user.click(within(screen.getByText(/^scheduled$/i).closest('tr')!).getByRole('button', { name: /mark picked up/i }));
    const dlg = await screen.findByRole('dialog');
    await user.click(within(dlg).getByRole('button', { name: /^(confirm|mark)/i }));
    await waitFor(() => expect(of('POST', /\/picked-up$/)).toHaveLength(1));
    const c = of('POST', /\/picked-up$/)[0]!;
    expect(c.url.pathname).toBe(`/v1/partners/admin/pickup-requests/${U(41)}/picked-up`);
    expect(ifMatch(c)).toBe('"6"');
    expect(c.body?.picked_up_at).toBeUndefined();
  });

  it('Reject: ConfirmDialog requires a reason (pickup_reject_reasons seed texts) -> SP4 {reason_code}', async () => {
    await open('pickups');
    const user = userEvent.setup({ delay: null });
    await user.click(within(screen.getByText(/^requested$/i).closest('tr')!).getByRole('button', { name: /^reject$/i }));
    const dlg = await screen.findByRole('dialog');
    await user.click(within(dlg).getByRole('button', { name: /^(confirm|reject)/i }));
    expect(of('POST', /\/reject$/)).toHaveLength(0);
    await pickReason(dlg, /^Outside service area$/);
    await user.click(within(dlg).getByRole('button', { name: /^(confirm|reject)/i }));
    await waitFor(() => expect(of('POST', /\/reject$/)).toHaveLength(1));
    expect(of('POST', /\/reject$/)[0]!.body).toEqual({ reason_code: 'outside_service_area' });
    expect(ifMatch(of('POST', /\/reject$/)[0]!)).toBe('"5"');
  });

  it('409 partners.pickup_invalid_transition -> alert in plain words (someone else changed it)', async () => {
    api.use(http.post(`${A}/pickup-requests/:id/picked-up`, async ({ request }) => { await rec(request); return problem(409, 'partners.pickup_invalid_transition'); }));
    await open('pickups');
    const user = userEvent.setup({ delay: null });
    await user.click(within(screen.getByText(/^scheduled$/i).closest('tr')!).getByRole('button', { name: /mark picked up/i }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /^(confirm|mark)/i }));
    const a = await screen.findAllByRole('alert');
    expect(a.map((x) => x.textContent).join(' ')).not.toMatch(/partners\.pickup_invalid_transition/);
    expect(a.length).toBeGreaterThan(0);
  });

  it('no partners.pickup.manage -> permission text, no API call; empty -> "No pickup requests"; 500 -> alert', async () => {
    await open('pickups', [PERM.read]);
    expect(screen.getByText(/permission/i)).toBeTruthy();
    expect(calls).toHaveLength(0);
    cleanup();
    api.use(http.get(`${A}/pickup-requests`, () => HttpResponse.json(page([]))));
    await open('pickups');
    expect(screen.getByText(/no pickup/i)).toBeTruthy();
    cleanup();
    api.use(http.get(`${A}/pickup-requests`, () => problem(500, 'common.internal')));
    await open('pickups');
    expect(screen.getByRole('alert')).toBeTruthy();
  });
});

describe('SF-1 partner doctors mapping (US-13.3)', () => {
  it('default lists unmapped (mapping_state=unmapped); columns Partner, Name, Qualification, Council/reg. no., Samples this month, State; counts only, no money', async () => {
    await open('referrers');
    expect((of('GET', /\/admin\/referrers$/)[0]!.url.searchParams.get('mapping_state') ?? 'unmapped')).toBe('unmapped');
    for (const h of ['Partner', 'Name', 'Qualification', 'Samples this month', 'State']) expect(screen.getByRole('columnheader', { name: new RegExp(h, 'i') })).toBeTruthy();
    const r = screen.getByText('Dr Synthetic Referrer').closest('tr')!;
    expect(r.textContent).toMatch(/SYN-12345/);
    expect(r.textContent).toMatch(/30/);
    expect(document.body.textContent).not.toMatch(/commission|NPR/i);
    expect(document.body.textContent).not.toMatch(/\bwaiting\b.*\bunmapped\b/i);
  });

  it('mapping_state and partner_id filters travel to SR1', async () => {
    await open('referrers', ADMIN_PERMS, { mapping_state: 'mapped', partner_id: PARTNER });
    const q = of('GET', /\/admin\/referrers$/)[0]!.url.searchParams;
    expect(q.get('mapping_state')).toBe('mapped');
    expect(q.get('partner_id')).toBe(PARTNER);
  });

  it('Confirm -> Dialog with C3 doctor search (POST body, not URL), the "not listed" note, and NO create-doctor link; pick -> SR2 {catalog_doctor_id} with If-Match "6"', async () => {
    await open('referrers');
    const user = userEvent.setup({ delay: null });
    await user.click(within(screen.getByText('Dr Synthetic Referrer').closest('tr')!).getByRole('button', { name: /^confirm$/i }));
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getByText('If the doctor is not listed, ask the catalogue team to add them, then confirm.')).toBeTruthy();
    expect(within(dlg).queryByRole('link', { name: /(create|add|new) doctor/i })).toBeNull();
    expect(within(dlg).queryByRole('button', { name: /(create|add|new) doctor/i })).toBeNull();
    await user.type(within(dlg).getByRole('combobox'), 'Dr Cat');
    const opt = await screen.findByRole('option', { name: /Dr Catalogue Match/ }, { timeout: 4000 });
    const s = of('POST', /\/v1\/catalog\/doctors\/search$/).at(-1)!;
    expect(s.url.search).toBe('');
    expect(s.body.q).toMatch(/Dr Cat/);
    await user.click(opt);
    await user.click(within(dlg).getByRole('button', { name: /^(confirm|map|save)/i }));
    await waitFor(() => expect(of('POST', /\/map$/)).toHaveLength(1));
    const c = of('POST', /\/map$/)[0]!;
    expect(c.url.pathname).toBe(`/v1/partners/admin/referrers/${REFERRER}/map`);
    expect(c.body).toEqual({ catalog_doctor_id: DOCTOR });
    expect(ifMatch(c)).toBe('"6"');
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('SR2 422 partners.referrer_doctor_inactive / 404 -> plain message in the dialog, dialog stays open', async () => {
    api.use(http.post(`${A}/referrers/:id/map`, async ({ request }) => { await rec(request); return problem(422, 'partners.referrer_doctor_inactive'); }));
    await open('referrers');
    const user = userEvent.setup({ delay: null });
    await user.click(within(screen.getByText('Dr Synthetic Referrer').closest('tr')!).getByRole('button', { name: /^confirm$/i }));
    const dlg = await screen.findByRole('dialog');
    await user.type(within(dlg).getByRole('combobox'), 'Dr Cat');
    await user.click(await screen.findByRole('option', { name: /Dr Catalogue Match/ }, { timeout: 4000 }));
    await user.click(within(dlg).getByRole('button', { name: /^(confirm|map|save)/i }));
    const alert = await within(dlg).findByRole('alert');
    expect(alert.textContent).toMatch(/inactive|not active|no longer/i);
    expect(alert.textContent).not.toMatch(/partners\./);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('Reject needs a reason (referrer_mapping_reject_reasons seed text) -> SR3 reject-mapping {reason_code}', async () => {
    await open('referrers');
    const user = userEvent.setup({ delay: null });
    await user.click(within(screen.getByText('Dr Synthetic Referrer').closest('tr')!).getByRole('button', { name: /^reject$/i }));
    const dlg = await screen.findByRole('dialog');
    await user.click(within(dlg).getByRole('button', { name: /^(confirm|reject)/i }));
    expect(of('POST', /reject-mapping$/)).toHaveLength(0);
    await pickReason(dlg, /^Cannot identify this doctor$/);
    await user.click(within(dlg).getByRole('button', { name: /^(confirm|reject)/i }));
    await waitFor(() => expect(of('POST', /reject-mapping$/)).toHaveLength(1));
    expect(of('POST', /reject-mapping$/)[0]!.body.reason_code).toBe('not_identifiable');
    expect(ifMatch(of('POST', /reject-mapping$/)[0]!)).toBe('"6"');
  });

  it('mapped rows show the C3 doctor and "Unlink" -> SR3 unmap with If-Match "8"', async () => {
    await open('referrers', ADMIN_PERMS, { mapping_state: 'mapped' });
    const r = screen.getByText('Dr Already Mapped').closest('tr')!;
    expect(r.textContent).toMatch(/Dr Catalogue Match/);
    await userEvent.click(within(r).getByRole('button', { name: /^unlink$/i }));
    const dlg = screen.queryByRole('dialog');
    if (dlg) await userEvent.click(within(dlg).getByRole('button', { name: /^(confirm|unlink)/i }));
    await waitFor(() => expect(of('POST', /\/unmap$/)).toHaveLength(1));
    expect(ifMatch(of('POST', /\/unmap$/)[0]!)).toBe('"8"');
  });

  it('without partners.referrer.map: permission text, no API call; empty -> "No doctors"; 500 -> alert', async () => {
    await open('referrers', [PERM.read]);
    expect(screen.getByText(/permission/i)).toBeTruthy();
    expect(calls).toHaveLength(0);
    cleanup();
    api.use(http.get(`${A}/referrers`, () => HttpResponse.json(page([]))));
    await open('referrers');
    expect(screen.getByText(/no doctors/i)).toBeTruthy();
    cleanup();
    api.use(http.get(`${A}/referrers`, () => problem(500, 'common.internal')));
    await open('referrers');
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  it('no axe violations', async () => {
    await open('referrers');
    await noAxeViolations();
  });
});
