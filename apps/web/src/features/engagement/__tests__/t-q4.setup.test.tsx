// @vitest-environment jsdom
// C16.T-Q4 — W7 queue setup (04-UI-UX W7; 03-APP-FLOW §7.2; TRD Q1b/Q1c/Q2b/Q2c/Q8). Contract: see t-q4.harness.tsx header (ASSUMED).
// Field rules (W7): Queue Code ^[a-z0-9_]{1,32}$, Name ≤ 60, Token prefix ^[A-Z]{1,2}$, Order 0–999, Active; Counter Name ≤ 40, Order, Active;
// Display Name ≤ 40, Queues multi-select 1–10, Status, Last seen, [Pair this screen] (dialog text), [Revoke] ConfirmDialog.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as H from './t-q4.harness';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }), usePathname: () => '/engagement/queue/setup', useSearchParams: () => new URLSearchParams() }));
vi.mock('server-only', () => ({}));
afterEach(cleanup);

const tab = (n: RegExp) => screen.getByRole('tab', { name: n });
async function openForm(user: ReturnType<typeof userEvent.setup>, label: RegExp) {
  await user.click(screen.getByRole('button', { name: label }));
  return screen.findByRole('dialog');
}
const fill = async (user: ReturnType<typeof userEvent.setup>, scope: HTMLElement, label: RegExp, value: string) => {
  const f = within(scope).getByLabelText(label);
  await user.clear(f);
  if (value) await user.type(f, value);
};
const submit = (scope: HTMLElement) => within(scope).getByRole('button', { name: /^(save|create)/i });

describe('tabs and lists (Q1b / Q2b / Q8)', () => {
  it('three tabs: Queues, Counters, Displays', async () => {
    await H.showSetup();
    expect(screen.getAllByRole('tab').map((t) => H.norm(t.textContent))).toEqual([expect.stringMatching(/queues/i), expect.stringMatching(/counters/i), expect.stringMatching(/displays/i)]);
  });

  it('Queues lists code, name, prefix, order and active (inactive queues included — setup is the definition view)', async () => {
    await H.showSetup();
    const t = H.pageText();
    for (const s of ['registration', 'A — Registration', 'sample', 'B — Sample collection', 'old', 'C — Retired']) expect(t).toContain(s);
  });

  it('Counters tab lists the counters', async () => {
    await H.showSetup();
    await userEvent.setup().click(tab(/counters/i));
    expect(H.pageText()).toContain('Counter 1');
    expect(H.pageText()).toContain('Counter 2');
  });

  it('Displays tab lists name, status (text) and last seen; the revoked display has no Revoke button', async () => {
    await H.showSetup();
    await userEvent.setup().click(tab(/displays/i));
    expect(H.pageText()).toContain('Reception TV');
    expect(H.pageText()).toContain('Old TV');
    expect(H.pageText()).toMatch(/active/i);
    expect(H.pageText()).toMatch(/revoked/i);
    expect(screen.getAllByRole('button', { name: /^revoke/i })).toHaveLength(1);
  });

  // LD-140 / 10-DESIGN-SYSTEM §6: statuses are StatusChip (tone + word) in the Queues, Counters and Displays cells.
  it('Active/Inactive and Active/Revoked render as StatusChip (tone + word)', async () => {
    await H.showSetup();
    const user = userEvent.setup();
    const has = (re: RegExp) => Array.from(document.querySelectorAll('.lims-chip')).some((c) => re.test((c.textContent ?? '').trim()) && /^(neutral|info|success|warning|danger|critical)$/.test(c.getAttribute('data-tone') ?? ''));
    expect(has(/^active$/i), 'queues: Active chip').toBe(true);
    expect(has(/^inactive$/i), 'queues: Inactive chip').toBe(true);
    await user.click(tab(/counters/i));
    expect(has(/^(in)?active$/i), 'counters: chip').toBe(true);
    await user.click(tab(/displays/i));
    expect(has(/^active$/i), 'displays: Active chip').toBe(true);
    expect(has(/^revoked$/i), 'displays: Revoked chip').toBe(true);
  });

  it('shows no display token, cookie or hash anywhere', async () => {
    await H.showSetup();
    await userEvent.setup().click(tab(/displays/i));
    expect(H.pageText()).not.toMatch(/token_hash|display_token|qdisp|sha-?256/i);
  });
});

describe('queue form validation (Q1c; W7)', () => {
  async function queueForm() {
    const actions = H.setupActions();
    await H.showSetup(actions);
    const user = userEvent.setup();
    const d = await openForm(user, /(new|add|create) queue/i);
    return { actions, user, d };
  }

  it('valid input → createQueue with centre_id, code, display_name, token_prefix, sort_order, is_active', async () => {
    const { actions, user, d } = await queueForm();
    await fill(user, d, /code/i, 'lab_results');
    await fill(user, d, /name/i, 'D — Results');
    await fill(user, d, /token prefix/i, 'D');
    await fill(user, d, /order/i, '3');
    await user.click(submit(d));
    expect(actions.createQueue).toHaveBeenCalledTimes(1);
    expect(actions.createQueue.mock.calls[0]![0]).toMatchObject({ centre_id: H.CENTRE, code: 'lab_results', display_name: 'D — Results', token_prefix: 'D', sort_order: 3, is_active: true });
  });

  it.each([
    ['code with upper case / space', /code/i, 'Bad Code'],
    ['code longer than 32', /code/i, 'a'.repeat(33)],
    ['empty code', /code/i, ''],
    ['name longer than 60', /name/i, 'N'.repeat(61)],
    ['token prefix lower case', /token prefix/i, 'a'],
    ['token prefix of 3 letters', /token prefix/i, 'ABC'],
    ['token prefix digit', /token prefix/i, '1'],
    ['order 1000', /order/i, '1000'],
    ['order -1', /order/i, '-1'],
  ])('rejects %s without calling the API', async (_n, label, value) => {
    const { actions, user, d } = await queueForm();
    await fill(user, d, /code/i, 'lab_results');
    await fill(user, d, /name/i, 'D — Results');
    await fill(user, d, /token prefix/i, 'D');
    await fill(user, d, /order/i, '3');
    await fill(user, d, label, value);
    await user.click(submit(d));
    expect(actions.createQueue).not.toHaveBeenCalled();
    expect(within(d).getAllByText(/./).some((e) => /invalid|required|must|at most|between|use/i.test(e.textContent ?? ''))).toBe(true);
  });

  it('a server-side duplicate code (rejection) is shown on the form, the dialog stays open', async () => {
    const actions = H.setupActions({ createQueue: vi.fn(async () => { throw Object.assign(new Error('common.validation_failed'), { problem: { code: 'common.validation_failed', errors: [{ pointer: '/code' }] } }); }) });
    await H.showSetup(actions);
    const user = userEvent.setup();
    const d = await openForm(user, /(new|add|create) queue/i);
    await fill(user, d, /code/i, 'registration');
    await fill(user, d, /name/i, 'Dup');
    await fill(user, d, /token prefix/i, 'Z');
    await fill(user, d, /order/i, '0');
    await user.click(submit(d));
    expect(await within(await screen.findByRole('dialog')).findByRole('alert')).toBeTruthy();
  });
});

describe('counter form (Q2c) — Name ≤ 40, Order', () => {
  it('valid → createCounter with centre_id, display_name, sort_order, is_active', async () => {
    const actions = H.setupActions();
    await H.showSetup(actions);
    const user = userEvent.setup();
    await user.click(tab(/counters/i));
    const d = await openForm(user, /(new|add|create) counter/i);
    await fill(user, d, /name/i, 'Counter 3');
    await fill(user, d, /order/i, '2');
    await user.click(submit(d));
    expect(actions.createCounter.mock.calls[0]![0]).toMatchObject({ centre_id: H.CENTRE, display_name: 'Counter 3', sort_order: 2, is_active: true });
  });

  it('name of 41 characters is rejected', async () => {
    const actions = H.setupActions();
    await H.showSetup(actions);
    const user = userEvent.setup();
    await user.click(tab(/counters/i));
    const d = await openForm(user, /(new|add|create) counter/i);
    await fill(user, d, /name/i, 'N'.repeat(41));
    await fill(user, d, /order/i, '2');
    await user.click(submit(d));
    expect(actions.createCounter).not.toHaveBeenCalled();
  });
});

describe('displays: pair and revoke (Q8; AC-22.1)', () => {
  it('[Pair this screen] opens a dialog with the exact TV-browser instruction', async () => {
    await H.showSetup();
    const user = userEvent.setup();
    await user.click(tab(/displays/i));
    const d = await openForm(user, /pair this screen/i);
    expect(H.norm(d.textContent)).toContain("Use this button on the TV's own browser. After pairing, sign out — the screen keeps showing the queue.");
  });

  it('Pair submits display_name and queue_ids (1–10); the client never receives a token', async () => {
    const actions = H.setupActions();
    await H.showSetup(actions);
    const user = userEvent.setup();
    await user.click(tab(/displays/i));
    const d = await openForm(user, /pair this screen/i);
    await fill(user, d, /name/i, 'Lobby TV');
    await user.click(within(d).getByRole('checkbox', { name: /A — Registration/ }));
    await user.click(within(d).getByRole('button', { name: /^pair$/i }));
    expect(actions.pairDisplay).toHaveBeenCalledTimes(1);
    const body = actions.pairDisplay.mock.calls[0]![0];
    expect(body).toEqual({ display_name: 'Lobby TV', queue_ids: [H.QA] });
  });

  it('Pair with no queue selected, or a name over 40, does not call the API', async () => {
    const actions = H.setupActions();
    await H.showSetup(actions);
    const user = userEvent.setup();
    await user.click(tab(/displays/i));
    const d = await openForm(user, /pair this screen/i);
    await fill(user, d, /name/i, 'Lobby TV');
    await user.click(within(d).getByRole('button', { name: /^pair$/i }));
    expect(actions.pairDisplay).not.toHaveBeenCalled();
    await fill(user, d, /name/i, 'T'.repeat(41));
    await user.click(within(d).getByRole('checkbox', { name: /A — Registration/ }));
    await user.click(within(d).getByRole('button', { name: /^pair$/i }));
    expect(actions.pairDisplay).not.toHaveBeenCalled();
  });

  it('only active queues are offered when pairing', async () => {
    await H.showSetup();
    const user = userEvent.setup();
    await user.click(tab(/displays/i));
    const d = await openForm(user, /pair this screen/i);
    expect(within(d).queryByRole('checkbox', { name: /C — Retired/ })).toBeNull();
  });

  it('[Revoke] asks for confirmation first; cancelling revokes nothing; confirming calls revokeDisplay(display)', async () => {
    const actions = H.setupActions();
    await H.showSetup(actions);
    const user = userEvent.setup();
    await user.click(tab(/displays/i));
    await user.click(screen.getByRole('button', { name: /^revoke/i }));
    let d = await screen.findByRole('alertdialog').catch(() => screen.findByRole('dialog'));
    expect(actions.revokeDisplay).not.toHaveBeenCalled();
    await user.click(within(d).getByRole('button', { name: /cancel/i }));
    expect(actions.revokeDisplay).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /^revoke/i }));
    d = await screen.findByRole('alertdialog').catch(() => screen.findByRole('dialog'));
    await user.click(within(d).getByRole('button', { name: /^(revoke|confirm)/i }));
    expect(actions.revokeDisplay).toHaveBeenCalledTimes(1);
    expect(H.idOf(actions.revokeDisplay.mock.calls[0]![0])).toBe(H.id(31));
  });
});

describe('accessibility (axe)', () => {
  it.each([['queues', /queues/i], ['counters', /counters/i], ['displays', /displays/i]])('%s tab is clean', async (_n, t) => {
    await H.showSetup();
    await userEvent.setup().click(tab(t));
    await H.axeClean();
  });
  it('queue form dialog is clean', async () => {
    await H.showSetup();
    await openForm(userEvent.setup(), /(new|add|create) queue/i);
    await H.axeClean();
  });
  it('pair dialog is clean', async () => {
    await H.showSetup();
    const user = userEvent.setup();
    await user.click(tab(/displays/i));
    await openForm(user, /pair this screen/i);
    await H.axeClean();
  });
});
