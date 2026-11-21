// @vitest-environment jsdom
// T0D-UICONSOLE-2 (LD-353 template 2 CONSOLE, rules 5, 6, 8; LD-364): /lab/verification and /lab/approval share ONE SplitConsole. Synthetic data only.
// Props do not change: VerificationQueue({ items, permissions, currentUserId? }), ApprovalQueue({ items, permissions, currentUserId?, onStepUp? }). No route, permission, contract or operation changes.
// MENU LABELS (title = menu, rule 8): h1 = t('lab.nav.verification') ("Verify") and t('lab.nav.approval') ("Approve").
// PAGE: PageHeader + ONE FilterBar (holds the checkbox "Flagged only", same flagged_only URL filter; department and centre filters are NOT built: the queue contract has no such fields, see the notes)
//   + ONE StatTile row [Pending, Flagged, Oldest wait] above ONE SplitConsole.
//   Pending = registrations in the queue; Flagged = registrations with a flagged result (flag other than N, critical, or a result that needs a flag acknowledgement); Oldest wait = the oldest wait (hh:mm), a dash when none.
// QUEUE (left): one item per REGISTRATION (rows of the same registration_no are grouped, first seen order). Item = ONE focusable <button data-console-item="{registration_no}">; click or Enter selects (aria-selected), nothing is selected first.
//   Header cells exactly: Priority, Registration no, Patient, Analyte count, Flags, Waiting time (the header row stays when empty and the EmptyState sits INSIDE .lims-console-list).
//   Waiting time = approval queue: time since verified_at of the oldest result (hh:mm); verification queue: the DTO has no timestamp, so a dash (contract gap in the notes).
//   Each row has a checkbox "Select {registration_no}" (aria-label) for the bulk tick: it is DISABLED (not hidden) on a flagged registration, on a registration the user already signed, and when the user may not act.
// DETAIL (right, after a selection): patient strip (name, age_sex, patient_code, registration no, priority); results table, headers exactly Analyte, Value, Unit, Reference range, Flag, Previous value, Change, Comment, Sign-off,
//   one row per result of that registration: value_numeric (or value_text), unit_code, reference_range_snapshot "low–high" (en dash; text when no low / high), flag badge, delta.prev_value, change "abs (pct%)" from delta.abs / delta.pct,
//   comment_text, the VERLEVEL chip "Signed n of m" (a button) + next step; ack checkboxes "Acknowledge delta" etc. sit in the Flag cell of a result that needs them (verification only). An audit line [data-console-audit] starting "Audit".
// STICKY BAR (.lims-console-actions): "Select all unflagged (S)", primary "Verify N (V)" / "Approve N (A)" (N = results that would be sent; just "Verify (V)" and disabled when 0), "Return for repeat (R)", "Hold (H)".
//   Primary acts on the ticked registrations, else on the selected registration. "Select all unflagged" opens ONE confirm dialog ("{n} registrations", "{m} results", Confirm / Cancel); Confirm sends ONE bulk request.
//   Return for repeat opens a dialog for the selected registration (the existing returnResult operation). Hold has no operation: the button is shown DISABLED with the words "not available yet" as its description.
//   A user without the permission sees the same bar with every action disabled and the visible reason "You do not have permission to verify results." / "...to approve results." (never a hidden control).
//   A result the user already signed (VERLEVEL, currentUserId): the queue row is aria-disabled with the words "You already signed this result", its tick disabled, Select all skips it, it is never sent.
// PAGES: 501 operation_pending shows NotAvailable under the menu title with the list header row and no alert; 500 still throws to error.tsx; both error.tsx keep the h1, show the digest and Retry, never the message.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { ReactNode } from 'react';
import { ToastProvider } from '@lims/ui/components/Toast';
import { t } from '@/core/i18n/messages';
import { actionBar, barActions, consoles, detailPane, filterBars, hasAge, itemOf, items, listHeaders, listPane, norm, pickItem, selected, shortcutOf, tileMap, tileRows, tiles, tileLabel, titles } from '@/__tests__/uiconsole1.helpers';

const ORIGIN = 'http://api.test';
process.env['LIMS_ORIGIN_API'] = ORIGIN;
const push = vi.hoisted(() => vi.fn());
const refresh = vi.hoisted(() => vi.fn());
const session = vi.hoisted(() => ({ perms: [] as string[] }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh, back: vi.fn() }),
  usePathname: () => '/lab/verification',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: session.perms, displayName: 'Synthetic Lab', tenantCode: 'syn', roles: [], membershipId: '01a1a98a-ac40-7000-8000-000000000090' } }),
  getRequestPathname: async () => '/lab/verification',
}));

const NOW = Date.parse('2026-11-16T06:00:00.000Z');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); cleanup(); push.mockReset(); refresh.mockReset(); session.perms = []; calls.length = 0; signoffs = {}; });

const id = (n: number) => `01a1a98a-ac40-7000-8000-${String(n).padStart(12, '0')}`;
const ME = id(7001), OTHER = id(7002);
const VERIFY = ['lab.result.read', 'lab.result.verify'];
const APPROVE = ['lab.result.read', 'lab.result.approve'];
type Over = Record<string, unknown>;
const reg = (n: number) => `REG${String(n).padStart(4, '0')}`;
/** result n of registration r; unflagged by default (flag N, delta pass) */
const row = (n: number, r: number, o: { result?: Over; name?: string; priority?: string } = {}) => ({
  result: {
    id: id(n), version: 1, order_id: id(1000 + r), order_item_id: id(2000 + n), specimen_id: id(3000 + r), test_id: id(4000 + n), analyte_id: id(5000 + n),
    analyte_code: `AN${n}`, status: 'resulted', origin: 'manual', value_numeric: `5.${n}`, unit_code: 'mmol_l', flag: 'N',
    range_unavailable_age_unknown: false, critical: { is_critical: false }, on_hold: false, qc_review_required: false, unit_mismatch: false,
    current_version_no: 1, delta: { status: 'pass' }, instrument_flags: [], reference_range_snapshot: { low: '3.5', high: '5.5', unit_code: 'mmol_l' }, ...o.result,
  },
  registration_no: reg(r),
  barcode: `SYN${String(r).padStart(6, '0')}`,
  patient_display: { full_name: o.name ?? `Synthetic Patient ${r}`, age_sex: '40Y M', patient_code: `P${r}` },
  priority: o.priority ?? 'routine',
});
const DELTA_FAIL = { delta: { status: 'fail', prev_value: '4.1', abs: '1.3', pct: '31.7', prev_at: ago(2000) } };
const signoffRow = (seq: number, by: string, name: string) => ({
  result_version: 1, seq, action: 'verify', signer_user_id: by, signer_display_name: name, signer_title: 'Senior Technologist', signer_role_code: 'technologist', signer_is_pathologist: false, signed_at: '2026-11-15T04:15:00.000Z',
});

const calls: { method: string; url: URL; body?: any }[] = [];
const okAll = (body: any) => HttpResponse.json({ results: body.items.map((i: any) => ({ id: i.id, outcome: 'ok' })) });
let signoffs: Record<string, unknown[]> = {};
const problem = (status: number) => HttpResponse.json({ type: 'about:blank', title: 'x', status, code: status === 501 ? 'operation_pending' : 'common.internal', request_id: 'req-synthetic' }, { status, headers: { 'content-type': 'application/problem+json' } });
let answer = 0; // 0 = the specific handlers below; 501 / 500 = every request fails (pages)
const api = setupServer(
  http.all(`${ORIGIN}/*`, async ({ request, params }) => {
    const u = new URL(request.url);
    if (answer) return problem(answer);
    calls.push({ method: request.method, url: u, body: request.method === 'GET' ? undefined : await request.clone().json().catch(() => undefined) });
    if (request.method === 'POST' && u.pathname === '/v1/lab/results/bulk-verify') return okAll(await request.clone().json());
    if (request.method === 'POST' && u.pathname === '/v1/lab/results/bulk-approve') return okAll(await request.clone().json());
    const m = /\/v1\/lab\/results\/([^/]+)\/signoffs$/.exec(u.pathname);
    if (m) return HttpResponse.json({ data: signoffs[m[1]!] ?? [] });
    void params;
    return HttpResponse.json({ data: [] });
  }),
);
beforeAll(() => api.listen({ onUnhandledFrame: 'error' }));
afterEach(() => { answer = 0; api.resetHandlers(); });
afterAll(() => api.close());
const posts = () => calls.filter((c) => c.method === 'POST' && /bulk-(verify|approve)$/.test(c.url.pathname));

const MODES = [
  { mode: 'verify', menuKey: 'lab.nav.verification', perms: VERIFY, verb: 'Verify', key: 'V', empty: 'Nothing waiting for verification.', denied: 'You do not have permission to verify results.',
    mount: async (rows: unknown[], extra: Over = {}) => { const { VerificationQueue } = await import('../components/VerificationQueue'); return render(<ToastProvider><VerificationQueue items={rows as never} permissions={VERIFY} {...extra} /></ToastProvider>); },
    mountAs: async (rows: unknown[], permissions: string[]) => { const { VerificationQueue } = await import('../components/VerificationQueue'); return render(<ToastProvider><VerificationQueue items={rows as never} permissions={permissions} /></ToastProvider>); } },
  { mode: 'approve', menuKey: 'lab.nav.approval', perms: APPROVE, verb: 'Approve', key: 'A', empty: 'Nothing waiting for approval.', denied: 'You do not have permission to approve results.',
    mount: async (rows: unknown[], extra: Over = {}) => { const { ApprovalQueue } = await import('../components/ApprovalQueue'); return render(<ToastProvider><ApprovalQueue items={rows as never} permissions={APPROVE} {...extra} /></ToastProvider>); },
    mountAs: async (rows: unknown[], permissions: string[]) => { const { ApprovalQueue } = await import('../components/ApprovalQueue'); return render(<ToastProvider><ApprovalQueue items={rows as never} permissions={permissions} /></ToastProvider>); } },
] as const;

const HEADERS = ['Priority', 'Registration no', 'Patient', 'Analyte count', 'Flags', 'Waiting time'];
const RESULT_HEADERS = ['Analyte', 'Value', 'Unit', 'Reference range', 'Flag', 'Previous value', 'Change', 'Comment', 'Sign-off'];
const inOrder = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
const resultHeaders = (c: HTMLElement) => [...(detailPane(c)?.querySelectorAll('thead th, [role="columnheader"]') ?? [])].map((h) => norm(h.textContent));
const resultRow = (c: HTMLElement, code: string) => {
  const r = [...(detailPane(c)?.querySelectorAll('tbody tr') ?? [])].find((x) => x.textContent?.includes(code));
  if (!r) throw new Error(`no result row for ${code}`);
  return r as HTMLElement;
};
const tick = (c: HTMLElement, regNo: string) => within(listPane(c)!).getByRole('checkbox', { name: `Select ${regNo}` }) as HTMLInputElement;
const bar = (c: HTMLElement) => actionBar(c)!;
const barBtn = (c: HTMLElement, name: RegExp) => within(bar(c)).getByRole('button', { name }) as HTMLButtonElement;

// 3 results over 2 registrations: REG0001 = AN1 + AN2 (unflagged), REG0002 = AN3 (flag H), REG0003 = AN4 (unflagged, other priority)
const ONE = [row(1, 1)];
const MANY = [row(1, 1, { priority: 'urgent' }), row(3, 2, { result: { flag: 'H' } }), row(2, 1, { priority: 'urgent' }), row(4, 3, { name: 'Synthetic Patient Three' })];

describe.each(MODES)('T0D-UICONSOLE-2 $mode queue (template 2 CONSOLE)', (m) => {
  it.each([['no rows', () => []], ['one row', () => ONE]])('%s: h1 = the menu label, one FilterBar with Flagged only, one StatTile row, one console; filters and tiles sit above the list', async (_n, rows) => {
    const { container } = await m.mount(rows());
    expect(titles(container)).toEqual([t(m.menuKey)]);
    expect(filterBars(container)).toHaveLength(1);
    expect(within(filterBars(container)[0]!).getByRole('checkbox', { name: /flagged only/i })).toBeTruthy();
    expect(tileRows(container)).toHaveLength(1);
    expect(tiles(container).map(tileLabel)).toEqual(['Pending', 'Flagged', 'Oldest wait']);
    expect(consoles(container)).toHaveLength(1);
    const c = consoles(container)[0]!;
    expect(c.contains(filterBars(container)[0]!)).toBe(false);
    expect(c.contains(tileRows(container)[0]!)).toBe(false);
    expect(inOrder(filterBars(container)[0]!, c)).toBe(true);
    expect(inOrder(tileRows(container)[0]!, c)).toBe(true);
    expect(listPane(container)).toBeTruthy();
    expect(detailPane(container)).toBeTruthy();
  });

  it.each([['no rows', () => []], ['one row', () => ONE]])('%s: the queue header row is drawn with the six named columns', async (_n, rows) => {
    const { container } = await m.mount(rows());
    expect(listHeaders(container)).toEqual(HEADERS);
  });

  it('no rows: the EmptyState (title kept) is inside the list area, no item, tiles read 0, 0 and a dash; the bar still shows its actions, disabled', async () => {
    const { container } = await m.mount([]);
    const empty = listPane(container)!.querySelector('.lims-state');
    expect(empty).toBeTruthy();
    expect(norm(empty!.textContent)).toContain(m.empty);
    expect(items(container)).toHaveLength(0);
    expect(tileMap(container)).toEqual({ Pending: '0', Flagged: '0', 'Oldest wait': '—' });
    for (const b of barActions(container)) expect((b as HTMLButtonElement).disabled).toBe(true);
    expect(barActions(container).length).toBeGreaterThanOrEqual(4);
  });

  it('several rows: one item per registration in first-seen order, analyte count, priority, patient, tiles counted per registration', async () => {
    const { container } = await m.mount(MANY);
    expect(items(container).map((i) => i.getAttribute('data-console-item'))).toEqual([reg(1), reg(2), reg(3)]);
    expect(selected(container)).toHaveLength(0);
    const r1 = itemOf(container, reg(1))!.closest('tr')!;
    const cells = [...r1.querySelectorAll('td')].map((c) => norm(c.textContent));
    expect(cells.join('|')).toMatch(/urgent/);
    expect(cells.join('|')).toContain('Synthetic Patient 1');
    expect(cells).toContain('2'); // analyte count of REG0001
    expect([...itemOf(container, reg(3))!.closest('tr')!.querySelectorAll('td')].map((c) => norm(c.textContent))).toContain('1');
    expect(tileMap(container)).toMatchObject({ Pending: '3', Flagged: '1' });
  });

  it('a click selects the registration: aria-selected, patient strip and a results table with the full header; another click moves the detail', async () => {
    const { container } = await m.mount(MANY);
    const d = pickItem(container, reg(1));
    expect(selected(container).map((i) => i.getAttribute('data-console-item'))).toEqual([reg(1)]);
    expect(norm(d.textContent)).toContain('Synthetic Patient 1');
    expect(norm(d.textContent)).toContain('40Y M');
    expect(norm(d.textContent)).toContain('P1');
    expect(norm(d.textContent)).toContain(reg(1));
    expect(resultHeaders(container)).toEqual(RESULT_HEADERS);
    expect([...d.querySelectorAll('tbody tr')].map((r) => /AN\d/.exec(r.textContent ?? '')?.[0])).toEqual(['AN1', 'AN2']);
    pickItem(container, reg(3));
    expect(selected(container).map((i) => i.getAttribute('data-console-item'))).toEqual([reg(3)]);
    expect(norm(detailPane(container)!.textContent)).toContain('Synthetic Patient Three');
    expect(norm(detailPane(container)!.textContent)).not.toContain('Synthetic Patient 1');
  });

  it('the results table shows value, unit, reference range, flag, previous value, change and comment', async () => {
    const { container } = await m.mount([row(1, 1, { result: { value_numeric: '6.8', unit_code: 'mmol_l', flag: 'H', ...DELTA_FAIL, comment_text: 'Hemolysed sample, repeat advised' } }), row(2, 1, { result: { value_numeric: undefined, value_text: 'Reactive', reference_range_snapshot: { text: 'Non reactive' }, unit_code: undefined } })]);
    pickItem(container, reg(1));
    const r1 = resultRow(container, 'AN1');
    const cells = [...r1.querySelectorAll('td')].map((c) => norm(c.textContent));
    expect(cells[0]).toContain('AN1');
    expect(cells[1]).toBe('6.8');
    expect(cells[2]).toContain('mmol_l');
    expect(cells[3]).toBe('3.5–5.5');
    expect(cells[4]).toMatch(/H/);
    expect(cells[5]).toBe('4.1');
    expect(cells[6]).toContain('1.3');
    expect(cells[6]).toContain('31.7');
    expect(cells[7]).toContain('Hemolysed sample, repeat advised');
    const r2 = [...resultRow(container, 'AN2').querySelectorAll('td')].map((c) => norm(c.textContent));
    expect(r2[1]).toBe('Reactive');
    expect(r2[3]).toBe('Non reactive');
    expect(r2[5]).toBe('—'); // no previous value: a dash, never an empty cell
    expect(r2[6]).toBe('—');
  });

  it('XSS: a comment, patient name and signer name that are markup stay text', async () => {
    const { container } = await m.mount([row(1, 1, { name: '<img src=x onerror=alert(1)>', result: { comment_text: '<script>alert(1)</script>' } })]);
    pickItem(container, reg(1));
    expect(container.querySelector('img[src="x"], script')).toBeNull();
    expect(norm(detailPane(container)!.textContent)).toContain('<script>alert(1)</script>');
  });

  it('the detail has an audit line starting "Audit"; the signer of a recorded sign-off appears in it', async () => {
    signoffs[id(1)] = [signoffRow(1, OTHER, 'Synthetic Signer One')];
    const { container } = await m.mount([row(1, 1, { result: { signoff_count: 1, signoff_required: 2, next_step: 'approve' } })]);
    const d = pickItem(container, reg(1));
    const audit = d.querySelector('[data-console-audit]');
    expect(audit).toBeTruthy();
    expect(norm(audit!.textContent)).toMatch(/^Audit/);
    await waitFor(() => expect(norm(d.querySelector('[data-console-audit]')!.textContent)).toContain('Synthetic Signer One'));
    expect(within(resultRow(container, 'AN1')).getByRole('button', { name: 'Signed 1 of 2' })).toBeTruthy();
  });

  it('keyboard: j and k move the focus over the registrations, Enter selects the focused one; the ends stay put', async () => {
    const user = userEvent.setup();
    const { container } = await m.mount(MANY);
    const its = () => items(container);
    its()[0]!.focus();
    await user.keyboard('j');
    expect(document.activeElement).toBe(its()[1]);
    await user.keyboard('j');
    expect(document.activeElement).toBe(its()[2]);
    await user.keyboard('j');
    expect(document.activeElement).toBe(its()[2]);
    await user.keyboard('k');
    expect(document.activeElement).toBe(its()[1]);
    await user.keyboard('{Enter}');
    expect(selected(container).map((i) => i.getAttribute('data-console-item'))).toEqual([reg(2)]);
    its()[0]!.focus();
    await user.keyboard('k');
    expect(document.activeElement).toBe(its()[0]);
  });

  it('sticky bar: Select all unflagged, the primary action named after the level, Return for repeat and Hold, each with its shortcut in the label', async () => {
    const { container } = await m.mount(MANY);
    pickItem(container, reg(1));
    const labels = barActions(container).map((b) => norm(b.textContent));
    expect(labels).toEqual(['Select all unflagged (S)', `${m.verb} 2 (${m.key})`, 'Return for repeat (R)', 'Hold (H)']);
    expect(shortcutOf(barActions(container)[1])).toBe(m.key);
    expect(bar(container).closest('.lims-console-detail')).toBeTruthy();
  });

  it('with nothing selected or ticked the primary reads "' + m.verb + ' (' + m.key + ')" and is disabled; Return for repeat is disabled until a registration is selected', async () => {
    const { container } = await m.mount(MANY);
    const primary = barBtn(container, new RegExp(`^${m.verb} \\(${m.key}\\)$`));
    expect(primary.disabled).toBe(true);
    expect(barBtn(container, /^Return for repeat/).disabled).toBe(true);
    pickItem(container, reg(1));
    expect(barBtn(container, /^Return for repeat/).disabled).toBe(false);
  });

  it('Hold has no operation: it is shown, disabled, and says so in its description', async () => {
    const { container } = await m.mount(MANY);
    pickItem(container, reg(1));
    const hold = barBtn(container, /^Hold/);
    expect(hold.disabled).toBe(true);
    const desc = (hold.getAttribute('aria-describedby') ?? '').split(' ').map((i) => document.getElementById(i)?.textContent ?? '').join(' ') + (hold.getAttribute('title') ?? '');
    expect(desc).toMatch(/not available yet/i);
  });

  it('Return for repeat opens its dialog for the selected registration; nothing is sent by opening it', async () => {
    const user = userEvent.setup();
    const { container } = await m.mount(MANY);
    pickItem(container, reg(1));
    await user.click(barBtn(container, /^Return for repeat/));
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('the shortcut S works from the queue: it opens the confirm', async () => {
    const user = userEvent.setup();
    const { container } = await m.mount([row(1, 1), row(2, 2)]);
    items(container)[0]!.focus();
    await user.keyboard('s');
    const dlg = await screen.findByRole('dialog');
    expect(dlg.textContent).toMatch(/2 registrations/);
    await user.click(within(dlg).getByRole('button', { name: /^cancel$/i }));
    expect(posts()).toHaveLength(0);
  });

  it('read only: without the permission every action stays on the bar disabled and the reason is written out; ticks are disabled, not hidden', async () => {
    const { container } = await m.mountAs([row(1, 1), row(2, 2)], ['lab.result.read']);
    pickItem(container, reg(1));
    expect(barActions(container).length).toBeGreaterThanOrEqual(4);
    for (const b of barActions(container)) expect((b as HTMLButtonElement).disabled).toBe(true);
    expect(norm(bar(container).textContent)).toContain(m.denied);
    expect(tick(container, reg(1)).disabled).toBe(true);
  });

  it('the queue items are buttons with an accessible name that includes the registration number', async () => {
    const { container } = await m.mount(MANY);
    for (const i of items(container)) {
      expect(i.tagName).toBe('BUTTON');
      expect(i.textContent).toContain(i.getAttribute('data-console-item')!);
    }
  });
});

describe('T0D-UICONSOLE-2 waiting time', () => {
  const [verify, approve] = MODES;
  it('approval queue: waiting time = time since verified_at; the oldest is on the tile; a result without it shows a dash', async () => {
    const { container } = await approve.mount([row(1, 1, { result: { status: 'verified', verified_at: ago(135) } }), row(2, 2, { result: { status: 'verified', verified_at: ago(20) } }), row(3, 3, { result: { status: 'verified' } })]);
    const wait = (r: number) => norm([...itemOf(container, reg(r))!.closest('tr')!.querySelectorAll('td')].at(-1)!.textContent);
    expect(hasAge(wait(1), 135)).toBe(true);
    expect(hasAge(wait(2), 20)).toBe(true);
    expect(wait(3)).toBe('—');
    expect(hasAge(tileMap(container)['Oldest wait']!, 135)).toBe(true);
  });
  it('verification queue: the contract has no timestamp, so the wait is a dash everywhere and the tile too (no invented time)', async () => {
    const { container } = await verify.mount([row(1, 1), row(2, 2)]);
    expect(norm([...itemOf(container, reg(1))!.closest('tr')!.querySelectorAll('td')].at(-1)!.textContent)).toBe('—');
    expect(tileMap(container)['Oldest wait']).toBe('—');
  });
});

describe('T0D-UICONSOLE-2 verification: flags, bulk and acknowledgement (no change to the rules)', () => {
  const [verify] = MODES;
  it('a flagged registration cannot be ticked (disabled with its reason), but opens: its flags need an acknowledgement ticked in the detail before Verify is enabled', async () => {
    const user = userEvent.setup();
    const { container } = await verify.mount([row(1, 1), row(2, 2, { result: { flag: 'H', ...DELTA_FAIL } })]);
    expect(tick(container, reg(2)).disabled).toBe(true);
    expect(tick(container, reg(1)).disabled).toBe(false);
    pickItem(container, reg(2));
    const primary = () => barBtn(container, /^Verify 1 \(V\)$/);
    expect(primary().disabled).toBe(true);
    await user.click(within(resultRow(container, 'AN2')).getByRole('checkbox', { name: /acknowledge delta/i }));
    expect(primary().disabled).toBe(false);
    await user.click(primary());
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]!.body.items).toEqual([{ id: id(2), version: 1, acknowledged_flags: ['delta'] }]);
    expect(posts()[0]!.url.pathname).toBe('/v1/lab/results/bulk-verify');
  });

  it('Verify on the selected unflagged registration sends all of its results in ONE request with no flag list', async () => {
    const user = userEvent.setup();
    const { container } = await verify.mount([row(1, 1), row(2, 1), row(3, 2)]);
    pickItem(container, reg(1));
    await user.click(barBtn(container, /^Verify 2 \(V\)$/));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]!.body.items).toEqual([{ id: id(1), version: 1 }, { id: id(2), version: 1 }]);
    expect(await screen.findByRole('dialog')).toBeTruthy(); // outcome dialog; closing it refreshes the list
  });

  it('ticked registrations win over the selected one; the primary counts their results', async () => {
    const user = userEvent.setup();
    const { container } = await verify.mount([row(1, 1), row(2, 1), row(3, 2), row(4, 3)]);
    pickItem(container, reg(3));
    await user.click(tick(container, reg(1)));
    await user.click(tick(container, reg(2)));
    await user.click(barBtn(container, /^Verify 3 \(V\)$/));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]!.body.items.map((i: any) => i.id).sort()).toEqual([id(1), id(2), id(3)]);
  });

  it('Select all unflagged: ONE confirm names the registrations and results, skips every flagged one (flag H without a needed ack too), Confirm sends ONE request', async () => {
    const user = userEvent.setup();
    const { container } = await verify.mount([row(1, 1), row(2, 1), row(3, 2, { result: { flag: 'H' } }), row(4, 3), row(5, 4, { result: { ...DELTA_FAIL } }), row(6, 5, { result: { critical: { is_critical: true } } })]);
    await user.click(barBtn(container, /^Select all unflagged \(S\)$/));
    const dlg = await screen.findByRole('dialog');
    expect(dlg.textContent).toMatch(/2 registrations/);
    expect(dlg.textContent).toMatch(/3 results/);
    expect(posts()).toHaveLength(0);
    await user.click(within(dlg).getByRole('button', { name: /^confirm$/i }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]!.body.items.map((i: any) => i.id).sort()).toEqual([id(1), id(2), id(4)]);
    for (const i of posts()[0]!.body.items) expect(i.acknowledged_flags).toBeUndefined();
  });

  it('Select all unflagged then Cancel sends nothing and ticks nothing', async () => {
    const user = userEvent.setup();
    const { container } = await verify.mount([row(1, 1), row(2, 2)]);
    await user.click(barBtn(container, /^Select all unflagged/));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /^cancel$/i }));
    expect(posts()).toHaveLength(0);
    expect(tick(container, reg(1)).checked).toBe(false);
  });

  it('Select all unflagged with nothing unflagged is disabled (the reason is the empty confirm, never a hidden control)', async () => {
    const { container } = await verify.mount([row(1, 1, { result: { flag: 'LL' } })]);
    expect(barBtn(container, /^Select all unflagged/).disabled).toBe(true);
  });

  it('more than 200 ticked results are sent in chunks of at most 200, one Idempotency-Key each (the old bulk rule is kept)', async () => {
    const user = userEvent.setup();
    const rows = Array.from({ length: 250 }, (_, i) => row(i + 1, i + 1));
    const { container } = await verify.mount(rows);
    await user.click(barBtn(container, /^Select all unflagged/));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /^confirm$/i }));
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(posts().map((p) => p.body.items.length).sort((a, b) => a - b)).toEqual([50, 200]);
  });
});

describe('T0D-UICONSOLE-2 verification levels (T0D-VERLEVEL-1) inside the console', () => {
  const lvl = (n: number, r: number, required: number, count: number, next: 'verify' | 'approve' | 'none') => row(n, r, { result: { signoff_required: required, signoff_count: count, next_step: next } });
  it.each(MODES)('$mode: the queue row says who is next and the detail row has the chip as a button', async (m) => {
    const { container } = await m.mount([lvl(1, 1, 2, 1, 'approve')]);
    expect(norm(itemOf(container, reg(1))!.closest('tr')!.textContent)).toMatch(/Needs pathologist/);
    pickItem(container, reg(1));
    expect(within(resultRow(container, 'AN1')).getByRole('button', { name: 'Signed 1 of 2' })).toBeTruthy();
  });

  it.each(MODES)('$mode: a registration the signed in person already signed is read only in the queue with the reason; Select all skips it; it is never sent', async (m) => {
    const user = userEvent.setup();
    signoffs[id(1)] = [signoffRow(1, ME, 'Synthetic Me')];
    signoffs[id(2)] = [signoffRow(1, OTHER, 'Synthetic Signer One')];
    const rows = [lvl(1, 1, 2, 1, 'approve'), lvl(2, 2, 2, 1, 'approve')];
    const { container } = await m.mount(rows, { currentUserId: ME });
    const mineRow = () => itemOf(container, reg(1))!.closest('tr')!;
    await waitFor(() => expect(mineRow().getAttribute('aria-disabled')).toBe('true'));
    expect(within(mineRow()).getByText(/you already signed this result/i)).toBeTruthy();
    expect(tick(container, reg(1)).disabled).toBe(true);
    expect(itemOf(container, reg(2))!.closest('tr')!.getAttribute('aria-disabled')).not.toBe('true');
    expect(Number(getComputedStyle(mineRow()).opacity)).toBeLessThan(1);
    expect(itemOf(container, reg(1))).toBeTruthy(); // dimmed, not hidden
    await user.click(barBtn(container, /^Select all unflagged/));
    const dlg = await screen.findByRole('dialog');
    expect(dlg.textContent).toMatch(/1 registrations?/);
    await user.click(within(dlg).getByRole('button', { name: /^confirm$/i }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]!.body.items.map((i: any) => i.id)).toEqual([id(2)]);
  });

  it.each(MODES)('$mode: selecting the dimmed registration shows it read only: the primary is disabled, the reason is written in the bar', async (m) => {
    signoffs[id(1)] = [signoffRow(1, ME, 'Synthetic Me')];
    const { container } = await m.mount([lvl(1, 1, 2, 1, 'approve')], { currentUserId: ME });
    await waitFor(() => expect(itemOf(container, reg(1))!.closest('tr')!.getAttribute('aria-disabled')).toBe('true'));
    pickItem(container, reg(1));
    expect(barBtn(container, new RegExp(`^${m.verb}( \\d+)? \\(${m.key}\\)$`)).disabled).toBe(true);
    expect(norm(bar(container).textContent)).toMatch(/you already signed this result/i);
  });

  it.each(MODES)('$mode: a refusal comes back in words per result (outcome dialog), never the raw code', async (m) => {
    const user = userEvent.setup();
    api.use(http.post(`${ORIGIN}/v1/lab/results/bulk-${m.mode}`, async ({ request }) => {
      const b: any = await request.clone().json();
      return HttpResponse.json({ results: b.items.map((i: any) => ({ id: i.id, outcome: 'error', code: 'lab.pathologist_required' })) });
    }));
    const { container } = await m.mount([row(1, 1), row(2, 1)]);
    pickItem(container, reg(1));
    await user.click(barBtn(container, new RegExp(`^${m.verb} 2 \\(${m.key}\\)$`)));
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getByText(/0 done, 2 not done/)).toBeTruthy();
    expect(dlg.textContent).not.toMatch(/lab\.|common\./);
    expect(dlg.textContent).toMatch(/pathologist/i);
  });
});

describe('T0D-UICONSOLE-2 approval: step-up and critical values keep working', () => {
  const [, approve] = MODES;
  it('403 auth.mfa_required shows the warning banner with Verify now above the console; the same request is re-sent after the step-up', async () => {
    const user = userEvent.setup();
    let n = 0;
    api.use(http.post(`${ORIGIN}/v1/lab/results/bulk-approve`, async ({ request }) => {
      n += 1;
      const b: any = await request.clone().json();
      if (n === 1) return HttpResponse.json({ type: 'about:blank', title: 'mfa', status: 403, code: 'auth.mfa_required' }, { status: 403, headers: { 'content-type': 'application/problem+json' } });
      return okAll(b);
    }));
    const onStepUp = vi.fn();
    const { container } = await approve.mount([row(1, 1, { result: { status: 'verified' } })], { onStepUp });
    pickItem(container, reg(1));
    await user.click(barBtn(container, /^Approve 1 \(A\)$/));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/second check/i);
    await user.click(within(alert).getByRole('button', { name: /verify now/i }));
    await waitFor(() => expect(onStepUp).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(n).toBe(2));
  });

  it('a critical result that lacks its notification is refused in words with the link to the critical value', async () => {
    const user = userEvent.setup();
    api.use(http.post(`${ORIGIN}/v1/lab/results/bulk-approve`, async ({ request }) => {
      const b: any = await request.clone().json();
      return HttpResponse.json({ results: b.items.map((i: any) => ({ id: i.id, outcome: 'error', code: 'lab.critical_ack_required' })) });
    }));
    const { container } = await approve.mount([row(1, 1, { result: { status: 'verified', critical: { is_critical: true, critical_event_id: id(900) } } })]);
    pickItem(container, reg(1));
    await user.click(barBtn(container, /^Approve 1 \(A\)$/));
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getByRole('link', { name: /open critical value/i }).getAttribute('href')).toBe(`/lab/critical-values/${id(900)}`);
  });
});

describe.each([
  ['verification', () => import('@/app/(staff)/lab/verification/page'), 'lab.nav.verification', VERIFY],
  ['approval', () => import('@/app/(staff)/lab/approval/page'), 'lab.nav.approval', APPROVE],
] as const)('T0D-UICONSOLE-2 %s page: pending operation and failures', (_n, load, key, perms) => {
  const run = async () => {
    session.perms = [...perms];
    const mod = await load();
    return (mod.default as (p: never) => Promise<ReactNode>)({ searchParams: Promise.resolve({}) } as never);
  };
  it('501 operation_pending: NotAvailable under the menu title, the queue header row stays, no red error', async () => {
    answer = 501;
    const { container } = render(<ToastProvider>{await run()}</ToastProvider>);
    await screen.findByText(/not available yet/i);
    expect(titles(container)).toEqual([t(key)]);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.body.textContent).not.toMatch(/something went wrong/i);
    expect(listHeaders(container)).toEqual(HEADERS);
    expect(filterBars(container)).toHaveLength(1);
  });
  it('500 is still an error: the page throws to error.tsx', async () => {
    answer = 500;
    await expect(run()).rejects.toBeTruthy();
  });
});

describe.each([
  ['verification', () => import('@/app/(staff)/lab/verification/error'), 'lab.nav.verification'],
  ['approval', () => import('@/app/(staff)/lab/approval/error'), 'lab.nav.approval'],
])('T0D-UICONSOLE-2 %s error.tsx (rule 6)', (_n, load, key) => {
  it('keeps the page title, shows the reference and Retry, never the message', async () => {
    const reset = vi.fn();
    const Boundary = (await load()).default as (p: { error: Error & { digest?: string }; reset: () => void }) => ReactNode;
    const { container } = render(<Boundary error={Object.assign(new Error('boom secret detail'), { digest: 'dig-123' })} reset={reset} />);
    expect(titles(container)).toEqual([t(key)]);
    expect(document.body.textContent).toContain('dig-123');
    expect(document.body.textContent).not.toContain('boom secret detail');
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(reset).toHaveBeenCalledTimes(1);
  });
});
