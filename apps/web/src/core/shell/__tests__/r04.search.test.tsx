// @vitest-environment jsdom
// T0D-UI-R04: global search in the top bar (10-DESIGN-SYSTEM §3; "search uses existing BFF endpoints only").
// Fake API = MSW at LIMS_ORIGIN_API playing contracts/openapi/frontdesk.yaml (POST /v1/frontdesk/patients/search) and lab.yaml
// (POST /v1/lab/specimens/lookup). The search runs in a SERVER ACTION ('use server', called from the client search box): the browser never
// holds the JWT and never calls the API itself (so jsdom sees the call through MSW, as the micro scan tests do).
//
// CONTRACT chosen by the tester (writer: follow it, or dispute via .orchestra/notes):
//   Enter in the searchbox submits (no per-keystroke call). Empty/blank -> no request. Input maxLength 100 (SearchPatientsRequest.query).
//   Barcode-shaped text (^[A-Z0-9]{1,20}$ after trim) -> POST lookup {barcode} (only if actor has lab.specimen.read); a 200 SpecimenDto opens the order:
//       router.push('/frontdesk/orders/<order_id>') (route staff.frontdesk.order).  Everything else, and barcode-shaped text too, may also go to patients/search.
//   Non-barcode text -> POST patients/search {query, mode ∈ auto|name|phone|code|registration_no, limit ≤ 20} (only if actor has frontdesk.patient.read).
//   Request bodies carry the text; paths/query strings never do (barcodes + names are PHI-class, CV §9.2). Bearer JWT is attached server-side.
//   Results: a region/list named /search results/i with one link per patient (name + code), href /frontdesk/patients/<id>.
//   No match -> role="status" text /no (results|match)/i. API failure -> role="alert" with a generic message (never problem title/detail).
//   Stale responses never overwrite newer ones (last submitted query wins).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse, delay } from 'msw';
import { ALL_PERMS, ID, ORIGIN, PATIENT_SEARCH, SPECIMEN_LOOKUP, api, calls, hits, patient, problem, resetHits, router, session, specimen, user } from './r04.harness';
import { AppShell } from '../AppShell';

vi.mock('next/navigation', async () => (await import('./r04.harness')).navigationMock);
vi.mock('next/link', async () => (await import('./r04.harness')).linkMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./r04.harness')).sessionMock);
vi.mock('@/core/session/actions', async () => (await import('./r04.harness')).actionsMock);
vi.mock('@/core/nav/generated', async () => (await import('./r04.harness')).generatedMock);

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterAll(() => api.close());
beforeEach(() => { resetHits(); router.push.mockClear(); });
afterEach(() => api.resetHandlers());

const SEARCH_PERMS = [...ALL_PERMS, 'frontdesk.patient.read', 'lab.specimen.read', 'frontdesk.order.read'];
const mount = (perms = SEARCH_PERMS) => render(<AppShell session={session(perms) as any} pathname="/lab/worklist"><p>page</p></AppShell>);
const box = () => screen.getByRole('searchbox', { name: /search/i }) as HTMLInputElement;
async function submit(text: string) {
  const u = user();
  await u.click(box());
  await u.clear(box());
  await u.type(box(), `${text}{Enter}`);
}

describe('input', () => {
  it('blank or whitespace does not call anything; maxLength 100', async () => {
    mount();
    expect(box().maxLength).toBe(100);
    await submit('   ');
    await new Promise((r) => setTimeout(r, 50));
    expect(hits).toHaveLength(0);
  });
  it('typing alone (no Enter) does not call the API', async () => {
    mount();
    await user().type(box(), 'Demo');
    await new Promise((r) => setTimeout(r, 50));
    expect(hits).toHaveLength(0);
  });
});

describe('barcode', () => {
  it('a barcode looks the specimen up by body {barcode} and opens the order directly', async () => {
    mount();
    await submit('E2600000101');
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(`/frontdesk/orders/${ID(201)}`));
    const [h] = calls(SPECIMEN_LOOKUP);
    expect(h!.json).toEqual({ barcode: 'E2600000101' });
    expect(h!.headers.get('authorization')).toBe('Bearer jwt-synthetic');
  });
  it('surrounding spaces are trimmed (scanner CR/space)', async () => {
    mount();
    await submit('  E2600000101 ');
    await waitFor(() => expect(calls(SPECIMEN_LOOKUP)).toHaveLength(1));
    expect(calls(SPECIMEN_LOOKUP)[0]!.json).toEqual({ barcode: 'E2600000101' });
  });
  it('unknown barcode (404) shows a no-match status and does not navigate', async () => {
    api.use(http.post(`${ORIGIN}/v1/lab/specimens/lookup`, () => problem('common.not_found', 404)));
    api.use(http.post(`${ORIGIN}/v1/frontdesk/patients/search`, () => HttpResponse.json({ data: [] })));
    mount();
    await submit('ZZZ99999999');
    expect((await screen.findByRole('status')).textContent).toMatch(/no (results|match)/i);
    expect(router.push).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain('LEAK');
  });
  it('text that is not barcode-shaped never reaches the lab lookup (pattern ^[A-Z0-9]{1,20}$)', async () => {
    mount();
    for (const bad of ["E26'; DROP TABLE--", 'e2600000101 x', 'ÉÀ12345', 'A'.repeat(21)]) {
      resetHits();
      await submit(bad);
      await waitFor(() => expect(calls(PATIENT_SEARCH).length).toBeGreaterThan(0));
      expect(calls(SPECIMEN_LOOKUP), bad).toHaveLength(0);
    }
  });
  it('actor without lab.specimen.read: no lookup call is made', async () => {
    mount(SEARCH_PERMS.filter((p) => p !== 'lab.specimen.read'));
    await submit('E2600000101');
    await waitFor(() => expect(calls(PATIENT_SEARCH).length).toBeGreaterThan(0));
    expect(calls(SPECIMEN_LOOKUP)).toHaveLength(0);
    expect(router.push).not.toHaveBeenCalled();
  });
});

describe('patients: name, mobile, patient id', () => {
  it('name -> POST patients/search with the text in the body, ≤ 20 results asked, no lab lookup', async () => {
    mount();
    await submit('Demo Patient');
    await waitFor(() => expect(calls(PATIENT_SEARCH)).toHaveLength(1));
    const body = calls(PATIENT_SEARCH)[0]!.json;
    expect(body.query).toBe('Demo Patient');
    expect(['auto', 'name']).toContain(body.mode ?? 'auto');
    expect(body.limit ?? 20).toBeLessThanOrEqual(20);
    expect(calls(SPECIMEN_LOOKUP)).toHaveLength(0);
  });
  it.each([['9841234567', ['auto', 'phone']], ['P-000001', ['auto', 'code']]])('%s -> patients/search with mode %j', async (q, modes) => {
    mount();
    await submit(q);
    await waitFor(() => expect(calls(PATIENT_SEARCH)).toHaveLength(1));
    const body = calls(PATIENT_SEARCH)[0]!.json;
    expect(body.query).toBe(q);
    expect(modes).toContain(body.mode ?? 'auto');
  });
  it('results list links to the patient pages; name + code visible', async () => {
    mount();
    await submit('Demo');
    const list = await screen.findByRole('region', { name: /search results/i }).catch(() => screen.findByRole('list', { name: /search results/i }));
    const a = within(list).getByRole('link', { name: /Demo Patient A/ });
    expect(a.getAttribute('href')).toBe(`/frontdesk/patients/${ID(1)}`);
    expect(within(list).getAllByRole('link')).toHaveLength(2);
    expect(list.textContent).toContain('P-000001');
  });
  it('actor without frontdesk.patient.read: no patients/search call', async () => {
    mount(SEARCH_PERMS.filter((p) => p !== 'frontdesk.patient.read'));
    await submit('Demo');
    await new Promise((r) => setTimeout(r, 80));
    expect(calls(PATIENT_SEARCH)).toHaveLength(0);
  });
  it('patient names render as text (XSS), Devanagari intact', async () => {
    api.use(http.post(`${ORIGIN}/v1/frontdesk/patients/search`, () => HttpResponse.json({ data: [patient(7, '<img src=x onerror=alert(1)>'), patient(8, 'सुनिता श्रेष्ठ')] })));
    mount();
    await submit('x');
    expect(await screen.findByText('सुनिता श्रेष्ठ')).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByText('<img src=x onerror=alert(1)>', { exact: false })).toBeTruthy();
  });
});

describe('endpoints and privacy', () => {
  it('only the two existing BFF endpoints are called; no query string; the typed text never appears in a path', async () => {
    mount();
    await submit('Demo Patient');
    await submit('E2600000101');
    await waitFor(() => expect(router.push).toHaveBeenCalled());
    for (const h of hits) {
      expect(h.method).toBe('POST');
      expect(h.path).toMatch(/\/v1\/(frontdesk\/patients\/search|lab\/specimens\/lookup)$/);
      expect(h.search).toBe('');
      expect(decodeURIComponent(h.path)).not.toMatch(/Demo|E2600000101/);
    }
  });
  it('API failure -> generic alert, no problem title/detail leaked, no navigation', async () => {
    api.use(http.post(`${ORIGIN}/v1/frontdesk/patients/search`, () => problem('common.internal', 500)));
    mount();
    await submit('Demo');
    expect((await screen.findByRole('alert')).textContent).not.toMatch(/LEAK|common\.internal/);
    expect(document.body.textContent).not.toContain('LEAK');
    expect(router.push).not.toHaveBeenCalled();
  });
  it('403 / 429 also stay generic', async () => {
    for (const [code, status] of [['auth.forbidden', 403], ['common.rate_limited', 429]] as const) {
      api.use(http.post(`${ORIGIN}/v1/frontdesk/patients/search`, () => problem(code, status)));
      const { unmount } = mount();
      await submit('Demo');
      expect((await screen.findByRole('alert')).textContent).not.toMatch(/LEAK/);
      unmount();
    }
  });
  it('race: a slow earlier search never overwrites a newer one', async () => {
    let n = 0;
    api.use(http.post(`${ORIGIN}/v1/frontdesk/patients/search`, async () => {
      n += 1;
      if (n === 1) { await delay(250); return HttpResponse.json({ data: [patient(11, 'Old Result')] }); }
      return HttpResponse.json({ data: [patient(12, 'New Result')] });
    }));
    mount();
    await submit('first');
    await submit('second');
    expect(await screen.findByText(/New Result/)).toBeTruthy();
    await new Promise((r) => setTimeout(r, 400));
    expect(screen.queryByText(/Old Result/)).toBeNull();
    expect(screen.getByText(/New Result/)).toBeTruthy();
  });
  it('double Enter does not fire the same search twice at once', async () => {
    mount();
    const u = user();
    await u.click(box());
    await u.type(box(), 'Demo{Enter}{Enter}');
    await waitFor(() => expect(calls(PATIENT_SEARCH).length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 100));
    expect(calls(PATIENT_SEARCH)).toHaveLength(1);
  });
});
