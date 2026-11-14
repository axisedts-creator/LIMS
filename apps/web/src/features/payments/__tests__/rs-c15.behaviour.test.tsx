// @vitest-environment jsdom
// RS-C15 — restyle of the payment staff screens (LD-140; 10-DESIGN-SYSTEM s3 shell/page rules, s4 Accounts row, s6 "colour-only status", s8 acceptance).
// Appearance and arrangement only: data, fields and calls are the existing ones (rs-c15.static.test.ts guards that). Nothing here submits a request.
// ASSUMED contracts (dispute via writer if wrong; the words/tones are the ones the payment screens already use elsewhere, so no new copy is invented):
//   A1 Reconciliation > Open findings, column "Our status": each non-empty cell is a kit StatusChip (tone + icon + word), tone from the payment_intent mapping
//      (settled success, expired danger, initiated info), words as today (initiated reads "Started"). An absent status stays an em dash with no chip.
//   A2 Intent detail > Refunds tab, column "Status": same words and tones as the Refunds list (REFUND_STATUS in labels.tsx): completed = success "Completed",
//      failed = danger "Failed", pending_approval = warning "Waiting for approval" (today: neutral + "Pending approval").
//   A3 Settings: each gateway card carries a status chip next to its title: enabled = success "Enabled", off = neutral "Disabled"; Fonepay = neutral "Not available yet".
//      The existing Enabled switch stays (it is the control; the chip is the status).
//   A4 Every chip on every payment screen is tone + icon + word; every column headed "Status" / "Our status" holds a chip in every row.
//   A5 One container level: no card inside a card (s6). One primary button per page (s3). Filters sit between the title and the list (s3), unchanged in number.
// Guards (pass today): A4 on screens already compliant, A5, filters, keyboard path, axe serious/critical.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  U, accounts, axeClean, chipsAreComplete, columnCells, holdReasons, intentCodes, intentDetail, paySettings, reconCodes, reconFindings, reconRuns, reconStats,
  refundCodes, refunds, reviewIntents, worksheets, wrap,
} from './rs-c15.fixtures';

const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  usePathname: () => '/payments/review',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: [], displayName: 'Synthetic Finance', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/payments/review',
}));

afterEach(() => { cleanup(); push.mockClear(); });

const ALL = ['payments.reconciliation.read', 'payments.intent.resolve', 'payments.refund.request', 'payments.refund.approve', 'payments.merchant_config.manage'];
const tone = (el: Element) => el.querySelector('.lims-chip')?.getAttribute('data-tone');
const chipText = (el: Element) => (el.querySelector('.lims-chip')?.textContent ?? '').trim();
const primaries = (scope: ParentNode = document) => [...scope.querySelectorAll('button')].filter((b) => b.classList.contains('lims-btn-primary'));

async function renderRecon() {
  const { ReconciliationView } = await import('../components/ReconciliationView');
  return wrap(<ReconciliationView runs={reconRuns as never} findings={reconFindings as never} stats={reconStats} permissions={ALL} codes={reconCodes as never} />);
}
async function renderReview() {
  const { ReviewQueue } = await import('../components/ReviewQueue');
  return wrap(<ReviewQueue intents={reviewIntents as never} permissions={ALL} centres={[]} holdReasons={holdReasons} />);
}
async function renderDetail() {
  const { IntentDetailView } = await import('../components/IntentDetailView');
  return wrap(<IntentDetailView intent={intentDetail as never} permissions={ALL} codes={intentCodes} />);
}
async function renderRefunds() {
  const { RefundsList } = await import('../components/RefundsList');
  return wrap(<RefundsList refunds={refunds as never} permissions={ALL} currentMembershipId={U(95)} codes={refundCodes} thresholdPaisa={0} />);
}
async function renderSettings() {
  const { SettingsView } = await import('../components/SettingsView');
  return wrap(<SettingsView environment="production" accounts={accounts as never} settings={paySettings as never} permissions={ALL} />);
}
async function renderStaticQr() {
  const { StaticQrView } = await import('../components/StaticQrView');
  return wrap(<StaticQrView worksheets={worksheets as never} permissions={ALL} centres={[{ id: U(3), name: 'Synthetic Centre' }]} />);
}
const openFindings = async () => { await userEvent.click(screen.getByRole('tab', { name: /open findings/i })); return screen.findByRole('grid', { name: /open findings/i }); };

describe('RS-C15 status chips: tone + icon + word (10-DESIGN-SYSTEM s6; A1, A2, A3, A4)', () => {
  it('A1 reconciliation findings: "Our status" is a status chip with the payment tone and today\'s word', async () => {
    await renderRecon();
    const grid = await openFindings();
    const cells = columnCells(grid, /^our status$/i);
    expect(cells).toHaveLength(reconFindings.length);
    expect(cells.map(chipText)).toEqual(['Started', 'Paid', 'Expired', '']);
    expect(cells.map(tone)).toEqual(['info', 'success', 'danger', undefined]);
    expect(cells[3]!.textContent!.trim()).toBe('—');
  });

  it('A2 intent detail refunds tab: refund status uses the refund tones and words of the Refunds list', async () => {
    await renderDetail();
    await userEvent.click(screen.getByRole('tab', { name: /^refunds$/i }));
    const grid = await screen.findByRole('grid', { name: /^refunds$/i });
    const cells = columnCells(grid, /^status$/i);
    expect(cells.map(chipText)).toEqual(['Completed', 'Failed', 'Waiting for approval']);
    expect(cells.map(tone)).toEqual(['success', 'danger', 'warning']);
  });

  it('A3 settings: eSewa Enabled/success, Khalti Disabled/neutral, Fonepay "Not available yet"/neutral, each beside the card title', async () => {
    await renderSettings();
    const card = (name: string) => screen.getByRole('heading', { name }).closest('.lims-card') as HTMLElement;
    const chip = (name: string) => { const c = card(name).querySelector<HTMLElement>('.lims-chip'); expect(c, `status chip in the ${name} card`).not.toBeNull(); return c!; };
    expect([chip('eSewa').textContent!.trim(), chip('eSewa').dataset['tone']]).toEqual(['Enabled', 'success']);
    expect([chip('Khalti').textContent!.trim(), chip('Khalti').dataset['tone']]).toEqual(['Disabled', 'neutral']);
    expect([chip('Fonepay').textContent!.trim(), chip('Fonepay').dataset['tone']]).toEqual(['Not available yet', 'neutral']);
    const sw = within(card('eSewa')).getByRole('switch', { name: /enabled/i }); // the control is unchanged
    expect(sw.getAttribute('aria-checked') ?? String((sw as HTMLInputElement).checked)).toBe('true');
  });

  it.each([
    ['review queue', renderReview, /^status$/i],
    ['refunds list', renderRefunds, /^status$/i],
    ['static QR worksheets', renderStaticQr, /^status$/i],
  ] as const)('A4 %s: every chip is tone + icon + word and every row has one in the Status column', async (_n, render, header) => {
    await render();
    const grid = screen.getAllByRole('grid')[0]!;
    const cells = columnCells(grid, header);
    expect(cells.length).toBeGreaterThan(0);
    for (const c of cells) expect(c.querySelector('.lims-chip'), `status chip in row "${c.parentElement?.textContent?.slice(0, 40)}"`).not.toBeNull();
    chipsAreComplete(document.body);
  });

  it('A4 reconciliation runs and findings: every chip is tone + icon + word; Severity and run Status columns are chips in every row', async () => {
    await renderRecon();
    expect(columnCells(screen.getByRole('grid', { name: /reconciliation runs/i }), /^status$/i).every((c) => c.querySelector('.lims-chip'))).toBe(true);
    chipsAreComplete(document.body);
    const grid = await openFindings();
    expect(columnCells(grid, /^severity$/i).every((c) => c.querySelector('.lims-chip'))).toBe(true);
    chipsAreComplete(document.body);
  });
});

describe('RS-C15 arrangement guards (10-DESIGN-SYSTEM s3, s4 Accounts, s6; A5)', () => {
  it.each([
    ['review queue', renderReview], ['reconciliation', renderRecon], ['intent detail', renderDetail], ['refunds list', renderRefunds], ['settings', renderSettings], ['static QR', renderStaticQr],
  ] as const)('%s: one container level (no card inside a card) and at most one primary button (settings: one per section card)', async (name, render) => {
    await render();
    expect(document.querySelectorAll('.lims-card .lims-card')).toHaveLength(0);
    if (name === 'settings') for (const c of document.querySelectorAll<HTMLElement>('.lims-card')) expect(primaries(c).length, c.textContent!.slice(0, 30)).toBeLessThanOrEqual(1);
    else expect(primaries().map((b) => b.textContent)).toHaveLength(name === 'review queue' || name === 'refunds list' ? 0 : 1);
  });

  it('refunds list: row actions are not primary (one primary per page, s3): Approve / Confirm refund done become secondary; Reject / Mark refund failed stay danger', async () => {
    await renderRefunds();
    const grid = screen.getAllByRole('grid')[0]!;
    expect(within(grid).getAllByRole('button', { name: /^approve$/i }).length).toBeGreaterThan(0);
    expect(primaries(grid).map((b) => b.textContent)).toEqual([]);
    for (const b of within(grid).getAllByRole('button', { name: /^reject$/i })) expect(b.classList.contains('lims-btn-danger')).toBe(true);
  });

  it('review queue: the filter bar sits between the title and the list, with the existing five filters (Status, Gateway, Hold reason, Created; Centre only when centres exist)', async () => {
    await renderReview();
    const title = screen.getByRole('heading', { name: /payment review/i });
    const search = document.querySelector('[role="search"]') as HTMLElement;
    const grid = screen.getByRole('grid');
    expect(title.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(search.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    for (const l of [/^status$/i, /^gateway$/i, /hold reason/i, /created/i]) expect(within(search).getAllByText(l).length).toBeGreaterThan(0);
  });

  it('reconciliation: Open findings keeps its Kind and Severity filters above the list; Runs keeps its columns', async () => {
    await renderRecon();
    const runs = screen.getByRole('grid', { name: /reconciliation runs/i });
    for (const h of ['Business date', 'Trigger', 'Status', 'Checked', 'OK', 'Findings', 'Critical', 'Finished']) expect(within(runs).getByRole('columnheader', { name: new RegExp(`^${h}`) })).toBeTruthy();
    const grid = await openFindings();
    const search = document.querySelector('[role="search"]') as HTMLElement;
    expect(within(search).getAllByText(/^kind$/i).length).toBeGreaterThan(0);
    expect(within(search).getAllByText(/^severity$/i).length).toBeGreaterThan(0);
    expect(search.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    for (const h of ['Found', 'Severity', 'Kind', 'Intent', 'Our status', 'Provider status', 'Our amount', 'Provider amount', 'Automatic action', 'Actions']) expect(within(grid).getByRole('columnheader', { name: new RegExp(`^${h}`) })).toBeTruthy();
  });

  it('money columns stay right-aligned and use the kit amount text (Rs. lakh grouping) in ledger-style tables', async () => {
    await renderRecon();
    const grid = await openFindings();
    for (const c of columnCells(grid, /^our amount$/i).filter((x) => x.textContent!.trim() !== '—')) expect(c.querySelector('.lims-money')).not.toBeNull();
    const heads = [...grid.querySelectorAll('[role="columnheader"]')].filter((h) => /amount/i.test(h.textContent ?? ''));
    expect(heads.length).toBe(2);
  });
});

describe('RS-C15 keyboard-only main tasks (s8) and axe (s8)', () => {
  const tabTo = async (user: ReturnType<typeof userEvent.setup>, ok: () => boolean, max = 120) => {
    for (let i = 0; i < max && !ok(); i += 1) await user.tab();
    return ok();
  };

  // DataTable is a react-aria grid (C0 04-UI-UX: "Tab enters the grid. Arrow keys move between cells"): in-cell links/buttons are reached by arrow keys, not Tab (RS-C15 ruling, RS-C7 ruling).
  const inGrid = () => !!document.activeElement?.closest('[role="grid"]');
  /** From inside the grid, snake over cells (right along a row, down, left back...) until `ok()`; keyboard only. */
  const arrowTo = async (user: ReturnType<typeof userEvent.setup>, ok: () => boolean, rows = 6, cols = 15) => {
    let key = '{ArrowRight}';
    for (let r = 0; r < rows && !ok(); r += 1) {
      for (let c = 0; c < cols && !ok(); c += 1) await user.keyboard(key);
      if (ok()) break;
      await user.keyboard('{ArrowDown}');
      key = key === '{ArrowRight}' ? '{ArrowLeft}' : '{ArrowRight}';
    }
    return ok();
  };

  it('review queue: Tab enters the grid, arrow keys reach the first payment link cell; it points at the intent screen (open a payment to review it)', async () => {
    await renderReview();
    const user = userEvent.setup({ delay: null });
    expect(await tabTo(user, inGrid, 20)).toBe(true);
    const link = document.querySelector<HTMLAnchorElement>(`a[href="/payments/intents/${U(101)}"]`)!;
    expect(link).not.toBeNull();
    expect(await arrowTo(user, () => document.activeElement === link || (!!document.activeElement?.matches('[role="gridcell"], [role="rowheader"]') && document.activeElement.contains(link)))).toBe(true);
  });

  it('reconciliation: keyboard reaches Run now, switches to Open findings with the arrow keys, reaches Resolve and opens the dialog, Cancel (keyboard) closes it', async () => {
    await renderRecon();
    const user = userEvent.setup({ delay: null });
    expect(await tabTo(user, () => document.activeElement?.textContent === 'Run now')).toBe(true);
    expect(await tabTo(user, () => document.activeElement?.getAttribute('role') === 'tab')).toBe(true);
    await user.keyboard('{ArrowRight}');
    await screen.findByRole('grid', { name: /open findings/i });
    expect(await tabTo(user, inGrid, 20)).toBe(true);
    expect(await arrowTo(user, () => document.activeElement?.textContent === 'Resolve')).toBe(true);
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('dialog', { name: /resolve finding/i })).toBeTruthy();
    // ConfirmDialog is isDismissable={false} (packages/ui ConfirmDialog.tsx:60): Escape does not close it by design; the keyboard way out is Cancel.
    expect(await tabTo(user, () => document.activeElement?.textContent === 'Cancel', 40)).toBe(true);
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it.each([
    ['review queue', renderReview], ['reconciliation', renderRecon], ['intent detail', renderDetail], ['refunds list', renderRefunds], ['settings', renderSettings], ['static QR', renderStaticQr],
  ] as const)('%s: axe reports no serious or critical violation', async (_n, render) => {
    await render();
    await axeClean();
  });
});
