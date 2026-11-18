// @vitest-environment jsdom
// T0D-PRINTCFG-1 done_when (3): the report print dialog of ReportDetailView({report, permissions}) offers "With letterhead", "Plain paper (my own pre-printed pad)" and
// "Typed header and footer", with copies, and shows which profile will apply. ASSUMED contract (dispute if wrong):
//   radio names keep /with letterhead/i (default) and /plain paper/i (c6-t31 pins both and getBy needs each to match ONE radio) and add /typed header and footer/i.
//   createReportPrint takes only { variant: 'letterhead' | 'plain', copies } (CreateReportPrintRequest, additionalProperties false; no paper_mode field exists), so
//   "Plain paper" and "Typed header and footer" both send variant 'plain' and the saved print profile decides the paper mode on the server.
//   The dialog reads listPrintProfiles (document_kind=report) and shows a line "Profile that applies: <plain words of the paper mode>" ("Lab default" when none is set);
//   a failing read (a printer without reporting.settings.manage gets 403) never blocks printing.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { ToastProvider } from '@lims/ui/components/Toast';
import { API, ORIGIN, PC, api, profile } from './printcfg1.harness';
import { RELEASE, U, detail, vsum } from './c6-t31.fixtures';

const posts: { path: string; json: any }[] = [];
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => {
  API.reset(); posts.length = 0; PC.session.permissions = RELEASE;
  api.use(http.post(`${ORIGIN}/v1/reporting/report-versions/:id/prints`, async ({ request }) => {
    posts.push({ path: new URL(request.url).pathname, json: await request.json() });
    return HttpResponse.json({ id: U(18), state: 'rendering', variant: 'plain', copies: 1, expires_at: '2026-11-05T05:15:00.000Z' }, { status: 201 });
  }));
});
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

async function open() {
  const { ReportDetailView } = await import('../components/ReportDetailView');
  const u = userEvent.setup();
  render(<ToastProvider><ReportDetailView report={detail({ versions: [vsum({ status: 'released' })], display_status: 'released' }) as never} permissions={RELEASE} /></ToastProvider>);
  await u.click(screen.getByRole('button', { name: /print/i }));
  return { u, dlg: await screen.findByRole('dialog') };
}

describe('report print dialog (done_when 3)', () => {
  it('three paper choices, letterhead first and selected', async () => {
    const { dlg } = await open();
    expect(within(dlg).getAllByRole('radio').length).toBe(3);
    expect((within(dlg).getByRole('radio', { name: /with letterhead/i }) as HTMLInputElement).checked).toBe(true);
    expect(within(dlg).getByRole('radio', { name: /plain paper/i })).toBeTruthy();
    expect(within(dlg).getByRole('radio', { name: /typed header and footer/i })).toBeTruthy();
  });

  it('Typed header and footer with 3 copies sends variant plain and copies 3 and nothing else', async () => {
    const { u, dlg } = await open();
    await u.click(within(dlg).getByRole('radio', { name: /typed header and footer/i }));
    const copies = within(dlg).getByLabelText(/copies/i);
    await u.clear(copies); await u.type(copies, '3');
    await u.click(within(dlg).getByRole('button', { name: /^print$/i }));
    await waitFor(() => expect(posts.length).toBe(1));
    expect(posts[0]!.json).toEqual({ variant: 'plain', copies: 3 });
    expect(await screen.findByText(/Preparing print…/)).toBeTruthy();
  });

  it('Letterhead sends variant letterhead; Plain paper sends plain', async () => {
    const a = await open();
    await a.u.click(within(a.dlg).getByRole('button', { name: /^print$/i }));
    await waitFor(() => expect(posts.length).toBe(1));
    expect(posts[0]!.json).toEqual({ variant: 'letterhead', copies: 1 });
    cleanup();
    const b = await open();
    await b.u.click(within(b.dlg).getByRole('radio', { name: /plain paper/i }));
    await b.u.click(within(b.dlg).getByRole('button', { name: /^print$/i }));
    await waitFor(() => expect(posts.length).toBe(2));
    expect(posts[1]!.json).toEqual({ variant: 'plain', copies: 1 });
  });

  it('shows which profile will apply, in plain words', async () => {
    API.profiles = [profile({ paper_mode: 'preprinted_paper', header_text: '', footer_text: '', reserve_top_mm: 45, reserve_bottom_mm: 25 })];
    const { dlg } = await open();
    const line = await within(dlg).findByText(/profile that applies/i);
    await waitFor(() => expect(line.textContent).toMatch(/pre-?printed pad/i));
  });

  it('says Lab default when no profile is set', async () => {
    API.profiles = [];
    const { dlg } = await open();
    await waitFor(() => expect(within(dlg).getByText(/profile that applies/i).textContent).toMatch(/lab default/i));
  });

  it('a profile read that is refused (403) does not block printing', async () => {
    API.listFail = 403;
    const { u, dlg } = await open();
    await u.click(within(dlg).getByRole('radio', { name: /plain paper/i }));
    await u.click(within(dlg).getByRole('button', { name: /^print$/i }));
    await waitFor(() => expect(posts.length).toBe(1));
    expect(posts[0]!.json).toEqual({ variant: 'plain', copies: 1 });
  });

  it('the dialog never shows typed header text as HTML (a stored profile with markup stays text)', async () => {
    API.profiles = [profile({ header_text: '<img src=x onerror=alert(1)>' })];
    await open();
    await new Promise((r) => setTimeout(r, 300));
    expect(document.querySelector('img[src="x"]')).toBeNull();
  });
});
