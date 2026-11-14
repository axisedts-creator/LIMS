// @vitest-environment jsdom
// C13.T16 — SP-1 Partners, SP-2 Partner detail, SP-3 Partner users, SS-1 Settings (04-UI-UX §4). ACs: US-01.1 (create), .2 (code_duplicate), .3 (other-tenant credit party -> 404),
// .4 (aal1 -> auth.mfa_required), .5 (suspend with reason, staff can still read), .6 (credit_party_in_use). Contract: t16.harness.tsx.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { ADMIN_PERMS, BRANCH, CENTRE, CREDIT, ORIGIN, PARTNER, PERM, U, manifestSummary, page, partner, partnerSummary, partnerUser, referrer, settings } from './t16.fixtures';
import { calls, idemKey, ifMatch, noAxeViolations, of, pageModule, problem, rec, renderPage, wrap } from './t16.harness';

const session = { perms: [] as string[] };
const refresh = vi.fn();
const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh, back: vi.fn() }),
  usePathname: () => '/partners',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: session.perms, displayName: 'Synthetic Admin', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/partners',
}));

let users: unknown[] = [partnerUser(1, { partner_role: 'partner_admin' }), partnerUser(2)];
const A = `${ORIGIN}/v1/partners/admin`;
const api = setupServer(
  http.get(`${A}/partners`, async ({ request }) => { await rec(request); return HttpResponse.json(page([partnerSummary(), partnerSummary({ id: U(2), partner_code: 'SYN-LAB-02', name: 'Second Synthetic Lab', status: 'suspended' })])); }),
  http.post(`${A}/partners`, async ({ request }) => { await rec(request); return HttpResponse.json(partner(), { status: 201 }); }),
  http.get(`${A}/partners/:id`, async ({ request, params }) => { await rec(request); return params['id'] === PARTNER ? HttpResponse.json(partner()) : problem(404, 'common.not_found'); }),
  http.post(`${A}/partners/:id/suspend`, async ({ request }) => { await rec(request); return HttpResponse.json({}); }),
  http.post(`${A}/partners/:id/reactivate`, async ({ request }) => { await rec(request); return HttpResponse.json({}); }),
  http.post(`${A}/partners/:id/resync`, async ({ request }) => { await rec(request); return HttpResponse.json({}, { status: 202 }); }),
  http.get(`${A}/partners/:id/users`, async ({ request }) => { await rec(request); return HttpResponse.json(page(users)); }),
  http.post(`${A}/partners/:id/users`, async ({ request }) => { await rec(request); return HttpResponse.json(partnerUser(3, { status: 'invited' }), { status: 201 }); }),
  http.post(`${A}/partner-users/:id/role`, async ({ request }) => { await rec(request); return HttpResponse.json({}); }),
  http.post(`${A}/partner-users/:id/deactivate`, async ({ request }) => { await rec(request); return HttpResponse.json({}); }),
  http.post(`${A}/partner-users/:id/reactivate`, async ({ request }) => { await rec(request); return HttpResponse.json({}); }),
  http.get(`${A}/manifests`, async ({ request }) => { await rec(request); return HttpResponse.json(page([manifestSummary()])); }),
  http.get(`${A}/referrers`, async ({ request }) => { await rec(request); return HttpResponse.json(page([referrer()])); }),
  http.get(`${A}/settings`, async ({ request }) => { await rec(request); return HttpResponse.json(settings(), { headers: { etag: '"7"' } }); }),
  http.put(`${A}/settings`, async ({ request }) => { await rec(request); return HttpResponse.json(settings(), { headers: { etag: '"8"' } }); }),
  http.get(`${ORIGIN}/v1/catalog/credit-parties`, async ({ request }) => { await rec(request); return HttpResponse.json({ data: [{ id: CREDIT, party_code: 'CP00001', name: 'Synthetic Credit Party', kind: 'partner_lab', is_active: true }], page: { limit: 20 } }); }),
  http.get(`${ORIGIN}/v1/identity/branches`, async ({ request }) => { await rec(request); return HttpResponse.json({ data: [{ branch_id: BRANCH, code: 'B1', name: 'Synthetic Branch', is_active: true }] }); }),
  http.get(`${ORIGIN}/v1/identity/centres`, async ({ request }) => { await rec(request); return HttpResponse.json({ data: [{ centre_id: CENTRE, code: 'C000000001', name: 'Synthetic Receiving Centre', branch_id: BRANCH, is_active: true }] }); }),
);
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { cleanup(); api.resetHandlers(); calls.length = 0; refresh.mockReset(); push.mockReset(); session.perms = []; users = [partnerUser(1, { partner_role: 'partner_admin' }), partnerUser(2)]; });
afterAll(() => api.close());

const list = async (perms: string[] = ADMIN_PERMS, searchParams: Record<string, string> = {}) => { session.perms = perms; return renderPage('', { searchParams }); };
const detail = async (perms: string[] = ADMIN_PERMS) => { session.perms = perms; return renderPage('[partner_id]', { params: { partner_id: PARTNER } }); };
const pickReason = async (scope: HTMLElement, option: RegExp) => {
  await userEvent.click(within(scope).getByRole('button', { name: /reason/i }));
  await userEvent.click(await screen.findByRole('option', { name: option }));
};

describe('SP-1 list', () => {
  it('table: code (mono), name, credit party code + name, receiving centre, active users, open manifests, status chip with word; caption present', async () => {
    await list();
    for (const h of ['Code', 'Name', 'Credit party', 'Receiving centre', 'Active users', 'Open manifests', 'Status']) expect(screen.getByRole('columnheader', { name: new RegExp(h, 'i') })).toBeTruthy();
    const r = screen.getByText('SYN-LAB-01').closest('tr')!;
    expect(r.textContent).toMatch(/CP00001/);
    expect(r.textContent).toMatch(/Synthetic Credit Party/);
    expect(r.textContent).toMatch(/Synthetic Receiving Centre/);
    expect(within(r).getByText(/^active$/i)).toBeTruthy();
    expect(within(screen.getByText('SYN-LAB-02').closest('tr')!).getByText(/^suspended$/i)).toBeTruthy();
    expect(screen.getByRole('grid', { name: /\S/ })).toBeTruthy(); // kit DataTable `caption` prop = accessible table name (C0 04-UI-UX:196; C13 04-UI-UX:257)
    expect(within(r).getByRole('link', { name: /Synthetic Partner Lab|SYN-LAB-01/ }).getAttribute('href')).toBe(`/partners/${PARTNER}`);
  });

  it('filters travel to the API: status + q (≤ 64) from the URL; default sends no status', async () => {
    await list(ADMIN_PERMS, { status: 'suspended', q: 'SYN' });
    const g = of('GET', /\/admin\/partners$/)[0]!;
    expect(g.url.searchParams.get('status')).toBe('suspended');
    expect(g.url.searchParams.get('q')).toBe('SYN');
  });

  it('empty -> EmptyState "No partners"; API 500 -> alert banner (not a blank table, not a throw); no permission -> permission text and no API call', async () => {
    api.use(http.get(`${A}/partners`, () => HttpResponse.json(page([]))));
    await list();
    expect(screen.getByText(/no partners/i)).toBeTruthy();
    cleanup();
    api.use(http.get(`${A}/partners`, () => problem(500, 'common.internal')));
    await list();
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    cleanup(); calls.length = 0;
    await list([]);
    expect(screen.getByText(/permission/i)).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it('"New partner" is the single primary button and only shows with partners.partner.manage', async () => {
    await list([PERM.read]);
    expect(screen.queryByRole('button', { name: /new partner/i })).toBeNull();
    cleanup();
    await list();
    expect(screen.getAllByRole('button', { name: /new partner/i })).toHaveLength(1);
  });

  it('no axe violations', async () => {
    await list();
    await noAxeViolations();
  });
});

describe('SP-1 New partner dialog (US-01.1–.6)', () => {
  async function fill(user: ReturnType<typeof userEvent.setup>, code = 'syn-new_1') {
    await user.click(screen.getAllByRole('button', { name: /new partner/i })[0]!);
    const dlg = await screen.findByRole('dialog');
    await user.type(within(dlg).getByLabelText(/partner code/i), code);
    await user.tab(); // blur -> uppercase
    await user.type(within(dlg).getByLabelText(/^name/i), 'Synthetic New Lab');
    const cp = within(dlg).getByRole('combobox', { name: /credit party/i });
    await user.type(cp, 'CP0');
    await user.click(await screen.findByRole('option', { name: /CP00001/ }));
    await user.click(within(dlg).getByRole('button', { name: /receiving branch/i }));
    await user.click(await screen.findByRole('option', { name: /Synthetic Branch/ }));
    await user.click(within(dlg).getByRole('button', { name: /receiving centre/i }));
    await user.click(await screen.findByRole('option', { name: /Synthetic Receiving Centre/ }));
    return dlg;
  }
  const submit = (dlg: HTMLElement) => userEvent.click(within(dlg).getByRole('button', { name: /^(create|save|add)/i }));

  it('code is upper-cased on blur; order creation defaults to "When the lab receives the samples"; fields have the spec max lengths', async () => {
    await list();
    const user = userEvent.setup({ delay: null });
    const dlg = await fill(user);
    expect((within(dlg).getByLabelText(/partner code/i) as HTMLInputElement).value).toBe('SYN-NEW_1');
    expect((within(dlg).getByLabelText(/partner code/i) as HTMLInputElement).maxLength).toBe(20);
    expect((within(dlg).getByLabelText(/^name/i) as HTMLInputElement).maxLength).toBe(160);
    expect((within(dlg).getByRole('radio', { name: /when the lab receives the samples/i }) as HTMLInputElement).checked).toBe(true);
    expect(within(dlg).getByRole('radio', { name: /as soon as the partner submits/i })).toBeTruthy();
  });

  it('invalid code (^[A-Z0-9_-]{1,20}$) is refused client-side: no POST', async () => {
    await list();
    const user = userEvent.setup({ delay: null });
    const dlg = await fill(user, 'bad code!');
    await submit(dlg);
    expect(of('POST', /\/admin\/partners$/)).toHaveLength(0);
    expect(within(dlg).getByText(/letters|digits|code/i, { selector: '[role=alert], .lims-field-error, [id$=error]' })).toBeTruthy();
  });

  it('US-01.1: POST body = code, name, credit_party_id, receiving_branch_id, receiving_centre_id, conversion_mode; Idempotency-Key; credit party looked up by code prefix via C3', async () => {
    await list();
    const user = userEvent.setup({ delay: null });
    const dlg = await fill(user);
    await submit(dlg);
    await waitFor(() => expect(of('POST', /\/admin\/partners$/)).toHaveLength(1));
    const c = of('POST', /\/admin\/partners$/)[0]!;
    expect(c.body).toMatchObject({ partner_code: 'SYN-NEW_1', name: 'Synthetic New Lab', credit_party_id: CREDIT, receiving_branch_id: BRANCH, receiving_centre_id: CENTRE, conversion_mode: 'on_receipt' });
    expect(idemKey(c)).toMatch(/\S{8,}/);
    expect(of('GET', /\/v1\/catalog\/credit-parties$/).at(-1)!.url.searchParams.get('q')?.length).toBeLessThanOrEqual(20);
    await waitFor(() => expect(refresh.mock.calls.length + push.mock.calls.length).toBeGreaterThan(0));
  });

  it.each([
    ['US-01.2', 409, 'partners.code_duplicate', /already (exists|in use|used)|duplicate|taken/i],
    ['US-01.6', 409, 'partners.credit_party_in_use', /credit party.*(already|in use|linked|used)|already.*credit party/i],
    ['US-01.3', 404, 'common.not_found', /not found|no longer|doesn.t exist|not available/i],
    ['US-01.4', 403, 'auth.mfa_required', /second (sign-in )?step|two-step|multi-?factor|mfa|verify/i],
  ])('%s: %i %s -> plain-words message in the dialog (no raw code), dialog stays open, no navigation', async (_ac, status, code, re) => {
    api.use(http.post(`${A}/partners`, async ({ request }) => { await rec(request); return problem(status as number, code as string); }));
    await list();
    const user = userEvent.setup({ delay: null });
    const dlg = await fill(user);
    await submit(dlg);
    const alert = await within(dlg).findByRole('alert');
    expect(alert.textContent).toMatch(re as RegExp);
    expect(alert.textContent).not.toMatch(/partners\.|auth\.|common\./);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(push).not.toHaveBeenCalled();
  });

  it('the credit-party combobox only searches after typing and never sends more than the 20-char code prefix the C3 API allows', async () => {
    await list();
    const user = userEvent.setup({ delay: null });
    await user.click(screen.getAllByRole('button', { name: /new partner/i })[0]!);
    const dlg = await screen.findByRole('dialog');
    expect(of('GET', /credit-parties$/)).toHaveLength(0);
    await user.type(within(dlg).getByRole('combobox', { name: /credit party/i }), 'X'.repeat(40));
    await waitFor(() => expect(of('GET', /credit-parties$/).length).toBeGreaterThan(0));
    for (const c of of('GET', /credit-parties$/)) expect((c.url.searchParams.get('q') ?? '').length).toBeLessThanOrEqual(20);
  });
});

describe('SP-2 detail + SP-3 users', () => {
  it('Overview: description list (code, name, credit party, centre, conversion mode, contact), projection status line, tabs Overview/Users/Manifests/Doctors', async () => {
    await detail();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(expect.arrayContaining(['Overview', 'Users', 'Manifests', 'Doctors']));
    const t = document.body.textContent ?? '';
    expect(t).toMatch(/SYN-LAB-01/);
    expect(t).toMatch(/Synthetic Credit Party/);
    expect(t).toMatch(/Prices synced/);
    expect(t).toMatch(/Statements synced/);
  });

  it('404 -> notFound(); 5xx propagates; not-found says "Partner not found"', async () => {
    session.perms = ADMIN_PERMS;
    const { default: Page } = await pageModule('[partner_id]');
    await expect(Page({ params: Promise.resolve({ partner_id: U(404) }), searchParams: Promise.resolve({}) })).rejects.toThrow('NEXT_NOT_FOUND');
    api.use(http.get(`${A}/partners/:id`, () => problem(500, 'common.internal')));
    await expect(Page({ params: Promise.resolve({ partner_id: PARTNER }), searchParams: Promise.resolve({}) })).rejects.not.toThrow('NEXT_NOT_FOUND');
    wrap(((await pageModule('[partner_id]', 'not-found')).default as () => any)());
    expect(screen.getByText(/Partner not found/)).toBeTruthy();
  });

  it('US-01.5 Suspend: ConfirmDialog requires a reason (partner_suspend_reasons seed texts) -> SA5 {reason_code} with If-Match "4"', async () => {
    await detail();
    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole('button', { name: /^suspend$/i }));
    const dlg = await screen.findByRole('dialog');
    await user.click(within(dlg).getByRole('button', { name: /^(confirm|suspend)/i }));
    expect(of('POST', /\/suspend$/)).toHaveLength(0);
    await pickReason(dlg, /^Credit hold$/);
    await user.click(within(dlg).getByRole('button', { name: /^(confirm|suspend)/i }));
    await waitFor(() => expect(of('POST', /\/suspend$/)).toHaveLength(1));
    const c = of('POST', /\/suspend$/)[0]!;
    expect(c.url.pathname).toBe(`/v1/partners/admin/partners/${PARTNER}/suspend`);
    expect(c.body.reason_code).toBe('credit_hold');
    expect(ifMatch(c)).toBe('"4"');
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('suspended partner: "Reactivate" instead of "Suspend"; data still readable (users/manifests tabs render); POST reactivate with If-Match', async () => {
    api.use(http.get(`${A}/partners/:id`, () => HttpResponse.json(partner({ status: 'suspended', suspend_reason_code: 'credit_hold' }))));
    await detail();
    expect(screen.queryByRole('button', { name: /^suspend$/i })).toBeNull();
    expect(screen.getByText(/^suspended$/i)).toBeTruthy();
    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole('button', { name: /^reactivate$/i }));
    const dlg = screen.queryByRole('dialog');
    if (dlg) await user.click(within(dlg).getByRole('button', { name: /^(confirm|reactivate)/i }));
    await waitFor(() => expect(of('POST', /\/reactivate$/)).toHaveLength(1));
    expect(ifMatch(of('POST', /\/reactivate$/)[0]!)).toBe('"4"');
  });

  it('Suspend/Reactivate/Invite/Resync need partners.partner.manage: a read-only user sees the detail but none of the actions', async () => {
    await detail([PERM.read]);
    for (const n of [/^suspend$/i, /^reactivate$/i, /invite user/i, /resync/i]) expect(screen.queryByRole('button', { name: n })).toBeNull();
    expect(document.body.textContent).toMatch(/SYN-LAB-01/);
  });

  it('Resync menu -> scopes price_list / statements / tracking -> SA7 {scopes:[...]}', async () => {
    await detail();
    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole('button', { name: /resync data/i }));
    await user.click(await screen.findByRole('menuitem', { name: /price list/i }));
    await waitFor(() => expect(of('POST', /\/resync$/)).toHaveLength(1));
    expect(of('POST', /\/resync$/)[0]!.body).toEqual({ scopes: ['price_list'] });
    await user.click(screen.getByRole('button', { name: /resync data/i }));
    for (const n of [/price list/i, /statements/i, /tracking|orders/i]) expect(await screen.findByRole('menuitem', { name: n })).toBeTruthy();
  });

  it('SP-3 Users tab: same columns as PU-1 (name, masked email, role, status, MFA, last sign-in) + Invite user / Change role / Deactivate; status shown as words', async () => {
    await detail();
    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole('tab', { name: 'Users' }));
    const r = screen.getByText('Synthetic User 2').closest('tr')!;
    expect(r.textContent).toMatch(/u2\*\*\*@partner\.invalid/);
    expect(within(r).getByText(/active/i)).toBeTruthy();
    expect(within(r).getByRole('button', { name: /change role/i })).toBeTruthy();
    expect(within(r).getByRole('button', { name: /deactivate/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /invite user/i })).toBeTruthy();
    expect(screen.queryByText(/no active administrator/i)).toBeNull();
  });

  it('SP-3 banner "This partner has no active administrator." when no active partner_admin; deactivated rows offer Reactivate', async () => {
    users = [partnerUser(1, { partner_role: 'partner_admin', status: 'deactivated' }), partnerUser(2)];
    await detail();
    await userEvent.click(screen.getByRole('tab', { name: 'Users' }));
    expect(screen.getByText('This partner has no active administrator.')).toBeTruthy();
    expect(within(screen.getByText('Synthetic User 1').closest('tr')!).getByRole('button', { name: /reactivate/i })).toBeTruthy();
  });

  it('SP-3 Invite user: SA9 {email, display_name, partner_role} + Idempotency-Key; 409 identity.user_exists -> plain message', async () => {
    await detail();
    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole('tab', { name: 'Users' }));
    await user.click(screen.getByRole('button', { name: /invite user/i }));
    const dlg = await screen.findByRole('dialog');
    await user.type(within(dlg).getByLabelText(/email/i), 'new.admin@partner.invalid');
    await user.type(within(dlg).getByLabelText(/name/i), 'Synthetic New Admin');
    await user.click(within(dlg).getByRole('radio', { name: /admin/i }));
    await user.click(within(dlg).getByRole('button', { name: /^(invite|send)/i }));
    await waitFor(() => expect(of('POST', /\/users$/)).toHaveLength(1));
    const c = of('POST', /\/users$/)[0]!;
    expect(c.body).toEqual({ email: 'new.admin@partner.invalid', display_name: 'Synthetic New Admin', partner_role: 'partner_admin' });
    expect(idemKey(c)).toMatch(/\S{8,}/);
  });

  it('SP-3 Deactivate: coded reason (partner_user_deactivate_reasons); 409 partners.last_partner_admin -> plain message', async () => {
    api.use(http.post(`${A}/partner-users/:id/deactivate`, async ({ request }) => { await rec(request); return problem(409, 'partners.last_partner_admin'); }));
    await detail();
    const user = userEvent.setup({ delay: null });
    await user.click(screen.getByRole('tab', { name: 'Users' }));
    await user.click(within(screen.getByText('Synthetic User 1').closest('tr')!).getByRole('button', { name: /deactivate/i }));
    const dlg = await screen.findByRole('dialog');
    await pickReason(dlg, /^Left organisation$/);
    await user.click(within(dlg).getByRole('button', { name: /^(confirm|deactivate)/i }));
    await waitFor(() => expect(of('POST', /\/deactivate$/)).toHaveLength(1));
    expect(of('POST', /\/deactivate$/)[0]!.body.reason_code).toBe('left_organisation');
    expect((await screen.findAllByRole('alert')).map((a) => a.textContent).join(' ')).toMatch(/last|only.*administrator|at least one/i);
  });

  it('Manifests and Doctors tabs read SI1 / SR1 filtered by this partner', async () => {
    await detail();
    expect(of('GET', /\/admin\/manifests$/)[0]!.url.searchParams.get('partner_id')).toBe(PARTNER);
    expect(of('GET', /\/admin\/referrers$/)[0]!.url.searchParams.get('partner_id')).toBe(PARTNER);
  });

  it('a failing tab read shows a banner in that tab only; the rest of the page renders', async () => {
    api.use(http.get(`${A}/partners/:id/users`, () => problem(500, 'common.internal')));
    await detail();
    expect(document.body.textContent).toMatch(/SYN-LAB-01/);
    await userEvent.click(screen.getByRole('tab', { name: 'Users' }));
    expect(screen.getByRole('alert')).toBeTruthy();
  });
});

describe('SS-1 Settings (02-TRD §10.2)', () => {
  const open = async (perms = ADMIN_PERMS) => { session.perms = perms; return renderPage('settings'); };

  it('renders every TRD §10.2 field; Patient access slips off by default; consent statement counts characters', async () => {
    await open();
    for (const l of [/default order creation/i, /show standard-rate tests/i, /require confirmed doctors/i, /patient access slips/i, /max samples per manifest/i, /draft expiry/i, /pickup days ahead/i, /daily report downloads/i, /consent text version/i, /consent statement/i])
      expect(screen.getAllByText(l).length).toBeGreaterThan(0);
    expect(screen.getByText(/Partners can print a slip with a link the patient opens with a code sent to their mobile\./)).toBeTruthy();
    expect(document.body.textContent).toMatch(/\d+\s*\/\s*2000/);
  });

  it('PUT sends the whole settings object with If-Match from the GET ETag; out-of-range value is blocked client-side', async () => {
    await open();
    const user = userEvent.setup({ delay: null });
    const draft = screen.getByLabelText(/draft expiry/i);
    await user.clear(draft);
    await user.type(draft, '91');
    await user.click(screen.getByRole('button', { name: /^save/i }));
    expect(of('PUT', /\/settings$/)).toHaveLength(0);
    await user.clear(draft);
    await user.type(draft, '30');
    await user.click(screen.getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(of('PUT', /\/settings$/)).toHaveLength(1));
    const c = of('PUT', /\/settings$/)[0]!;
    expect(ifMatch(c)).toBe('"7"');
    expect(c.body).toEqual(settings({ draft_ttl_days: 30 }));
  });

  it('409 common.version_conflict -> "changed by someone else" banner; read-only user sees values but no Save', async () => {
    api.use(http.put(`${A}/settings`, async ({ request }) => { await rec(request); return problem(409, 'common.version_conflict'); }));
    await open();
    await userEvent.click(screen.getByRole('button', { name: /^save/i }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/changed|someone else|reload|refresh/i);
    cleanup();
    await open([PERM.read]);
    expect(screen.queryByRole('button', { name: /^save/i })).toBeNull();
  });
});

describe('boundaries', () => {
  it.each(['', '[partner_id]', 'settings'])('%s has loading.tsx and error.tsx (segment boundary at partners/ counts)', async (rel) => {
    for (const f of ['loading', 'error']) {
      let mod: { default: unknown } | undefined;
      try { mod = await pageModule(rel, f); } catch { mod = await pageModule('', f); }
      expect(typeof mod!.default).toBe('function');
    }
  });
});
