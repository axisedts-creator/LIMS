// @vitest-environment jsdom
// C5 T-25 — Lab settings "QC holds" tab (04-UI-UX §3.13: "QC holds (list; Release with comment — Phase 2 copy 'Holds are created by the QC module')"; 02-TRD §5.7 rows 45-46; 03-APP-FLOW QC hold lifecycle;
// 07-SECURITY S-16, REQ-SEC-062/067 `auth.mfa_required`). Real HTTP goes to LIMS_ORIGIN_API (MSW); `onUnhandledRequest: 'error'`.
// ASSUMED contract (T-29 owns the page; this task adds the fourth tab to components/settings/LabSettingsPage.tsx — the writer matches the names or disputes):
//   Tab (role="tab") "QC holds" next to General / Delta rules / Reason codes; it loads GET /v1/lab/qc-holds?status=active (bearer token) when opened — the other tabs' requests are not made for it.
//   A "Status" select (options "Active" / "Released") switches the list: GET /v1/lab/qc-holds?status=released.
//   Columns: Instrument, Analyte, Status ("Active" / "Released" TEXT), Held at, Released at, Comment. Instrument / Analyte cells = IdText (first 8 chars of the id). Empty: "No QC holds."
//   Copy: "Holds are created by the QC module" is visible on the tab.
//   Per ACTIVE row a "Release" button, shown only with `lab.qc_hold.release` (released rows never have one). It opens a role="dialog" with a "Comment" textarea (required, maxLength 500) and the confirm button
//   "Release hold" -> POST /v1/lab/qc-holds/{hold_id}/release with body EXACTLY { comment } (no If-Match; Idempotency-Key optional), bearer token; success closes the dialog and reloads the list.
//   An empty comment sends nothing and shows role="alert". A problem+json answer shows its title in role="alert"; `auth.mfa_required` shows a re-authentication hint (/multi-factor|verify your identity|re-authenticate/i).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { ReactNode } from 'react';
import { ToastProvider } from '@lims/ui/components/Toast';

const nav = { push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() };
vi.mock('next/navigation', () => ({
  useRouter: () => nav,
  usePathname: () => '/lab/settings',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: [], displayName: 'Synthetic Lab Manager', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/lab/settings',
}));

const ORIGIN = 'http://api.test';
process.env.LIMS_ORIGIN_API = ORIGIN;
const U = (n: number) => `01a1a98a-ac40-7000-8000-${String(n).padStart(12, '0')}`;
const MANAGE = ['lab.config.manage', 'lab.worklist.read', 'lab.result.read', 'lab.specimen.read', 'lab.qc_hold.release'];
const NO_RELEASE = ['lab.config.manage', 'lab.worklist.read', 'lab.result.read', 'lab.specimen.read'];
const problem = (status: number, code: string, title: string) => HttpResponse.json({ type: `urn:lims:error:${code}`, title, status, code, request_id: 'req-synthetic-25h' }, { status });

const HOLD1 = { id: U(0x601), instrument_id: 'aa111111-ac40-7000-8000-000000000301', analyte_id: 'bb222222-ac40-7000-8000-000000000401', status: 'active', held_at: '2026-11-05T04:15:00.000Z' };
const HOLD2 = { id: U(0x602), instrument_id: 'cc333333-ac40-7000-8000-000000000302', analyte_id: 'dd444444-ac40-7000-8000-000000000402', status: 'active', held_at: '2026-11-05T05:15:00.000Z' };
const REL = { id: U(0x603), instrument_id: 'ee555555-ac40-7000-8000-000000000303', analyte_id: 'ff666666-ac40-7000-8000-000000000403', status: 'released', held_at: '2026-11-04T04:15:00.000Z',
  released_at: '2026-11-04T08:00:00.000Z', release_comment: 'Synthetic re-run in control' };

interface Call { method: string; url: URL; headers: Headers; body?: any }
const calls: Call[] = [];
const rec = async (r: Request) => { calls.push({ method: r.method, url: new URL(r.url), headers: r.headers, body: r.method === 'GET' ? undefined : await r.clone().json().catch(() => undefined) }); };
const holdGets = () => calls.filter((c) => c.method === 'GET' && c.url.pathname === '/v1/lab/qc-holds');
const releases = () => calls.filter((c) => c.method === 'POST' && /\/v1\/lab\/qc-holds\/[^/]+\/release$/.test(c.url.pathname));
let listReply: (status: string | null) => Response, releaseReply: () => Response;

const quiet = (path: string) => http.get(`${ORIGIN}${path}`, async ({ request }) => { await rec(request); return HttpResponse.json({ data: [] }); });
const api = setupServer(
  http.get(`${ORIGIN}/v1/lab/qc-holds`, async ({ request }) => { await rec(request); return listReply(new URL(request.url).searchParams.get('status')); }),
  http.post(`${ORIGIN}/v1/lab/qc-holds/:id/release`, async ({ request }) => { await rec(request); return releaseReply(); }),
  // the settings page opens on the General tab: its own read is allowed, anything else is an error
  http.get(`${ORIGIN}/v1/lab/settings`, async ({ request }) => { await rec(request); return HttpResponse.json({ version: 1, label_width_mm: 50, label_height_mm: 25, label_copies_default: 1, label_renderer: 'html_svg',
    host_query_requires_received: true, ingest_auto_receive: false, critical_notification_blocks_approval: true, recollection_default: true, delta_check_enabled: true, history_days: 730 }); }),
  quiet('/v1/lab/delta-check-rules'),
);
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => {
  listReply = (status) => HttpResponse.json({ data: status === 'released' ? [REL] : [HOLD1, HOLD2] });
  releaseReply = () => HttpResponse.json({ ...HOLD1, status: 'released', released_at: '2026-11-05T06:00:00.000Z', release_comment: 'x' });
  Object.values(nav).forEach((f) => f.mockReset());
});
afterEach(() => { cleanup(); api.resetHandlers(); calls.length = 0; });
afterAll(() => api.close());

const load = async () => (await import(/* @vite-ignore */ '../components/settings/LabSettingsPage')) as Record<string, (p: any) => ReactNode>;
const open = async (permissions: readonly string[] = MANAGE) => {
  const { LabSettingsPage } = await load();
  return render(<ToastProvider><LabSettingsPage permissions={permissions} /></ToastProvider>);
};
const holdsTab = async () => { const user = userEvent.setup(); await user.click(await screen.findByRole('tab', { name: /qc holds/i })); return user; };
const rowsOf = () => screen.getAllByRole('row').slice(1);

describe('QC holds tab — #45 (listQcHolds)', () => {
  it('is a fourth tab; opening it loads GET /v1/lab/qc-holds?status=active with the bearer token and shows the Phase 2 copy', async () => {
    await open();
    expect(screen.getAllByRole('tab').map((t) => t.textContent?.trim())).toEqual(expect.arrayContaining(['General', 'Delta rules', 'Reason codes', 'QC holds']));
    await holdsTab();
    await waitFor(() => expect(holdGets()).toHaveLength(1));
    expect(holdGets()[0]!.url.searchParams.get('status')).toBe('active');
    expect(holdGets()[0]!.headers.get('authorization')).toBe('Bearer jwt-synthetic');
    expect(await screen.findByText(/holds are created by the qc module/i)).toBeTruthy();
  });

  it('lists the active holds: instrument + analyte (first 8 chars), Status "Active", held at; columns as specified', async () => {
    await open();
    await holdsTab();
    await screen.findByRole('table');
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent?.trim())).toEqual(['Instrument', 'Analyte', 'Status', 'Held at', 'Released at', 'Comment']);
    const rows = rowsOf();
    expect(rows).toHaveLength(2);
    for (const t of [HOLD1.instrument_id.slice(0, 8), HOLD1.analyte_id.slice(0, 8), 'Active']) expect(within(rows[0]!).getByText(t), t).toBeTruthy();
  });

  it('the Status select switches to released holds (GET ?status=released): released_at, comment and "Released" text; no Release button on released rows', async () => {
    await open();
    const user = await holdsTab();
    await screen.findByRole('table');
    await user.selectOptions(screen.getByLabelText(/^status/i), 'Released');
    await waitFor(() => expect(holdGets().at(-1)!.url.searchParams.get('status')).toBe('released'));
    await waitFor(() => expect(within(rowsOf()[0]!).getByText(REL.instrument_id.slice(0, 8))).toBeTruthy());
    const r = rowsOf()[0]!;
    expect(within(r).getByText('Released')).toBeTruthy();
    expect(within(r).getByText('Synthetic re-run in control')).toBeTruthy();
    expect(within(r).queryByRole('button', { name: /^release/i })).toBeNull();
  });

  it('empty list: "No QC holds."', async () => {
    listReply = () => HttpResponse.json({ data: [] });
    await open();
    await holdsTab();
    expect(await screen.findByText('No QC holds.')).toBeTruthy();
  });

  it('a failing list shows its problem title in an alert', async () => {
    listReply = () => problem(403, 'auth.forbidden', 'You cannot view QC holds');
    await open();
    await holdsTab();
    expect((await screen.findByRole('alert')).textContent).toMatch(/you cannot view qc holds/i);
  });
});

describe('Release a hold — #46 (S-16)', () => {
  it('only holders of lab.qc_hold.release see "Release", one per ACTIVE row', async () => {
    await open(NO_RELEASE);
    await holdsTab();
    await screen.findByRole('table');
    expect(screen.queryAllByRole('button', { name: /^release/i })).toHaveLength(0);
    cleanup();
    await open(MANAGE);
    await holdsTab();
    await screen.findByRole('table');
    expect(screen.getAllByRole('button', { name: /^release/i })).toHaveLength(2);
  });

  it('Release -> dialog -> comment -> POST /v1/lab/qc-holds/{id}/release with body exactly { comment }; closes and reloads the list', async () => {
    await open();
    const user = await holdsTab();
    await screen.findByRole('table');
    await user.click(within(rowsOf()[0]!).getByRole('button', { name: /^release/i }));
    const dlg = await screen.findByRole('dialog');
    const box = within(dlg).getByLabelText(/comment/i) as HTMLTextAreaElement;
    expect(box.maxLength).toBe(500);
    await user.type(box, 'Re-run in control (synthetic)');
    const before = holdGets().length;
    listReply = () => HttpResponse.json({ data: [HOLD2] });
    await user.click(within(dlg).getByRole('button', { name: /release hold/i }));
    await waitFor(() => expect(releases()).toHaveLength(1));
    const p = releases()[0]!;
    expect(p.url.pathname).toBe(`/v1/lab/qc-holds/${HOLD1.id}/release`);
    expect(p.body).toEqual({ comment: 'Re-run in control (synthetic)' });
    expect(p.headers.get('authorization')).toBe('Bearer jwt-synthetic');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(holdGets().length).toBeGreaterThan(before));
    await waitFor(() => expect(rowsOf()).toHaveLength(1));
    expect(within(rowsOf()[0]!).getByText(HOLD2.instrument_id.slice(0, 8))).toBeTruthy();
  });

  it('an empty comment sends nothing and shows an alert (the API requires 1..500 characters)', async () => {
    await open();
    const user = await holdsTab();
    await screen.findByRole('table');
    await user.click(within(rowsOf()[0]!).getByRole('button', { name: /^release/i }));
    const dlg = await screen.findByRole('dialog');
    await user.click(within(dlg).getByRole('button', { name: /release hold/i }));
    expect((await within(dlg).findAllByRole('alert')).length).toBeGreaterThan(0);
    expect(releases()).toHaveLength(0);
  });

  it('a double click sends ONE release', async () => {
    releaseReply = () => HttpResponse.json({ ...HOLD1, status: 'released' });
    await open();
    const user = await holdsTab();
    await screen.findByRole('table');
    await user.click(within(rowsOf()[0]!).getByRole('button', { name: /^release/i }));
    const dlg = await screen.findByRole('dialog');
    await user.type(within(dlg).getByLabelText(/comment/i), 'once');
    await user.dblClick(within(dlg).getByRole('button', { name: /release hold/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(releases()).toHaveLength(1);
  });

  it.each([
    [403, 'auth.forbidden', 'Not allowed to release holds', /not allowed to release holds/i],
    [404, 'common.not_found', 'Hold not found', /hold not found/i],
    [409, 'common.version_conflict', 'Hold already released', /hold already released/i],
  ])('a %s problem shows its title in an alert and keeps the dialog open', async (status, code, title, re) => {
    releaseReply = () => problem(status as number, code as string, title as string);
    await open();
    const user = await holdsTab();
    await screen.findByRole('table');
    await user.click(within(rowsOf()[0]!).getByRole('button', { name: /^release/i }));
    const dlg = await screen.findByRole('dialog');
    await user.type(within(dlg).getByLabelText(/comment/i), 'try');
    await user.click(within(dlg).getByRole('button', { name: /release hold/i }));
    expect((await within(dlg).findByRole('alert')).textContent).toMatch(re as RegExp);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('auth.mfa_required shows a re-authentication hint, not a generic failure', async () => {
    releaseReply = () => problem(403, 'auth.mfa_required', 'Multi-factor authentication required');
    await open();
    const user = await holdsTab();
    await screen.findByRole('table');
    await user.click(within(rowsOf()[0]!).getByRole('button', { name: /^release/i }));
    const dlg = await screen.findByRole('dialog');
    await user.type(within(dlg).getByLabelText(/comment/i), 'try');
    await user.click(within(dlg).getByRole('button', { name: /release hold/i }));
    expect((await within(dlg).findByRole('alert')).textContent).toMatch(/multi-factor|verify your identity|re-authenticate/i);
  });

  it('has no axe violations (tab + release dialog)', async () => {
    await open();
    const user = await holdsTab();
    await screen.findByRole('table');
    await user.click(within(rowsOf()[0]!).getByRole('button', { name: /^release/i }));
    await screen.findByRole('dialog');
    const res = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
    expect(res.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
});
