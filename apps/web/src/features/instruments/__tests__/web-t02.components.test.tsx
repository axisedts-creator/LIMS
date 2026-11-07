// @vitest-environment jsdom
// WEB-T02 — SCR-01 Agents list, SCR-02 Agent detail, SCR-03 Enrolment code reveal (04-UI-UX §3, 03-APP-FLOW §5/F-03).
// ACs: AC-01.3 (code shown exactly once), AC-16.1 (list), AC-16.2 (other-centre 404), AC-16.3 (detail contents, no secrets).
// Component tests + MSW (server functions run for real against MSW) + axe. Synthetic data only.
// ASSUMED module/prop contract (spec fixes folders + kit components only; writer may tell me to rename via a dispute):
//   features/instruments/components/AgentsList.tsx          export AgentsList({agents, permissions, centres, workingCentreId?})
//   features/instruments/components/AgentDetail.tsx         export AgentDetail({agent, transitions, instruments, permissions})
//   features/instruments/components/IssueEnrolmentCode.tsx  export IssueEnrolmentCode({agentId, queueDepth?})  (trigger button + SCR-03)
//   app/(staff)/instruments/agents/[agent_id]/page.tsx      default async Page({params: Promise<{agent_id}>}); getAgent 404 → next/navigation notFound()
//   permissions: readonly string[] (session.actor.permissions); navigation via next/navigation useRouter().push.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { ReactNode } from 'react';
import { ToastProvider } from '@lims/ui/components/Toast';

const push = vi.fn();
const replace = vi.fn();
const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace, refresh, back: vi.fn() }),
  usePathname: () => '/instruments/agents',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw Object.assign(new Error('NEXT_NOT_FOUND'), { digest: 'NEXT_HTTP_ERROR_FALLBACK;404' }); },
}));
vi.mock('server-only', () => ({}));
const session = vi.hoisted(() => ({ permissions: ['instruments.agent.read', 'instruments.agent.manage'] as string[] }));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: session.permissions, displayName: 'Synthetic Manager', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/instruments/agents',
}));

const ORIGIN = 'http://api.test';
process.env.LIMS_ORIGIN_API = ORIGIN;
const AGENT_ID = '01a1a98a-ac40-7000-8000-0000000d0101';
const CENTRE = '01a1a98a-ac40-7000-8000-0000000c0001';
const SECRET = 'lmse_SYNTHETICSECRET0123456';
const HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const READ = ['instruments.agent.read'];
const MANAGE = ['instruments.agent.read', 'instruments.agent.manage'];

const health = (o: Record<string, unknown> = {}) => ({ state: 'online', health_version: 1, queue_depth: 0, oldest_pending_age_seconds: 0, queue_rejected: 0, queue_oversize: 0, last_heartbeat_at: '2026-11-07T04:00:00.000Z', agent_version: '1.0.0', clock_offset_seconds: 0, ...o });
const summary = (o: Record<string, unknown> = {}) => ({ id: AGENT_ID, agent_code: 'SYN-AGENT-1', display_name: 'Synthetic bench PC', centre_id: CENTRE, status: 'active', update_channel: 'stable', version: 3, latest_config_version: 7, health: health(), ...o });
const detail = (o: Record<string, unknown> = {}) => ({ ...summary(), backlog_threshold: 100, enrolled_at: '2026-11-01T04:00:00.000Z', credentials: [], ...o });
const centres = [{ id: CENTRE, name: 'Synthetic Centre A1' }];

const calls: { method: string; url: URL; headers: Headers; body?: any }[] = [];
const rec = async (r: Request) => { calls.push({ method: r.method, url: new URL(r.url), headers: r.headers, body: r.method === 'POST' ? await r.clone().json().catch(() => undefined) : undefined }); };
const issueOk = () => http.post(`${ORIGIN}/v1/instruments/agents/:id/enrolment-codes`, async ({ request }) => { await rec(request); return HttpResponse.json({ enrolment_code: SECRET, expires_at: '2026-11-08T04:05:00.000Z', credential_id: '01a1a98a-ac40-7000-8000-0000000a0002' }, { status: 201 }); });
const listSeen: URL[] = [];
const api = setupServer(
  issueOk(),
  http.get(`${ORIGIN}/v1/instruments/agents`, ({ request }) => { listSeen.push(new URL(request.url)); return HttpResponse.json({ data: [summary()], page: { limit: 50 } }); }),
  http.get(`${ORIGIN}/v1/instruments/agents/:id/health-transitions`, () => HttpResponse.json({ data: [], page: { limit: 50 } })),
  http.get(`${ORIGIN}/v1/instruments/instruments`, ({ request }) => { listSeen.push(new URL(request.url)); return HttpResponse.json({ data: [], page: { limit: 50 } }); }),
);
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { cleanup(); api.resetHandlers(); calls.length = 0; push.mockReset(); replace.mockReset(); refresh.mockReset(); listSeen.length = 0; vi.useRealTimers(); localStorage.clear(); sessionStorage.clear(); session.permissions = MANAGE; });
afterAll(() => api.close());
beforeEach(() => { Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => {}) } }); });

const wrap = (ui: ReactNode) => render(<ToastProvider>{ui}</ToastProvider>);
const noAxeViolations = async () => {
  const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } }); // jsdom has no layout/colour
  expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
};

describe('SCR-01 AgentsList (AC-16.1)', () => {
  const load = async () => (await import('../components/AgentsList')).AgentsList;
  const rows = [
    summary(),
    summary({ id: '01a1a98a-ac40-7000-8000-0000000d0102', agent_code: 'SYN-AGENT-2', display_name: 'Backlogged PC', health: health({ state: 'backlog', queue_depth: 250, clock_offset_seconds: 300 }) }),
    summary({ id: '01a1a98a-ac40-7000-8000-0000000d0103', agent_code: 'SYN-AGENT-3', display_name: 'Silent PC', health: health({ state: 'degraded' }) }),
    summary({ id: '01a1a98a-ac40-7000-8000-0000000d0104', agent_code: 'SYN-AGENT-4', display_name: 'Down PC', health: health({ state: 'offline' }), status: 'revoked' }),
  ];

  it('renders the 04-UI-UX columns; agent code is a row header linking to SCR-02', async () => {
    const AgentsList = await load();
    wrap(<AgentsList agents={rows as never} permissions={READ} centres={centres} />);
    for (const h of ['Agent code', 'Name', 'Centre', 'Health', 'Last heartbeat', 'Version', 'Queue', 'Clock offset', 'Status']) expect(screen.getByRole('columnheader', { name: new RegExp(h, 'i') })).toBeTruthy();
    const link = screen.getByRole('link', { name: 'SYN-AGENT-1' });
    expect(link.getAttribute('href')).toBe(`/instruments/agents/${AGENT_ID}`);
    expect(link.closest('[role="rowheader"], th')).toBeTruthy();
    expect(screen.getByText('Synthetic bench PC')).toBeTruthy();
    expect(screen.getByText('250')).toBeTruthy(); // queue depth as integer
  });

  it('health chips always carry text (online/backlog/degraded/offline map to 04-UI-UX §1 labels)', async () => {
    const AgentsList = await load();
    wrap(<AgentsList agents={rows as never} permissions={READ} centres={centres} />);
    for (const t of ['Online', 'Backlog', 'Instrument silent', 'Offline']) expect(screen.getAllByText(t).length).toBeGreaterThan(0);
  });

  it('empty state uses the exact 03-APP-FLOW §5 text; "New agent" only with instruments.agent.manage', async () => {
    const AgentsList = await load();
    const { unmount } = wrap(<AgentsList agents={[]} permissions={READ} centres={centres} />);
    expect(screen.getByText('No agents yet. Create one for each lab PC that connects analysers.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /new agent/i })).toBeNull();
    unmount();
    wrap(<AgentsList agents={[]} permissions={MANAGE} centres={centres} />);
    expect(screen.getAllByRole('button', { name: /new agent/i }).length).toBeGreaterThan(0);
  });

  it('without manage, no manage affordance anywhere in the populated list', async () => {
    const AgentsList = await load();
    wrap(<AgentsList agents={rows as never} permissions={READ} centres={centres} />);
    expect(screen.queryByRole('button', { name: /new agent|enrolment|revoke|retire/i })).toBeNull();
  });

  it('axe: populated and empty', async () => {
    const AgentsList = await load();
    const a = wrap(<AgentsList agents={rows as never} permissions={MANAGE} centres={centres} />);
    await noAxeViolations();
    a.unmount();
    wrap(<AgentsList agents={[]} permissions={MANAGE} centres={centres} />);
    await noAxeViolations();
  });

  // review #2: 04-UI-UX SCR-01 FilterBar (Centre, Status multi, Health multi). ASSUMED: changing a filter navigates (router.push|replace) to a URL
  // whose query uses the E10 names (centre_id, status, health_state); the page reads them from searchParams (see page tests below).
  it('FilterBar: Centre, Status and Health filters are present; picking a Status chip navigates with status=', async () => {
    const AgentsList = await load();
    wrap(<AgentsList agents={rows as never} permissions={READ} centres={centres} />);
    const bar = screen.getByRole('search');
    for (const l of ['Centre', 'Status', 'Health']) expect(within(bar).getByText(l, { selector: 'label, .lims-label, span' })).toBeTruthy();
    await userEvent.click(within(bar).getByRole('option', { name: /retired/i }));
    const urls = [...push.mock.calls, ...replace.mock.calls].map((c) => String(c[0]));
    expect(urls.some((u) => /status=[^&]*retired/.test(decodeURIComponent(u)))).toBe(true);
  });

  // review #8: 04-UI-UX SCR-01 auto-refresh: every 30 s via router.refresh(), paused while the tab is hidden. ASSUMED: poller lives in AgentsList.
  describe('auto-refresh', () => {
    const visibility = (v: 'visible' | 'hidden') => Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v });
    afterEach(() => visibility('visible'));
    it('refreshes every 30 s while visible, not before', async () => {
      vi.useFakeTimers();
      const AgentsList = await load();
      wrap(<AgentsList agents={rows as never} permissions={READ} centres={centres} />);
      vi.advanceTimersByTime(29_000);
      expect(refresh).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1_000);
      expect(refresh).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(30_000);
      expect(refresh).toHaveBeenCalledTimes(2);
    });
    it('does not refresh while the tab is hidden; resumes when visible', async () => {
      vi.useFakeTimers();
      const AgentsList = await load();
      wrap(<AgentsList agents={rows as never} permissions={READ} centres={centres} />);
      visibility('hidden');
      vi.advanceTimersByTime(90_000);
      expect(refresh).not.toHaveBeenCalled();
      visibility('visible');
      vi.advanceTimersByTime(30_000);
      expect(refresh).toHaveBeenCalled();
    });
    it('stops polling after unmount', async () => {
      vi.useFakeTimers();
      const AgentsList = await load();
      const { unmount } = wrap(<AgentsList agents={rows as never} permissions={READ} centres={centres} />);
      unmount();
      vi.advanceTimersByTime(120_000);
      expect(refresh).not.toHaveBeenCalled();
    });
  });

  describe('New agent dialog → E11', () => {
    const open = async (workingCentreId = CENTRE) => {
      const AgentsList = await load();
      wrap(<AgentsList agents={[]} permissions={MANAGE} centres={centres} workingCentreId={workingCentreId} />);
      await userEvent.click(screen.getAllByRole('button', { name: /new agent/i })[0]!);
      return screen.getByRole('dialog');
    };
    const created = () => http.post(`${ORIGIN}/v1/instruments/agents`, async ({ request }) => { await rec(request); return HttpResponse.json(detail({ agent_code: 'HUB-PC-01', display_name: 'Hub PC' }), { status: 201 }); });

    it('uppercases the code on input, submits with Ctrl+Enter, sends Idempotency-Key + centre default, navigates to SCR-02 and toasts', async () => {
      api.use(created());
      const dlg = await open();
      const code = within(dlg).getByLabelText(/agent code/i) as HTMLInputElement;
      await userEvent.type(code, 'hub-pc-01');
      expect(code.value).toBe('HUB-PC-01');
      await userEvent.type(within(dlg).getByLabelText(/^name/i), 'Hub PC');
      await userEvent.keyboard('{Control>}{Enter}{/Control}');
      await waitFor(() => expect(calls).toHaveLength(1));
      expect(calls[0]!.body).toMatchObject({ agent_code: 'HUB-PC-01', display_name: 'Hub PC', centre_id: CENTRE });
      expect(calls[0]!.headers.get('idempotency-key')).toBeTruthy();
      await waitFor(() => expect(push).toHaveBeenCalledWith(`/instruments/agents/${AGENT_ID}`));
      expect(await screen.findByText('Agent created. Issue an enrolment code to install it.')).toBeTruthy();
    });

    it('invalid code (^[A-Z0-9-]{2,32}$) or empty name blocks submit — no API call', async () => {
      api.use(created());
      const dlg = await open();
      await userEvent.type(within(dlg).getByLabelText(/agent code/i), 'a');
      await userEvent.keyboard('{Control>}{Enter}{/Control}');
      await new Promise((r) => setTimeout(r, 100));
      expect(calls).toHaveLength(0);
      expect(push).not.toHaveBeenCalled();
      expect(within(dlg).getAllByRole('alert').length + dlg.querySelectorAll('[aria-invalid="true"]').length).toBeGreaterThan(0);
    });

    it('double submit (Ctrl+Enter twice, fast) creates one agent', async () => {
      api.use(created());
      const dlg = await open();
      await userEvent.type(within(dlg).getByLabelText(/agent code/i), 'HUB-PC-01');
      await userEvent.type(within(dlg).getByLabelText(/^name/i), 'Hub PC');
      await userEvent.keyboard('{Control>}{Enter}{Enter}{/Control}');
      await waitFor(() => expect(push).toHaveBeenCalled());
      expect(calls).toHaveLength(1);
    });

    // review #7: one Idempotency-Key per dialog open; an in-flight submit blocks a second POST (02-CONVENTIONS §4.5).
    it('two fast submits while the first is in flight → one POST; a retry after failure reuses the same Idempotency-Key', async () => {
      let n = 0;
      api.use(http.post(`${ORIGIN}/v1/instruments/agents`, async ({ request }) => {
        await rec(request);
        await new Promise((r) => setTimeout(r, 150));
        return ++n === 1 ? HttpResponse.json({ type: 'urn:lims:error:common.internal', title: 'x', status: 500, code: 'common.internal' }, { status: 500 }) : HttpResponse.json(detail({ agent_code: 'HUB-PC-01' }), { status: 201 });
      }));
      const dlg = await open();
      await userEvent.type(within(dlg).getByLabelText(/agent code/i), 'HUB-PC-01');
      await userEvent.type(within(dlg).getByLabelText(/^name/i), 'Hub PC');
      await userEvent.keyboard('{Control>}{Enter}{Enter}{Enter}{/Control}');
      await screen.findByRole('alert'); // danger toast after the failed first attempt
      expect(calls).toHaveLength(1);
      await userEvent.keyboard('{Control>}{Enter}{/Control}');
      await waitFor(() => expect(push).toHaveBeenCalled());
      expect(calls).toHaveLength(2);
      expect(calls[1]!.headers.get('idempotency-key')).toBe(calls[0]!.headers.get('idempotency-key'));
    });

    it('re-opening the dialog mints a NEW Idempotency-Key', async () => {
      api.use(http.post(`${ORIGIN}/v1/instruments/agents`, async ({ request }) => { await rec(request); return HttpResponse.json({ type: 'urn:lims:error:common.internal', title: 'x', status: 500, code: 'common.internal' }, { status: 500 }); }));
      const submitOnce = async () => {
        const dlg = await open();
        await userEvent.type(within(dlg).getByLabelText(/agent code/i), 'HUB-PC-01');
        await userEvent.type(within(dlg).getByLabelText(/^name/i), 'Hub PC');
        await userEvent.keyboard('{Control>}{Enter}{/Control}');
        await waitFor(() => expect(calls.length).toBeGreaterThan(0));
        cleanup();
      };
      await submitOnce();
      const first = calls.length;
      await submitOnce();
      expect(calls).toHaveLength(first + 1);
      expect(calls[first]!.headers.get('idempotency-key')).not.toBe(calls[0]!.headers.get('idempotency-key'));
    });

    // review #3: no centre chosen must be a visible field error, never a silent return.
    it('no centre selected → field error shown, no API call', async () => {
      const AgentsList = await load();
      wrap(<AgentsList agents={[]} permissions={MANAGE} centres={centres} />); // no workingCentreId
      await userEvent.click(screen.getAllByRole('button', { name: /new agent/i })[0]!);
      const dlg = screen.getByRole('dialog');
      await userEvent.type(within(dlg).getByLabelText(/agent code/i), 'HUB-PC-01');
      await userEvent.type(within(dlg).getByLabelText(/^name/i), 'Hub PC');
      await userEvent.keyboard('{Control>}{Enter}{/Control}');
      await new Promise((r) => setTimeout(r, 100));
      expect(calls).toHaveLength(0);
      expect(within(dlg).getAllByRole('alert').length + dlg.querySelectorAll('[aria-invalid="true"]').length).toBeGreaterThan(0);
    });

    it('409 instruments.code_duplicate keeps the dialog open, no navigation', async () => {
      api.use(http.post(`${ORIGIN}/v1/instruments/agents`, () => HttpResponse.json({ type: 'urn:lims:error:instruments.code_duplicate', title: 'dup', status: 409, code: 'instruments.code_duplicate' }, { status: 409 })));
      const dlg = await open();
      await userEvent.type(within(dlg).getByLabelText(/agent code/i), 'HUB-PC-01');
      await userEvent.type(within(dlg).getByLabelText(/^name/i), 'Hub PC');
      await userEvent.keyboard('{Control>}{Enter}{/Control}');
      await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
      expect(push).not.toHaveBeenCalled();
    });

    it('axe: dialog open', async () => {
      await open();
      await noAxeViolations();
    });
  });
});

describe('SCR-02 AgentDetail (AC-16.3)', () => {
  const load = async () => (await import('../components/AgentDetail')).AgentDetail;
  const transitions = Array.from({ length: 50 }, (_, i) => ({ health_version: 50 - i, from_state: i % 2 ? 'online' : 'offline', to_state: i % 2 ? 'offline' : 'online', changed_at: `2026-11-06T${String(i % 24).padStart(2, '0')}:00:00.000Z`, queue_depth: 0, silent_instrument_ids: [] }));
  const instruments = [{ id: '01a1a98a-ac40-7000-8000-0000000e0001', instrument_code: 'SIM-CHEM-1', display_name: 'Sim chem', vendor: 'Synthetic', model: 'S1', protocol: 'astm', agent_id: AGENT_ID, agent_code: 'SYN-AGENT-1', centre_id: CENTRE, driver_code: 'generic_astm', driver_status: 'generic', state: 'live', version: 1, link_state: 'up', last_message_at: '2026-11-07T03:58:00.000Z', unmapped_code_count: 0 }];
  const credentials = [
    // extra secret-ish fields on purpose: the UI must not render anything beyond the documented columns (AC-16.3 "never secrets")
    { credential_id: '01a1a98a-ac40-7000-8000-0000000a0001', kind: 'device_token', status: 'active', issued_at: '2026-11-01T04:00:00.000Z', issued_by_display: 'Synthetic Manager', used_at: '2026-11-01T04:05:00.000Z', secret_sha256: HASH, token: 'tok_SHOULDNEVERSHOW' },
    { credential_id: '01a1a98a-ac40-7000-8000-0000000a0002', kind: 'enrolment_code', status: 'used', issued_at: '2026-11-01T03:00:00.000Z', issued_by_display: 'Synthetic Manager', expires_at: '2026-11-02T03:00:00.000Z', enrolment_code: SECRET },
  ];
  const render1 = async (perm = MANAGE, agent: Record<string, unknown> = {}) => {
    const AgentDetail = await load();
    return wrap(<AgentDetail agent={detail({ credentials, ...agent }) as never} transitions={transitions as never} instruments={instruments as never} permissions={perm} />);
  };

  it('header "code — name" with health + status chips; five tabs in 04-UI-UX order', async () => {
    await render1();
    expect(screen.getByRole('heading', { level: 1, name: /SYN-AGENT-1\s+—\s+Synthetic bench PC/ })).toBeTruthy();
    expect(screen.getAllByText('Online').length).toBeGreaterThan(0);
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Overview', 'Instruments', 'Health history', 'Credentials', 'Commands & logs']);
  });

  it('manage actions visible with manage; hidden without (03-APP-FLOW §5)', async () => {
    const { unmount } = await render1(MANAGE);
    for (const n of [/issue enrolment code/i, /request command/i, /revoke/i, /retire/i, /edit/i]) expect(screen.getByRole('button', { name: n })).toBeTruthy();
    unmount();
    await render1(READ);
    for (const n of [/issue enrolment code/i, /request command/i, /revoke/i, /retire/i, /edit/i]) expect(screen.queryByRole('button', { name: n })).toBeNull();
  });

  it('Instruments tab lists code (link), link state and last message time', async () => {
    await render1();
    await userEvent.click(screen.getByRole('tab', { name: 'Instruments' }));
    expect(screen.getByRole('link', { name: 'SIM-CHEM-1' }).getAttribute('href')).toMatch(/\/instruments\/instruments\/01a1a98a-ac40-7000-8000-0000000e0001$/);
    expect(screen.getByText(/\bup\b/i)).toBeTruthy();
  });

  it('Health history shows the last 50 transitions as "From → To"', async () => {
    await render1();
    await userEvent.click(screen.getByRole('tab', { name: 'Health history' }));
    expect(screen.getAllByText(/(Online|Offline)\s→\s(Online|Offline)/)).toHaveLength(50);
  });

  it('Credentials tab: kind/status/issued-by shown; no secret, hash or token anywhere in the DOM (AC-16.3, E1)', async () => {
    await render1();
    await userEvent.click(screen.getByRole('tab', { name: 'Credentials' }));
    expect(screen.getByText('Enrolment code')).toBeTruthy();
    expect(screen.getByText('Device token')).toBeTruthy();
    expect(screen.getAllByText('Synthetic Manager').length).toBeGreaterThan(0);
    const html = document.body.innerHTML;
    for (const s of [SECRET, HASH, 'tok_SHOULDNEVERSHOW', 'secret_sha256']) expect(html).not.toContain(s);
  });

  it('warning banners: config rejected, recent IP change; none when healthy', async () => {
    const { unmount } = await render1(MANAGE, { health: health({ config_version_applied: 6, config_state: 'signature_invalid', last_ip: '10.0.5.9', last_ip_changed_at: new Date(Date.now() - 3600_000).toISOString() }) });
    expect(screen.getByText(/The agent rejected configuration version 7: signature_invalid\. Contact support\./)).toBeTruthy();
    expect(screen.getByText("This agent's network address changed recently. If you didn't move the PC, revoke it.")).toBeTruthy();
    unmount();
    await render1(MANAGE, { health: health({ config_state: 'ok', last_ip_changed_at: '2026-01-01T00:00:00.000Z' }) });
    expect(screen.queryByText(/rejected configuration/)).toBeNull();
    expect(screen.queryByText(/network address changed/)).toBeNull();
  });

  it('revoked agent shows the 04-UI-UX §6 banner', async () => {
    await render1(MANAGE, { status: 'revoked', revoked_at: '2026-11-05T00:00:00.000Z' });
    expect(screen.getByText("This agent's access was revoked. It keeps messages locally until it is re-enrolled.")).toBeTruthy();
  });

  // review #5: 04-UI-UX SCR-02 Overview — Banner warning when update state ∈ {verify_failed, rolled_back}. (The |clock offset| > tenant-warn banner is
  // NOT tested: the spec gives neither the tenant-warn source nor its text.)
  it.each(['verify_failed', 'rolled_back'])('warning banner when update state is %s; none for idle', async (state) => {
    const { unmount } = await render1(MANAGE, { health: health({ update_state: 'idle', config_state: 'ok' }) });
    expect(document.querySelectorAll('[data-tone="warning"]')).toHaveLength(0);
    unmount();
    await render1(MANAGE, { health: health({ update_state: state, config_state: 'ok' }) });
    const banners = [...document.querySelectorAll('[data-tone="warning"]')];
    expect(banners).toHaveLength(1);
    expect(banners[0]!.textContent).toMatch(/update/i);
  });

  // review #4: Instruments tab columns per 04-UI-UX: code, state, link state, last message, last error code, silence status.
  it('Instruments tab also shows "Last error code" and "Silence status" columns with their values', async () => {
    const AgentDetail = await load();
    const rowsI = [{ ...instruments[0]!, link_state: 'error', last_link_error_code: 'firewall_rule_missing', silent_since: '2026-11-07T01:00:00.000Z' }];
    wrap(<AgentDetail agent={detail() as never} transitions={[]} instruments={rowsI as never} permissions={READ} />);
    await userEvent.click(screen.getByRole('tab', { name: 'Instruments' }));
    for (const h of ['Instrument code', 'State', 'Link state', 'Last message', 'Last error code', 'Silence status']) expect(screen.getByRole('columnheader', { name: new RegExp(`^${h}$`, 'i') })).toBeTruthy();
    expect(screen.getByText('firewall_rule_missing')).toBeTruthy();
  });

  // review #6: SCR-02 actions must not ship as disabled stubs. Commands & logs tab lists E18 rows.
  it('manage actions are enabled, not disabled stubs (Retire is gated separately, below)', async () => {
    await render1(MANAGE);
    for (const n of [/request command/i, /revoke/i, /edit/i]) expect((screen.getByRole('button', { name: n }) as HTMLButtonElement).disabled, String(n)).toBe(false);
  });

  // 04-UI-UX.md:115 — Retire "disabled with tooltip when instruments are not retired".
  it('Retire is disabled with a tooltip while any instrument is not retired', async () => {
    await render1(MANAGE); // fixture instrument is state: 'live'
    const retire = screen.getByRole('button', { name: /retire/i }) as HTMLButtonElement;
    expect(retire.disabled).toBe(true);
    expect(retire.getAttribute('title') || retire.getAttribute('aria-describedby')).toBeTruthy();
  });

  it('Retire is enabled when the agent has no instruments or all are retired', async () => {
    const AgentDetail = await load();
    const { unmount } = wrap(<AgentDetail agent={detail({ credentials }) as never} transitions={transitions as never} instruments={[]} permissions={MANAGE} />);
    expect((screen.getByRole('button', { name: /retire/i }) as HTMLButtonElement).disabled).toBe(false);
    unmount();
    wrap(<AgentDetail agent={detail({ credentials }) as never} transitions={transitions as never} instruments={[{ ...instruments[0]!, state: 'retired' }] as never} permissions={MANAGE} />);
    expect((screen.getByRole('button', { name: /retire/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('Revoke opens a danger ConfirmDialog with the 04-UI-UX body and a reason field; nothing is sent until confirmed', async () => {
    await render1(MANAGE);
    await userEvent.click(screen.getByRole('button', { name: /revoke/i }));
    const dlg = screen.getByRole('dialog');
    expect(dlg.textContent).toContain('The PC stops uploading immediately. Messages already on the PC stay there until it is re-enrolled.');
    expect(calls).toHaveLength(0);
  });

  it('Commands & logs tab calls E18 for this agent and renders the commands', async () => {
    api.use(http.get(`${ORIGIN}/v1/instruments/agents/:id/commands`, ({ request }) => {
      listSeen.push(new URL(request.url));
      return HttpResponse.json({ data: [{ id: '01a1a98a-ac40-7000-8000-0000000f0001', kind: 'upload_logs', state: 'completed', requested_at: '2026-11-07T01:00:00.000Z', completed_at: '2026-11-07T01:01:00.000Z', result_code: 'ok_synthetic' }], page: { limit: 50 } });
    }));
    await render1();
    await userEvent.click(screen.getByRole('tab', { name: 'Commands & logs' }));
    expect(await screen.findByText(/upload.?logs/i)).toBeTruthy();
    expect(listSeen.some((u) => u.pathname === `/v1/instruments/agents/${AGENT_ID}/commands`)).toBe(true);
  });

  // review round 2 #1 — 04-UI-UX.md:110, E20 getAgentLogBundle (02-TRD.md:698)
  describe('View log (E20)', () => {
    const BUNDLE = '01a1a98a-ac40-7000-8000-0000000b0001';
    const cmd = (o: Record<string, unknown>) => ({ command_id: '01a1a98a-ac40-7000-8000-0000000f0001', agent_id: AGENT_ID, kind: 'upload_logs', params: {}, state: 'completed', requested_at: '2026-11-07T01:00:00.000Z', requested_by_display: 'Synthetic Manager', completed_at: '2026-11-07T01:01:00.000Z', result_code: 'ok_synthetic', expires_at: '2026-11-08T01:00:00.000Z', ...o });
    const useCommands = (rows: unknown[]) => api.use(
      http.get(`${ORIGIN}/v1/instruments/agents/:id/commands`, () => HttpResponse.json({ data: rows, page: { limit: 50 } })),
      http.get(`${ORIGIN}/v1/instruments/agents/:id/log-bundles/:bundle`, ({ request }) => { listSeen.push(new URL(request.url)); return HttpResponse.json({ bundle_id: BUNDLE, lines: ['synthetic log line one', 'synthetic log line two'], from_at_agent: '2026-11-07T00:00:00.000Z', to_at_agent: '2026-11-07T01:00:00.000Z', created_at: '2026-11-07T01:01:00.000Z' }); }),
    );
    const openCommands = async (perm = MANAGE) => { await render1(perm); await userEvent.click(screen.getByRole('tab', { name: 'Commands & logs' })); };

    it('completed upload_logs with log_bundle_id → "View log" calls E20 with agent_id/bundle_id and renders lines', async () => {
      useCommands([cmd({ log_bundle_id: BUNDLE })]);
      await openCommands();
      await userEvent.click(await screen.findByRole('button', { name: /view log/i }));
      expect(await screen.findByText(/synthetic log line one/)).toBeTruthy();
      expect(screen.getByText(/synthetic log line two/)).toBeTruthy();
      expect(listSeen.some((u) => u.pathname === `/v1/instruments/agents/${AGENT_ID}/log-bundles/${BUNDLE}`)).toBe(true);
    });

    it('no "View log" without log_bundle_id, for non-upload_logs, for non-completed, or without manage', async () => {
      useCommands([cmd({}), cmd({ command_id: '01a1a98a-ac40-7000-8000-0000000f0002', kind: 'restart_service', log_bundle_id: BUNDLE }), cmd({ command_id: '01a1a98a-ac40-7000-8000-0000000f0003', state: 'queued', log_bundle_id: BUNDLE })]);
      await openCommands();
      await screen.findByText(/restart service/i);
      expect(screen.queryByRole('button', { name: /view log/i })).toBeNull();
    });

    it('READ-only: no "View log" even with a log_bundle_id', async () => {
      useCommands([cmd({ log_bundle_id: BUNDLE })]);
      await openCommands(READ);
      await screen.findByText(/upload.?logs/i);
      expect(screen.queryByRole('button', { name: /view log/i })).toBeNull();
    });
  });

  // review round 2 #2/#3 — 04-UI-UX.md:190-191
  describe('shortcuts', () => {
    const PAGE = 'staff.instruments.agent';
    const altE = async () => (await import('@/core/shortcuts/registry')).shortcuts.list(PAGE).find((s) => /^alt\+e$/i.test(s.key));

    it('Alt+E opens the "Issue enrolment code" ConfirmDialog for MANAGE', async () => {
      const { act } = await import('@testing-library/react');
      await render1(MANAGE);
      const sc = await altE();
      expect(sc?.description).toBe('Issue enrolment code');
      act(() => sc!.run());
      expect(within(await screen.findByRole('dialog')).getByText('Issue enrolment code')).toBeTruthy();
      expect(calls).toHaveLength(0); // opening is not issuing
    });

    it('Alt+E is not registered for READ and is unregistered on unmount', async () => {
      const { unmount } = await render1(READ);
      expect(await altE()).toBeUndefined();
      unmount();
      await render1(MANAGE);
      expect(await altE()).toBeTruthy();
      cleanup();
      expect(await altE()).toBeUndefined();
    });

    it('help for instruments.agents does not advertise Alt+N (global key; SCR-01 key is a CR)', async () => {
      const help = (await import('../help/instruments.agents')).default;
      expect(help.shortcuts.map((s: { keys: string }) => s.keys)).not.toContain('Alt+N');
    });
  });

  it('axe: every tab', async () => {
    await render1();
    for (const t of ['Overview', 'Instruments', 'Health history', 'Credentials', 'Commands & logs']) {
      await userEvent.click(screen.getByRole('tab', { name: t }));
      await noAxeViolations();
    }
  });

  it('page: getAgent 404 (other centre, AC-16.2) → next/navigation notFound(), not a rendered agent', async () => {
    api.use(http.get(`${ORIGIN}/v1/instruments/agents/:id`, () => HttpResponse.json({ type: 'urn:lims:error:common.not_found', title: 'Not found', status: 404, code: 'common.not_found' }, { status: 404 })));
    const mod = await import('../../../app/(staff)/instruments/agents/[agent_id]/page');
    await expect(mod.default({ params: Promise.resolve({ agent_id: '01a1a98a-ac40-7000-8000-0000000d0202' }) } as never)).rejects.toMatchObject({ message: 'NEXT_NOT_FOUND' });
  });

  it('page: a non-404 API failure is NOT turned into not-found (error.tsx handles it)', async () => {
    api.use(http.get(`${ORIGIN}/v1/instruments/agents/:id`, () => HttpResponse.json({ type: 'urn:lims:error:common.internal', title: 'x', status: 500, code: 'common.internal' }, { status: 500 })));
    const mod = await import('../../../app/(staff)/instruments/agents/[agent_id]/page');
    await expect(mod.default({ params: Promise.resolve({ agent_id: AGENT_ID }) } as never)).rejects.toMatchObject({ status: 500 });
  });
});

describe('pages → BFF (review #2, #3, #4)', () => {
  const listPage = async (sp: Record<string, string | string[] | undefined>) => {
    const mod = await import('../../../app/(staff)/instruments/agents/page');
    return (await mod.default({ searchParams: Promise.resolve(sp) } as never)) as { props: Record<string, any> };
  };

  it('agents page: no query → E10 with default status = all except retired and sort=agent_code', async () => {
    await listPage({});
    const u = listSeen.find((x) => x.pathname === '/v1/instruments/agents')!;
    expect(u.searchParams.get('status')!.split(',').sort()).toEqual(['active', 'pending_enrolment', 'revoked']);
    expect(u.searchParams.get('sort')).toBe('agent_code');
    expect(u.searchParams.get('centre_id')).toBeNull();
    expect(u.searchParams.get('health_state')).toBeNull();
  });

  it('agents page: searchParams centre_id / status / health_state / sort are forwarded to E10 (AC-16.1)', async () => {
    await listPage({ centre_id: CENTRE, status: 'retired,active', health_state: 'offline,backlog', sort: '-last_heartbeat_at' });
    const u = listSeen.find((x) => x.pathname === '/v1/instruments/agents')!;
    expect(u.searchParams.get('centre_id')).toBe(CENTRE);
    expect(u.searchParams.get('status')).toBe('retired,active');
    expect(u.searchParams.get('health_state')).toBe('offline,backlog');
    expect(u.searchParams.get('sort')).toBe('-last_heartbeat_at');
  });

  it('agents page: tampered query values never reach the API (enum-validated)', async () => {
    await listPage({ status: "active,x'; drop", health_state: 'nope', sort: 'password', centre_id: 'not-a-uuid' }).catch(() => undefined);
    for (const u of listSeen.filter((x) => x.pathname === '/v1/instruments/agents')) {
      expect(u.search).not.toMatch(/drop|nope|password|not-a-uuid/);
    }
  });

  it('agent page: Instruments tab is fed by E21 called with agent_id', async () => {
    const row = { id: '01a1a98a-ac40-7000-8000-0000000e0001', instrument_code: 'SIM-CHEM-1', display_name: 'Sim chem', state: 'live', link_state: 'up', last_message_at: '2026-11-07T03:58:00.000Z' };
    api.use(
      http.get(`${ORIGIN}/v1/instruments/agents/:id`, () => HttpResponse.json(detail())),
      http.get(`${ORIGIN}/v1/instruments/instruments`, ({ request }) => { listSeen.push(new URL(request.url)); return HttpResponse.json({ data: [row], page: { limit: 50 } }); }),
    );
    const mod = await import('../../../app/(staff)/instruments/agents/[agent_id]/page');
    const el = (await mod.default({ params: Promise.resolve({ agent_id: AGENT_ID }) } as never)) as { props: Record<string, any> };
    expect(listSeen.some((u) => u.pathname === '/v1/instruments/instruments' && u.searchParams.get('agent_id') === AGENT_ID)).toBe(true);
    expect(el.props.instruments).toEqual([row]);
  });
});

describe('SCR-03 Issue enrolment code (AC-01.3)', () => {
  const load = async () => (await import('../components/IssueEnrolmentCode')).IssueEnrolmentCode;
  const start = async (queueDepth = 0) => {
    const IssueEnrolmentCode = await load();
    wrap(<IssueEnrolmentCode agentId={AGENT_ID} queueDepth={queueDepth} />);
    await userEvent.click(screen.getByRole('button', { name: /issue enrolment code/i }));
    return screen.getByRole('dialog');
  };
  const confirm = async () => {
    const dlg = screen.getByRole('dialog');
    await userEvent.click(within(dlg).getByRole('button', { name: /issue/i }));
  };
  const bodyHas = (s: string) => document.body.textContent!.includes(s);

  it('step 1: ConfirmDialog with the 04-UI-UX body; nothing is issued until confirmed', async () => {
    const dlg = await start();
    expect(within(dlg).getByText('Issue enrolment code', { selector: 'h1,h2,h3,[role="heading"]' })).toBeTruthy();
    expect(dlg.textContent).toContain('A one-time code lets one PC enrol as this agent. It expires in 24 hours. Earlier unused codes stop working.');
    expect(calls).toHaveLength(0);
  });

  it('queue > 0 adds the F-03 warning with the count; queue = 0 does not', async () => {
    const dlg = await start(4);
    expect(dlg.textContent).toContain('This agent still has 4 messages waiting. Re-enrolling another PC will stop this PC from uploading them.');
    cleanup();
    const dlg0 = await start(0);
    expect(dlg0.textContent).not.toContain('messages waiting');
  });

  it('confirm → E14 once → SecretRevealOnce "Enrolment code" shows the code, expiry and the install instruction', async () => {
    await start();
    await confirm();
    await waitFor(() => expect(bodyHas(SECRET)).toBe(true));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.pathname).toBe(`/v1/instruments/agents/${AGENT_ID}/enrolment-codes`);
    expect(screen.getByText('Enrolment code', { selector: '.lims-label, label, span, [id]' })).toBeTruthy();
    expect(document.body.textContent).toContain('Code shown. Copy it now.');
    expect(document.body.textContent).toMatch(/Expires/);
    expect(document.body.textContent).toMatch(/bridge-agent install --server \S+ --enrolment-code /);
  });

  it('reveal dialog is not dismissable (Escape, overlay click) and Done is disabled until "I have copied this code"', async () => {
    await start();
    await confirm();
    await waitFor(() => expect(bodyHas(SECRET)).toBe(true));
    await userEvent.keyboard('{Escape}');
    expect(bodyHas(SECRET)).toBe(true);
    await userEvent.click(document.body);
    expect(bodyHas(SECRET)).toBe(true);
    const done = screen.getByRole('button', { name: 'Done' }) as HTMLButtonElement;
    expect(done.disabled || done.getAttribute('aria-disabled') === 'true').toBe(true);
    await userEvent.click(screen.getByLabelText('I have copied this code'));
    await userEvent.click(done);
  });

  it('after Done the code is gone from the DOM, URL, storage and title; re-opening issues a NEW call, never the old code', async () => {
    await start();
    await confirm();
    await waitFor(() => expect(bodyHas(SECRET)).toBe(true));
    await userEvent.click(screen.getByLabelText('I have copied this code'));
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(bodyHas(SECRET)).toBe(false));
    expect(document.body.innerHTML).not.toContain(SECRET);
    expect(location.href + document.title + JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage })).not.toContain(SECRET);
    // re-open: must go through confirm + a second POST; no cached secret
    await userEvent.click(screen.getByRole('button', { name: /issue enrolment code/i }));
    expect(bodyHas(SECRET)).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('double-click on Issue sends ONE request (two codes would invalidate the first, E14)', async () => {
    await start();
    const btn = within(screen.getByRole('dialog')).getByRole('button', { name: /issue/i });
    await userEvent.dblClick(btn);
    await waitFor(() => expect(bodyHas(SECRET)).toBe(true));
    expect(calls).toHaveLength(1);
  });

  it('403 auth.mfa_required → banner "Confirm with your authenticator to continue"; no code shown', async () => {
    api.use(http.post(`${ORIGIN}/v1/instruments/agents/:id/enrolment-codes`, () => HttpResponse.json({ type: 'urn:lims:error:auth.mfa_required', title: 'mfa', status: 403, code: 'auth.mfa_required' }, { status: 403 })));
    await start();
    await confirm();
    expect(await screen.findByText(/Confirm with your authenticator to continue/)).toBeTruthy();
    expect(bodyHas('lmse_')).toBe(false);
  });

  it('other failure (409 instruments.agent_not_active) → danger toast carrying the code; no secret UI', async () => {
    api.use(http.post(`${ORIGIN}/v1/instruments/agents/:id/enrolment-codes`, () => HttpResponse.json({ type: 'urn:lims:error:instruments.agent_not_active', title: 'x', status: 409, code: 'instruments.agent_not_active' }, { status: 409 })));
    await start();
    await confirm();
    const toast = await screen.findByRole('alert');
    expect(toast.textContent).toContain('instruments.agent_not_active');
    expect(bodyHas('lmse_')).toBe(false);
  });

  it('the code is never written to console while shown', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    await start();
    await confirm();
    await waitFor(() => expect(bodyHas(SECRET)).toBe(true));
    for (const s of spies) expect(JSON.stringify(s.mock.calls)).not.toContain(SECRET);
  });

  it('axe: confirm step and reveal step; reveal announces via a live region', async () => {
    await start();
    await noAxeViolations();
    await confirm();
    await waitFor(() => expect(bodyHas(SECRET)).toBe(true));
    await noAxeViolations();
    expect(screen.getByRole('status').textContent).toContain('Code shown. Copy it now.');
  });
});

describe('static guards on the WEB-T02 files (REQ-SEC-068: browser holds no JWT/API origin)', () => {
  it('components/* never mention the API origin, bearer tokens, or persist anything', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const WEB = join(import.meta.dirname, '..', '..', '..', '..');
    const dir = join(WEB, 'src/features/instruments/components');
    const files = readdirSync(dir).filter((f) => /\.tsx?$/.test(f) && !/\.(test|spec)\./.test(f));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const src = readFileSync(join(dir, f), 'utf8');
      expect(src, f).not.toMatch(/LIMS_ORIGIN_API|authorization|Bearer |localStorage|sessionStorage|document\.cookie|dangerouslySetInnerHTML/i);
    }
  });

  it('every server/*.server.ts starts with the "server-only" guard (02-CONVENTIONS §2.4)', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const WEB = join(import.meta.dirname, '..', '..', '..', '..');
    const dir = join(WEB, 'src/features/instruments/server');
    const files = readdirSync(dir).filter((f) => f.endsWith('.server.ts'));
    for (const n of ['listAgents', 'getAgent', 'createAgent', 'issueEnrolmentCode', 'listAgentHealthTransitions', 'listInstruments']) expect(files, n).toContain(`${n}.server.ts`);
    for (const f of files) expect(readFileSync(join(dir, f), 'utf8'), f).toMatch(/^(\s*\/\/[^\n]*\n|\s*'use server';?\s*\n)*\s*import ['"]server-only['"]/);
  });

  it('route pages exist as server components: agents/page.tsx and agents/[agent_id]/page.tsx (no "use client")', async () => {
    const { readFileSync, existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    const WEB = join(import.meta.dirname, '..', '..', '..', '..');
    for (const p of ['agents/page.tsx', 'agents/[agent_id]/page.tsx']) {
      const f = join(WEB, 'src/app/(staff)/instruments', p);
      expect(existsSync(f), p).toBe(true);
      expect(readFileSync(f, 'utf8'), p).not.toMatch(/^\s*['"]use client['"]/);
    }
  });
});
