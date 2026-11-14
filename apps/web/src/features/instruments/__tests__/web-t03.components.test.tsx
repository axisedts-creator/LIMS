// @vitest-environment jsdom
// WEB-T03 — SCR-05 Instruments list, SCR-06 Instrument form (create/edit), SCR-07 Instrument detail + commissioning dialogs (04-UI-UX §3).
// ACs: AC-03.1..03.6 (create/edit form, error mapping), AC-04.1..04.5 (start commissioning, go live, suspend/resume, invalid transition).
// Component tests + MSW (server actions run for real against MSW) + axe. Synthetic data only.
// ASSUMED module/prop contract (spec fixes folders + kit components only; dispute to rename):
//   components/InstrumentsList.tsx   export InstrumentsList({instruments, permissions, centres, agents, drivers})   (SCR-05; "New instrument" opens the SCR-06 form in a Dialog)
//   components/InstrumentForm.tsx    export InstrumentForm({mode: 'create'|'edit', agents, drivers, instrument?, permissions?})  (SCR-06; create → push(SCR-07), edit → router.refresh)
//   components/InstrumentDetail.tsx  export InstrumentDetail({instrument, agents, drivers, permissions})            (SCR-07 header, actions, tabs, Go live/Suspend/Retire dialogs)
//   app/(staff)/instruments/instruments/page.tsx                      default async Page({searchParams: Promise<…>}) → element with props {instruments, agents, drivers}
//   app/(staff)/instruments/instruments/[instrument_id]/page.tsx      default async Page({params: Promise<{instrument_id}>}); getInstrument 404 → notFound(); props {instrument, agents, drivers}
//   permissions: readonly string[] (session.actor.permissions); manage = instruments.instrument.manage; navigation via next/navigation useRouter().push.
//   Shortcut page ids: staff.instruments.instruments (Alt+I "New instrument", LD-79), staff.instruments.instrument (Alt+P "Open mappings").
// NOT tested (spec gap, see notes): parser-options fields from the driver optionsSchema (E22 Driver has no schema field in contracts), timezone list.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
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
  usePathname: () => '/instruments/instruments',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw Object.assign(new Error('NEXT_NOT_FOUND'), { digest: 'NEXT_HTTP_ERROR_FALLBACK;404' }); },
}));
vi.mock('server-only', () => ({}));
const session = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: session.permissions, displayName: 'Synthetic Manager', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/instruments/instruments',
}));

const ORIGIN = 'http://api.test';
process.env.LIMS_ORIGIN_API = ORIGIN;
const INST = '01a1a98a-ac40-7000-8000-0000000e0001';
const AGENT = '01a1a98a-ac40-7000-8000-0000000d0101';
const CENTRE = '01a1a98a-ac40-7000-8000-0000000c0001';
const READ = ['instruments.instrument.read'];
const MANAGE = ['instruments.instrument.read', 'instruments.instrument.manage'];
const IM = `${ORIGIN}/v1/instruments/instruments`;
session.permissions = MANAGE;

const driver = (o: Record<string, unknown> = {}) => ({ code: 'astm_generic_e1394', display_name: 'Generic ASTM E1394', protocol: 'astm', status: 'generic', driver_version: '1.0.0', is_active: true, capabilities: { host_query: false, worklist_download: false, qc: true, attachments: false, calibration: false }, ...o });
const DRIVERS = [
  driver(),
  driver({ code: 'astm_verified_x', display_name: 'Synthetic Verified Driver', status: 'verified', capabilities: { host_query: true, worklist_download: false, qc: true, attachments: false, calibration: false } }),
  driver({ code: 'sketch_y', display_name: 'Synthetic Sketch Driver', status: 'sketch_blocked' }),
];
const agents = [{ id: AGENT, agent_code: 'SYN-AGENT-1', display_name: 'Synthetic bench PC', centre_id: CENTRE, status: 'active' }];
const centres = [{ id: CENTRE, name: 'Synthetic Centre A1' }];
const tcpClient = { kind: 'tcp_client', host: '10.0.0.7', port: 5000, connect_timeout_s: 10, reconnect_max_backoff_s: 60 };
const summary = (o: Record<string, unknown> = {}) => ({ id: INST, instrument_code: 'SIM-CHEM-1', display_name: 'Sim chem', vendor: 'Synthetic Vendor', model: 'SV-100', protocol: 'astm', agent_id: AGENT, agent_code: 'SYN-AGENT-1', centre_id: CENTRE, driver_code: 'astm_generic_e1394', driver_status: 'generic', state: 'draft', version: 4, link_state: 'up', last_message_at: '2026-11-07T03:58:00.000Z', unmapped_code_count: 3, ...o });
const full = (o: Record<string, unknown> = {}) => ({ ...summary(), driver_version: '1.0.0', transport: tcpClient, protocol_options: {}, capabilities: { host_query: false, worklist_download: false }, status: { link_state: 'up', last_message_at: '2026-11-07T03:58:00.000Z' }, ...o });

const calls: { method: string; url: URL; headers: Headers; body?: any }[] = [];
const rec = async (r: Request) => { calls.push({ method: r.method, url: new URL(r.url), headers: r.headers, body: r.method === 'GET' ? undefined : await r.clone().json().catch(() => undefined) }); };
const problem = (status: number, code: string, extra: Record<string, unknown> = {}) => HttpResponse.json({ type: `urn:lims:error:${code}`, title: code, status, code, ...extra }, { status });
const listSeen: URL[] = [];
const api = setupServer(
  http.get(`${ORIGIN}/v1/instruments/drivers`, () => HttpResponse.json({ data: DRIVERS })),
  http.get(`${ORIGIN}/v1/instruments/agents`, () => HttpResponse.json({ data: agents.map((a) => ({ ...a, update_channel: 'stable', version: 1, latest_config_version: 1, health: { state: 'online', queue_depth: 0, oldest_pending_age_seconds: 0 } })), page: { limit: 50 } })),
  http.get(`${ORIGIN}/v1/instruments/agents/:id`, () => HttpResponse.json({ ...agents[0], update_channel: 'stable', version: 1, latest_config_version: 1, backlog_threshold: 100, credentials: [], health: { state: 'online', queue_depth: 0, oldest_pending_age_seconds: 0 } })),
  http.get(IM, ({ request }) => { listSeen.push(new URL(request.url)); return HttpResponse.json({ data: [summary()], page: { limit: 50 } }); }),
  http.get(`${IM}/:id`, ({ request }) => { listSeen.push(new URL(request.url)); return HttpResponse.json(full()); }),
  http.post(IM, async ({ request }) => { await rec(request); return HttpResponse.json(full({ state: 'draft', version: 1 }), { status: 201 }); }),
  http.patch(`${IM}/:id`, async ({ request }) => { await rec(request); return HttpResponse.json(full({ version: 5 })); }),
  http.post(`${IM}/:id/:action`, async ({ request }) => { await rec(request); return HttpResponse.json(full({ version: 5 })); }),
);
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { cleanup(); api.resetHandlers(); calls.length = 0; listSeen.length = 0; push.mockReset(); replace.mockReset(); refresh.mockReset(); vi.useRealTimers(); localStorage.clear(); sessionStorage.clear(); session.permissions = MANAGE; });
afterAll(() => api.close());
beforeEach(() => { Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => {}) } }); });

const wrap = (ui: ReactNode) => render(<ToastProvider>{ui}</ToastProvider>);
const noAxeViolations = async () => {
  const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
  expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
};
const bodyHas = (s: string | RegExp) => (typeof s === 'string' ? document.body.textContent!.includes(s) : s.test(document.body.textContent!));
const choose = async (scope: HTMLElement, label: RegExp, option: string | RegExp) => {
  await userEvent.click(within(scope).getByRole('button', { name: label }));
  await userEvent.click(await screen.findByRole('option', { name: option }));
};
const SAVE = /^(create instrument|save)$/i;
const loadForm = async () => (await import('../components/InstrumentForm')).InstrumentForm;
const form = async (props: Record<string, unknown> = {}) => {
  const InstrumentForm = await loadForm();
  wrap(<InstrumentForm mode="edit" instrument={full() as never} agents={agents as never} drivers={DRIVERS as never} permissions={MANAGE} {...(props as object)} />);
  return document.body;
};
const submit = () => userEvent.click(screen.getByRole('button', { name: SAVE }));

describe('SCR-05 InstrumentsList', () => {
  const load = async () => (await import('../components/InstrumentsList')).InstrumentsList;
  const rows = [
    summary(),
    summary({ id: '01a1a98a-ac40-7000-8000-0000000e0002', instrument_code: 'SIM-CHEM-2', display_name: 'Verified chem', driver_status: 'verified', state: 'live', unmapped_code_count: 0 }),
    summary({ id: '01a1a98a-ac40-7000-8000-0000000e0003', instrument_code: 'SIM-HEM-1', display_name: 'Sketchy', driver_status: 'sketch_blocked', state: 'commissioning', unmapped_code_count: 12 }),
    summary({ id: '01a1a98a-ac40-7000-8000-0000000e0004', instrument_code: 'SIM-OLD-1', display_name: 'Old one', state: 'retired', unmapped_code_count: 0 }),
    summary({ id: '01a1a98a-ac40-7000-8000-0000000e0005', instrument_code: 'SIM-SUS-1', display_name: 'Paused', state: 'suspended', unmapped_code_count: 0 }),
  ];
  const props = (o: Record<string, unknown> = {}) => ({ instruments: rows, permissions: READ, centres, agents, drivers: DRIVERS, ...o }) as never;

  it('renders the 04-UI-UX columns; instrument code is a row header linking to SCR-07', async () => {
    const InstrumentsList = await load();
    wrap(<InstrumentsList {...props()} />);
    // anchored: "State chip" and "Link state" are both headers (04-UI-UX.md:122), see WEB-T02-ruling item 2.
    // Ruling r2: spec col is "Vendor/Model" and "Unmapped codes" (04-UI-UX.md:122); other headers stay anchored.
    const cols: RegExp[] = [...['Code', 'Name', 'Protocol', 'Agent', 'Driver', 'State', 'Link state', 'Last message'].map((h) => new RegExp(`^${h}$`, 'i')), /^Vendor\s*\/\s*Model$/i, /^Unmapped( codes)?$/i];
    for (const re of cols) expect(screen.getByRole('columnheader', { name: re }), String(re)).toBeTruthy();
    const link = screen.getByRole('link', { name: 'SIM-CHEM-1' });
    expect(link.getAttribute('href')).toBe(`/instruments/instruments/${INST}`);
    expect(link.closest('[role="rowheader"], th')).toBeTruthy();
    expect(bodyHas('Synthetic Vendor')).toBe(true);
    expect(bodyHas('SV-100')).toBe(true);
    expect(bodyHas('SYN-AGENT-1')).toBe(true);
  });

  it('driver status badges always carry text: Generic / Verified / "Sketch — not for live use"; state chips carry text', async () => {
    const InstrumentsList = await load();
    wrap(<InstrumentsList {...props()} />);
    for (const t of ['Generic', 'Verified', 'Sketch — not for live use']) expect(screen.getAllByText(t).length, t).toBeGreaterThan(0);
    for (const t of [/^draft$/i, /^commissioning$/i, /^live$/i, /^suspended$/i, /^retired$/i]) expect(screen.getAllByText(t).length, String(t)).toBeGreaterThan(0);
  });

  it('unmapped codes are text "N unmapped" linking to SCR-08 (mappings)', async () => {
    const InstrumentsList = await load();
    wrap(<InstrumentsList {...props()} />);
    const l = screen.getByRole('link', { name: '3 unmapped' });
    expect(l.getAttribute('href')).toBe(`/instruments/instruments/${INST}/mappings`);
    expect(screen.getByRole('link', { name: '12 unmapped' })).toBeTruthy();
  });

  it('empty state uses "No instruments registered."; "New instrument" only with instruments.instrument.manage', async () => {
    const InstrumentsList = await load();
    const { unmount } = wrap(<InstrumentsList {...props({ instruments: [] })} />);
    expect(screen.getByText('No instruments registered.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /new instrument/i })).toBeNull();
    unmount();
    wrap(<InstrumentsList {...props({ instruments: [], permissions: MANAGE })} />);
    expect(screen.getAllByRole('button', { name: /new instrument/i }).length).toBeGreaterThan(0);
  });

  it('FilterBar: Centre, Agent, State, Protocol; picking the Retired state navigates with state= (E23 name)', async () => {
    const InstrumentsList = await load();
    wrap(<InstrumentsList {...props()} />);
    const bar = screen.getByRole('search');
    for (const l of ['Centre', 'Agent', 'State', 'Protocol']) expect(within(bar).getByText(l, { selector: 'label, .lims-label, span' })).toBeTruthy();
    await userEvent.click(within(bar).getByRole('option', { name: /retired/i }));
    const urls = [...push.mock.calls, ...replace.mock.calls].map((c) => String(c[0]));
    expect(urls.some((u) => /state=[^&]*retired/.test(decodeURIComponent(u)))).toBe(true);
  });

  it('"New instrument" opens the SCR-06 form in a dialog; nothing is sent until submit', async () => {
    const InstrumentsList = await load();
    wrap(<InstrumentsList {...props({ permissions: MANAGE })} />);
    await userEvent.click(screen.getAllByRole('button', { name: /new instrument/i })[0]!);
    const dlg = screen.getByRole('dialog');
    expect(within(dlg).getByLabelText(/^code/i)).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  // LD-79: global keys are Alt+N/Alt+M/Alt+H, so SCR-05 "New instrument" is Alt+I (CR-C7-WEB-T03-a).
  it('page-level Alt+I "New instrument" is registered for manage only and unregistered on unmount; Alt+N is never registered (LD-79)', async () => {
    const InstrumentsList = await load();
    const key = async (re: RegExp) => (await import('@/core/shortcuts/registry')).shortcuts.list('staff.instruments.instruments').find((s) => re.test(s.key));
    const altI = () => key(/^alt\+i$/i);
    const a = wrap(<InstrumentsList {...props({ permissions: READ })} />);
    expect(await altI()).toBeUndefined();
    a.unmount();
    wrap(<InstrumentsList {...props({ permissions: MANAGE })} />);
    const sc = await altI();
    expect(sc?.description).toBe('New instrument');
    expect(await key(/^alt\+n$/i)).toBeUndefined();
    act(() => sc!.run());
    expect(within(await screen.findByRole('dialog')).getByLabelText(/^code/i)).toBeTruthy();
    cleanup();
    expect(await altI()).toBeUndefined();
  });

  it('help for instruments.instruments advertises Alt+I "New instrument" and not the global Alt+N (LD-79)', async () => {
    const help = (await import('../help/instruments.instruments')).default;
    const keys = help.shortcuts.map((s: { keys: string }) => s.keys);
    expect(keys).toContain('Alt+I');
    expect(keys).not.toContain('Alt+N');
    expect(help.shortcuts.find((s: { keys: string }) => s.keys === 'Alt+I').action).toBe('New instrument');
  });

  it('SECURITY: display names are rendered as text, never HTML', async () => {
    const InstrumentsList = await load();
    const evil = '<img src=x onerror=alert(1)>';
    wrap(<InstrumentsList {...props({ instruments: [summary({ display_name: evil, vendor: '<script>alert(1)</script>' })] })} />);
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
    expect(bodyHas(evil)).toBe(true);
  });

  it('axe: populated, empty, and with the create dialog open', async () => {
    const InstrumentsList = await load();
    const a = wrap(<InstrumentsList {...props({ permissions: MANAGE })} />);
    await noAxeViolations();
    await userEvent.click(screen.getAllByRole('button', { name: /new instrument/i })[0]!);
    await noAxeViolations();
    a.unmount();
    wrap(<InstrumentsList {...props({ instruments: [], permissions: MANAGE })} />);
    await noAxeViolations();
  });
});

describe('SCR-06 InstrumentForm — create (AC-03.1, AC-03.2, AC-03.6)', () => {
  const open = async () => {
    const InstrumentForm = await loadForm();
    wrap(<InstrumentForm mode="create" agents={agents as never} drivers={DRIVERS as never} permissions={MANAGE} />);
    return document.body;
  };
  const fill = async (b: HTMLElement) => {
    await userEvent.type(within(b).getByLabelText(/^code/i), 'SIM-CHEM-1');
    await userEvent.type(within(b).getByLabelText(/^name/i), 'Sim chem');
    await userEvent.type(within(b).getByLabelText(/^vendor/i), 'Synthetic Vendor');
    await userEvent.type(within(b).getByLabelText(/^model/i), 'SV-100');
    await choose(b, /agent/i, /SYN-AGENT-1/);
    await userEvent.click(within(b).getByRole('radio', { name: /astm/i }));
    await choose(b, /transport kind/i, /serial/i);
    await userEvent.type(within(b).getByLabelText(/^port/i), 'COM3');
    await choose(b, /baud/i, '9600');
    await choose(b, /data bits/i, '8');
    await choose(b, /parity/i, /^none$/i);
    await choose(b, /stop bits/i, '1');
    await choose(b, /driver/i, /Generic ASTM/);
  };

  it('has the six 04-UI-UX sections; "Advanced link settings" is collapsed by default', async () => {
    const b = await open();
    for (const h of ['Identity', 'Connection', 'Driver', 'Capabilities', 'Monitoring']) expect(within(b).getByText(h, { selector: 'h2,h3,h4,[role="heading"],legend' }), h).toBeTruthy();
    const adv = within(b).getByText('Advanced link settings');
    expect(adv).toBeTruthy();
    expect(within(b).queryByLabelText(/max outbound retry cycles/i)).toBeNull();
    await userEvent.click(adv);
    expect(within(b).getByLabelText(/max outbound retry cycles/i)).toBeTruthy();
    expect(b.textContent).toContain('Default values, taken from a published vendor implementation of LIS1-A. Use the values in this instrument\'s manual when it gives them.');
  });

  it('Identity: software version help text; serial no / software version optional', async () => {
    const b = await open();
    expect(b.textContent).toContain("Interface behaviour can change with software version — record it from the instrument's About screen.");
    for (const [label, max] of [['code', 32], ['name', 80], ['vendor', 60], ['model', 60]] as const) expect(Number((within(b).getByLabelText(new RegExp(`^${label}`, 'i')) as HTMLInputElement).getAttribute('maxlength')), label).toBe(max);
  });

  it('AC-03.1: fills the form → ONE POST E24 with typed values, Idempotency-Key, then navigates to SCR-07', async () => {
    const b = await open();
    await fill(b);
    await userEvent.click(screen.getByRole('button', { name: SAVE }));
    await waitFor(() => expect(calls).toHaveLength(1));
    const c = calls[0]!;
    expect(c.method).toBe('POST');
    expect(c.url.pathname).toBe('/v1/instruments/instruments');
    expect(c.headers.get('idempotency-key')).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(c.body).toMatchObject({
      instrument_code: 'SIM-CHEM-1', display_name: 'Sim chem', vendor: 'Synthetic Vendor', model: 'SV-100', agent_id: AGENT, protocol: 'astm', driver_code: 'astm_generic_e1394',
      transport: { kind: 'serial', port_name: 'COM3', baud_rate: 9600, data_bits: 8, parity: 'none', stop_bits: '1' },
      capabilities: { host_query: false, worklist_download: false },
    });
    expect(c.body.transport.dtr ?? true).toBe(true);
    expect(c.body.transport.rts ?? true).toBe(true);
    expect('state' in c.body).toBe(false); // server decides: new instruments are draft
    await waitFor(() => expect(push).toHaveBeenCalledWith(`/instruments/instruments/${INST}`));
  });

  it('double submit (Ctrl+Enter twice) creates one instrument; a retry after failure reuses the same Idempotency-Key', async () => {
    let n = 0;
    api.use(http.post(IM, async ({ request }) => { await rec(request); await new Promise((r) => setTimeout(r, 120)); return ++n === 1 ? problem(500, 'common.internal') : HttpResponse.json(full({ version: 1 }), { status: 201 }); }));
    const b = await open();
    await fill(b);
    await userEvent.keyboard('{Control>}{Enter}{Enter}{/Control}');
    await screen.findByRole('alert');
    expect(calls).toHaveLength(1);
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(calls).toHaveLength(2);
    expect(calls[1]!.headers.get('idempotency-key')).toBe(calls[0]!.headers.get('idempotency-key'));
  });

  it('invalid code (^[A-Z0-9-]{2,32}$) blocks submit — no API call, field flagged invalid', async () => {
    const b = await open();
    await userEvent.type(within(b).getByLabelText(/^code/i), 'a');
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    await new Promise((r) => setTimeout(r, 100));
    expect(calls).toHaveLength(0);
    expect(push).not.toHaveBeenCalled();
    expect(b.querySelectorAll('[aria-invalid="true"]').length + within(b).queryAllByRole('alert').length).toBeGreaterThan(0);
  });

  it('transport fields switch with the kind: serial / tcp_client / tcp_server (02-TRD §5.8)', async () => {
    const b = await open();
    await userEvent.click(within(b).getByRole('radio', { name: /astm/i }));
    await choose(b, /transport kind/i, /serial/i);
    for (const l of [/^port/i, /baud/i, /data bits/i, /parity/i, /stop bits/i, /dtr/i, /rts/i]) expect(within(b).getByLabelText(l), String(l)).toBeTruthy();
    expect(b.textContent).toContain("Use the values from the instrument's LIS/host interface manual.");
    await choose(b, /transport kind/i, /tcp client/i);
    for (const l of [/^host$/i, /^port/i, /connect timeout/i, /reconnect max back-off/i]) expect(within(b).getByLabelText(l), String(l)).toBeTruthy();
    expect(within(b).queryByLabelText(/baud/i)).toBeNull();
    await choose(b, /transport kind/i, /tcp server/i);
    for (const l of [/listen address/i, /^port/i, /allowed instrument addresses/i]) expect(within(b).getByLabelText(l), String(l)).toBeTruthy();
    expect(b.textContent).toContain("The agent will accept connections on the lab network. Run 'bridge-agent firewall enable' on the PC.");
  });

  it('transport kind options are filtered by protocol: Folder only offers no serial/tcp', async () => {
    const b = await open();
    await userEvent.click(within(b).getByRole('radio', { name: /folder only/i }));
    expect(within(b).queryByLabelText(/baud/i)).toBeNull();
    expect(within(b).queryByLabelText(/connect timeout/i)).toBeNull();
    expect(within(b).getByLabelText(/folder path/i)).toBeTruthy();
  });

  it('Driver select shows each driver with its status (Generic / Verified / Sketch)', async () => {
    const b = await open();
    await userEvent.click(within(b).getByRole('button', { name: /driver/i }));
    const opts = await screen.findAllByRole('option');
    const text = opts.map((o) => o.textContent).join('|');
    expect(text).toMatch(/Generic ASTM E1394.*Generic/);
    expect(text).toMatch(/Synthetic Verified Driver.*Verified/);
  });

  it('AC-03.6: 409 instruments.code_duplicate → error on the Code field, no navigation', async () => {
    api.use(http.post(IM, () => problem(409, 'instruments.code_duplicate')));
    const b = await open();
    await fill(b);
    await userEvent.click(screen.getByRole('button', { name: SAVE }));
    const code = within(b).getByLabelText(/^code/i);
    await waitFor(() => expect(code.getAttribute('aria-invalid')).toBe('true'));
    const desc = (code.getAttribute('aria-describedby') ?? '').split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
    expect(desc).toMatch(/already/i);
    expect(push).not.toHaveBeenCalled();
  });

  it('AC-03.2: 400 common.validation_failed errors[] are mapped by JSON Pointer to their fields; unmapped paths surface in a form-level alert (never dropped)', async () => {
    api.use(http.post(IM, () => problem(400, 'common.validation_failed', { errors: [
      { path: '/vendor', code: 'common.field_required', message: 'vendor is required' },
      { path: '/transport/port_name', code: 'common.pattern', message: 'port_name must look like COM3' },
      { path: '/silence_active_from', code: 'common.pattern', message: 'must be HH:MM' },
      { path: '/something/unknown', code: 'common.invalid', message: 'unmapped problem <b>bold</b>' },
    ] })));
    const b = await open();
    await fill(b);
    await userEvent.click(screen.getByRole('button', { name: SAVE }));
    const described = async (label: RegExp) => {
      const el = within(b).getByLabelText(label);
      await waitFor(() => expect(el.getAttribute('aria-invalid')).toBe('true'));
      return (el.getAttribute('aria-describedby') ?? '').split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
    };
    expect(await described(/^vendor/i)).toContain('vendor is required');
    expect(await described(/^port/i)).toContain('port_name must look like COM3');
    expect(await described(/active from/i)).toContain('must be HH:MM');
    expect(within(b).getAllByRole('alert').map((a) => a.textContent).join(' ')).toContain('unmapped problem');
    expect(document.querySelector('b')).toBeNull(); // server text is text, not HTML
    expect(push).not.toHaveBeenCalled();
  });

  it('AC-03.2 client side: TCP port outside 1–65535 blocks submit (schema-driven), message on the Port field', async () => {
    const b = await open();
    await fill(b);
    await choose(b, /transport kind/i, /tcp client/i);
    await userEvent.type(within(b).getByLabelText(/^host$/i), '10.0.0.7');
    const port = within(b).getByLabelText(/^port/i);
    await userEvent.clear(port);
    await userEvent.type(port, '70000');
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    await new Promise((r) => setTimeout(r, 100));
    expect(calls).toHaveLength(0);
    expect(port.getAttribute('aria-invalid')).toBe('true');
  });

  it('403 auth.mfa_required on save → banner "Confirm with your authenticator to continue"', async () => {
    api.use(http.post(IM, () => problem(403, 'auth.mfa_required')));
    const b = await open();
    await fill(b);
    await userEvent.click(screen.getByRole('button', { name: SAVE }));
    expect(await screen.findByText(/Confirm with your authenticator to continue/)).toBeTruthy();
  });

  it('axe: create form and tcp_server variant', async () => {
    const b = await open();
    await noAxeViolations();
    await userEvent.click(within(b).getByRole('radio', { name: /astm/i }));
    await choose(b, /transport kind/i, /tcp server/i);
    await noAxeViolations();
  });
});

describe('SCR-06 InstrumentForm — edit (AC-03.2..03.5)', () => {
  it('Code and Agent are immutable after create (disabled/read-only)', async () => {
    const b = await form();
    const code = within(b).getByLabelText(/^code/i) as HTMLInputElement;
    expect(code.value).toBe('SIM-CHEM-1');
    expect(code.disabled || code.readOnly).toBe(true);
    const agent = within(b).getByRole('button', { name: /agent/i });
    expect(agent.hasAttribute('disabled') || agent.getAttribute('aria-disabled') === 'true').toBe(true);
  });

  it('AC-03.5: Save → PATCH E26 with If-Match "<version>", never sends instrument_code / agent_id, toast "Saved. The agent picks this up within a minute."', async () => {
    const b = await form();
    const name = within(b).getByLabelText(/^name/i);
    await userEvent.clear(name);
    await userEvent.type(name, 'Renamed chem');
    await submit();
    await waitFor(() => expect(calls).toHaveLength(1));
    const c = calls[0]!;
    expect(c.method).toBe('PATCH');
    expect(c.url.pathname).toBe(`/v1/instruments/instruments/${INST}`);
    expect(c.headers.get('if-match')).toBe('"4"');
    expect(c.body).toMatchObject({ display_name: 'Renamed chem' });
    expect('instrument_code' in c.body || 'agent_id' in c.body).toBe(false);
    expect(await screen.findByText('Saved. The agent picks this up within a minute.')).toBeTruthy();
    expect(refresh).toHaveBeenCalled();
  });

  it('409 common.version_conflict → alert, no success toast (someone else changed the instrument)', async () => {
    api.use(http.patch(`${IM}/:id`, () => problem(409, 'common.version_conflict')));
    const b = await form();
    await userEvent.type(within(b).getByLabelText(/^name/i), 'x');
    await submit();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/version_conflict|changed|reload/i);
    expect(bodyHas('Saved. The agent picks this up')).toBe(false);
  });

  it('AC-03.2: tcp_client port rejected by the server (400 /transport/port) is shown beside Port', async () => {
    api.use(http.patch(`${IM}/:id`, () => problem(400, 'common.validation_failed', { errors: [{ path: '/transport/port', code: 'common.out_of_range', message: 'port must be between 1 and 65535' }] })));
    const b = await form();
    await userEvent.type(within(b).getByLabelText(/^name/i), 'x');
    await submit();
    const port = within(b).getByLabelText(/^port/i);
    await waitFor(() => expect(port.getAttribute('aria-invalid')).toBe('true'));
    expect((port.getAttribute('aria-describedby') ?? '').split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ')).toContain('port must be between 1 and 65535');
  });

  it('AC-03.3: Host query is disabled with a reason when the driver does not declare host_query; enabled when it does', async () => {
    const b = await form();
    const sw = within(b).getByRole('switch', { name: /host query/i }) as HTMLInputElement;
    expect(sw.disabled || sw.getAttribute('aria-disabled') === 'true').toBe(true);
    const reason = (sw.getAttribute('aria-describedby') ?? '').split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
    expect(reason).toMatch(/driver/i);
    cleanup();
    const b2 = await form({ instrument: full({ driver_code: 'astm_verified_x', driver_status: 'verified' }) as never });
    const sw2 = within(b2).getByRole('switch', { name: /host query/i }) as HTMLInputElement;
    expect(sw2.disabled).toBe(false);
  });

  it('AC-03.3: 422 instruments.capability_not_supported for host_query is shown at the Host query switch; no success toast', async () => {
    api.use(http.patch(`${IM}/:id`, async ({ request }) => { await rec(request); return problem(422, 'instruments.capability_not_supported', { errors: [{ path: '/capabilities/host_query', code: 'instruments.capability_not_supported', message: 'The driver does not support host query.' }] }); }));
    const b = await form({ instrument: full({ driver_code: 'astm_verified_x', driver_status: 'verified' }) as never });
    await userEvent.click(within(b).getByRole('switch', { name: /host query/i }));
    await submit();
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body.capabilities).toMatchObject({ host_query: true });
    const sw = within(b).getByRole('switch', { name: /host query/i });
    await waitFor(() => expect(bodyHas('The driver does not support host query.')).toBe(true));
    expect(sw.getAttribute('aria-invalid') === 'true' || (sw.getAttribute('aria-describedby') ?? '').length > 0 || within(b).queryAllByRole('alert').length > 0).toBe(true);
    expect(bodyHas('Saved. The agent picks this up')).toBe(false);
  });

  it('AC-03.4: Worklist download is always disabled with "Not available yet" and is never sent as true', async () => {
    const b = await form({ instrument: full({ driver_code: 'astm_verified_x', driver_status: 'verified' }) as never });
    const sw = within(b).getByRole('switch', { name: /worklist download/i }) as HTMLInputElement;
    expect(sw.disabled || sw.getAttribute('aria-disabled') === 'true').toBe(true);
    expect(b.textContent).toContain('Not available yet');
    await userEvent.click(sw);
    expect(sw.checked).toBe(false);
    await userEvent.type(within(b).getByLabelText(/^name/i), 'x');
    await submit();
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body.capabilities?.worklist_download ?? false).toBe(false);
  });

  it('Picture/PDF folder switch reveals the file-drop fields; barcode pattern needs the (?P<barcode>…) group (exact 04-UI-UX message) and blocks submit', async () => {
    const b = await form();
    await userEvent.click(within(b).getByRole('switch', { name: /picture\/pdf folder/i }));
    for (const l of [/folder path/i, /file name pattern/i, /barcode pattern/i, /stable seconds/i, /move after capture/i, /captured subfolder/i, /attachment code/i]) expect(within(b).getByLabelText(l), String(l)).toBeTruthy();
    for (const t of [/pdf/i, /png/i, /jpeg/i]) expect(within(b).getByRole('checkbox', { name: t })).toBeTruthy();
    const bc = within(b).getByLabelText(/barcode pattern/i);
    await userEvent.type(bc, '^(\\d+)$');
    await userEvent.tab();
    expect(b.textContent).toContain('Include a named group (?P<barcode>…) that captures the sample barcode');
    await submit();
    await new Promise((r) => setTimeout(r, 100));
    expect(calls).toHaveLength(0);
    await userEvent.clear(bc);
    await userEvent.type(bc, '(?P<barcode>\\d+)');
    await userEvent.tab();
    expect(b.textContent).not.toContain('Include a named group');
  });

  it('file-drop fields validate: folder must be an absolute Windows path, captured subfolder ^[A-Za-z0-9_-]{1,60}$', async () => {
    const b = await form();
    await userEvent.click(within(b).getByRole('switch', { name: /picture\/pdf folder/i }));
    await userEvent.type(within(b).getByLabelText(/folder path/i), '..\\relative');
    await userEvent.type(within(b).getByLabelText(/captured subfolder/i), '../escape');
    await userEvent.tab();
    expect(within(b).getByLabelText(/folder path/i).getAttribute('aria-invalid')).toBe('true');
    expect(within(b).getByLabelText(/captured subfolder/i).getAttribute('aria-invalid')).toBe('true');
    await submit();
    await new Promise((r) => setTimeout(r, 100));
    expect(calls).toHaveLength(0);
  });

  it('Monitoring: silence window is 15–1440 minutes; active from/to are HH:MM', async () => {
    const b = await form();
    const w = within(b).getByLabelText(/silence window/i);
    await userEvent.type(w, '5');
    await userEvent.type(within(b).getByLabelText(/active from/i), '25:99');
    await userEvent.tab();
    expect(w.getAttribute('aria-invalid')).toBe('true');
    expect(within(b).getByLabelText(/active from/i).getAttribute('aria-invalid')).toBe('true');
    await submit();
    await new Promise((r) => setTimeout(r, 100));
    expect(calls).toHaveLength(0);
  });

  it('Advanced link settings: Max outbound retry cycles is 1–10 (default 3 for ASTM)', async () => {
    const b = await form();
    await userEvent.click(within(b).getByText('Advanced link settings'));
    const f = within(b).getByLabelText(/max outbound retry cycles/i) as HTMLInputElement;
    expect(f.value).toBe('3');
    await userEvent.clear(f);
    await userEvent.type(f, '11');
    await userEvent.tab();
    expect(f.getAttribute('aria-invalid')).toBe('true');
  });

  it('without instruments.instrument.manage the form is read-only: no Save button, fields not editable', async () => {
    const b = await form({ permissions: READ });
    expect(screen.queryByRole('button', { name: SAVE })).toBeNull();
    const name = within(b).getByLabelText(/^name/i) as HTMLInputElement;
    expect(name.disabled || name.readOnly).toBe(true);
  });

  it('axe: edit form (tcp_client) and file-drop variant', async () => {
    const b = await form();
    await noAxeViolations();
    await userEvent.click(within(b).getByRole('switch', { name: /picture\/pdf folder/i }));
    await noAxeViolations();
  });
});

describe('SCR-07 InstrumentDetail — header, actions by state, tabs', () => {
  const load = async () => (await import('../components/InstrumentDetail')).InstrumentDetail;
  const show = async (o: Record<string, unknown> = {}, permissions: readonly string[] = MANAGE, drivers: unknown = DRIVERS) => {
    const InstrumentDetail = await load();
    return wrap(<InstrumentDetail instrument={full(o) as never} agents={agents as never} drivers={drivers as never} permissions={permissions} />);
  };
  const btn = (n: RegExp | string) => screen.queryByRole('button', { name: n });
  const ACTIONS = { start: /^start commissioning$/i, live: /^go live$/i, suspend: /^suspend$/i, resume: /^resume$/i, retire: /^retire$/i };

  it('header "CODE — name" with a state chip carrying text', async () => {
    await show({ state: 'live' });
    expect(screen.getByRole('heading', { name: /SIM-CHEM-1\s+—\s+Sim chem/ })).toBeTruthy();
    expect(screen.getAllByText(/^live$/i).length).toBeGreaterThan(0);
  });

  it.each([
    ['draft', ['start', 'retire']],
    ['commissioning', ['live', 'retire']],
    ['live', ['suspend', 'retire']],
    ['suspended', ['resume', 'retire']],
    ['retired', []],
  ] as const)('AC-04.5 (UI): in state %s only the transitions the state machine allows are offered', async (state, allowed) => {
    await show({ state });
    for (const [k, re] of Object.entries(ACTIONS)) expect(!!btn(re), `${state}:${k}`).toBe((allowed as readonly string[]).includes(k));
  });

  it('read-only (no manage): no commissioning action in any state; Mappings and Messages links remain', async () => {
    for (const state of ['draft', 'commissioning', 'live', 'suspended']) {
      cleanup();
      await show({ state }, READ);
      for (const re of Object.values(ACTIONS)) expect(btn(re), `${state}:${re}`).toBeNull();
      expect(screen.getByRole('link', { name: /mappings/i }).getAttribute('href')).toBe(`/instruments/instruments/${INST}/mappings`);
      const m = screen.getByRole('link', { name: /messages/i }).getAttribute('href')!;
      expect(m).toContain('/instruments/messages');
      expect(m).toContain(`instrument_id=${INST}`);
    }
  });

  it('tabs Overview · Configuration · History; Overview shows link state, driver + version, go-live record', async () => {
    await show({ state: 'live', driver_code: 'astm_verified_x', driver_status: 'verified', live_at: '2026-11-06T04:00:00.000Z', live_by_display: 'Synthetic Manager', go_live_checklist: { manual_reference_confirmed: true, sample_comparison_done: true, qc_comparison_done: true, mappings_reviewed: true } });
    for (const t of ['Overview', 'Configuration', 'History']) expect(screen.getByRole('tab', { name: t })).toBeTruthy();
    expect(bodyHas('Synthetic Manager')).toBe(true);
    expect(bodyHas('1.0.0')).toBe(true);
    await userEvent.click(screen.getByRole('tab', { name: 'Configuration' }));
    expect(screen.getByLabelText(/^code/i)).toBeTruthy();
  });

  it('Alt+P "Open mappings" (SCR-07; Alt+M is global) navigates to SCR-08', async () => {
    await show({ state: 'live' });
    const sc = (await import('@/core/shortcuts/registry')).shortcuts.list('staff.instruments.instrument').find((s) => /^alt\+p$/i.test(s.key));
    expect(sc?.description).toBe('Open mappings');
    act(() => sc!.run());
    expect(push).toHaveBeenCalledWith(`/instruments/instruments/${INST}/mappings`);
  });

  it('SECURITY: names from the API are text, never HTML', async () => {
    await show({ display_name: '<img src=x onerror=alert(1)>' });
    expect(document.querySelector('img')).toBeNull();
  });

  it('axe: every tab', async () => {
    await show({ state: 'live' });
    for (const t of ['Overview', 'Configuration', 'History']) {
      await userEvent.click(screen.getByRole('tab', { name: t }));
      await noAxeViolations();
    }
  });
});

describe('SCR-07 commissioning actions (AC-04.1..04.5)', () => {
  const load = async () => (await import('../components/InstrumentDetail')).InstrumentDetail;
  const show = async (o: Record<string, unknown> = {}, permissions: readonly string[] = MANAGE) => {
    const InstrumentDetail = await load();
    return wrap(<InstrumentDetail instrument={full(o) as never} agents={agents as never} drivers={DRIVERS as never} permissions={permissions} />);
  };
  const click = (n: RegExp | string) => userEvent.click(screen.getByRole('button', { name: n }));
  const dlgConfirm = (dlg: HTMLElement, n: RegExp | string) => userEvent.click(within(dlg).getByRole('button', { name: n }));
  const CHECKS = ['The official interface manual for this model and software version is on file', 'Patient-sample comparison with the instrument printout is done', 'QC values compared', 'Code mappings reviewed'];
  const NOTE = 'Compared 10 patient samples and 3 QC levels with the printout.';

  it('AC-04.1: Start commissioning → POST E27 once with If-Match, then the page refreshes (double click = one call)', async () => {
    await show({ state: 'draft' });
    await userEvent.dblClick(screen.getByRole('button', { name: /^start commissioning$/i }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url.pathname).toBe(`/v1/instruments/instruments/${INST}/start-commissioning`);
    expect(calls[0]!.headers.get('if-match')).toBe('"4"');
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(calls).toHaveLength(1);
  });

  it('AC-04.1: 422 instruments.driver_not_available on start → danger alert carrying the code; no refresh-as-success', async () => {
    api.use(http.post(`${IM}/:id/start-commissioning`, () => problem(422, 'instruments.driver_not_available')));
    await show({ state: 'draft' });
    await click(/^start commissioning$/i);
    const a = await screen.findByRole('alert');
    expect(a.textContent).toMatch(/driver_not_available|driver/i);
  });

  it('AC-04.5: 409 instruments.invalid_transition → alert naming the problem and the page re-reads (stale buttons disappear)', async () => {
    api.use(http.post(`${IM}/:id/start-commissioning`, () => problem(409, 'instruments.invalid_transition')));
    await show({ state: 'draft' });
    await click(/^start commissioning$/i);
    const a = await screen.findByRole('alert');
    expect(a.textContent).toMatch(/invalid_transition|not allowed|no longer/i);
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  describe('Go live dialog (AC-04.2, AC-04.3)', () => {
    const open = async (o: Record<string, unknown> = {}) => {
      await show({ state: 'commissioning', driver_code: 'astm_verified_x', driver_status: 'verified', ...o });
      await click(/^go live$/i);
      return screen.getByRole('dialog');
    };
    const checkAll = async (dlg: HTMLElement) => { for (const c of CHECKS) await userEvent.click(within(dlg).getByRole('checkbox', { name: c })); };

    it('shows the four checkboxes with the 04-UI-UX labels (unchecked) and an Evidence note (max 2000); nothing sent on open', async () => {
      const dlg = await open();
      for (const c of CHECKS) expect((within(dlg).getByRole('checkbox', { name: c }) as HTMLInputElement).checked, c).toBe(false);
      const note = within(dlg).getByLabelText(/evidence note/i);
      expect(note.getAttribute('maxlength')).toBe('2000');
      expect(calls).toHaveLength(0);
    });

    it('AC-04.3: all four checked + note ≥ 10 chars → POST E28 {checklist, evidence_note} with If-Match; dialog closes and the page refreshes', async () => {
      const dlg = await open();
      await checkAll(dlg);
      await userEvent.type(within(dlg).getByLabelText(/evidence note/i), NOTE);
      await dlgConfirm(dlg, /go live/i);
      await waitFor(() => expect(calls).toHaveLength(1));
      expect(calls[0]!.url.pathname).toBe(`/v1/instruments/instruments/${INST}/go-live`);
      expect(calls[0]!.headers.get('if-match')).toBe('"4"');
      expect(calls[0]!.body).toEqual({ checklist: { manual_reference_confirmed: true, sample_comparison_done: true, qc_comparison_done: true, mappings_reviewed: true }, evidence_note: NOTE });
      await waitFor(() => expect(refresh).toHaveBeenCalled());
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    it('AC-04.3: any unchecked item, or a note shorter than 10 characters → no request is sent', async () => {
      const dlg = await open();
      await userEvent.click(within(dlg).getByRole('checkbox', { name: CHECKS[0]! }));
      await userEvent.click(within(dlg).getByRole('checkbox', { name: CHECKS[1]! }));
      await userEvent.click(within(dlg).getByRole('checkbox', { name: CHECKS[2]! }));
      await userEvent.type(within(dlg).getByLabelText(/evidence note/i), NOTE);
      await dlgConfirm(dlg, /go live/i); // 4th item missing
      await new Promise((r) => setTimeout(r, 100));
      expect(calls).toHaveLength(0);
      await userEvent.click(within(dlg).getByRole('checkbox', { name: CHECKS[3]! }));
      const note = within(dlg).getByLabelText(/evidence note/i);
      await userEvent.clear(note);
      await userEvent.type(note, 'too short');
      await dlgConfirm(dlg, /go live/i);
      await new Promise((r) => setTimeout(r, 100));
      expect(calls).toHaveLength(0);
    });

    it('AC-04.3: server 422 instruments.go_live_checklist_incomplete is shown inside the dialog (it stays open)', async () => {
      api.use(http.post(`${IM}/:id/go-live`, () => problem(422, 'instruments.go_live_checklist_incomplete')));
      const dlg = await open();
      await checkAll(dlg);
      await userEvent.type(within(dlg).getByLabelText(/evidence note/i), NOTE);
      await dlgConfirm(dlg, /go live/i);
      const a = await within(screen.getByRole('dialog')).findByRole('alert');
      expect(a.textContent).toMatch(/checklist|go_live_checklist_incomplete/i);
      expect(screen.queryByRole('dialog')).toBeTruthy();
    });

    it.each(['generic', 'sketch_blocked'])('AC-04.2: driver status %s → blocking danger banner with the B2 text and Go live cannot be sent', async (status) => {
      const dlg = await open({ driver_code: status === 'generic' ? 'astm_generic_e1394' : 'sketch_y', driver_status: status });
      expect(dlg.textContent).toContain('This driver is not verified against an official manual. The instrument cannot go live.');
      await checkAll(dlg);
      await userEvent.type(within(dlg).getByLabelText(/evidence note/i), NOTE);
      await dlgConfirm(dlg, /go live/i);
      await new Promise((r) => setTimeout(r, 100));
      expect(calls).toHaveLength(0);
    });

    it('verified driver → no blocking banner', async () => {
      const dlg = await open();
      expect(dlg.textContent).not.toContain('This driver is not verified');
    });

    it('AC-04.2: server 422 instruments.driver_not_available (driver changed meanwhile) is shown in the dialog', async () => {
      api.use(http.post(`${IM}/:id/go-live`, () => problem(422, 'instruments.driver_not_available')));
      const dlg = await open();
      await checkAll(dlg);
      await userEvent.type(within(dlg).getByLabelText(/evidence note/i), NOTE);
      await dlgConfirm(dlg, /go live/i);
      const a = await within(screen.getByRole('dialog')).findByRole('alert');
      expect(a.textContent).toMatch(/driver/i);
    });

    it('403 auth.mfa_required (privileged op at aal1) → banner "Confirm with your authenticator to continue"', async () => {
      api.use(http.post(`${IM}/:id/go-live`, () => problem(403, 'auth.mfa_required')));
      const dlg = await open();
      await checkAll(dlg);
      await userEvent.type(within(dlg).getByLabelText(/evidence note/i), NOTE);
      await dlgConfirm(dlg, /go live/i);
      expect(await screen.findByText(/Confirm with your authenticator to continue/)).toBeTruthy();
    });

    it('double click on the confirm button sends ONE request', async () => {
      const dlg = await open();
      await checkAll(dlg);
      await userEvent.type(within(dlg).getByLabelText(/evidence note/i), NOTE);
      await userEvent.dblClick(within(dlg).getByRole('button', { name: /go live/i }));
      await waitFor(() => expect(calls.length).toBeGreaterThan(0));
      await new Promise((r) => setTimeout(r, 100));
      expect(calls).toHaveLength(1);
    });

    it('the evidence note is never written to console or storage', async () => {
      const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
      const dlg = await open();
      await checkAll(dlg);
      await userEvent.type(within(dlg).getByLabelText(/evidence note/i), NOTE);
      await dlgConfirm(dlg, /go live/i);
      await waitFor(() => expect(calls).toHaveLength(1));
      for (const s of spies) expect(JSON.stringify(s.mock.calls)).not.toContain(NOTE);
      expect(JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage })).not.toContain(NOTE);
    });

    it('axe: go-live dialog (verified and blocked)', async () => {
      await open();
      await noAxeViolations();
      cleanup();
      await open({ driver_code: 'astm_generic_e1394', driver_status: 'generic' });
      await noAxeViolations();
    });
  });

  describe('Suspend / Resume / Retire (AC-04.4)', () => {
    it('Suspend needs a reason of 3–300 chars: too short → nothing sent; valid → POST E29 {reason_text} with If-Match', async () => {
      await show({ state: 'live', version: 6 });
      await click(/^suspend$/i);
      const dlg = screen.getByRole('dialog');
      const reason = within(dlg).getByRole('textbox');
      await userEvent.type(reason, 'ab');
      await dlgConfirm(dlg, /suspend/i);
      await new Promise((r) => setTimeout(r, 100));
      expect(calls).toHaveLength(0);
      await userEvent.type(reason, 'c reagent problem');
      await dlgConfirm(dlg, /suspend/i);
      await waitFor(() => expect(calls).toHaveLength(1));
      expect(calls[0]!.url.pathname).toBe(`/v1/instruments/instruments/${INST}/suspend`);
      expect(calls[0]!.headers.get('if-match')).toBe('"6"');
      expect(calls[0]!.body).toEqual({ reason_text: 'abc reagent problem' });
      await waitFor(() => expect(refresh).toHaveBeenCalled());
    });

    it('reason longer than 300 characters is not submittable', async () => {
      await show({ state: 'live' });
      await click(/^suspend$/i);
      const dlg = screen.getByRole('dialog');
      const reason = within(dlg).getByRole('textbox') as HTMLTextAreaElement;
      await userEvent.click(reason);
      await userEvent.paste('x'.repeat(301));
      await dlgConfirm(dlg, /suspend/i);
      await new Promise((r) => setTimeout(r, 100));
      // 04-UI-UX.md:113/:143 only require 3–300 chars; a maxLength=300 textarea truncates the paste, so a valid request is fine.
      expect(reason.value.length).toBeLessThanOrEqual(300);
      expect(calls.every((c) => (c.body?.reason_text ?? '').length <= 300)).toBe(true);
    });

    it('Resume → POST E30 with If-Match (no dialog needed)', async () => {
      await show({ state: 'suspended', version: 8 });
      await click(/^resume$/i);
      await waitFor(() => expect(calls).toHaveLength(1));
      expect(calls[0]!.url.pathname).toBe(`/v1/instruments/instruments/${INST}/resume`);
      expect(calls[0]!.headers.get('if-match')).toBe('"8"');
    });

    it('Resume: 422 instruments.driver_not_available → alert (driver no longer verified)', async () => {
      api.use(http.post(`${IM}/:id/resume`, () => problem(422, 'instruments.driver_not_available')));
      await show({ state: 'suspended' });
      await click(/^resume$/i);
      expect((await screen.findByRole('alert')).textContent).toMatch(/driver/i);
    });

    it('Retire: reminder "Deactivate this instrument\'s code mappings in Mappings." + reason 3–300 → POST E31', async () => {
      await show({ state: 'live' });
      await click(/^retire$/i);
      const dlg = screen.getByRole('dialog');
      expect(dlg.textContent).toContain("Deactivate this instrument's code mappings in Mappings.");
      await userEvent.type(within(dlg).getByRole('textbox'), 'Analyser decommissioned');
      await dlgConfirm(dlg, /retire/i);
      await waitFor(() => expect(calls).toHaveLength(1));
      expect(calls[0]!.url.pathname).toBe(`/v1/instruments/instruments/${INST}/retire`);
      expect(calls[0]!.body).toEqual({ reason_text: 'Analyser decommissioned' });
    });

    it('Retire dialog: Cancel closes it and sends nothing', async () => {
      await show({ state: 'draft' });
      await click(/^retire$/i);
      const dlg = screen.getByRole('dialog');
      await dlgConfirm(dlg, /cancel/i);
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(calls).toHaveLength(0);
    });

    it('axe: suspend dialog', async () => {
      await show({ state: 'live' });
      await click(/^suspend$/i);
      await noAxeViolations();
    });
  });
});

describe('pages → BFF', () => {
  const listPage = async (sp: Record<string, string | string[] | undefined>) => {
    const mod = await import('../../../app/(staff)/instruments/instruments/page');
    return (await mod.default({ searchParams: Promise.resolve(sp) } as never)) as { props: Record<string, any> };
  };
  const e23 = () => listSeen.filter((u) => u.pathname === '/v1/instruments/instruments');

  it('instruments page: no query → E23 with state = all except retired; rows, agents and drivers are passed to the list', async () => {
    const el = await listPage({});
    const u = e23()[0]!;
    expect(u.searchParams.get('state')!.split(',').sort()).toEqual(['commissioning', 'draft', 'live', 'suspended']);
    expect(u.searchParams.get('agent_id')).toBeNull();
    expect(el.props.instruments).toHaveLength(1);
    expect(el.props.agents.length).toBeGreaterThan(0);
    expect(el.props.drivers.map((d: { code: string }) => d.code)).toContain('astm_verified_x');
  });

  it('instruments page: centre_id / agent_id / state / protocol / sort are forwarded; tampered values never reach the API', async () => {
    await listPage({ centre_id: CENTRE, agent_id: AGENT, state: 'retired,live', protocol: 'astm', sort: '-last_message_at' });
    const u = e23()[0]!;
    expect(u.searchParams.get('centre_id')).toBe(CENTRE);
    expect(u.searchParams.get('agent_id')).toBe(AGENT);
    expect(u.searchParams.get('state')).toBe('retired,live');
    expect(u.searchParams.get('protocol')).toBe('astm');
    expect(u.searchParams.get('sort')).toBe('-last_message_at');
    listSeen.length = 0;
    await listPage({ state: "live,x'; drop", protocol: 'ftp', sort: 'password', centre_id: 'not-a-uuid', agent_id: 'nope' }).catch(() => undefined);
    for (const x of e23()) expect(x.search).not.toMatch(/drop|ftp|password|not-a-uuid|nope/);
  });

  it('detail page: getInstrument 404 (other centre) → notFound(), not a rendered instrument', async () => {
    api.use(http.get(`${IM}/:id`, () => problem(404, 'common.not_found')));
    const mod = await import('../../../app/(staff)/instruments/instruments/[instrument_id]/page');
    await expect(mod.default({ params: Promise.resolve({ instrument_id: '01a1a98a-ac40-7000-8000-0000000e0999' }) } as never)).rejects.toMatchObject({ message: 'NEXT_NOT_FOUND' });
  });

  it('detail page: a non-404 API failure is NOT turned into not-found (error.tsx handles it)', async () => {
    api.use(http.get(`${IM}/:id`, () => problem(500, 'common.internal')));
    const mod = await import('../../../app/(staff)/instruments/instruments/[instrument_id]/page');
    await expect(mod.default({ params: Promise.resolve({ instrument_id: INST }) } as never)).rejects.toMatchObject({ status: 500 });
  });

  it('detail page: passes the instrument, agents and drivers to InstrumentDetail', async () => {
    const mod = await import('../../../app/(staff)/instruments/instruments/[instrument_id]/page');
    const el = (await mod.default({ params: Promise.resolve({ instrument_id: INST }) } as never)) as { props: Record<string, any> };
    expect(el.props.instrument.id).toBe(INST);
    expect(el.props.drivers.length).toBe(DRIVERS.length);
    expect(Array.isArray(el.props.agents)).toBe(true);
  });

  it('detail page: a non-uuid instrument_id is not forwarded to the API (404 locally)', async () => {
    const mod = await import('../../../app/(staff)/instruments/instruments/[instrument_id]/page');
    await expect(mod.default({ params: Promise.resolve({ instrument_id: '../agents' }) } as never)).rejects.toBeTruthy();
    expect(listSeen).toHaveLength(0);
  });
});

describe('static guards on the WEB-T03 files (REQ-SEC-068: browser holds no JWT/API origin)', () => {
  const WEB = async () => (await import('node:path')).join(import.meta.dirname, '..', '..', '..', '..');
  const src = async (rel: string) => (await import('node:fs')).readFileSync((await import('node:path')).join(await WEB(), rel), 'utf8');
  const files = async (rel: string) => { const { readdirSync } = await import('node:fs'); return readdirSync((await import('node:path')).join(await WEB(), rel)).filter((f) => /\.tsx?$/.test(f) && !/\.(test|spec)\./.test(f)); };

  it('components/* and forms/* never mention the API origin, bearer tokens or persistence; no dangerouslySetInnerHTML', async () => {
    for (const dir of ['src/features/instruments/components', 'src/features/instruments/forms']) {
      const fs = await files(dir);
      expect(fs.length, dir).toBeGreaterThan(0);
      for (const f of fs) expect(await src(`${dir}/${f}`), f).not.toMatch(/LIMS_ORIGIN_API|authorization|Bearer |localStorage|sessionStorage|document\.cookie|dangerouslySetInnerHTML/i);
    }
  });

  it('forms/* are pure (client-importable): no "server-only", no server/*.server imports', async () => {
    for (const f of await files('src/features/instruments/forms')) expect(await src(`src/features/instruments/forms/${f}`), f).not.toMatch(/server-only|\.server['"]/);
  });

  it('every new server/*.server.ts starts with the "server-only" guard', async () => {
    const all = await files('src/features/instruments/server');
    for (const n of ['listDrivers', 'getInstrument', 'createInstrument', 'updateInstrument', 'startInstrumentCommissioning', 'goLiveInstrument', 'suspendInstrument', 'resumeInstrument', 'retireInstrument']) {
      expect(all, n).toContain(`${n}.server.ts`);
      expect(await src(`src/features/instruments/server/${n}.server.ts`), n).toMatch(/^(\s*\/\/[^\n]*\n|\s*'use server';?\s*\n)*\s*import ['"]server-only['"]/);
    }
  });

  it('route pages exist as server components: instruments/page.tsx and instruments/[instrument_id]/page.tsx (no "use client")', async () => {
    const { existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    for (const p of ['instruments/page.tsx', 'instruments/[instrument_id]/page.tsx']) {
      expect(existsSync(join(await WEB(), 'src/app/(staff)/instruments', p)), p).toBe(true);
      expect(await src(`src/app/(staff)/instruments/${p}`), p).not.toMatch(/^\s*['"]use client['"]/);
    }
  });
});
