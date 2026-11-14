// @vitest-environment jsdom
// AN-T17 — ExportDialog (C8 04-UI-UX §6; US-17.1, US-02.1 UI side; 07-SECURITY export rows). MSW observes POST /v1/analytics/exports.
// ASSUMED contract (spec fixes only the file + kit primitives): apps/web/src/features/analytics/components/ExportDialog.tsx exports
//   ExportDialog({ isOpen, onClose, reportCode, params, summary, pdfEnabled? })
//     params  = API ExportParams, sent verbatim (period stays as bs_month / fiscal_year_bs / dates: the UI never converts B.S.<->A.D.)
//     summary = { report: string; periodAd: string; periodBs: string; centres: readonly string[] /* [] = all */; groupBy?: string }
//     pdfEnabled defaults false (LIMS_ANALYTICS_PDF_ENABLED=false).
//   The dialog posts through a server action -> server/*.server.ts -> serverFetch (Bearer from session, Idempotency-Key, never in the DOM).
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { delay, http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { ReactNode } from 'react';
import { ToastProvider } from '@lims/ui/components/Toast';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/analytics/reports/income',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: [], displayName: 'Synthetic Owner', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/analytics/reports/income',
}));

const ORIGIN = 'http://api.test';
process.env.LIMS_ORIGIN_API = ORIGIN;
const CENTRE = '01a1a98a-ac40-7000-8000-000000000002';
const EXPORT_ID = '01a1a98a-ac40-7000-8000-000000000030';
const PARAMS = { bs_month: '2083-07', centre_id: [CENTRE], group_by: 'day' };
const SUMMARY = { report: 'Income', periodAd: '18/10/2026 – 16/11/2026', periodBs: '2083-07-01 – 2083-07-30 B.S.', centres: ['Synthetic Centre A'], groupBy: 'Day' };
const problem = (code: string, status: number) => HttpResponse.json({ type: `urn:lims:error:${code}`, title: code, status, code }, { status });
const queued = () => HttpResponse.json({ id: EXPORT_ID, report_code: 'income', format: 'xlsx', status: 'queued', params: PARAMS, requested_at: '2026-11-09T04:30:00.000Z', downloads_used: 0, downloads_allowed: 3 }, { status: 202 });

const calls: { url: URL; headers: Headers; body: any }[] = [];
let respond: () => Response | Promise<Response> = queued;
const api = setupServer(
  http.post(`${ORIGIN}/v1/analytics/exports`, async ({ request }) => {
    calls.push({ url: new URL(request.url), headers: request.headers, body: await request.clone().json().catch(() => undefined) });
    return respond();
  }),
);
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { cleanup(); api.resetHandlers(); calls.length = 0; respond = queued; });
afterAll(() => api.close());

const load = async () => ((await import(/* @vite-ignore */ '../components/ExportDialog')) as { ExportDialog: any }).ExportDialog;
const wrap = (ui: ReactNode) => render(<ToastProvider>{ui}</ToastProvider>);
const open = async (over: Record<string, unknown> = {}) => {
  const ExportDialog = await load();
  const onClose = vi.fn();
  const view = wrap(<ExportDialog isOpen onClose={onClose} reportCode="income" params={PARAMS} summary={SUMMARY} {...over} />);
  return { onClose, view, user: userEvent.setup() };
};
const exportBtn = () => screen.getByRole('button', { name: /^export$/i }) as HTMLButtonElement;
const ack = () => screen.getByRole('checkbox', { name: /I will keep this file inside the lab and delete it when no longer needed\./ });
const axeClean = async () => {
  const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
  expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
};

describe('ExportDialog — content (§6)', () => {
  it('titled "Export report"; Excel/CSV/PDF radios with Excel default; read-only summary with A.D. and B.S. period, centres, group by', async () => {
    await open();
    expect(screen.getByRole('dialog', { name: 'Export report' })).toBeTruthy();
    expect((screen.getByRole('radio', { name: /Excel/ }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole('radio', { name: /CSV/ })).toBeTruthy();
    expect(screen.getByRole('radio', { name: /PDF/ })).toBeTruthy();
    const d = screen.getByRole('dialog');
    for (const s of [SUMMARY.report, SUMMARY.periodAd, SUMMARY.periodBs, 'Synthetic Centre A', 'Day']) expect(d.textContent).toContain(s);
  });

  it('shows "All centres" when the centre list is empty', async () => {
    await open({ summary: { ...SUMMARY, centres: [] } });
    expect(screen.getByRole('dialog').textContent).toContain('All centres');
  });

  it('PDF is disabled with the "not available yet" hint while the flag is off (default)', async () => {
    await open();
    expect((screen.getByRole('radio', { name: /PDF/ }) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByRole('dialog').textContent).toContain('PDF export is not available yet');
  });

  it('PDF is selectable when pdfEnabled', async () => {
    await open({ pdfEnabled: true });
    expect((screen.getByRole('radio', { name: /PDF/ }) as HTMLInputElement).disabled).toBe(false);
  });

  it('Export stays disabled until the acknowledgement is ticked', async () => {
    const { user } = await open();
    expect((ack() as HTMLInputElement).checked).toBe(false);
    expect(exportBtn().disabled).toBe(true);
    await user.click(exportBtn());
    expect(calls).toHaveLength(0);
    await user.click(ack());
    expect(exportBtn().disabled).toBe(false);
  });

  it('Cancel closes without any request', async () => {
    const { user, onClose } = await open();
    await user.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0);
  });

  it('axe: no violations (open, and with an error banner)', async () => {
    respond = () => problem('common.rate_limited', 429);
    const { user } = await open();
    await axeClean();
    await user.click(ack());
    await user.click(exportBtn());
    await screen.findByText(/Export limit reached\./);
    await axeClean();
  });
});

describe('ExportDialog — submit (US-17.1; US-02.1 UI side)', () => {
  it('POSTs {report_code, format:"xlsx", params} verbatim with Bearer + Idempotency-Key; on 202 toasts "Export queued" and closes', async () => {
    const { user, onClose } = await open();
    await user.click(ack());
    await user.click(exportBtn());
    await screen.findByText('Export queued');
    expect(screen.getByText('You can download it from My exports.')).toBeTruthy();
    expect(onClose).toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.headers.get('authorization')).toBe('Bearer jwt-synthetic');
    expect(c.headers.get('idempotency-key')).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(c.body).toEqual({ report_code: 'income', format: 'xlsx', params: PARAMS }); // exactly the 3 schema keys; bs_month NOT converted client-side
  });

  it('CSV selection is sent as format "csv"', async () => {
    const { user } = await open();
    await user.click(screen.getByRole('radio', { name: /CSV/ }));
    await user.click(ack());
    await user.click(exportBtn());
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body.format).toBe('csv');
  });

  it('double press sends exactly one request (button busy while posting)', async () => {
    respond = async () => { await delay(150); return queued(); };
    const { user } = await open();
    await user.click(ack());
    await user.dblClick(exportBtn());
    await screen.findByText('Export queued');
    expect(calls).toHaveLength(1);
  });

  it('a report_code outside ^[a-z][a-z0-9_]*$ never leaves the BFF (no request, no success toast, dialog stays open)', async () => {
    const { user, onClose } = await open({ reportCode: 'income/../../admin?x=1' });
    await user.click(ack());
    await user.click(exportBtn());
    await new Promise((r) => setTimeout(r, 100));
    expect(calls).toHaveLength(0);
    expect(screen.queryByText('Export queued')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('never renders the access token', async () => {
    const { user } = await open();
    await user.click(ack());
    await user.click(exportBtn());
    await screen.findByText('Export queued');
    expect(document.body.innerHTML).not.toContain('jwt-synthetic');
  });
});

describe('ExportDialog — errors (§6) keep the dialog open and re-enable Export', () => {
  const fail = async (code: string, status: number) => {
    respond = () => problem(code, status);
    const o = await open();
    await o.user.click(ack());
    await o.user.click(exportBtn());
    return o;
  };

  it('429 common.rate_limited -> inline warning "Export limit reached. Try again at …"', async () => {
    const { onClose } = await fail('common.rate_limited', 429);
    expect(await screen.findByText(/Export limit reached\. Try again at/)).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByText('Export queued')).toBeNull();
    expect(exportBtn().disabled).toBe(false);
  });

  it('auth.mfa_required -> banner with a "Verify now" action', async () => {
    const { onClose } = await fail('auth.mfa_required', 403);
    expect(await screen.findByRole('button', { name: /verify now/i })).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('422 analytics.range_too_large -> "Choose 366 days or fewer."', async () => {
    await fail('analytics.range_too_large', 422);
    expect(await screen.findByText('Choose 366 days or fewer.')).toBeTruthy();
  });

  it('500 -> generic inline error, no success toast, never the raw problem code/stack', async () => {
    const { onClose } = await fail('common.internal', 500);
    await waitFor(() => expect(calls).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText('Export queued')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});
