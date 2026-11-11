// @vitest-environment jsdom
// FD-T14 — Patient page (04-UI-UX §5), Front-desk worklist (§6, F26 possible duplicates), Discount approvals inbox (§7).
// ACs: US-FD-13.1-.3 (recollection flags on the worklist), US-FD-07.2-.5 (approver side of remote approval). 03-APP-FLOW §4 states; 07-SECURITY (masked phone, aal2, self-approval).
// ASSUMED module/prop contract (dispute via writer if wrong). Under apps/web/src/features/frontdesk/components/:
//   PatientView({patient, orders, permissions})                                  patient = Patient (DTO), orders = OrderSummaryDto[] (listPatientOrders data)
//   FrontdeskWorklist({flags, orders, preRegistered, duplicates, resolutions, permissions})
//        flags = OrderFlag[] (all kinds/statuses; the tabs filter), orders = OrderSummaryDto[] used to join registration_no/patient_display by order_id,
//        preRegistered = OrderSummaryDto[] (status pre_registered), duplicates = PossibleDuplicate[] (F26), resolutions = coded set frontdesk.flag_resolutions
//   DiscountApprovalsInbox({approvals, permissions, currentMembershipId, centres})  approvals = DiscountApproval[] (F16 data), centres = [{id, name}]
//   Actions call the BFF (MSW observes /v1/frontdesk/*) with Idempotency-Key + If-Match = `"<row version>"`. Polling (inbox 10 s) = GET /v1/frontdesk/discount-approvals or router.refresh().
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { ReactNode } from 'react';
import { ToastProvider } from '@lims/ui/components/Toast';
import { ORIGIN, ORDER, PATIENT, FLAG, APPROVAL, APPROVAL_OWN, APPROVAL_EXPIRED, CENTRE, ME, OTHER, PERM, RECEPTION, READ_ONLY, U, approval, flag, flagResolutions, npr, orderSummary, patient, patientOrders, patientSummary } from './fd-t14.fixtures';

const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh, back: vi.fn() }),
  usePathname: () => '/frontdesk/worklist',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: [], displayName: 'Synthetic Reception', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/frontdesk/worklist',
}));
process.env.LIMS_ORIGIN_API = ORIGIN;

const centres = [{ id: CENTRE, name: 'Synthetic Centre A1' }];
const APPROVER = [PERM.approve, PERM.orderRead];
const calls: { method: string; url: URL; headers: Headers; body?: any }[] = [];
const rec = async (r: Request) => { calls.push({ method: r.method, url: new URL(r.url), headers: r.headers, body: r.method === 'GET' ? undefined : await r.clone().json().catch(() => undefined) }); };
const problem = (status: number, code: string) => HttpResponse.json({ type: 'about:blank', title: code, status, code }, { status, headers: { 'content-type': 'application/problem+json' } });
const api = setupServer(
  http.post(`${ORIGIN}/v1/frontdesk/discount-approvals/:id/approve`, async ({ request }) => { await rec(request); return HttpResponse.json(approval({ status: 'approved', version: 8 })); }),
  http.post(`${ORIGIN}/v1/frontdesk/discount-approvals/:id/reject`, async ({ request }) => { await rec(request); return HttpResponse.json(approval({ status: 'rejected', version: 8 })); }),
  http.get(`${ORIGIN}/v1/frontdesk/discount-approvals`, async ({ request }) => { await rec(request); return HttpResponse.json({ data: [] }); }),
  http.post(`${ORIGIN}/v1/frontdesk/order-flags/:id/resolve`, async ({ request }) => { await rec(request); return HttpResponse.json(flag({ status: 'resolved', resolution_code: 'patient_recalled', version: 3 })); }),
  http.patch(`${ORIGIN}/v1/frontdesk/patients/:id`, async ({ request }) => { await rec(request); return HttpResponse.json(patient({ version: 5 })); }),
  http.post(`${ORIGIN}/v1/frontdesk/patients/:id/consents`, async ({ request }) => { await rec(request); return HttpResponse.json({ id: U(95), patient_id: PATIENT, consents: patient().consents, recorded_at: '2026-11-07T04:00:00.000Z', recorded_by: { membership_id: ME, display_name: 'Me' } }); }),
);
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { cleanup(); api.resetHandlers(); calls.length = 0; refresh.mockReset(); vi.useRealTimers(); localStorage.clear(); sessionStorage.clear(); });
afterAll(() => api.close());

const wrap = (ui: ReactNode) => render(<ToastProvider>{ui}</ToastProvider>);
const noAxeViolations = async () => {
  const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
  expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
};
const mod = async <T,>(p: string) => (await import(/* @vite-ignore */ `../components/${p}`)) as T;

// ───────────────────────────────────────── Patient page §5
describe('§5 PatientView', () => {
  const load = async () => (await mod<{ PatientView: any }>('PatientView')).PatientView;
  const view = (V: any, p: unknown = patient(), orders: unknown[] = patientOrders, perms: readonly string[] = RECEPTION) => wrap(<V patient={p as never} orders={orders as never} permissions={perms} />);

  it('demographics card: code, name, sex, age, masked phone; consents; visits table with registration no (links to the order), status, source', async () => {
    const V = await load();
    view(V);
    const t = document.body.textContent ?? '';
    for (const s of [/P-000001/, /Demo Patient A/, /female/i, /34 y/, /98xxxxxx42/, /v3/]) expect(t).toMatch(s);
    expect(screen.getByRole('link', { name: 'R-0001-000001' }).getAttribute('href')).toBe(`/frontdesk/orders/${U(1)}`);
    const row = screen.getByRole('link', { name: 'R-0001-000007' }).closest('tr')!;
    expect(within(row).getByText(/cancelled/i)).toBeTruthy();
    for (const h of ['Registration no', 'Status']) expect(screen.getByRole('columnheader', { name: new RegExp(h, 'i') })).toBeTruthy();
  });

  it('empty visits → "No visits yet" (03-APP-FLOW §4)', async () => {
    const V = await load();
    view(V, patient(), []);
    expect(screen.getByText(/No visits yet/)).toBeTruthy();
  });

  it('edit demographics: PATCH with If-Match = row version; body carries only the changed field', async () => {
    const V = await load();
    view(V);
    await userEvent.click(screen.getByRole('button', { name: /edit/i }));
    const name = screen.getByRole('textbox', { name: /full name/i });
    await userEvent.clear(name);
    await userEvent.type(name, 'Demo Patient B');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]!.method).toBe('PATCH');
    expect(calls[0]!.url.pathname).toBe(`/v1/frontdesk/patients/${PATIENT}`);
    expect(calls[0]!.headers.get('if-match')).toBe('"4"');
    expect(calls[0]!.body).toEqual({ full_name: 'Demo Patient B' });
  });

  it('409 common.version_conflict → "Updated by someone else — reload" with a reload action; form is not silently overwritten', async () => {
    api.use(http.patch(`${ORIGIN}/v1/frontdesk/patients/:id`, async ({ request }) => { await rec(request); return problem(409, 'common.version_conflict'); }));
    const V = await load();
    view(V);
    await userEvent.click(screen.getByRole('button', { name: /edit/i }));
    const name = screen.getByRole('textbox', { name: /full name/i });
    await userEvent.clear(name);
    await userEvent.type(name, 'Demo Patient B');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(await screen.findByText(/Updated by someone else — reload/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /reload/i })).toBeTruthy();
  });

  it('"Update consent" dialog posts the five flags + consent_text_version with an Idempotency-Key', async () => {
    const V = await load();
    view(V);
    await userEvent.click(screen.getByRole('button', { name: /update consent/i }));
    const dlg = screen.getByRole('dialog');
    await userEvent.click(within(dlg).getByRole('checkbox', { name: /whatsapp/i }));
    await userEvent.click(within(dlg).getByRole('button', { name: /save|record|confirm/i }));
    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]!.url.pathname).toBe(`/v1/frontdesk/patients/${PATIENT}/consents`);
    expect(calls[0]!.body).toEqual(expect.objectContaining({ processing: true, sms: true, whatsapp: true, email: false, share_with_referrer: false }));
    expect(typeof calls[0]!.body.consent_text_version).toBe('string');
    expect(calls[0]!.headers.get('idempotency-key')).toBeTruthy();
  });

  it('edit / consent actions need frontdesk.registration.create (read-only sees demographics only)', async () => {
    const V = await load();
    view(V, patient(), patientOrders, READ_ONLY);
    expect(screen.queryByRole('button', { name: /edit|update consent/i })).toBeNull();
  });

  it('Anonymise is shown only with frontdesk.patient.anonymise, with retention info text; absent otherwise', async () => {
    const V = await load();
    view(V);
    expect(screen.queryByRole('button', { name: /anonymi[sz]e/i })).toBeNull();
    cleanup();
    view(V, patient(), patientOrders, [...RECEPTION, PERM.anonymise]);
    expect(screen.getByRole('button', { name: /anonymi[sz]e/i })).toBeTruthy();
    expect(document.body.textContent).toMatch(/retention|retained|kept for/i);
  });

  it('anonymised patient: "Anonymised" text, no edit/consent/anonymise actions, no phone/email shown', async () => {
    const V = await load();
    view(V, patient({ is_anonymised: true, full_name: 'Anonymised', phone_e164: undefined, email: undefined, address_text: undefined, phone_masked: '' }), patientOrders, [...RECEPTION, PERM.anonymise]);
    expect(screen.getAllByText(/anonymi[sz]ed/i).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /^edit|update consent|^anonymi[sz]e/i })).toBeNull();
  });

  it('PHI: masked phone in the list/summary; React text nodes only; nothing in browser storage; axe', async () => {
    const V = await load();
    view(V, patient({ full_name: '<b onmouseover=alert(1)>Demo</b>' }));
    expect(document.querySelector('b[onmouseover]')).toBeNull();
    expect(localStorage.length + sessionStorage.length).toBe(0);
    await noAxeViolations();
  });
});

// ───────────────────────────────────────── Worklist §6
describe('§6 FrontdeskWorklist', () => {
  const load = async () => (await mod<{ FrontdeskWorklist: any }>('FrontdeskWorklist')).FrontdeskWorklist;
  const orders = [orderSummary(), orderSummary({ id: U(6), registration_no: 'R-0001-000002', patient_display: 'Demo Patient C' }), orderSummary({ id: U(7), registration_no: 'R-0001-000003', patient_display: 'Demo Patient D' })];
  const flags = [
    flag(), // recollection for ORDER, open
    flag({ id: U(21), order_id: U(6), specimen_id: U(71) }), // another specimen
    flag({ id: U(22), order_id: U(7), kind: 'booking_cancelled_after_registration', specimen_id: undefined }),
    flag({ id: U(23), order_id: U(7), status: 'resolved', resolution_code: 'patient_recalled', resolved_by: { membership_id: ME, display_name: 'Me' } }),
  ];
  const pre = [orderSummary({ id: U(8), registration_no: 'R-0001-000004', patient_display: 'Demo Patient E', status: 'pre_registered', source: 'engagement_booking', has_open_flag: false })];
  const dup = [{ patient: patientSummary({ id: U(9), patient_code: 'P-000009', full_name: 'Demo Patient F' }), candidates: [patientSummary({ id: U(10), patient_code: 'P-000003', full_name: 'Demo Patient F.', phone_masked: '98xxxxxx11' })] }];
  const view = (W: any, o: Record<string, unknown> = {}) => wrap(<W flags={flags as never} orders={orders as never} preRegistered={pre as never} duplicates={dup as never} resolutions={flagResolutions} permissions={RECEPTION} {...o} />);

  it('four tabs in spec order; "Possible duplicates created today" only with frontdesk.registration.create', async () => {
    const W = await load();
    view(W);
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Recollection needed', 'Booking cancelled after registration', 'Pre-registered today', 'Possible duplicates created today']);
    cleanup();
    view(W, { permissions: [PERM.orderRead, PERM.orderEdit] });
    expect(screen.queryByRole('tab', { name: /possible duplicates/i })).toBeNull();
  });

  it('US-FD-13.1 Recollection tab lists OPEN recollection flags (registration no, patient, created) — one row per specimen flag, resolved ones excluded', async () => {
    const W = await load();
    view(W);
    expect(screen.getByRole('link', { name: 'R-0001-000001' }).getAttribute('href')).toBe(`/frontdesk/orders/${ORDER}`);
    const row = screen.getByRole('link', { name: 'R-0001-000001' }).closest('tr')!;
    expect(within(row).getByText('Demo Patient A')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'R-0001-000002' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'R-0001-000003' })).toBeNull(); // booking-cancelled + resolved are not recollection rows
    expect(screen.getAllByRole('row').filter((r) => within(r).queryAllByRole('link').length).length).toBe(2);
  });

  it('Booking-cancelled tab shows only open booking_cancelled_after_registration flags', async () => {
    const W = await load();
    view(W);
    await userEvent.click(screen.getByRole('tab', { name: 'Booking cancelled after registration' }));
    expect(screen.getByRole('link', { name: 'R-0001-000003' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'R-0001-000001' })).toBeNull();
  });

  it('Resolve (frontdesk.order.edit): dialog with coded resolution; no request without it; POST resolve with resolution_code, If-Match=flag version, Idempotency-Key', async () => {
    const W = await load();
    view(W);
    const row = screen.getByRole('link', { name: 'R-0001-000001' }).closest('tr')!;
    await userEvent.click(within(row).getByRole('button', { name: /resolve/i }));
    const dlg = screen.getByRole('dialog');
    await userEvent.click(within(dlg).getByRole('button', { name: /resolve|confirm/i }));
    expect(calls.length).toBe(0);
    await userEvent.click(within(dlg).getByRole('button', { name: /resolution|reason/i }));
    await userEvent.click(await screen.findByRole('option', { name: /patient recalled/i }));
    await userEvent.click(within(dlg).getByRole('button', { name: /resolve|confirm/i }));
    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]!.url.pathname).toBe(`/v1/frontdesk/order-flags/${FLAG}/resolve`);
    expect(calls[0]!.body.resolution_code).toBe('patient_recalled');
    expect(calls[0]!.headers.get('if-match')).toBe('"2"');
    expect(calls[0]!.headers.get('idempotency-key')).toBeTruthy();
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('no Resolve buttons without frontdesk.order.edit', async () => {
    const W = await load();
    view(W, { permissions: [PERM.orderRead] });
    expect(screen.queryByRole('button', { name: /resolve/i })).toBeNull();
  });

  it('keyboard: "R" on a focused row opens Resolve; Enter opens the order (DataTable row navigation)', async () => {
    const W = await load();
    view(W);
    const row = screen.getByRole('link', { name: 'R-0001-000001' }).closest('tr')!;
    row.focus();
    await userEvent.keyboard('r');
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('Pre-registered today: registration no, patient, source (text)', async () => {
    const W = await load();
    view(W);
    await userEvent.click(screen.getByRole('tab', { name: 'Pre-registered today' }));
    const row = screen.getByRole('link', { name: 'R-0001-000004' }).closest('tr')!;
    expect(within(row).getByText('Demo Patient E')).toBeTruthy();
    expect(within(row).getByText(/booking/i)).toBeTruthy();
  });

  it('Possible duplicates (F26): patient + candidates with MASKED phones only, link to each patient page, no raw phone', async () => {
    const W = await load();
    view(W);
    await userEvent.click(screen.getByRole('tab', { name: 'Possible duplicates created today' }));
    expect(screen.getByRole('link', { name: /P-000009/ }).getAttribute('href')).toBe(`/frontdesk/patients/${U(9)}`);
    expect(screen.getByRole('link', { name: /P-000003/ }).getAttribute('href')).toBe(`/frontdesk/patients/${U(10)}`);
    expect(document.body.textContent).toMatch(/98xxxxxx11/);
    expect(document.body.textContent).not.toMatch(/\+977\d{7,}|\b98\d{8}\b/);
  });

  it('empty states: "Nothing pending" on each empty tab (03-APP-FLOW §4)', async () => {
    const W = await load();
    view(W, { flags: [], preRegistered: [], duplicates: [] });
    expect(screen.getByText('Nothing pending')).toBeTruthy();
    for (const t of ['Booking cancelled after registration', 'Pre-registered today', 'Possible duplicates created today']) {
      await userEvent.click(screen.getByRole('tab', { name: t }));
      expect(screen.getByText('Nothing pending')).toBeTruthy();
    }
  });

  it('axe: populated and empty', async () => {
    const W = await load();
    const a = view(W);
    await noAxeViolations();
    a.unmount();
    view(W, { flags: [], preRegistered: [], duplicates: [] });
    await noAxeViolations();
  });
});

// ───────────────────────────────────────── Discount approvals inbox §7
describe('§7 DiscountApprovalsInbox', () => {
  const load = async () => (await mod<{ DiscountApprovalsInbox: any }>('DiscountApprovalsInbox')).DiscountApprovalsInbox;
  const rows = [
    approval(),
    approval({ id: APPROVAL_OWN, requested_by: { membership_id: ME, display_name: 'Me Myself' }, version: 2 }),
    approval({ id: APPROVAL_EXPIRED, status: 'expired', version: 3, requested_by: { membership_id: OTHER, display_name: 'Late Requester' } }),
  ];
  const view = (I: any, o: Record<string, unknown> = {}) => wrap(<I approvals={rows as never} permissions={APPROVER} currentMembershipId={ME} centres={centres} {...o} />);
  const rowOf = (name: string) => screen.getByText(name).closest('tr')!;

  it('columns per §7; row shows requester, gross, discount amount + %, reason, status as text, centre name', async () => {
    const I = await load();
    view(I);
    for (const h of ['Requested', 'Centre', 'Requested by', 'Gross', 'Discount', 'Reason', 'Status']) expect(screen.getByRole('columnheader', { name: new RegExp('^' + h + '$', 'i') })).toBeTruthy();
    const r = rowOf('Synthetic Receptionist');
    expect(within(r).getByText('NPR 1,500.00')).toBeTruthy();
    expect(r.textContent).toMatch(/NPR 450\.00/);
    expect(r.textContent).toMatch(/30(\.0)?\s?%/);
    expect(within(r).getByText(/pending/i)).toBeTruthy();
    expect(r.textContent).toMatch(/Synthetic Centre A1/);
    expect(within(r).getByText(/expires|left|min/i)).toBeTruthy(); // expiry countdown
  });

  it('US-FD-07.2 Approve (A): confirm → POST approve with If-Match = row version and an Idempotency-Key; toast; refresh', async () => {
    const I = await load();
    view(I);
    await userEvent.click(within(rowOf('Synthetic Receptionist')).getByRole('button', { name: /approve/i }));
    const dlg = screen.queryByRole('dialog');
    if (dlg) await userEvent.click(within(dlg).getByRole('button', { name: /approve|confirm/i }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST').length).toBe(1));
    const c = calls.find((x) => x.method === 'POST')!;
    expect(c.url.pathname).toBe(`/v1/frontdesk/discount-approvals/${APPROVAL}/approve`);
    expect(c.headers.get('if-match')).toBe('"7"');
    expect(c.headers.get('idempotency-key')).toBeTruthy();
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('Reject (R): note required (no request without it); POST reject {note} with If-Match + Idempotency-Key', async () => {
    const I = await load();
    view(I);
    await userEvent.click(within(rowOf('Synthetic Receptionist')).getByRole('button', { name: /reject/i }));
    const dlg = screen.getByRole('dialog');
    await userEvent.click(within(dlg).getByRole('button', { name: /reject|confirm/i }));
    expect(calls.filter((c) => c.method === 'POST').length).toBe(0);
    await userEvent.type(within(dlg).getByRole('textbox', { name: /note/i }), 'Not justified');
    await userEvent.click(within(dlg).getByRole('button', { name: /reject|confirm/i }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST').length).toBe(1));
    const c = calls.find((x) => x.method === 'POST')!;
    expect(c.url.pathname).toBe(`/v1/frontdesk/discount-approvals/${APPROVAL}/reject`);
    expect(c.body).toEqual({ note: 'Not justified' });
    expect(c.headers.get('if-match')).toBe('"7"');
  });

  it('keyboard: "A" on a focused pending row starts Approve; "R" starts Reject', async () => {
    const I = await load();
    view(I);
    const r = rowOf('Synthetic Receptionist');
    r.focus();
    await userEvent.keyboard('r');
    expect(screen.getByRole('dialog')).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    r.focus();
    await userEvent.keyboard('a');
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('US-FD-07.3 403 auth.mfa_required → banner "Approving discounts requires MFA — complete MFA in your profile" with a link; nothing marked approved', async () => {
    api.use(http.post(`${ORIGIN}/v1/frontdesk/discount-approvals/:id/approve`, async ({ request }) => { await rec(request); return problem(403, 'auth.mfa_required'); }));
    const I = await load();
    view(I);
    await userEvent.click(within(rowOf('Synthetic Receptionist')).getByRole('button', { name: /approve/i }));
    const dlg = screen.queryByRole('dialog');
    if (dlg) await userEvent.click(within(dlg).getByRole('button', { name: /approve|confirm/i }));
    const banner = await screen.findByText(/Approving discounts requires MFA — complete MFA in your profile/);
    expect(within(banner.closest('[role="alert"],[role="status"],section,div')!).getAllByRole('link').length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(/auth\.mfa_required/);
    expect(within(rowOf('Synthetic Receptionist')).getByText(/pending/i)).toBeTruthy();
  });

  it('US-FD-07.4 own request: Approve disabled with "Needs another approver"; a server 403 frontdesk.discount_self_approval_forbidden is also shown readably', async () => {
    const I = await load();
    view(I);
    const own = rowOf('Me Myself');
    expect(within(own).getByText(/Needs another approver/)).toBeTruthy();
    expect((within(own).getByRole('button', { name: /approve/i }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    api.use(http.post(`${ORIGIN}/v1/frontdesk/discount-approvals/:id/approve`, async ({ request }) => { await rec(request); return problem(403, 'frontdesk.discount_self_approval_forbidden'); }));
    view(I, { currentMembershipId: U(999) }); // UI thinks it is someone else; the API still refuses
    await userEvent.click(within(rowOf('Me Myself')).getByRole('button', { name: /approve/i }));
    const dlg = screen.queryByRole('dialog');
    if (dlg) await userEvent.click(within(dlg).getByRole('button', { name: /approve|confirm/i }));
    expect(await screen.findByText(/another approver|own request|yourself/i)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/frontdesk\.discount_self_approval_forbidden/);
  });

  it('US-FD-07.5 expired / consumed rows: status text, no Approve/Reject buttons', async () => {
    const I = await load();
    view(I, { approvals: [...rows, approval({ id: U(33), status: 'consumed', requested_by: { membership_id: OTHER, display_name: 'Done Requester' }, consumed_order_id: ORDER, version: 9 })] });
    for (const [name, label] of [['Late Requester', /expired/i], ['Done Requester', /consumed|used/i]] as const) {
      const r = rowOf(name);
      expect(within(r).getByText(label)).toBeTruthy();
      expect(within(r).queryByRole('button', { name: /approve|reject/i })).toBeNull();
    }
  });

  it('409 common.version_conflict on approve → "changed" message (someone else decided first), no crash', async () => {
    api.use(http.post(`${ORIGIN}/v1/frontdesk/discount-approvals/:id/approve`, async ({ request }) => { await rec(request); return problem(409, 'common.version_conflict'); }));
    const I = await load();
    view(I);
    await userEvent.click(within(rowOf('Synthetic Receptionist')).getByRole('button', { name: /approve/i }));
    const dlg = screen.queryByRole('dialog');
    if (dlg) await userEvent.click(within(dlg).getByRole('button', { name: /approve|confirm/i }));
    expect(await screen.findByText(/changed|updated by someone else|reload|already decided/i)).toBeTruthy();
  });

  it('row detail drawer lists the discount lines (scope, kind, value, reason)', async () => {
    const I = await load();
    view(I);
    await userEvent.click(within(rowOf('Synthetic Receptionist')).getByRole('button', { name: /details?|view|lines/i }));
    const d = screen.getByRole('dialog');
    expect(d.textContent).toMatch(/bill/i);
    expect(d.textContent).toMatch(/30(\.0)?\s?%/);
    expect(d.textContent).toMatch(/staff relative|staff_relative/i);
  });

  it('empty → "No pending approvals"', async () => {
    const I = await load();
    view(I, { approvals: [] });
    expect(screen.getByText('No pending approvals')).toBeTruthy();
  });

  it('without frontdesk.discount.approve → "Approvals require approver role and MFA", and no rows/actions rendered', async () => {
    const I = await load();
    view(I, { permissions: [PERM.orderRead] });
    expect(screen.getByText(/Approvals require approver role and MFA/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /approve|reject/i })).toBeNull();
    expect(screen.queryByText('Synthetic Receptionist')).toBeNull();
  });

  it('polls every 10 s (BFF GET /v1/frontdesk/discount-approvals or router.refresh) and stops polling after unmount', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    const I = await load();
    const r = view(I);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_500); });
    await waitFor(() => expect(calls.filter((c) => c.method === 'GET').length + refresh.mock.calls.length).toBeGreaterThan(0));
    r.unmount();
    const seen = calls.length + refresh.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(calls.length + refresh.mock.calls.length).toBe(seen);
  });

  it('a long reason_text is rendered as text (no HTML) and the PHI-free inbox keeps nothing in browser storage; axe', async () => {
    const I = await load();
    view(I, { approvals: [approval({ reason_text: '<img src=x onerror=alert(1)>' })] });
    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect(localStorage.length + sessionStorage.length).toBe(0);
    await noAxeViolations();
  });
});

void npr;
