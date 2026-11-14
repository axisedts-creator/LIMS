// @vitest-environment jsdom
// RS-C6 (LD-140; 10-DESIGN-SYSTEM s3, s4 "Report preview and release", s6, s8): arrangement checks on the staff reporting screens + axe +
// keyboard-only path + recorded outline snapshots. Behaviour must not change, so the keyboard path asserts the SAME server-action call as before.
// Server actions are mocked at module level (their HTTP behaviour is covered by the chunk's c6-t31 tests, which must stay green).
// ASSUMED contract (the spec fixes the kit and the layout rule, not the markup; the writer may dispute a name via the ruling flow):
//   - ReportDetailView shows a "Report preview" region (`section`/role=region, accessible name matches /report preview/i) holding ONLY the existing
//     download link `/reporting/report-versions/<id>/pdf` of the latest downloadable version: no iframe/object/embed (review RS-C6 item 1; an
//     inline preview needs a CR). Paper on neutral.100 (token classes, no literals). No downloadable version yet: no preview region.
//   - Delivery status words in the Deliveries card and in the delivery attempt list are kit status chips (`.lims-chip`: tone + word, s6),
//     not a sentence of "Queued 0 · Sent 1 …"; all six counts stay visible, zero included (review item 2).
//   - Release stays the single primary button of the page; Held for dues stays a warning banner; the Send-to audiences stay checkboxes.
// Synthetic data only.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import type { ReactNode } from 'react';
import { ToastProvider } from '@lims/ui/components/Toast';
import { ADMIN, BULK, CENTRE, DLV, REPORT, V2, delivery, detail, summary, vsum } from './c6-t31.fixtures';

const A = vi.hoisted(() => {
  const names = ['listCodesAction', 'listOverrideReasonsAction', 'listCriticalAlertsAction', 'getPrintAction', 'listOutsourcedFilesAction', 'searchReportsAction', 'releaseVersionAction', 'bulkReleaseAction', 'retryRenderAction', 'regenerateAction', 'createPrintAction', 'revokeQrAction', 'recordOverrideAction', 'uploadOutsourcedAction', 'confirmOutsourcedAction', 'saveNarrativeDraftAction', 'signNarrativeAction', 'startAmendmentAction', 'uploadNarrativeImageAction', 'retryDeliveryAction', 'previewTemplateAction', 'saveTemplateDraftAction', 'publishTemplateAction', 'upsertMessageTextAction', 'upsertChannelAccountAction', 'rotateCallbackTokenAction', 'updateSettingsAction'];
  return Object.fromEntries(names.map((n) => [n, vi.fn(async () => ({ ok: true, data: [] }))])) as Record<string, ReturnType<typeof vi.fn>>;
});
vi.mock('../server/actions', () => A);
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/reporting',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));

afterEach(() => { cleanup(); for (const f of Object.values(A)) f.mockClear(); });

const wrap = (ui: ReactNode) => render(<ToastProvider>{ui}</ToastProvider>);
const centres = [{ id: CENTRE, name: 'Synthetic Centre A1' }];
const noSeriousAxe = async () => {
  const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } }); // jsdom has no layout or colours
  expect(r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
};
const primaryButtons = () => [...document.querySelectorAll('button.lims-btn-primary, button[class*="primary"], a.lims-btn-primary')].filter((b) => !b.closest('[role="dialog"]'));
/** Deterministic outline (no generated ids): headings, regions, buttons, links, chips, embeds with their accessible text. Recorded by the writer (LD-170). */
const outline = (root: ParentNode = document.body) =>
  [...root.querySelectorAll('h1,h2,h3,section[aria-label],[role="region"],button,a[href],.lims-chip,iframe,object,embed,input[type="checkbox"]')]
    .map((e) => `${e.tagName.toLowerCase()}${e.getAttribute('role') ? `[${e.getAttribute('role')}]` : ''} ${(e.getAttribute('aria-label') ?? e.getAttribute('title') ?? e.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60)}`)
    .join('\n');

const loadDetail = async () => (await import('../components/ReportDetailView')).ReportDetailView as any;
const loadDlv = async () => (await import('../components/DeliveriesList')).DeliveriesList as any;
const loadDlvDetail = async () => (await import('../components/DeliveryDetail')).DeliveryDetail as any;
const loadWorklist = async () => (await import('../components/ReportsWorklist')).ReportsWorklist as any;
const embedOf = (root: ParentNode) => root.querySelector<HTMLElement>('iframe,object,embed');
const pdfOf = (e: HTMLElement | null) => e?.getAttribute('src') ?? e?.getAttribute('data') ?? '';

describe('RS-C6 report preview and release (s4)', () => {
  // Review RS-C6 item 1: an embedded PDF makes the browser call the download route on every render (false report.download audit rows, report_download
  // rate budget) and the route answers content-disposition: attachment. So the region holds ONLY the existing download link.
  const embeds = () => document.querySelectorAll('iframe, object, embed');
  it('a "Report preview" region holds the existing download link and no embedded PDF', async () => {
    const D = await loadDetail();
    wrap(<D report={detail() as never} permissions={ADMIN} />);
    const region = screen.getByRole('region', { name: /report preview/i });
    expect(embeds().length, 'no iframe/object/embed: viewing must not call the download route').toBe(0);
    const link = within(region).getByRole('link', { name: /download/i });
    expect(link.getAttribute('href')).toMatch(new RegExp(`^/reporting/report-versions/${V2}/pdf$`));
  });
  it('the preview link follows the NEWEST non-discarded downloadable version', async () => {
    const D = await loadDetail();
    wrap(<D report={detail({ versions: [vsum({ id: V2, version_no: 2 }), vsum({ id: '01a1a98a-ac40-7000-8000-0000000000aa', version_no: 3, status: 'discarded' })] }) as never} permissions={ADMIN} />);
    expect(within(screen.getByRole('region', { name: /report preview/i })).getByRole('link', { name: /download/i }).getAttribute('href')).toContain(V2);
    expect(embeds().length).toBe(0);
  });
  it('no downloadable version: no preview region, nothing embedded', async () => {
    const D = await loadDetail();
    wrap(<D report={detail({ display_status: 'awaiting_content', versions: [vsum({ status: 'rendering' })] }) as never} permissions={ADMIN} />);
    expect(embeds().length).toBe(0);
    expect(screen.queryByRole('region', { name: /report preview/i })).toBeNull();
  });
  it('Deliveries card: counts are status chips (tone + word)', async () => {
    const D = await loadDetail();
    wrap(<D report={detail() as never} permissions={ADMIN} />);
    const card = screen.getAllByRole('heading', { name: /^deliveries$/i })[0]!.closest('.lims-card, section, article, div')! as HTMLElement;
    const chips = [...card.querySelectorAll('.lims-chip')].map((c) => (c.textContent ?? '').replace(/\s+/g, ' ').trim());
    expect(chips.length).toBeGreaterThanOrEqual(3);
    for (const re of [/sent/i, /delivered/i, /failed/i]) expect(chips.some((c) => re.test(c) && /\d/.test(c)), `chip for ${re}`).toBe(true);
    expect(screen.getByRole('link', { name: /open delivery log filtered to this report/i }).getAttribute('href')).toContain(`report_id=${REPORT}`);
  });
  it('Deliveries card keeps all six counts visible when every count is 0 (review item 2: nothing displayed may disappear)', async () => {
    const D = await loadDetail();
    wrap(<D report={detail({ deliveries_summary: { queued: 0, sent: 0, delivered: 0, read: 0, failed: 0, suppressed: 0 } }) as never} permissions={ADMIN} />);
    const card = screen.getAllByRole('heading', { name: /^deliveries$/i })[0]!.closest('.lims-card, section, article, div')! as HTMLElement;
    const chips = [...card.querySelectorAll('.lims-chip')].map((c) => (c.textContent ?? '').replace(/\s+/g, ' ').trim());
    for (const w of [/queued/i, /sent/i, /delivered/i, /read/i, /failed/i, /suppressed/i]) expect(chips.some((c) => w.test(c) && /0/.test(c)), `chip ${w}`).toBe(true);
  });
  it('release stays the only primary button; Download is secondary (s3: one primary per page)', async () => {
    const D = await loadDetail();
    wrap(<D report={detail() as never} permissions={ADMIN} />);
    const p = primaryButtons();
    expect(p.length).toBe(1);
    expect(p[0]!.textContent).toMatch(/^Release/);
  });
  it('held for dues stays a warning banner with the override action', async () => {
    const D = await loadDetail();
    wrap(<D report={detail({ display_status: 'held', balance_due_paisa: 50000, versions: [vsum({ status: 'rendered' })] }) as never} permissions={ADMIN} />);
    const b = document.querySelector('.lims-banner.lims-tone-warning');
    expect(b?.textContent).toMatch(/Held for dues/);
    expect(within(b as HTMLElement).getByRole('button', { name: /record override/i })).toBeTruthy();
  });
  it('Devanagari patient names render verbatim in the header card', async () => {
    const D = await loadDetail();
    wrap(<D report={detail({ patient_display_name: 'सिन्थेटिक रोगी' }) as never} permissions={ADMIN} />);
    expect(screen.getByText(/सिन्थेटिक रोगी/)).toBeTruthy();
  });
  it('axe: zero serious/critical on the detail page, with the release dialog open, and when held', async () => {
    const D = await loadDetail();
    const u = userEvent.setup();
    const a = wrap(<D report={detail() as never} permissions={ADMIN} />);
    await noSeriousAxe();
    await u.click(screen.getAllByRole('button', { name: /^release/i })[0]!);
    await screen.findByRole('dialog', { name: /release report/i });
    await noSeriousAxe();
    a.unmount();
    wrap(<D report={detail({ display_status: 'held', balance_due_paisa: 50000 }) as never} permissions={ADMIN} />);
    await noSeriousAxe();
  });
  it('keyboard only: Tab reaches Release, Enter opens the dialog, Tab to its Release, Enter sends the same releaseVersionAction call', async () => {
    const D = await loadDetail();
    const u = userEvent.setup();
    wrap(<D report={detail() as never} permissions={ADMIN} />);
    // accessible label only: the kit adds a decorative <kbd aria-hidden> shortcut (Alt+R, 04-UI-UX:23) after .lims-btn-label
    const label = (el: Element) => (el.querySelector('.lims-btn-label')?.textContent ?? el.textContent ?? '').trim();
    const isRelease = () => document.activeElement instanceof HTMLButtonElement && /^release\b/i.test(label(document.activeElement));
    for (let i = 0; i < 60 && !isRelease(); i++) await u.tab();
    expect(isRelease(), 'Release must be reachable with Tab alone').toBe(true);
    await u.keyboard('{Enter}');
    const dlg = await screen.findByRole('dialog', { name: /release report/i });
    for (let i = 0; i < 20 && !(isRelease() && dlg.contains(document.activeElement)); i++) await u.tab();
    expect(dlg.contains(document.activeElement) && isRelease(), 'dialog Release reachable with Tab alone').toBe(true);
    await u.keyboard('{Enter}');
    await waitFor(() => expect(A['releaseVersionAction']).toHaveBeenCalledTimes(1));
    expect(A['releaseVersionAction']).toHaveBeenCalledWith(V2, 7, { audiences: ['patient'] }, expect.any(String));
  });
  it('Send-to audiences are checkboxes (patient fixed on)', async () => {
    const D = await loadDetail();
    const u = userEvent.setup();
    wrap(<D report={detail({ computed_audiences: ['patient', 'referrer'] }) as never} permissions={ADMIN} />);
    await u.click(screen.getAllByRole('button', { name: /^release/i })[0]!);
    const dlg = await screen.findByRole('dialog', { name: /release report/i });
    const boxes = within(dlg).getAllByRole('checkbox');
    expect(boxes.length).toBeGreaterThanOrEqual(2);
    expect((within(dlg).getByRole('checkbox', { name: /^patient$/i }) as HTMLInputElement).checked).toBe(true);
  });
});

describe('RS-C6 delivery screens', () => {
  it('delivery detail: each attempt outcome is a status chip (tone + word)', async () => {
    const X = await loadDlvDetail();
    wrap(<X delivery={delivery({ attempts: [{ attempt_no: 1, started_at: '2026-11-05T05:00:00.000Z', outcome: 'suppressed', error_code: 'no_consent' }, { attempt_no: 2, started_at: '2026-11-05T05:30:00.000Z', outcome: 'failed' }] }) as never} permissions={ADMIN} />);
    const list = screen.getByRole('list', { name: /delivery attempts/i });
    const rows = within(list).getAllByRole('listitem');
    expect(rows.length).toBe(2);
    for (const r of rows) expect(r.querySelector('.lims-chip'), 'attempt outcome as .lims-chip').toBeTruthy();
    expect(rows[0]!.textContent).toMatch(/suppressed/i);
  });
  it('delivery detail: one primary at most, Resend keeps its call; axe clean', async () => {
    const X = await loadDlvDetail();
    const u = userEvent.setup();
    wrap(<X delivery={delivery() as never} permissions={ADMIN} />);
    expect(primaryButtons().length).toBeLessThanOrEqual(1);
    await noSeriousAxe();
    await u.click(screen.getByRole('button', { name: /resend/i }));
    await waitFor(() => expect(A['retryDeliveryAction']).toHaveBeenCalledWith(DLV, expect.any(String)));
  });
  it('delivery log: failed row keeps masked destination and Resend; status is a chip; axe clean', async () => {
    const L = await loadDlv();
    wrap(<L deliveries={[delivery(), delivery({ id: '01a1a98a-ac40-7000-8000-000000000052', status: 'delivered', attempt_no: 1 })] as never} permissions={ADMIN} />);
    expect(screen.getAllByText('98••••••12').length).toBe(2);
    expect(screen.getAllByRole('button', { name: /resend/i }).length).toBe(1);
    expect(within(screen.getByRole('table')).getAllByText(/^(Failed|Delivered)$/).length).toBe(2);
    await noSeriousAxe();
  });
});

describe('RS-C6 worklist', () => {
  it('axe clean; one primary at most; tabs and filters keep working markup', async () => {
    const W = await loadWorklist();
    wrap(<W reports={[summary()] as never} tab="ready_to_release" permissions={BULK} centres={centres} />);
    expect(primaryButtons().length).toBeLessThanOrEqual(1);
    expect(screen.getAllByRole('tab').length).toBe(6);
    await noSeriousAxe();
  });
});

describe('RS-C6 key-screen outline snapshots (recorded once by the writer, LD-170; a baseline, not proof the look is right)', () => {
  it('report detail', async () => {
    const D = await loadDetail();
    wrap(<D report={detail() as never} permissions={ADMIN} />);
    expect(outline()).toMatchSnapshot();
  });
  it('report detail, held for dues', async () => {
    const D = await loadDetail();
    wrap(<D report={detail({ display_status: 'held', balance_due_paisa: 50000 }) as never} permissions={ADMIN} />);
    expect(outline()).toMatchSnapshot();
  });
  it('delivery detail', async () => {
    const X = await loadDlvDetail();
    wrap(<X delivery={delivery({ attempts: [{ attempt_no: 1, started_at: '2026-11-05T05:00:00.000Z', outcome: 'failed' }] }) as never} permissions={ADMIN} />);
    expect(outline()).toMatchSnapshot();
  });
  it('worklist', async () => {
    const W = await loadWorklist();
    wrap(<W reports={[summary()] as never} tab="ready_to_release" permissions={BULK} centres={centres} />);
    expect(outline()).toMatchSnapshot();
  });
});
