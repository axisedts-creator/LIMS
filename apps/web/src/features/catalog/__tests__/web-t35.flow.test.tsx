// @vitest-environment jsdom
// C3.T-35 "component + E2E (export → edit → import → commit)" — the in-process leg: ImportsScreen + ImportDetail wired to ONE stateful fake C3 API (MSW), real server
// actions/BFF functions, real timers (short). The browser leg lives in apps/web/tests/e2e/catalog/C3.T-35.imports.spec.ts (nightly, needs next dev + stub C2).
// Flow (03-APP-FLOW F-16 → F-15): finance exports price list PL-DRX v3 → export becomes ready → Download proxied via BFF → edited file uploaded (201 uploaded) → SCR-19 →
// validated with a `file.stale_base` warning (list was published as v4 after the export) → commit WITHOUT the stale-base box = disabled; WITH it = one commit POST → committed.
// Same contract assumptions as web-t35.components.test.tsx. Synthetic data only.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { ToastProvider } from '@lims/ui/components/Toast';
import { parseMultipart } from './web-t35.multipart'; // ruling C3.T-35 #4

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/catalog/imports',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({ getAccessToken: async () => 'jwt-synthetic', getShellSession: async () => undefined }));

const ORIGIN = 'http://api.test';
process.env.LIMS_ORIGIN_API = ORIGIN;
const ID = (n: number) => `01a1a98a-ac40-7000-8000-0000000d${String(n).padStart(4, '0')}`;
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PERM = ['catalog.test.read', 'catalog.price_list.read', 'catalog.price_list.manage'];
const PL = { id: ID(60), code: 'PL-DRX', name: 'Synthetic default prices', owner_kind: 'default', falls_through: true, assignments: [], current_version: { id: ID(61), version_no: 4 }, is_active: true, version: 2 };
const SUMMARY = { rows: 3, added: 0, changed: 1, removed: 0, unchanged: 2, errors: 0, warnings: 1 };

// ---- stateful fake API --------------------------------------------------------------------------------------------------------------------
const log: string[] = [];
const state = { exportPolls: 0, importPolls: 0, imp: undefined as undefined | Record<string, unknown>, commitBody: undefined as any, commitIfMatch: '' as string };
const importRow = (o: Record<string, unknown>) => ({ id: ID(80), kind: 'price_list', target_price_list_id: ID(60), base_version_no: 3, status: 'uploaded', file_name: 'prices-edited.xlsx', file_sha256: 'cd'.repeat(32), summary: SUMMARY, deduplicated: false, expires_at: '2026-11-20T00:00:00.000Z', created_at: '2026-11-09T04:00:00.000Z', created_by: ID(70), version: 1, ...o });
const api = setupServer(
  http.post(`${ORIGIN}/v1/catalog/exports`, async ({ request }) => { log.push(`POST exports ${JSON.stringify(await request.json())}`); return HttpResponse.json({ id: ID(90), kind: 'price_list', status: 'queued', version: 1 }, { status: 202 }); }),
  http.get(`${ORIGIN}/v1/catalog/exports/:id`, () => { state.exportPolls += 1; return HttpResponse.json({ id: ID(90), kind: 'price_list', status: state.exportPolls < 2 ? 'building' : 'ready', file_name: 'price-list-pl-drx-v3.xlsx', byte_size: 2048, expires_at: '2026-11-15T00:00:00.000Z', version: 2 }); }),
  http.post(`${ORIGIN}/v1/catalog/imports`, async ({ request }) => { const f = parseMultipart(request.headers.get('content-type') ?? '', await request.text()); log.push(`POST imports ${f.get('kind')} ${f.get('target_price_list_id')} ${(f.get('file') as { name: string }).name}`); state.imp = importRow({ status: 'uploaded' }); return HttpResponse.json(state.imp, { status: 201 }); }),
  http.get(`${ORIGIN}/v1/catalog/imports/:id`, () => { state.importPolls += 1; state.imp = importRow(state.commitBody ? { status: 'committing', version: 4 } : state.importPolls < 2 ? { status: 'validating', version: 2 } : { status: 'validated', version: 3 }); return HttpResponse.json(state.imp); }),
  http.get(`${ORIGIN}/v1/catalog/imports/:id/issues`, () => HttpResponse.json({ data: [{ seq: 1, severity: 'warning', sheet: '_meta', issue_code: 'file.stale_base', message: 'x' }], page: { limit: 50 } })),
  http.post(`${ORIGIN}/v1/catalog/imports/:id/commit`, async ({ request }) => { state.commitBody = await request.json(); state.commitIfMatch = request.headers.get('if-match') ?? ''; log.push('POST commit'); return HttpResponse.json(importRow({ status: 'committing', version: 4 }), { status: 202 }); }),
  http.get(`${ORIGIN}/v1/catalog/*`, () => HttpResponse.json({ data: [], page: { limit: 50 } })),
);
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { cleanup(); api.resetHandlers(); push.mockReset(); log.length = 0; Object.assign(state, { exportPolls: 0, importPolls: 0, imp: undefined, commitBody: undefined, commitIfMatch: '' }); });
afterAll(() => api.close());

describe('export → edit → import → commit (AC-16.2, 16.3, 16.5, 16.6, 16.7; F-15/F-16)', () => {
  it('runs end to end with exactly one export, one upload and one commit; the stale-base box gates the commit', async () => {
    const { ImportsScreen } = await import('../components/ImportsScreen');
    const { ImportDetail } = await import('../components/ImportDetail');

    // 1. SCR-18 — export the current price list.
    const a = render(<ToastProvider><ImportsScreen imports={[]} exports={[]} priceLists={[PL as never]} permissions={PERM} /></ToastProvider>);
    await userEvent.click(screen.getByRole('radio', { name: /price list prices/i }));
    await userEvent.click(screen.getByLabelText(/^price list$/i));
    await userEvent.click(await screen.findByRole('option', { name: /PL-DRX/ }));
    await userEvent.click(screen.getByRole('button', { name: /download current data/i }));
    await waitFor(() => expect(log).toContain(`POST exports ${JSON.stringify({ kind: 'price_list', price_list_version_id: ID(61) })}`));

    // 2. "edit in Excel" → upload the edited workbook (declared MIME decides; bytes are opaque to the app origin).
    await userEvent.upload(document.querySelector<HTMLInputElement>('input[type=file]')!, new File([new Uint8Array(32).fill(0x50)], 'prices-edited.xlsx', { type: XLSX }), { applyAccept: false });
    await userEvent.click(screen.getByRole('button', { name: /^upload/i }));
    await waitFor(() => expect(push).toHaveBeenCalledWith(`/catalog/imports/${ID(80)}`));
    expect(log.filter((l) => l.startsWith('POST imports'))).toEqual([`POST imports price_list ${ID(60)} prices-edited.xlsx`]);
    a.unmount();

    // 3. SCR-19 renders the new import (uploaded) and polls until validated (stale-base warning loaded from #100).
    render(<ToastProvider><ImportDetail importRow={state.imp as never} issues={[]} priceList={PL as never} permissions={PERM} /></ToastProvider>);
    // Ruling C3.T-35-ruling.md: StepStepper shows every label at all times (04-UI-UX.md:208), so wait on the poll outcome, then on the *current* step.
    await waitFor(() => expect(state.importPolls).toBeGreaterThanOrEqual(2), { timeout: 8000 });
    await waitFor(() => expect(document.querySelector('[aria-current="step"],[aria-current="true"]')?.textContent).toMatch(/Ready to commit/), { timeout: 8000 });
    expect(state.importPolls).toBeGreaterThanOrEqual(2);

    // 4. Commit: stale-base box required, then typed code.
    await userEvent.click(screen.getByRole('button', { name: /^commit/i }));
    const d = screen.getByRole('dialog');
    await userEvent.type(within(d).getByRole('textbox', { name: /change reason/i }), 'Replace with edited Q4 prices');
    await userEvent.type(within(d).getByRole('textbox', { name: /confirm/i }), 'PL-DRX');
    const go = within(d).getByRole('button', { name: /^commit$/i }) as HTMLButtonElement;
    expect(go.disabled, 'stale-base not yet accepted').toBe(true);
    await userEvent.click(within(d).getByRole('checkbox', { name: /changed after this file was exported/i }));
    await waitFor(() => expect(go.disabled).toBe(false));
    await userEvent.click(go);
    await waitFor(() => expect(log.filter((l) => l === 'POST commit')).toHaveLength(1));
    expect(state.commitBody).toMatchObject({ change_reason: 'Replace with edited Q4 prices', accept_stale_base: true, publish: true, replace_draft: false });
    expect(state.commitIfMatch).toBe('"3"'); // version of the row polled to `validated`, not the stale one rendered at upload time
    await waitFor(() => expect(screen.getAllByText('Committing').length).toBeGreaterThan(0));
    expect(log.filter((l) => l.startsWith('POST exports'))).toHaveLength(1);
  }, 30_000);
});
