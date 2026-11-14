// @vitest-environment jsdom
// C10.T-24 — breakpoint tables list + import dialog (04-UI-UX §6.1, §9, §10; AC-12.1, AC-12.3, AC-12.5; 07-SECURITY REQ-SEC-083/085, S-13).
// LD-140 (2026-11-13): kit components only, one primary button per page, every status shows tone + icon + word.
// ASSUMED seams: see t24.harness.tsx header. Uploads go through a server action that assembles multipart (metadata JSON part + `file` part text/csv) with an Idempotency-Key.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { ToastProvider } from '@lims/ui/components/Toast';
import { parseMultipart } from '../../catalog/__tests__/web-t35.multipart';
import { ID, ORIGIN, PERM_BP, PERM_READ_ONLY, api, hit, hits, problem, resetHits, router, setDto } from './t24.harness';

vi.mock('next/navigation', async () => (await import('./t24.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t24.harness')).sessionMock);

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { resetHits(); router.push.mockReset(); });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const ATTEST = 'Synthetic attestation: our laboratory holds a licence for this table.';
const CSV = 'standard,version\r\n=cmd|calc,1\r\n'; // formula-injection probe (S-13): must travel as opaque bytes, never evaluated
const mount = async (sets = [setDto()], permissions = PERM_BP) => {
  const { BreakpointSetsScreen } = await import('../components/breakpoints/BreakpointSetsScreen');
  return render(<ToastProvider><BreakpointSetsScreen sets={sets as never} permissions={permissions} /></ToastProvider>);
};
const openDialog = async () => { await userEvent.click(screen.getByRole('button', { name: /^import table$/i })); return screen.getByRole('dialog'); };
const fill = async (d: HTMLElement, o: { version?: string; title?: string; attest?: string } = {}) => {
  await userEvent.click(within(d).getByRole('button', { name: /standard/i }));
  await userEvent.click(await screen.findByRole('option', { name: /^CLSI$/ }));
  await userEvent.type(within(d).getByRole('textbox', { name: /^version/i }), o.version ?? '2099-test');
  await userEvent.type(within(d).getByRole('textbox', { name: /^title/i }), o.title ?? 'Synthetic zone table');
  await userEvent.type(within(d).getByRole('textbox', { name: /right to use this table/i }), o.attest ?? ATTEST);
};
const pickFile = (d: HTMLElement, f = new File([CSV], 'table.csv', { type: 'text/csv' })) =>
  userEvent.upload(d.querySelector<HTMLInputElement>('input[type=file]')!, f, { applyAccept: false });

describe('list (04-UI-UX §6.1)', () => {
  it('shows the always-on licence banner, the heading and the columns Title…Imported at', async () => {
    await mount();
    expect(screen.getByRole('heading', { level: 1, name: /breakpoint tables/i })).toBeTruthy();
    expect(document.body.textContent).toContain('LIMS does not include CLSI or EUCAST breakpoints. Import only tables your laboratory is licensed to use.');
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent?.trim());
    for (const h of ['Title', 'Standard', 'Version', 'Status', 'Effective from', 'Effective to', 'Rows', 'Errors', 'Imported by', 'Imported at']) expect(headers, h).toContain(h);
  });

  it.each([
    ['uploaded', 'Uploaded'], ['validating', 'Checking'], ['validated', 'Ready to activate'], ['invalid', 'Has errors'],
    ['active', 'In use'], ['retired', 'Retired'], ['discarded', 'Discarded'],
  ])('status %s is labelled "%s" (§9) and carries an icon besides the word (LD-140)', async (status, label) => {
    await mount([setDto({ status }) as never]);
    const chip = screen.getByText(label, { selector: '*' }).closest('[class],[data-tone],[role=status]') as HTMLElement;
    expect(chip, 'StatusChip element').toBeTruthy();
    expect(chip.querySelector('svg,[data-icon],[aria-hidden=true]'), 'icon in chip').toBeTruthy();
    expect(chip.textContent).toContain(label);
  });

  it('tone per §9: invalid = danger, active = success (read from the kit chip, not from colour)', async () => {
    await mount([setDto({ id: ID(1), status: 'invalid' }), setDto({ id: ID(2), status: 'active', title: 'Active one' })] as never);
    const tone = (label: string) => (screen.getByText(label).closest('[data-tone]') as HTMLElement | null)?.getAttribute('data-tone');
    expect(tone('Has errors')).toBe('danger');
    expect(tone('In use')).toBe('success');
  });

  it('empty state copy', async () => {
    await mount([]);
    expect(document.body.textContent).toContain('No breakpoint tables imported. Categories are entered manually.');
  });

  it('rows link to the detail route by UUID only (REQ-SEC-026/027)', async () => {
    await mount();
    const link = screen.getByRole('link', { name: /synthetic zone table/i }) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe(`/micro/breakpoint-sets/${ID(1)}`);
  });

  it('exactly one primary button on the page (LD-140) and it is "Import table"', async () => {
    await mount();
    const primaries = Array.from(document.querySelectorAll('button')).filter((b) => b.classList.contains('lims-btn-primary'));
    expect(primaries.map((b) => b.textContent?.trim())).toEqual(['Import table']);
  });

  it('without micro.breakpoint.manage there is no Import button (read-only user)', async () => {
    await mount([setDto()], PERM_READ_ONLY);
    expect(screen.queryByRole('button', { name: /^import table$/i })).toBeNull();
  });

  it('free text from the server (title) renders as text, never HTML (S-13)', async () => {
    await mount([setDto({ title: '<img src=x onerror=alert(1)>' }) as never]);
    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect(document.body.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});

describe('import dialog (AC-12.1; 04-UI-UX §6.1; done_when "CSV accept: FileUpload accept += text/csv")', () => {
  it('has the fields Standard, Version, Title, Intended start, Licence confirmation, File, template link and the Upload button', async () => {
    await mount();
    const d = await openDialog();
    expect(within(d).getByRole('button', { name: /standard/i })).toBeTruthy();
    expect((within(d).getByRole('textbox', { name: /^version/i }) as HTMLInputElement).maxLength).toBe(32);
    expect((within(d).getByRole('textbox', { name: /^title/i }) as HTMLInputElement).maxLength).toBe(120);
    expect((within(d).getByRole('textbox', { name: /right to use this table/i }) as HTMLTextAreaElement).maxLength).toBe(500);
    expect(d.textContent).toMatch(/as printed on your source/i);
    expect(within(d).getByText(/intended start/i)).toBeTruthy();
    const input = d.querySelector<HTMLInputElement>('input[type=file]')!;
    expect(input.accept).toBe('text/csv');
    expect(within(d).getByRole('link', { name: /download template/i }).getAttribute('href')).toMatch(/breakpoint-import-template|breakpoint-template/);
    expect(within(d).getByRole('button', { name: /^upload$/i })).toBeTruthy();
  });

  it('the Standard select offers exactly CLSI, EUCAST, ECOFF', async () => {
    await mount();
    const d = await openDialog();
    await userEvent.click(within(d).getByRole('button', { name: /standard/i }));
    expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['CLSI', 'EUCAST', 'ECOFF']);
  });

  it('licence attestation must be 20..500 characters: 19 blocks the request, 20 passes', async () => {
    api.use(http.post(`${ORIGIN}/v1/micro/breakpoint-sets`, () => HttpResponse.json(setDto({ status: 'uploaded' }), { status: 201 })));
    await mount();
    const d = await openDialog();
    await fill(d, { attest: 'x'.repeat(19) });
    await pickFile(d);
    await userEvent.click(within(d).getByRole('button', { name: /^upload$/i }));
    expect(hit('POST', /breakpoint-sets$/)).toHaveLength(0);
    expect(d.textContent).toMatch(/20/);
    await userEvent.type(within(d).getByRole('textbox', { name: /right to use this table/i }), 'y');
    await userEvent.click(within(d).getByRole('button', { name: /^upload$/i }));
    await waitFor(() => expect(hit('POST', /breakpoint-sets$/)).toHaveLength(1));
  });

  it('required fields: no request until Standard, Version, Title, licence text and a file are present', async () => {
    await mount();
    const d = await openDialog();
    await userEvent.click(within(d).getByRole('button', { name: /^upload$/i }));
    expect(hits.filter((h) => h.method === 'POST')).toHaveLength(0);
  });

  it('uploads a multipart body: metadata (application/json) + file (text/csv), Idempotency-Key set, then navigates to the new set (AC-12.1)', async () => {
    let raw = ''; let ct = ''; let key: string | null = null;
    api.use(http.post(`${ORIGIN}/v1/micro/breakpoint-sets`, async ({ request }) => {
      raw = await request.text(); ct = request.headers.get('content-type') ?? ''; key = request.headers.get('idempotency-key');
      return HttpResponse.json(setDto({ id: ID(77), status: 'uploaded' }), { status: 201 });
    }));
    await mount();
    const d = await openDialog();
    await fill(d);
    await pickFile(d);
    await userEvent.click(within(d).getByRole('button', { name: /^upload$/i }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(`/micro/breakpoint-sets/${ID(77)}`));
    expect(ct).toMatch(/^multipart\/form-data; boundary=/);
    expect(key).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    const f = parseMultipart(ct, raw);
    expect(f.keys().sort()).toEqual(['file', 'metadata']);
    expect(JSON.parse(f.get('metadata') as string)).toEqual({ standard: 'CLSI', standard_version: '2099-test', title: 'Synthetic zone table', licence_attestation_text: ATTEST });
    expect(raw).toMatch(/name="metadata"[\s\S]*?Content-Type: application\/json/i);
    expect(raw).toMatch(/name="file"; filename="table\.csv"[\s\S]*?Content-Type: text\/csv/i);
    expect((f.get('file') as { text: string }).text).toBe(CSV); // bytes untouched: the UI never parses or evaluates the CSV (REQ-SEC-088/S-13)
  });

  it('rejects a non-CSV or oversized file before any request (REQ-SEC-083: 5,242,880 bytes cap, text/csv only)', async () => {
    await mount();
    const d = await openDialog();
    await fill(d);
    await pickFile(d, new File(['x'], 'table.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    await userEvent.click(within(d).getByRole('button', { name: /^upload$/i }));
    await pickFile(d, new File([new Uint8Array(5_242_881)], 'big.csv', { type: 'text/csv' }));
    await userEvent.click(within(d).getByRole('button', { name: /^upload$/i }));
    expect(hits.filter((h) => h.method === 'POST')).toHaveLength(0);
    expect(d.textContent).toMatch(/5 ?MiB|5\.0 ?MB|5,242,880|too large|larger than/i);
  });

  it('accepts a file of exactly 5,242,880 bytes (boundary, AC-12.1)', async () => {
    api.use(http.post(`${ORIGIN}/v1/micro/breakpoint-sets`, () => HttpResponse.json(setDto({ id: ID(78), status: 'uploaded' }), { status: 201 })));
    await mount();
    const d = await openDialog();
    await fill(d);
    await pickFile(d, new File([new Uint8Array(5_242_880).fill(0x61)], 'edge.csv', { type: 'text/csv' }));
    await userEvent.click(within(d).getByRole('button', { name: /^upload$/i }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith(`/micro/breakpoint-sets/${ID(78)}`));
  });

  it('duplicate file → 422 micro.breakpoint_import_invalid shows the §10 copy and keeps the dialog open (AC-12.3)', async () => {
    api.use(http.post(`${ORIGIN}/v1/micro/breakpoint-sets`, () => problem('micro.breakpoint_import_invalid', 422, { detail: 'duplicate file' })));
    await mount();
    const d = await openDialog();
    await fill(d);
    await pickFile(d);
    await userEvent.click(within(d).getByRole('button', { name: /^upload$/i }));
    await waitFor(() => expect(document.body.textContent).toContain("The file can't be used (it must be a UTF-8 CSV that hasn't been uploaded before)."));
    expect(screen.queryByRole('dialog')).toBeTruthy();
    expect(router.push).not.toHaveBeenCalled();
  });

  it('aal1 → 403 auth.mfa_required is NOT shown as a form error (the shell owns the MFA prompt, 04-UI-UX §6.1) and nothing navigates (AC-12.5)', async () => {
    api.use(http.post(`${ORIGIN}/v1/micro/breakpoint-sets`, () => problem('auth.mfa_required', 403)));
    await mount();
    const d = await openDialog();
    await fill(d);
    await pickFile(d);
    await userEvent.click(within(d).getByRole('button', { name: /^upload$/i }));
    await waitFor(() => expect(hit('POST', /breakpoint-sets$/)).toHaveLength(1));
    expect(router.push).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toMatch(/auth\.mfa_required/); // raw code never shown to the user
  });

  it('a double click on Upload sends one request (idempotent submit, many-users/double-submit attack)', async () => {
    let n = 0;
    api.use(http.post(`${ORIGIN}/v1/micro/breakpoint-sets`, async () => { n += 1; await new Promise((r) => setTimeout(r, 150)); return HttpResponse.json(setDto({ id: ID(79), status: 'uploaded' }), { status: 201 }); }));
    await mount();
    const d = await openDialog();
    await fill(d);
    await pickFile(d);
    const go = within(d).getByRole('button', { name: /^upload$/i });
    await userEvent.dblClick(go);
    await waitFor(() => expect(router.push).toHaveBeenCalled());
    expect(n).toBe(1);
  });
});
