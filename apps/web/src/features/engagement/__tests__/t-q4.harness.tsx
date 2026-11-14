// C16.T-Q4 shared harness (tester-owned, not a test file). Synthetic data only. Fixtures follow contracts/openapi/engagement.yaml
// (Queue, QueueCounter, QueueToken, QueueDisplay — snake_case, `id` not `*_id`).
//
// ASSUMED CONTRACT (spec silent on component props — a dispute may refine it). Both components are NAMED exports, client components, props injected
// (no fetch inside the component under test except the polling call, which goes through `actions.listTokens`):
//   features/engagement/components/QueueConsole.tsx → QueueConsole({ labName, centreId, queues, counters, tokens, actions, pollMs? })
//     actions: listTokens(): Promise<QueueToken[]>              (Q4 poll; default every 5000 ms)
//              callNext(queueId, counterId): Promise<QueueToken | null>   (Q5; null = 204 queue empty)
//              recall(token) / complete(token) / skip(token): Promise<QueueToken>   (Q6; token = the row object, so the BFF can send If-Match)
//              serve(token, counterId): Promise<QueueToken>
//              transfer(token, toQueueId): Promise<{ from: QueueToken; to: QueueToken }>   (Q7)
//              issue({ queueId, priority }): Promise<QueueToken>   (Q3)
//   features/engagement/components/QueueSetup.tsx → QueueSetup({ centreId, queues, counters, displays, actions })
//     actions: createQueue(body) / updateQueue(queue, body) / createCounter(body) / updateCounter(counter, body) / pairDisplay({display_name, queue_ids})
//              / revokeDisplay(display) — all Promise<void>; pairDisplay never returns or exposes the display token (BFF sets the cookie).
//   Page registry id for shortcuts: 'staff.engagement.queue' (route id, contracts/routes.yaml).
import { expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { ToastProvider } from '@lims/ui/components/Toast';

export const id = (n: number) => `01940e00-0000-7000-8000-${String(n).padStart(12, '0')}`;
export const CENTRE = id(1);
export const QA = id(11), QB = id(12), QC = id(13); // A Registration, B Sample collection, C Old (inactive)
export const C1 = id(21), C2 = id(22);
export const T = (n: number) => id(100 + n);
export const NOW = '2026-01-15T04:32:05.000Z'; // fake "now" for Waiting mm:ss
export const LAB = 'Synthetic Diagnostics Lab';

export const queues = () => [
  { id: QA, centre_id: CENTRE, code: 'registration', display_name: 'A — Registration', token_prefix: 'A', sort_order: 0, is_active: true, version: 1 },
  { id: QB, centre_id: CENTRE, code: 'sample', display_name: 'B — Sample collection', token_prefix: 'B', sort_order: 1, is_active: true, version: 1 },
  { id: QC, centre_id: CENTRE, code: 'old', display_name: 'C — Retired', token_prefix: 'C', sort_order: 2, is_active: false, version: 1 },
];
export const counters = () => [
  { id: C1, centre_id: CENTRE, display_name: 'Counter 1', sort_order: 0, is_active: true, version: 1 },
  { id: C2, centre_id: CENTRE, display_name: 'Counter 2', sort_order: 1, is_active: true, version: 1 },
];
export const tok = (n: number, over: Record<string, unknown> = {}) => ({
  id: T(n), queue_id: QA, token_label: `A-${String(n).padStart(3, '0')}`, status: 'waiting', priority: 'normal',
  issued_at: '2026-01-15T04:30:00.000Z', call_count: 0, version: 1, ...over,
});
/** Queue A: A-001 waiting (2:05), A-002 waiting priority (issued later but must be first), A-003 waiting with booking; queue B: B-001 waiting. */
export const tokens = () => [
  tok(1),
  tok(2, { priority: 'priority', issued_at: '2026-01-15T04:31:00.000Z' }),
  tok(3, { booking_id: id(900), issued_at: '2026-01-15T04:31:30.000Z' }),
  tok(4, { queue_id: QB, token_label: 'B-001' }),
];
export const displays = () => [
  { id: id(31), centre_id: CENTRE, display_name: 'Reception TV', queue_ids: [QA, QB], status: 'active', paired_at: '2026-01-10T03:00:00.000Z', last_seen_at: '2026-01-15T04:31:50.000Z', version: 1 },
  { id: id(32), centre_id: CENTRE, display_name: 'Old TV', queue_ids: [QA], status: 'revoked', paired_at: '2026-01-01T03:00:00.000Z', revoked_at: '2026-01-05T03:00:00.000Z', version: 2 },
];

export function consoleActions(over: Record<string, unknown> = {}) {
  return {
    listTokens: vi.fn(async () => tokens()),
    callNext: vi.fn(async (queueId: string, counterId: string) => tok(1, { queue_id: queueId, status: 'called', counter_id: counterId, call_count: 1, called_at: NOW, version: 2 })),
    recall: vi.fn(async (t: any) => ({ ...t, call_count: t.call_count + 1, version: t.version + 1 })),
    serve: vi.fn(async (t: any, counterId: string) => ({ ...t, status: 'serving', counter_id: counterId, version: t.version + 1 })),
    complete: vi.fn(async (t: any) => ({ ...t, status: 'completed', version: t.version + 1 })),
    skip: vi.fn(async (t: any) => ({ ...t, status: 'skipped', version: t.version + 1 })),
    transfer: vi.fn(async (t: any, to: string) => ({ from: { ...t, status: 'transferred', version: t.version + 1 }, to: tok(50, { queue_id: to, token_label: 'B-002', transferred_from_token_id: t.id }) })),
    issue: vi.fn(async ({ queueId, priority }: { queueId: string; priority: string }) => tok(60, { queue_id: queueId, token_label: queueId === QB ? 'B-002' : 'A-004', priority, issued_at: NOW })),
    ...over,
  };
}
export const setupActions = (over: Record<string, unknown> = {}) => ({
  createQueue: vi.fn(async (_body: unknown) => {}), updateQueue: vi.fn(async (_body: unknown) => {}),
  createCounter: vi.fn(async (_body: unknown) => {}), updateCounter: vi.fn(async (_body: unknown) => {}),
  pairDisplay: vi.fn(async (_body: unknown) => {}), revokeDisplay: vi.fn(async (_body: unknown) => {}), ...over,
});

export const loadConsole = async () => ((await import(/* @vite-ignore */ '../components/QueueConsole')) as { QueueConsole: (p: any) => any }).QueueConsole;
export const loadSetup = async () => ((await import(/* @vite-ignore */ '../components/QueueSetup')) as { QueueSetup: (p: any) => any }).QueueSetup;

export async function showConsole(actions = consoleActions(), props: Record<string, unknown> = {}) {
  const QueueConsole = await loadConsole();
  const view = render(<ToastProvider><QueueConsole labName={LAB} centreId={CENTRE} queues={queues()} counters={counters()} tokens={tokens()} actions={actions} {...props} /></ToastProvider>);
  return { ...view, actions };
}
export async function showSetup(actions = setupActions(), props: Record<string, unknown> = {}) {
  const QueueSetup = await loadSetup();
  const view = render(<ToastProvider><QueueSetup centreId={CENTRE} queues={queues()} counters={counters()} displays={displays()} actions={actions} {...props} /></ToastProvider>);
  return { ...view, actions };
}

export const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
export const pageText = () => norm(document.body.textContent);
export async function axeClean() {
  const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
  expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
}
/** Kit Select (react-aria): trigger is a button named "<label> <value>", options render in a listbox. */
export async function pick(user: ReturnType<typeof userEvent.setup>, label: RegExp, option: RegExp) {
  await user.click(screen.getByRole('button', { name: label }));
  await user.click(await screen.findByRole('option', { name: option }));
}
export const idOf = (a: unknown) => (typeof a === 'string' ? a : (a as { id: string }).id);
export const waitingGrid = () => {
  const g = screen.queryAllByRole('grid', { name: /waiting/i });
  if (!g.length) throw new Error(`no table named /waiting/; grids: ${JSON.stringify(screen.queryAllByRole('grid').map((x) => x.getAttribute('aria-label')))}`);
  return g[0]!;
};
export const dataRows = (g: HTMLElement) => within(g).getAllByRole('row').slice(1);
export const rowTexts = (g: HTMLElement) => dataRows(g).map((r) => norm(r.textContent));
export const SHORTCUT_PAGE = 'staff.engagement.queue';
export const shortcut = async (re: RegExp) => (await import('@/core/shortcuts/registry')).shortcuts.list(SHORTCUT_PAGE).find((s) => re.test(s.key));
