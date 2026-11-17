// @vitest-environment jsdom
// HC-T19 — route page app/(staff)/homecollection/visits/[visit_id]/page.tsx (04-UI-UX §2.2 W2; TRD H2, H20; US-16-1; 07-SECURITY §3 "Staff web H1–H21", REQ-SEC-096/097). MSW plays the API.
// ASSUMED contract (dispute via the writer if wrong):
//   * default export async `Page({ params })`, `params` = Promise<{ visit_id: string }> (repo convention `[order_id]`, `[patient_id]`, Next 16).
//   * notFound() — before ANY API call — without homecollection.visit.read or for a non-uuid id; API 404 -> notFound(); API 403 (`homecollection.visit_not_assigned`, phlebotomist-only)
//     -> a view that says "This visit isn't assigned to you." (no detail, no raw code); 5xx is thrown to error.tsx (ApiError).
//   * US-16-1: exactly ONE `GET /visits/{id}` (H2 writes the access-log row, so a render must not read twice) and NO `POST /phone-reveal` on load.
//   * H20 reasons are read only with homecollection.visit.assign: review_reasons, flag_resolutions, visit_cancel_reasons, unassign_reasons, revisit_reasons.
//   * renders <VisitDetailView visit permissions codes/> (components/VisitDetailView.tsx) with `visit` rebuilt from an allow-list: no phone, nothing the spec does not name.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { API, CODES19, ORIGIN, PERMS_REVIEW, PHONE, U, VISIT_ID, detail, problem, reasonsFor, recorder, wrap, type Call } from './hc-t19.helpers';

const perms = vi.hoisted(() => ({ current: [] as string[] }));
const captured = vi.hoisted(() => ({ props: undefined as any }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => `/homecollection/visits/x`,
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: perms.current, displayName: 'Synthetic Dispatcher', tenantCode: 'syn', roles: [], membershipId: U(9) } }),
  getRequestPathname: async () => `/homecollection/visits/${VISIT_ID}`,
}));
vi.mock('@/features/homecollection/components/VisitDetailView', () => ({ VisitDetailView: (p: unknown) => { captured.props = p; return <div data-testid="detail" />; } }));

const calls: Call[] = [];
const rec = recorder(calls);
type R = () => Response | Promise<Response>;
let visit: R;
const reset = () => { visit = () => HttpResponse.json(detail()); };
reset();
const api = setupServer(
  http.get(`${API}/visits/:id`, async ({ request }) => { await rec(request); return visit(); }),
  http.post(`${API}/visits/:id/phone-reveal`, async ({ request }) => { await rec(request); return HttpResponse.json({ phone_e164: PHONE }); }),
  http.get(`${API}/reasons`, async ({ request }) => { await rec(request); return reasonsFor(new URL(request.url).searchParams.get('set')); }),
);
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { cleanup(); api.resetHandlers(); calls.length = 0; captured.props = undefined; perms.current = []; reset(); });
afterAll(() => api.close());
void ORIGIN;

const page = async (id: string = VISIT_ID) => {
  const path = '../../../app/(staff)/homecollection/visits/[visit_id]/page'; // variable path: a missing file fails each test, not the whole suite
  const mod = (await import(/* @vite-ignore */ path)) as { default: (p: any) => Promise<any> };
  wrap(await mod.default({ params: Promise.resolve({ visit_id: id }) }));
};
const to = (m: string, suffix: string) => calls.filter((c) => c.method === m && c.url.pathname.endsWith(suffix));

describe('permission gate and id validation (notFound BEFORE any API call)', () => {
  it.each([[[]], [['homecollection.handover.receive']], [['frontdesk.registration.create']]])('without homecollection.visit.read (%j): notFound and NOT ONE API call', async (p) => {
    perms.current = p as string[];
    await expect(page()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(calls).toHaveLength(0);
  });
  it.each(['not-a-uuid', '../../admin', '01a1a98a-ac40-7000-8000-00000000104%2F..', ''])('hostile id %j: notFound, no API call (nothing reaches the URL)', async (id) => {
    perms.current = PERMS_REVIEW;
    await expect(page(id)).rejects.toThrow('NEXT_NOT_FOUND');
    expect(calls).toHaveLength(0);
  });
  it('API 404 -> notFound (shell not-found page)', async () => {
    perms.current = PERMS_REVIEW;
    visit = () => problem('common.not_found', 404);
    await expect(page()).rejects.toThrow('NEXT_NOT_FOUND');
  });
  it('API 403 homecollection.visit_not_assigned (phlebotomist-only actor) -> "This visit isn\'t assigned to you.", no detail, no raw code', async () => {
    perms.current = ['homecollection.visit.read', 'homecollection.sync.upload'];
    visit = () => problem('homecollection.visit_not_assigned', 403);
    await page();
    expect(screen.queryByTestId('detail')).toBeNull();
    expect(document.body.textContent).toContain("This visit isn't assigned to you.");
    expect(document.body.textContent).not.toMatch(/homecollection\.visit_not_assigned|urn:lims/);
  });
  it('API 500 is thrown to error.tsx (the ApiError itself, so the request id is shown)', async () => {
    perms.current = PERMS_REVIEW;
    visit = () => problem('common.internal', 500);
    await expect(page()).rejects.toMatchObject({ status: 500 });
  });
});

describe('US-16-1: opening a visit reads H2 once and never asks for the phone', () => {
  it('exactly one GET /visits/{id} (one access-log row, purpose visit_detail) and no phone-reveal call', async () => {
    perms.current = PERMS_REVIEW;
    await page();
    expect(to('GET', `/visits/${VISIT_ID}`)).toHaveLength(1);
    expect(calls.filter((c) => c.url.pathname.endsWith('/phone-reveal'))).toHaveLength(0);
    expect(screen.getByTestId('detail')).toBeTruthy();
  });
  it('the view gets the visit and the actor permissions', async () => {
    perms.current = PERMS_REVIEW;
    await page();
    expect(captured.props.visit.id).toBe(VISIT_ID);
    expect(captured.props.visit.patient_display_name).toBe('Test Patient 0042');
    expect(captured.props.permissions).toEqual(PERMS_REVIEW);
  });
  it('allow-list: a phone (even if the API wrongly sent one), device ids, GPS and unknown fields never reach the browser', async () => {
    perms.current = PERMS_REVIEW;
    visit = () => HttpResponse.json(detail({ phone_e164: PHONE, patient_phone: PHONE, device_id: U(8888), gps: { lat: 1 }, internal_note: 'secret', collections: [{ ...detail().collections[0], phone_e164: PHONE, raw_payload: 'x' }] }));
    await page();
    const dump = JSON.stringify(captured.props);
    for (const w of ['9779800000042', 'phone', 'device_id', 'gps', 'internal_note', 'raw_payload']) expect(dump, w).not.toContain(w);
    expect(captured.props.visit.collections[0].id).toBe(detail().collections[0]!.id);
  });
  it('an unknown flag kind / collection hold code / status from the API is passed through as text (x-extensible enums)', async () => {
    perms.current = PERMS_REVIEW;
    visit = () => HttpResponse.json(detail({ open_flag_kinds: ['future_flag'], flags: [{ id: U(8199), version: 1, kind: 'future_flag', status: 'open', created_at: '2026-11-14T03:20:00.000Z' }] }));
    await page();
    expect(captured.props.visit.flags[0].kind).toBe('future_flag');
  });
});

describe('H20 coded sets', () => {
  it('a dispatcher (visit.assign) gets the five sets, each read once', async () => {
    perms.current = PERMS_REVIEW;
    await page();
    expect(to('GET', '/reasons').map((c) => c.url.searchParams.get('set')).sort()).toEqual(['flag_resolutions', 'review_reasons', 'revisit_reasons', 'unassign_reasons', 'visit_cancel_reasons']);
    expect(captured.props.codes.review_reasons.map((c: { code: string }) => c.code)).toEqual(CODES19.review_reasons.map((c) => c.code));
    expect(captured.props.codes.flag_resolutions).toHaveLength(CODES19.flag_resolutions.length);
  });
  it('read-only actor (no visit.assign): no H20 call, and the patient address / note are NOT passed to the view (only visit.assign holders see them)', async () => {
    perms.current = ['homecollection.visit.read'];
    await page();
    expect(to('GET', '/reasons')).toHaveLength(0);
    expect(captured.props.permissions).toEqual(['homecollection.visit.read']);
    const dump = JSON.stringify(captured.props.visit);
    for (const w of ['Baneshwor', 'synthetic temple', 'Ring the bell', '27.6934']) expect(dump, w).not.toContain(w);
  });
});
