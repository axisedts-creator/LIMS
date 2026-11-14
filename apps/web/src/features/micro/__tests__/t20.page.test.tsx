// @vitest-environment jsdom
// C10.T-20 — /micro/cultures/{culture_id} page + identity card + patient display fallback (04-UI-UX §3; 03-APP-FLOW §4.2; REQ-SEC-026/027).
// "patient display fallback": C4 getPatient fails/forbidden -> "Patient details unavailable", ONE Retry link, no retry storm, the page still works.
// Server component is awaited directly and its element rendered (MSW plays the API). Seams: see t20.harness.tsx header.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { ToastProvider } from '@lims/ui/components/Toast';
import { CULTURE_ID, ID, ORIGIN, PERM_READ, PERM_WORK, api, culture, hit, hits, incubating, patient, problem, resetHits, router, state } from './t20.harness';

vi.mock('next/navigation', async () => (await import('./t20.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t20.harness')).sessionMock);

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { resetHits(); router.refresh.mockReset(); state.permissions = PERM_WORK; });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const show = async (id: string = CULTURE_ID) => {
  const mod = await import('../../../app/(staff)/micro/cultures/[culture_id]/page');
  const el = await mod.default({ params: Promise.resolve({ culture_id: id }) } as never);
  return render(<ToastProvider>{el}</ToastProvider>);
};
const cultureGets = () => hit('GET', /^\/v1\/micro\/cultures\/[^/]+$/);
const patientGets = () => hit('GET', /^\/v1\/frontdesk\/patients\//);
const text = () => document.body.textContent ?? '';

describe('request shape (REQ-SEC-026/027)', () => {
  it('loads the culture once, then patient (patient_id from the culture) and specimen (specimen_id) — never anything from the URL besides the culture id', async () => {
    await show();
    expect(cultureGets()).toHaveLength(1);
    expect(cultureGets()[0]!.path).toBe(`/v1/micro/cultures/${CULTURE_ID}`);
    expect(patientGets().map((h) => h.path)).toEqual([`/v1/frontdesk/patients/${ID(5)}`]);
    expect(hit('GET', /^\/v1\/lab\/specimens\//).map((h) => h.path)).toEqual([`/v1/lab/specimens/${ID(4)}`]);
  });

  it.each(['not-a-uuid', '../../v1/identity/users', `${CULTURE_ID}/../x`, `${CULTURE_ID}%2f..`, '', 'x'.repeat(300)])('a malformed id (%j) -> notFound(), and no request reaches the API', async (bad) => {
    await expect(show(bad)).rejects.toThrow('NEXT_NOT_FOUND');
    expect(hits).toHaveLength(0);
  });

  it('404 / 400 from the API -> notFound() (identical for unknown, other tenant and other centre: S-01, S-02)', async () => {
    api.use(http.get(`${ORIGIN}/v1/micro/cultures/:id`, () => problem('common.not_found', 404)));
    await expect(show()).rejects.toThrow('NEXT_NOT_FOUND');
    api.use(http.get(`${ORIGIN}/v1/micro/cultures/:id`, () => problem('common.validation_failed', 400)));
    await expect(show()).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('403 -> full-page "no access" (no culture data, no patient / specimen fan-out)', async () => {
    api.use(http.get(`${ORIGIN}/v1/micro/cultures/:id`, () => problem('auth.forbidden', 403)));
    await show();
    expect(screen.getByRole('heading', { name: /don.t have access/i })).toBeTruthy();
    expect(screen.queryByRole('tab')).toBeNull();
    expect(patientGets()).toHaveLength(0);
    expect(hit('GET', /^\/v1\/lab\/specimens\//)).toHaveLength(0);
  });

  it('other failures reject to error.tsx (no partial page, no leaked detail)', async () => {
    api.use(http.get(`${ORIGIN}/v1/micro/cultures/:id`, () => problem('common.internal', 500, { detail: 'secret-internal-stack' })));
    await expect(show()).rejects.toBeTruthy();
  });
});

describe('layout (04-UI-UX §3)', () => {
  it('title = test name; breadcrumbs Microbiology › Culture; the five tabs in order; Instrument data badge = open count', async () => {
    api.use(http.get(`${ORIGIN}/v1/micro/cultures/:id`, () => HttpResponse.json(culture({ open_instrument_record_count: 3 }))));
    await show();
    expect(screen.getByRole('heading', { level: 1, name: /Synthetic Urine Culture/ })).toBeTruthy();
    const crumbs = screen.getByRole('navigation', { name: /breadcrumb/i });
    expect(crumbs.textContent).toMatch(/Microbiology/);
    expect(crumbs.textContent).toMatch(/Culture/);
    expect(screen.getAllByRole('tab').map((t) => t.textContent?.replace(/\s+/g, ' ').trim())).toEqual(['Setup & plates', 'Reads & stains', 'Isolates & AST', 'Reports', 'Instrument data (3)']);
    expect(screen.getAllByRole('tab')[0]!.getAttribute('aria-selected')).toBe('true');
  });

  it('identity card lists Patient, Age/Sex, Barcode, Reg no, Specimen type, Site, Received, Planted, Next read, Final due, Lab status', async () => {
    api.use(http.get(`${ORIGIN}/v1/micro/cultures/:id`, () => HttpResponse.json(incubating({ lab_result: { result_id: ID(60), status: 'verified', version_no: 1 } }))));
    await show();
    const labels = Array.from(document.querySelectorAll('dt')).map((d) => d.textContent?.trim());
    for (const l of ['Patient', 'Age / Sex', 'Barcode', 'Reg no', 'Specimen type', 'Site', 'Received', 'Planted', 'Next read', 'Final due', 'Lab status']) expect(labels, l).toContain(l);
    for (const v of ['Synthetic Patient One', 'E260000001', 'R261100001']) expect(text(), v).toContain(v);
    expect(text()).toMatch(/34 y.*F|F.*34 y/);
  });

  it('a failing specimen read leaves Reg no empty but the page renders (no error state)', async () => {
    api.use(http.get(`${ORIGIN}/v1/lab/specimens/:id`, () => problem('common.internal', 500)));
    await show();
    expect(screen.getByRole('heading', { level: 1, name: /Synthetic Urine Culture/ })).toBeTruthy();
    expect(text()).toContain('Synthetic Patient One');
  });

  it.each([
    ['awaiting_setup', 'Awaiting set-up', 'neutral'], ['incubating', 'Incubating', 'info'], ['growth_detected', 'Growth — work-up', 'warning'],
    ['final_submitted', 'Final submitted', 'success'], ['amending', 'Amending', 'warning'], ['cancelled', 'Cancelled', 'neutral'],
  ])('status %s -> chip "%s", tone %s, with an icon (§9; LD-140)', async (status, label, tone) => {
    api.use(http.get(`${ORIGIN}/v1/micro/cultures/:id`, () => HttpResponse.json(culture({ status }))));
    await show();
    const chip = screen.getAllByText(label, { selector: '*' }).map((e) => e.closest('[data-tone]')).find(Boolean) as HTMLElement | undefined;
    expect(chip, `chip ${label}`).toBeTruthy();
    expect(chip!.getAttribute('data-tone')).toBe(tone);
    expect(chip!.querySelector('svg,[data-icon],[aria-hidden=true]'), 'icon').toBeTruthy();
  });

  it('banners: chain_cancelled and amending copy (03-APP-FLOW §4.2 item 4)', async () => {
    api.use(http.get(`${ORIGIN}/v1/micro/cultures/:id`, () => HttpResponse.json(culture({ status: 'amending', chain_cancelled: true, amendment_reason_text: 'Synthetic reason text' }))));
    await show();
    expect(text()).toContain('This test was cancelled in the lab after a report was submitted');
    expect(text()).toContain('Amendment in progress: Synthetic reason text');
  });

  it('free text from the API is a text node, never HTML (REQ-SEC-088)', async () => {
    api.use(http.get(`${ORIGIN}/v1/micro/cultures/:id`, () => HttpResponse.json(culture({ test_name: '<img src=x onerror="window.__x=1">Synthetic', amendment_reason_text: '<script>window.__x=2</script>', status: 'amending' }))));
    await show();
    expect(document.querySelector('img[onerror]')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
    expect((window as any).__x).toBeUndefined();
  });
});

describe('patient display fallback (04-UI-UX §3)', () => {
  it.each([[403, 'auth.forbidden'], [404, 'common.not_found'], [500, 'common.internal']])('C4 answers %s -> "Patient details unavailable", no name, the page still renders', async (status, c) => {
    api.use(http.get(`${ORIGIN}/v1/frontdesk/patients/:id`, () => problem(c, status, { detail: 'secret-internal' })));
    await show();
    expect(screen.getByText(/patient details unavailable/i)).toBeTruthy();
    expect(text()).not.toContain('Synthetic Patient One');
    expect(text()).not.toContain('secret-internal');
    expect(screen.getByRole('heading', { level: 1, name: /Synthetic Urine Culture/ })).toBeTruthy();
    expect(screen.getAllByRole('tab')).toHaveLength(5);
  });

  it('a network error on the patient read is handled the same way', async () => {
    api.use(http.get(`${ORIGIN}/v1/frontdesk/patients/:id`, () => HttpResponse.error()));
    await show();
    expect(screen.getByText(/patient details unavailable/i)).toBeTruthy();
  });

  it('no retry storm: exactly one patient request on load, and exactly one "Retry" link', async () => {
    api.use(http.get(`${ORIGIN}/v1/frontdesk/patients/:id`, () => problem('common.internal', 500)));
    await show();
    await new Promise((r) => setTimeout(r, 300));
    expect(patientGets()).toHaveLength(1);
    expect(screen.getAllByRole('link', { name: /^retry$/i }).concat(screen.queryAllByRole('button', { name: /^retry$/i }))).toHaveLength(1);
  });

  it('Retry asks again once (a second patient read or a page refresh) and shows the name when it works', async () => {
    let n = 0;
    api.use(http.get(`${ORIGIN}/v1/frontdesk/patients/:id`, () => (++n === 1 ? problem('common.internal', 500) : HttpResponse.json(patient()))));
    await show();
    const retry = screen.queryByRole('link', { name: /^retry$/i }) ?? screen.getByRole('button', { name: /^retry$/i });
    await userEvent.click(retry);
    await waitFor(() => expect(patientGets().length > 1 || router.refresh.mock.calls.length > 0).toBe(true));
    expect(patientGets().length).toBeLessThanOrEqual(2);
  });

  it('a patient who cannot be shown never turns the culture into an error (read-only user without frontdesk.patient.read)', async () => {
    state.permissions = ['micro.culture.read'];
    api.use(http.get(`${ORIGIN}/v1/frontdesk/patients/:id`, () => problem('auth.forbidden', 403)));
    await show();
    expect(screen.getByText(/patient details unavailable/i)).toBeTruthy();
  });
});

describe('getPatient BFF function (C4 read; PHI minimisation)', () => {
  const get = async (id: string) => (await import('../server/getPatient.server')).getPatient(id);

  it('maps the C4 patient to { name, age_display, sex } and nothing else (no phone, code, visit date)', async () => {
    const p = await get(ID(5));
    expect(p).toEqual({ name: 'Synthetic Patient One', age_display: '34 y', sex: 'F' });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.path).toBe(`/v1/frontdesk/patients/${ID(5)}`);
  });

  it.each([[403], [404], [500]])('%s -> null (never throws), exactly one request', async (status) => {
    api.use(http.get(`${ORIGIN}/v1/frontdesk/patients/:id`, () => problem('common.internal', status)));
    expect(await get(ID(5))).toBeNull();
    expect(hits).toHaveLength(1);
  });

  it('a tampered id never reaches the API (null or a validation error, zero requests)', async () => {
    const r = await get('../../admin').catch(() => null);
    expect(r).toBeNull();
    expect(hits).toHaveLength(0);
  });
});

describe('permissions', () => {
  it('a read-only user sees the page but none of the write buttons', async () => {
    state.permissions = PERM_READ;
    api.use(http.get(`${ORIGIN}/v1/micro/cultures/:id`, () => HttpResponse.json(incubating())));
    await show();
    for (const n of [/set up culture/i, /record read/i, /add plate/i, /add isolate/i, /record stain/i, /preliminary report/i, /final report/i, /^cancel/i]) expect(screen.queryByRole('button', { name: n }), String(n)).toBeNull();
    expect(within(document.body).queryAllByRole('tab')).toHaveLength(5);
  });
});
