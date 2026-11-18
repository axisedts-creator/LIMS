// @vitest-environment jsdom
// T0D-VERLEVEL-1 (LD-316, LD-318 follow-up 4, LD-353) — verification and approval queues show who has signed.
// Contract: ResultDto (inside every queue row) now carries signoff_count 0..3, signoff_required 1..3, next_step verify | approve | none (contracts/openapi/lab.yaml);
// getResultSignoffs = GET /v1/lab/results/{id}/signoffs -> { data: ResultSignoff[] } (name, title, role code, time, signer_user_id); bulk verify / approve answer per id with the three new
// codes lab.verifier_not_distinct (409), lab.enterer_cannot_verify (403), lab.pathologist_required (403) (contracts/errors.yaml). Synthetic data only.
//
// ASSUMED prop/UI contract (the writer matches it or disputes through the ruling flow):
//   VerificationQueue({ items, permissions, currentUserId? }) and ApprovalQueue({ items, permissions, currentUserId?, onStepUp? }); currentUserId = the signed in person's user id (signer_user_id of
//   their own sign-offs). The page passes it (apps/web/src/app/(staff)/lab/{verification,approval}/page.tsx; the actor has only membershipId today, see the notes file).
//   Every row whose result has signoff fields shows a chip with the exact text "Signed {signoff_count} of {signoff_required}" INSIDE a button (so the keyboard can reach it) and a next step label:
//   next_step verify = "Needs verifier", approve = "Needs pathologist", none = "Ready". Rows without the fields (old data) show neither and nothing breaks.
//   Opening the chip button (click, or Enter / Space on it) shows the sign-off list of that row: one list item per signer with name, title, role and time ("YYYY-MM-DD HH:MM UTC").
//   Rows with signoff_count > 0 load GET .../signoffs (once per row); rows with 0 sign-offs never call it. The list is plain text (no markup from signer names).
//   A row the signed in person already signed (their id is a signer_user_id of that row) is dimmed: aria-disabled="true" on the row, the selection box disabled, the visible reason "You already signed this result",
//   the row is skipped by "Select all", and no request is ever sent for it. The row stays visible with its chip.
//   Refusals are explained in words in the outcome dialog (one line per failed result with the registration number); raw codes are never shown.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { ReactNode } from 'react';
import { ToastProvider } from '@lims/ui/components/Toast';
import { VerificationQueue } from '../components/VerificationQueue';
import { ApprovalQueue } from '../components/ApprovalQueue';

const push = vi.fn();
const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh, back: vi.fn() }),
  usePathname: () => '/lab/verification',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: [], displayName: 'Synthetic Tech', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/lab/verification',
}));
const ORIGIN = 'http://api.test';
process.env.LIMS_ORIGIN_API = ORIGIN;

const id = (n: number) => `01a1a98a-ac40-7000-8000-${String(n).padStart(12, '0')}`;
const ME = id(7001), OTHER = id(7002), THIRD = id(7003);
const VERIFY = ['lab.result.read', 'lab.result.verify'];
const APPROVE = ['lab.result.read', 'lab.result.approve'];

type Over = Record<string, unknown>;
const item = (n: number, o: { result?: Over; name?: string } = {}) => ({
  result: {
    id: id(n), version: 1, order_id: id(1000 + n), order_item_id: id(2000 + n), specimen_id: id(3000 + n), test_id: id(4000 + n), analyte_id: id(5000 + n),
    analyte_code: `AN${n}`, status: 'resulted', origin: 'manual', value_numeric: '5.4', unit_code: 'mmol_l', flag: 'N',
    range_unavailable_age_unknown: false, critical: { is_critical: false }, on_hold: false, qc_review_required: false, unit_mismatch: false,
    current_version_no: 1, delta: { status: 'pass' }, instrument_flags: [], ...o.result,
  },
  registration_no: `REG${String(n).padStart(4, '0')}`,
  barcode: `SYN${String(n).padStart(6, '0')}`,
  patient_display: { full_name: o.name ?? `Synthetic Patient ${n}`, age_sex: '40Y M', patient_code: `P${n}` },
  priority: 'routine',
});
const lvl = (n: number, required: number, count: number, next: 'verify' | 'approve' | 'none', over: Over = {}) => item(n, { result: { signoff_required: required, signoff_count: count, next_step: next, ...over } });
const signoff = (seq: number, by: string, name: string, o: Over = {}) => ({
  result_version: 1, seq, action: 'verify', signer_user_id: by, signer_display_name: name, signer_title: 'Senior Technologist', signer_role_code: 'technologist', signer_is_pathologist: false,
  signed_at: '2026-11-17T04:15:00.000Z', ...o,
});

const calls: { method: string; url: URL; headers: Headers; body?: any }[] = [];
const rec = async (r: Request) => { calls.push({ method: r.method, url: new URL(r.url), headers: r.headers, body: r.method === 'GET' ? undefined : await r.clone().json().catch(() => undefined) }); };
const problem = (status: number, code: string) => HttpResponse.json({ type: 'about:blank', title: code, status, code }, { status, headers: { 'content-type': 'application/problem+json' } });
const okAll = (body: any) => HttpResponse.json({ results: body.items.map((i: any) => ({ id: i.id, outcome: 'ok' })) });
let verifyReply: (b: any) => Response | Promise<Response> = okAll;
let approveReply: (b: any) => Response | Promise<Response> = okAll;
let signoffs: Record<string, unknown[]> = {};
let signoffStatus = 200;
const api = setupServer(
  http.post(`${ORIGIN}/v1/lab/results/bulk-verify`, async ({ request }) => { await rec(request); return verifyReply(await request.clone().json()); }),
  http.post(`${ORIGIN}/v1/lab/results/bulk-approve`, async ({ request }) => { await rec(request); return approveReply(await request.clone().json()); }),
  http.get(`${ORIGIN}/v1/lab/results/:rid/signoffs`, async ({ request, params }) => {
    await rec(request);
    if (signoffStatus !== 200) return problem(signoffStatus, 'common.internal');
    return HttpResponse.json({ data: signoffs[String(params['rid'])] ?? [] });
  }),
);
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { cleanup(); api.resetHandlers(); calls.length = 0; push.mockReset(); refresh.mockReset(); verifyReply = okAll; approveReply = okAll; signoffs = {}; signoffStatus = 200; });
afterAll(() => api.close());

const wrap = (ui: ReactNode) => render(<ToastProvider>{ui}</ToastProvider>);
// T0D-UICONSOLE-2 (LD-353 template 2 CONSOLE): one queue row per registration (checkbox "Select {reg}", the registration button, the next step label and, for a row the person already
// signed, the dimmed row with the reason); the "Signed n of m" chip button and the sign-off list sit in the detail pane of the selected registration; "Select all unflagged (S)" opens one
// confirm that sends; the primary button reads "Verify|Approve n (V|A)". Every assertion of the old flat table is kept and asked of the console markup.
type User = ReturnType<typeof userEvent.setup>;
const queueTable = () => screen.getByRole('table', { name: /queue/i });
const resultsTable = () => screen.getByRole('table', { name: 'Results' });
const rowOf = (reg: string) => {
  const r = within(queueTable()).getAllByRole('row').find((x) => x.textContent?.includes(reg));
  if (!r) throw new Error(`no row for ${reg}`);
  return r;
};
const selectBox = (reg: string) => within(rowOf(reg)).getByRole('checkbox', { name: `Select ${reg}` }) as HTMLInputElement;
const openReg = (user: User, reg: string) => user.click(within(rowOf(reg)).getByRole('button', { name: reg }));
const bulkBtn = (verb: 'Verify' | 'Approve', n?: number) => screen.getByRole('button', { name: new RegExp(`^${verb}${n === 0 ? '' : `\\s*${n ?? '\\d+'}`}\\s*\\(${verb[0]}\\)$`, 'i') });
const signoffCalls = () => calls.filter((c) => c.method === 'GET' && c.url.pathname.endsWith('/signoffs'));
const chipBtn = async (user: User, reg: string, text: RegExp) => { await openReg(user, reg); return within(resultsTable()).getByRole('button', { name: text }); };
const outcomeDlg = () => waitFor(() => {
  const d = screen.getAllByRole('dialog').find((x) => /\d+ done, \d+ not done/.test(x.textContent ?? ''));
  if (!d) throw new Error('no outcome dialog yet');
  return d;
});
/** "Select all unflagged (S)" opens ONE confirm; Confirm sends. */
const selectAllUnflagged = async (user: User) => {
  await user.click(screen.getByRole('button', { name: /^select all unflagged/i }));
  await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /^confirm$/i }));
};

const QUEUES = [
  ['verification queue', (items: any[], extra: Over = {}) => wrap(<VerificationQueue items={items} permissions={VERIFY} {...extra} />), 'Verify' as const, VERIFY],
  ['approval queue', (items: any[], extra: Over = {}) => wrap(<ApprovalQueue items={items} permissions={APPROVE} {...extra} />), 'Approve' as const, APPROVE],
] as const;

describe.each(QUEUES)('T0D-VERLEVEL-1 %s — chip and next step', (_name, mount) => {
  it.each([
    ['level 1, nobody yet', 1, 0, 'approve', 'Signed 0 of 1', 'Needs pathologist'],
    ['level 2, nobody yet', 2, 0, 'verify', 'Signed 0 of 2', 'Needs verifier'],
    ['level 2, one signed', 2, 1, 'approve', 'Signed 1 of 2', 'Needs pathologist'],
    ['level 3, one signed', 3, 1, 'verify', 'Signed 1 of 3', 'Needs verifier'],
    ['level 3, two signed', 3, 2, 'approve', 'Signed 2 of 3', 'Needs pathologist'],
    ['level 3, all signed', 3, 3, 'none', 'Signed 3 of 3', 'Ready'],
  ] as const)('%s: chip and next step label', async (_t, required, count, next, chip, step) => {
    const user = userEvent.setup();
    mount([lvl(1, required, count, next)]);
    const row = rowOf('REG0001'); // queue row: next step
    expect(within(row).getByText(step)).toBeTruthy();
    for (const other of ['Needs verifier', 'Needs pathologist', 'Ready'].filter((x) => x !== step)) expect(within(row).queryByText(other)).toBeNull();
    await openReg(user, 'REG0001'); // detail row: the chip (a button) and the same next step
    expect(within(resultsTable()).getByText(chip)).toBeTruthy();
    expect(within(resultsTable()).getByText(step)).toBeTruthy();
    for (const other of ['Needs verifier', 'Needs pathologist', 'Ready'].filter((x) => x !== step)) expect(within(resultsTable()).queryByText(other)).toBeNull();
  });

  it('every row has its own chip: a mixed page shows each row\'s own count, level and next step', async () => {
    const user = userEvent.setup();
    mount([lvl(1, 2, 0, 'verify'), lvl(2, 3, 2, 'approve'), lvl(3, 1, 0, 'approve')]);
    expect(within(rowOf('REG0001')).getByText('Needs verifier')).toBeTruthy();
    expect(within(rowOf('REG0002')).getByText('Needs pathologist')).toBeTruthy();
    expect(within(rowOf('REG0003')).getByText('Needs pathologist')).toBeTruthy();
    await openReg(user, 'REG0001');
    expect(within(resultsTable()).getByText('Signed 0 of 2')).toBeTruthy();
    await openReg(user, 'REG0002');
    expect(within(resultsTable()).getByText('Signed 2 of 3')).toBeTruthy();
    await openReg(user, 'REG0003');
    expect(within(resultsTable()).getByText('Signed 0 of 1')).toBeTruthy();
  });

  it('old rows without the three fields still render: no chip, no next step, no crash, no sign-off request', async () => {
    const user = userEvent.setup();
    mount([item(1)]);
    const row = rowOf('REG0001');
    expect(within(row).getByText(/Synthetic Patient 1/)).toBeTruthy();
    expect(row.textContent).not.toMatch(/Signed \d+ of \d+|Needs verifier|Needs pathologist/);
    await openReg(user, 'REG0001');
    expect(within(resultsTable()).getByText(/AN1/)).toBeTruthy();
    expect(resultsTable().textContent).not.toMatch(/Signed \d+ of \d+|Needs verifier|Needs pathologist/);
    expect(signoffCalls()).toHaveLength(0);
  });

  it('a row with signoff fields does not break the existing selection and bulk behaviour (button shows the count)', async () => {
    const user = userEvent.setup();
    mount([lvl(1, 2, 0, 'verify'), lvl(2, 2, 0, 'verify')]);
    await user.click(selectBox('REG0001'));
    expect((screen.getAllByRole('button').find((b) => /^(verify|approve)\s*1\s*\([va]\)$/i.test(b.textContent ?? '')) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe.each(QUEUES)('T0D-VERLEVEL-1 %s — who signed', (_name, mount) => {
  it('opening the chip lists each signer with name, title, role and time; the list comes from GET /results/{id}/signoffs with the bearer token', async () => {
    const user = userEvent.setup();
    signoffs[id(1)] = [signoff(1, OTHER, 'Synthetic Signer One'), signoff(2, THIRD, 'Synthetic Signer Two', { signer_title: 'Consultant Pathologist', signer_role_code: 'pathologist', signer_is_pathologist: true, signed_at: '2026-11-17T09:30:00.000Z', action: 'approve' })];
    mount([lvl(1, 3, 2, 'approve')]);
    await user.click(await chipBtn(user, 'REG0001', /signed 2 of 3/i));
    const one =(await screen.findByText('Synthetic Signer One')).closest('li')!;
    expect(one.textContent).toContain('Senior Technologist');
    expect(one.textContent).toMatch(/technologist/);
    expect(one.textContent).toContain('2026-11-17 04:15');
    const two = screen.getByText('Synthetic Signer Two').closest('li')!;
    expect(two.textContent).toContain('Consultant Pathologist');
    expect(two.textContent).toMatch(/pathologist/i);
    expect(two.textContent).toContain('2026-11-17 09:30');
    expect(signoffCalls().filter((c) => c.url.pathname === `/v1/lab/results/${id(1)}/signoffs`).length).toBeGreaterThanOrEqual(1);
    expect(signoffCalls()[0]!.headers.get('authorization')).toBe('Bearer jwt-synthetic');
  });

  it('keyboard: the chip is a button; Enter on it opens the same list', async () => {
    const user = userEvent.setup();
    signoffs[id(1)] = [signoff(1, OTHER, 'Synthetic Signer One')];
    mount([lvl(1, 2, 1, 'approve')]);
    (await chipBtn(user, 'REG0001', /signed 1 of 2/i)).focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByText('Synthetic Signer One')).toBeTruthy();
  });

  it('only rows with sign-offs load their chain: count 0 never calls the endpoint, count > 0 calls it once per row', async () => {
    mount([lvl(1, 2, 0, 'verify'), lvl(2, 2, 1, 'approve'), lvl(3, 3, 2, 'approve')]);
    await waitFor(() => expect(signoffCalls().length).toBeGreaterThanOrEqual(2));
    await new Promise((r) => setTimeout(r, 50));
    const paths = signoffCalls().map((c) => c.url.pathname);
    expect(paths).not.toContain(`/v1/lab/results/${id(1)}/signoffs`);
    expect(paths.filter((p) => p === `/v1/lab/results/${id(2)}/signoffs`)).toHaveLength(1);
    expect(paths.filter((p) => p === `/v1/lab/results/${id(3)}/signoffs`)).toHaveLength(1);
  });

  it('XSS: a signer name that is markup stays text; no element is created from it', async () => {
    const user = userEvent.setup();
    signoffs[id(1)] = [signoff(1, OTHER, '<img src=x onerror=alert(1)>')];
    mount([lvl(1, 2, 1, 'approve')]);
    await user.click(await chipBtn(user, 'REG0001', /signed 1 of 2/i));
    expect(await screen.findByText('<img src=x onerror=alert(1)>')).toBeTruthy();
    expect(document.querySelector('img[src="x"]')).toBeNull();
  });

  it('a failing sign-off read (500) leaves the chip and next step in place; the row is still usable', async () => {
    const user = userEvent.setup();
    signoffStatus = 500;
    mount([lvl(1, 2, 1, 'approve')]);
    await waitFor(() => expect(signoffCalls().length).toBeGreaterThanOrEqual(1));
    expect(within(rowOf('REG0001')).getByText('Needs pathologist')).toBeTruthy();
    await openReg(user, 'REG0001');
    expect(within(resultsTable()).getByText('Signed 1 of 2')).toBeTruthy();
    expect(within(resultsTable()).getByText('Needs pathologist')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/common\.internal/);
  });

  it('axe: no violations with the sign-off list open', async () => {
    const user = userEvent.setup();
    signoffs[id(1)] = [signoff(1, OTHER, 'Synthetic Signer One')];
    mount([lvl(1, 2, 1, 'approve'), lvl(2, 3, 0, 'verify')]);
    await user.click(await chipBtn(user, 'REG0001', /signed 1 of 2/i));
    await screen.findByText('Synthetic Signer One');
    const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
    expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
  });
});

describe.each(QUEUES)('T0D-VERLEVEL-1 %s — rows the signed in person already signed', (_name, mount, verb) => {
  it('is dimmed with the reason in words, cannot be selected, and Select all skips it; the other row works', async () => {
    const user = userEvent.setup();
    signoffs[id(1)] = [signoff(1, ME, 'Synthetic Me')];
    signoffs[id(2)] = [signoff(1, OTHER, 'Synthetic Signer One')];
    mount([lvl(1, 2, 1, 'approve'), lvl(2, 2, 1, 'approve')], { currentUserId: ME });
    await waitFor(() => expect(rowOf('REG0001').getAttribute('aria-disabled')).toBe('true'));
    const mine = rowOf('REG0001');
    expect(within(mine).getByText(/you already signed this result/i)).toBeTruthy();
    expect(within(mine).getByText('Needs pathologist')).toBeTruthy(); // dimmed, not hidden
    await openReg(user, 'REG0001'); // its detail stays reachable with the chip
    expect(within(resultsTable()).getByText('Signed 1 of 2')).toBeTruthy();
    expect((selectBox('REG0001') as HTMLInputElement).disabled).toBe(true);
    expect(rowOf('REG0002').getAttribute('aria-disabled')).not.toBe('true');
    expect(within(rowOf('REG0002')).queryByText(/you already signed/i)).toBeNull();
    // Review item 1: the dim must be a real style (no stylesheet defines .lims-row-dim), not only a class name.
    expect(Number(getComputedStyle(mine).opacity)).toBeLessThan(1);
    expect(Number(getComputedStyle(mine).opacity)).toBeGreaterThan(0);
    expect(getComputedStyle(rowOf('REG0002')).opacity).not.toBe('0.55');
    // "Select all unflagged" skips the dimmed row: the one confirm counts only REG0002 (1 registration, 1 result); cancelled, nothing is ticked or sent
    await user.click(screen.getByRole('button', { name: /^select all unflagged/i }));
    const dlg = await screen.findByRole('dialog');
    expect(dlg.textContent).toMatch(/1 registrations, 1 results/);
    await user.click(within(dlg).getByRole('button', { name: /^cancel$/i }));
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    expect((selectBox('REG0001') as HTMLInputElement).checked).toBe(false);
    // ticking the other row works and the primary button counts only it
    await user.click(selectBox('REG0002'));
    expect(bulkBtn(verb, 1)).toBeTruthy();
    expect((selectBox('REG0002') as HTMLInputElement).checked).toBe(true);
    expect((selectBox('REG0001') as HTMLInputElement).checked).toBe(false);
  });

  it('the bulk call never carries the dimmed row', async () => {
    const user = userEvent.setup();
    signoffs[id(1)] = [signoff(1, ME, 'Synthetic Me')];
    signoffs[id(2)] = [signoff(1, OTHER, 'Synthetic Signer One')];
    mount([lvl(1, 2, 1, 'approve'), lvl(2, 2, 1, 'approve')], { currentUserId: ME });
    await waitFor(() => expect(rowOf('REG0001').getAttribute('aria-disabled')).toBe('true'));
    await selectAllUnflagged(user);
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1));
    expect(calls.find((c) => c.method === 'POST')!.url.pathname).toBe(`/v1/lab/results/bulk-${verb.toLowerCase()}`);
    expect(calls.find((c) => c.method === 'POST')!.body.items.map((i: any) => i.id)).toEqual([id(2)]);
  });

  it('without currentUserId nothing is dimmed (the server still refuses with lab.verifier_not_distinct)', async () => {
    signoffs[id(1)] = [signoff(1, ME, 'Synthetic Me')];
    mount([lvl(1, 2, 1, 'approve')]);
    await waitFor(() => expect(signoffCalls().length).toBeGreaterThanOrEqual(1));
    expect(rowOf('REG0001').getAttribute('aria-disabled')).not.toBe('true');
  });

  it('a row only someone else signed is not dimmed for me', async () => {
    signoffs[id(1)] = [signoff(1, OTHER, 'Synthetic Signer One', { result_version: 1 })];
    mount([lvl(1, 2, 1, 'approve')], { currentUserId: ME });
    await waitFor(() => expect(signoffCalls().length).toBeGreaterThanOrEqual(1));
    expect(rowOf('REG0001').getAttribute('aria-disabled')).not.toBe('true');
  });
});

describe.each(QUEUES)('T0D-VERLEVEL-1 %s — refusals explained in words (bulk, per result)', (_name, mount, verb) => {
  const reply = (r: (b: any) => Response | Promise<Response>) => { if (verb === 'Verify') verifyReply = r; else approveReply = r; };

  it('lab.verifier_not_distinct, lab.enterer_cannot_verify and lab.pathologist_required each get their own plain sentence with the registration number; no raw code is shown', async () => {
    const user = userEvent.setup();
    const codes = ['lab.verifier_not_distinct', 'lab.enterer_cannot_verify', 'lab.pathologist_required'];
    reply((b) => HttpResponse.json({ results: b.items.map((i: any, k: number) => ({ id: i.id, outcome: 'error', code: codes[k] })) }));
    mount([lvl(1, 2, 0, 'verify'), lvl(2, 2, 0, 'verify'), lvl(3, 2, 1, 'approve')]);
    await selectAllUnflagged(user);
    const dlg = await outcomeDlg();
    expect(within(dlg).getByText(/0 done, 3 not done/)).toBeTruthy();
    expect(dlg.textContent).not.toMatch(/lab\.|common\./);
    const lines = within(dlg).getAllByRole('listitem').map((l) => l.textContent ?? '');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('REG0001');
    expect(lines[0]).toMatch(/already signed/i);
    expect(lines[1]).toContain('REG0002');
    expect(lines[1]).toMatch(/entered/i);
    expect(lines[2]).toContain('REG0003');
    expect(lines[2]).toMatch(/pathologist/i);
    expect(new Set(lines.map((l) => l.replace(/REG\d+|Synthetic Patient \d+|AN\d+/g, '').trim())).size).toBe(3);
  });

  it('a mixed batch lists only the failed results, each with its own reason, and counts the rest as done', async () => {
    const user = userEvent.setup();
    reply((b) => HttpResponse.json({ results: b.items.map((i: any, k: number) => (k === 1 ? { id: i.id, outcome: 'error', code: 'lab.pathologist_required' } : { id: i.id, outcome: 'ok' })) }));
    mount([lvl(1, 2, 0, 'verify'), lvl(2, 2, 1, 'approve'), lvl(3, 2, 0, 'verify')]);
    await selectAllUnflagged(user);
    const dlg = await outcomeDlg();
    expect(within(dlg).getByText(/2 done, 1 not done/)).toBeTruthy();
    const lines = within(dlg).getAllByRole('listitem');
    expect(lines).toHaveLength(1);
    expect(lines[0]!.textContent).toContain('REG0002');
    expect(lines[0]!.textContent).toMatch(/pathologist/i);
  });
});
