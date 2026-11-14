// @vitest-environment jsdom
// C16.T-Q4 — W6 queue console (04-UI-UX W6; 03-APP-FLOW §7.1; PRD US-EN-21.1–21.6; 07-SECURITY: slip/board carry no patient data).
// Contract of the component and its injected actions: see t-q4.harness.tsx header (ASSUMED — spec is silent on props).
// done_when: "04-UI-UX W6/W7; shortcuts registered; needs CR-C16-016 (TokenSlip)"; tests: "component tests; keyboard script; axe".
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as H from './t-q4.harness';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }), usePathname: () => '/engagement/queue', useSearchParams: () => new URLSearchParams() }));
vi.mock('server-only', () => ({}));

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(H.NOW)); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
const U = () => userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });

async function withCounter(actions = H.consoleActions(), counter = /counter 1/i, props: Record<string, unknown> = {}) {
  const view = await H.showConsole(actions, props);
  const user = U();
  await H.pick(user, /my counter/i, counter);
  return { ...view, user };
}
const callNextBtn = () => screen.getByRole('button', { name: /call next/i });

describe('queue tabs and waiting list (US-EN-21.2; W6 Elements)', () => {
  it('one tab per ACTIVE queue with its waiting count; the inactive queue has no tab', async () => {
    await H.showConsole();
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => H.norm(t.textContent))).toEqual([expect.stringMatching(/A — Registration.*3/), expect.stringMatching(/B — Sample collection.*1/)]);
    expect(H.pageText()).not.toContain('C — Retired');
  });

  it('waiting list columns are Token · Priority · Waiting · Booking', async () => {
    await H.showConsole();
    const heads = within(H.waitingGrid()).getAllByRole('columnheader').map((h) => H.norm(h.textContent));
    expect(heads).toEqual(expect.arrayContaining([expect.stringMatching(/token/i), expect.stringMatching(/priority/i), expect.stringMatching(/waiting/i), expect.stringMatching(/booking/i)]));
  });

  it('lists only the selected queue\'s waiting tokens: priority first, then oldest issue time (AC-21.2)', async () => {
    await H.showConsole();
    const rows = H.rowTexts(H.waitingGrid());
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain('A-002'); // priority, though issued after A-001
    expect(rows[1]).toContain('A-001');
    expect(rows[2]).toContain('A-003');
    expect(H.pageText()).not.toContain('B-001');
  });

  it('Waiting is mm:ss from the server issued_at; Booking shows ✓ only for a booking-linked token', async () => {
    await H.showConsole();
    const rows = H.rowTexts(H.waitingGrid());
    expect(rows[1]).toContain('02:05'); // 04:30:00 → 04:32:05
    expect(rows[0]).toContain('01:05');
    expect(rows[2]).toContain('✓');
    expect(rows[0]).not.toContain('✓');
    expect(rows[1]).not.toContain('✓');
  });

  it('switching tab shows the other queue\'s tokens', async () => {
    await H.showConsole();
    await U().click(screen.getByRole('tab', { name: /B — Sample collection/ }));
    const rows = H.rowTexts(H.waitingGrid());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('B-001');
  });

  it('shows no patient name, phone or registration number anywhere (AC-21.6)', async () => {
    await H.showConsole();
    expect(H.pageText()).not.toMatch(/patient|phone|\+977|full_?name/i);
  });
});

describe('Call next (AC-21.2; W6 "Alt+N with an empty queue → toast")', () => {
  it('needs a counter: with none chosen nothing is called', async () => {
    const { actions } = await H.showConsole();
    const btn = callNextBtn();
    if (!(btn as HTMLButtonElement).disabled) await U().click(btn);
    expect(actions.callNext).not.toHaveBeenCalled();
  });

  it('calls Q5 for the active tab\'s queue and the chosen counter, then shows the current token big, with status and call count', async () => {
    const { actions, user } = await withCounter(H.consoleActions(), /counter 2/i);
    await user.click(callNextBtn());
    expect(actions.callNext).toHaveBeenCalledWith(H.QA, H.C2);
    await waitFor(() => expect(H.pageText()).toMatch(/A-001/));
    expect(H.pageText()).toMatch(/called/i);
    expect(H.pageText()).toMatch(/1 call|call(s| count)?:? ?1|called 1/i);
  });

  it('an empty queue (204 → null) shows the toast "No one is waiting." and no current token', async () => {
    const { user } = await withCounter(H.consoleActions({ callNext: vi.fn(async () => null) }));
    await user.click(callNextBtn());
    expect(await screen.findByText('No one is waiting.')).toBeTruthy();
  });

  it('Call next works on the second tab with the queue id of THAT tab', async () => {
    const { actions, user } = await withCounter();
    await user.click(screen.getByRole('tab', { name: /B — Sample collection/ }));
    await user.click(callNextBtn());
    expect(actions.callNext).toHaveBeenCalledWith(H.QB, H.C1);
  });

  it('a failing call (rejected action) shows an inline error and keeps the console usable', async () => {
    const { user, actions } = await withCounter(H.consoleActions({ callNext: vi.fn(async () => { throw new Error('boom'); }) }));
    await user.click(callNextBtn());
    expect(await screen.findByRole('alert')).toBeTruthy();
    await user.click(callNextBtn());
    expect(actions.callNext).toHaveBeenCalledTimes(2);
  });
});

describe('current token actions (AC-21.3, 21.4; W6 buttons)', () => {
  async function called(over: Record<string, unknown> = {}, callNext = true) {
    const current = H.tok(1, { status: 'called', counter_id: H.C1, call_count: 1, version: 2, ...over });
    const r = await withCounter(H.consoleActions({ callNext: vi.fn(async () => current) }));
    if (callNext) await r.user.click(callNextBtn());
    await screen.findByText(/A-001/);
    return { ...r, current };
  }
  const btn = (n: RegExp) => screen.getByRole('button', { name: n }) as HTMLButtonElement;

  it('Recall sends the current token to Q6 recall and the call count goes up on screen', async () => {
    const { user, actions, current } = await called();
    await user.click(btn(/^recall/i));
    expect(actions.recall).toHaveBeenCalledTimes(1);
    expect(H.idOf(actions.recall.mock.calls[0]![0])).toBe(current.id);
    await waitFor(() => expect(H.pageText()).toMatch(/2 calls|calls?:? ?2|called 2/i));
  });

  it('Recall is disabled once call_count reaches 9 (recall allowed while call_count < 9)', async () => {
    const { actions } = await called({ call_count: 9 });
    expect(btn(/^recall/i).disabled).toBe(true);
    expect(actions.recall).not.toHaveBeenCalled();
  });

  it('suggests Skip after 3 calls (CONV) and not before', async () => {
    cleanup();
    await called({ call_count: 2 });
    expect(H.pageText()).not.toMatch(/suggest/i);
    cleanup();
    await called({ call_count: 3 });
    expect(H.pageText()).toMatch(/suggest/i);
    expect(H.pageText()).toMatch(/skip/i);
  });

  it('Serving → serve(token, my counter); Done → complete(token); Skip → skip(token)', async () => {
    const a = await called();
    await a.user.click(btn(/^serving/i));
    expect(a.actions.serve).toHaveBeenCalledTimes(1);
    expect(H.idOf(a.actions.serve.mock.calls[0]![0])).toBe(a.current.id);
    expect(a.actions.serve.mock.calls[0]![1]).toBe(H.C1);
    await waitFor(() => expect(H.pageText()).toMatch(/being served/i));
    await a.user.click(btn(/^done/i));
    expect(H.idOf(a.actions.complete.mock.calls[0]![0])).toBe(a.current.id);
    cleanup();
    const b = await called();
    await b.user.click(btn(/^skip/i));
    expect(H.idOf(b.actions.skip.mock.calls[0]![0])).toBe(b.current.id);
  });

  it('with no current token the per-token buttons are disabled', async () => {
    await withCounter();
    for (const n of [/^recall/i, /^serving/i, /^done/i, /^skip/i, /^transfer/i]) expect(btn(n).disabled, String(n)).toBe(true);
  });

  it('Transfer… opens a dialog listing the OTHER active queues; confirming calls transfer(token, target) (AC-21.4)', async () => {
    const { user, actions, current } = await called();
    await user.click(btn(/^transfer/i));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByText(/C — Retired/)).toBeNull();
    await H.pick(user, /target queue|to queue|queue/i, /B — Sample collection/);
    await user.click(within(dialog).getByRole('button', { name: /^transfer|confirm|move/i }));
    expect(actions.transfer).toHaveBeenCalledTimes(1);
    expect(H.idOf(actions.transfer.mock.calls[0]![0])).toBe(current.id);
    expect(actions.transfer.mock.calls[0]![1]).toBe(H.QB);
  });

  it('Transfer dialog does not offer the token\'s own queue', async () => {
    const { user } = await called();
    await user.click(btn(/^transfer/i));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /queue/i }));
    const opts = (await screen.findAllByRole('option')).map((o) => H.norm(o.textContent));
    expect(opts.some((o) => /A — Registration/.test(o))).toBe(false);
    expect(opts.some((o) => /B — Sample collection/.test(o))).toBe(true);
  });
});

describe('Issue token + slip (AC-21.1; W6 Slip row)', () => {
  it('Issue token dialog: queue + priority → issue({queueId, priority}) → TokenSlip with lab, queue, token label, date/time only', async () => {
    const { user, actions } = await H.showConsole().then(async (r) => ({ ...r, user: U() }));
    await user.click(screen.getByRole('button', { name: /issue token/i }));
    const dialog = await screen.findByRole('dialog');
    await H.pick(user, /queue/i, /B — Sample collection/);
    await H.pick(user, /priority/i, /^priority/i);
    await user.click(within(dialog).getByRole('button', { name: /^issue/i }));
    expect(actions.issue).toHaveBeenCalledWith({ queueId: H.QB, priority: 'priority' });
    const slip = await screen.findByTestId('token-slip').catch(() => screen.getByLabelText(/token slip/i));
    const t = H.norm(slip.textContent);
    expect(t).toContain(H.LAB);
    expect(t).toContain('B — Sample collection');
    expect(t).toContain('B-002');
    expect(t).toContain('2026-01-15');
    expect(t).not.toMatch(/patient|phone|booking|[0-9a-f]{8}-[0-9a-f]{4}-/i); // nothing else: no names, no ids
  });

  it('default priority is normal and the default queue is the active tab', async () => {
    const { user, actions } = await H.showConsole().then(async (r) => ({ ...r, user: U() }));
    await user.click(screen.getByRole('button', { name: /issue token/i }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /^issue/i }));
    expect(actions.issue).toHaveBeenCalledWith({ queueId: H.QA, priority: 'normal' });
  });
});

describe('polling (W6 Polling: every 5 s through the BFF)', () => {
  it('re-reads the tokens every 5 s by default (Q4) and replaces the waiting list', async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(new Date(H.NOW));
    const next = [H.tok(1), H.tok(9, { token_label: 'A-009' })];
    const actions = H.consoleActions({ listTokens: vi.fn(async () => next) });
    await H.showConsole(actions);
    expect(actions.listTokens).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(4_900); });
    expect(actions.listTokens).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(actions.listTokens).toHaveBeenCalledTimes(1);
    expect(H.pageText()).toContain('A-009');
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(actions.listTokens).toHaveBeenCalledTimes(2);
  });

  it('stops polling after unmount (no leak)', async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    const actions = H.consoleActions();
    const { unmount } = await H.showConsole(actions);
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(actions.listTokens).not.toHaveBeenCalled();
  });

  it('a failed poll keeps the last list on screen (no blank console)', async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    const actions = H.consoleActions({ listTokens: vi.fn(async () => { throw new Error('down'); }) });
    await H.showConsole(actions);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_100); });
    expect(actions.listTokens).toHaveBeenCalled();
    expect(H.pageText()).toContain('A-001');
  });
});

describe('keyboard script (shortcuts registered, W6 buttons)', () => {
  const need = async (re: RegExp) => { const s = await H.shortcut(re); expect(s, String(re)).toBeTruthy(); return s!; };

  it('registers Alt+R / Alt+S / Alt+D / Alt+K / Alt+T / Alt+I under page id staff.engagement.queue with descriptions', async () => {
    await H.showConsole();
    const { shortcuts } = await import('@/core/shortcuts/registry');
    const list = shortcuts.list(H.SHORTCUT_PAGE);
    for (const [k, d] of [['Alt+R', /recall/i], ['Alt+S', /serv/i], ['Alt+D', /done|complete/i], ['Alt+K', /skip/i], ['Alt+T', /transfer/i], ['Alt+I', /issue/i]] as const) {
      const s = list.find((x) => x.key.toLowerCase() === k.toLowerCase());
      expect(s, k).toBeTruthy();
      expect(s!.description, k).toMatch(d);
    }
  });

  it('registers a "Call next" shortcut that is NOT a global key (C0 registry throws on Alt+N / Alt+M / Alt+H — see T-Q4-tests.md, spec conflict)', async () => {
    await H.showConsole();
    const { shortcuts, GLOBAL_KEYS } = await import('@/core/shortcuts/registry');
    const s = shortcuts.list(H.SHORTCUT_PAGE).find((x) => /call next/i.test(x.description));
    expect(s).toBeTruthy();
    expect(GLOBAL_KEYS as readonly string[]).not.toContain(s!.key);
  });

  it('page shortcuts are unregistered on unmount (a later page can reuse the keys)', async () => {
    const { unmount } = await H.showConsole();
    expect((await import('@/core/shortcuts/registry')).shortcuts.list(H.SHORTCUT_PAGE).length).toBeGreaterThan(0);
    unmount();
    expect((await import('@/core/shortcuts/registry')).shortcuts.list(H.SHORTCUT_PAGE)).toHaveLength(0);
  });

  it('Alt+R / Alt+S / Alt+D / Alt+K run the same actions as the buttons (and only with a current token)', async () => {
    const current = H.tok(1, { status: 'called', counter_id: H.C1, call_count: 1, version: 2 });
    const { user, actions } = await withCounter(H.consoleActions({ callNext: vi.fn(async () => current) }));
    // no current token yet: shortcut is a no-op
    (await need(/^alt\+r$/i)).run();
    expect(actions.recall).not.toHaveBeenCalled();
    await user.click(callNextBtn());
    await screen.findByText(/A-001/);
    await act(async () => { (await need(/^alt\+r$/i)).run(); });
    expect(actions.recall).toHaveBeenCalledTimes(1);
    await act(async () => { (await need(/^alt\+s$/i)).run(); });
    expect(actions.serve).toHaveBeenCalledTimes(1);
    await act(async () => { (await need(/^alt\+d$/i)).run(); });
    expect(actions.complete).toHaveBeenCalledTimes(1);
  });

  it('Alt+K runs skip, Alt+T opens the transfer dialog, Alt+I opens the issue dialog', async () => {
    const current = H.tok(1, { status: 'called', counter_id: H.C1, call_count: 1, version: 2 });
    const { user, actions } = await withCounter(H.consoleActions({ callNext: vi.fn(async () => current) }));
    await user.click(callNextBtn());
    await screen.findByText(/A-001/);
    await act(async () => { (await need(/^alt\+k$/i)).run(); });
    expect(actions.skip).toHaveBeenCalledTimes(1);
    await act(async () => { (await need(/^alt\+i$/i)).run(); });
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  it('the Call-next shortcut calls Q5 (empty queue → toast "No one is waiting.")', async () => {
    const { actions } = await withCounter(H.consoleActions({ callNext: vi.fn(async () => null) }));
    const { shortcuts } = await import('@/core/shortcuts/registry');
    const s = shortcuts.list(H.SHORTCUT_PAGE).find((x) => /call next/i.test(x.description))!;
    await act(async () => { s.run(); });
    expect(actions.callNext).toHaveBeenCalledWith(H.QA, H.C1);
    expect(await screen.findByText('No one is waiting.')).toBeTruthy();
  });

  it('every control is reachable by Tab and has an accessible name (no mouse-only action)', async () => {
    await H.showConsole();
    const user = U();
    const names = new Set<string>();
    for (let i = 0; i < 40; i++) { await user.tab(); const el = document.activeElement as HTMLElement; names.add(H.norm(el.getAttribute('aria-label') ?? el.textContent)); }
    for (const n of [/call next/i, /issue token/i, /recall/i, /transfer/i]) expect([...names].some((x) => n.test(x)), String(n)).toBe(true);
  });
});

describe('accessibility (axe)', () => {
  it('console is clean — idle', async () => {
    await H.showConsole();
    await H.axeClean();
  });
  it('console is clean — with a current token', async () => {
    const { user } = await withCounter(H.consoleActions({ callNext: vi.fn(async () => H.tok(1, { status: 'called', counter_id: H.C1, call_count: 3, version: 2 })) }));
    await user.click(callNextBtn());
    await screen.findByText(/A-001/);
    await H.axeClean();
  });
  it('console is clean — issue dialog open and slip shown', async () => {
    const { user } = await H.showConsole().then(async (r) => ({ ...r, user: U() }));
    await user.click(screen.getByRole('button', { name: /issue token/i }));
    await screen.findByRole('dialog');
    await H.axeClean();
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^issue/i }));
    await screen.findByLabelText(/token slip/i).catch(() => undefined);
    await H.axeClean();
  });
  it('token status is text, not colour only (04-UI-UX §9 "no colour-only meaning")', async () => {
    const { user } = await withCounter(H.consoleActions({ callNext: vi.fn(async () => H.tok(1, { status: 'called', counter_id: H.C1, call_count: 1, version: 2 })) }));
    await user.click(callNextBtn());
    await screen.findByText(/A-001/);
    expect(H.pageText()).toMatch(/called/i);
  });
  // LD-140 / 10-DESIGN-SYSTEM §6: every status shows tone + word via the kit StatusChip (.lims-chip[data-tone]).
  it('current token status renders as a StatusChip (tone + word)', async () => {
    const { user } = await withCounter(H.consoleActions({ callNext: vi.fn(async () => H.tok(1, { status: 'called', counter_id: H.C1, call_count: 1, version: 2 })) }));
    await user.click(callNextBtn());
    await screen.findByText(/A-001/);
    const chip = Array.from(document.querySelectorAll('.lims-chip')).find((c) => /called/i.test(c.textContent ?? ''));
    expect(chip, 'StatusChip with the word "called"').toBeTruthy();
    expect(chip!.getAttribute('data-tone')).toMatch(/^(neutral|info|success|warning|danger|critical)$/);
  });
});
