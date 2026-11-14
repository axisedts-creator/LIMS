// @vitest-environment jsdom
// H80-T06 — SCR-06 Instrument form: preset "Truth H80E" (08-ADDENDUM-TRUTH-H80E §1 topology, §7 transport, §8 optionsSchema, §9 checklist).
// Binding: LD-139 (analyser is a TCP client; the address typed into it is the LAB PC running the bridge agent, never the cloud server;
// every U position is unverified, driver status stays generic, host query inert until a reviewed migration promotes it).
// ASSUMED contract (spec fixes only the behaviour; dispute to rename — see .orchestra/notes/H80-T06-tests.md):
//   components/InstrumentForm.tsx (create mode) gains a Select labelled "Preset" with options "Custom" and "Truth H80E" (create mode only, never in edit mode).
//   Choosing "Truth H80E" pre-fills protocol hl7v2, transport kind tcp_server, driver truth_h80e, vendor/model, and shows:
//     - bind field labelled with "lab PC" + "static", peers field labelled with "analyser", text "typed into the analyser" / "not the cloud server";
//     - options form rendered from the Driver's `options_schema` (JSON Schema; NEW optional field on server/types.ts Driver — the contract Driver has none);
//     - a region "Suggested analyte codes" (the §3 codes; nothing is created by the form);
//     - a region "Commissioning checklist": an ordered list of the nine §9 steps.
//   Host query switch: disabled with a reason while the driver status is not "verified" (02-TRD §6.6 step 2), whatever capabilities.host_query says.
// Component tests + MSW (server actions run for real) + axe. Synthetic data only.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { ReactNode } from 'react';
import { ToastProvider } from '@lims/ui/components/Toast';

const push = vi.fn();
const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh, back: vi.fn() }),
  usePathname: () => '/instruments/instruments',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw Object.assign(new Error('NEXT_NOT_FOUND'), { digest: 'NEXT_HTTP_ERROR_FALLBACK;404' }); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: ['instruments.instrument.read', 'instruments.instrument.manage'], displayName: 'Synthetic Manager', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/instruments/instruments',
}));

const ORIGIN = 'http://api.test';
process.env.LIMS_ORIGIN_API = ORIGIN;
const INST = '01a1a98a-ac40-7000-8000-0000000e0001';
const AGENT = '01a1a98a-ac40-7000-8000-0000000d0101';
const CENTRE = '01a1a98a-ac40-7000-8000-0000000c0001';
const MANAGE = ['instruments.instrument.read', 'instruments.instrument.manage'];
const IM = `${ORIGIN}/v1/instruments/instruments`;

// §8 optionsSchema, as the API would serve it on the driver row (fixture = the schema; the tests derive expectations from it).
const OPTIONS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    detection_mode_field: { type: 'string', title: 'Detection mode field', default: 'OBR.15', maxLength: 64 },
    type_flag_field: { type: 'string', title: 'Type flag field', default: 'MSH.16', maxLength: 64 },
    // real driver shape (drivers/truth_h80e/index.ts): numeric enum, NO `type` — review item 2; the form must still render it and send a number.
    host_query_detection_mode: { title: 'Host query detection mode', enum: [0, 1, 2], default: 0 },
    name_script: { type: 'string', title: 'Name script', enum: ['as_registered', 'latin_if_available'], default: 'as_registered' },
    qc_level_map: { type: 'object', title: 'QC level map', default: { L: 'low' } },
  },
};
const base = (o: Record<string, unknown> = {}) => ({ code: 'astm_generic_e1394', display_name: 'Generic ASTM E1394', protocol: 'astm', status: 'generic', driver_version: '1.0.0', is_active: true, capabilities: { host_query: false, worklist_download: false, qc: true, attachments: false, calibration: false }, ...o });
const h80 = (o: Record<string, unknown> = {}) => base({ code: 'truth_h80e', display_name: 'Truth-H80E HbA1c analyser', protocol: 'hl7v2', status: 'generic', driver_version: '0.1.0', capabilities: { host_query: true, worklist_download: false, qc: true, attachments: true, calibration: false }, options_schema: OPTIONS_SCHEMA, ...o });
const DRIVERS = [base(), h80()];
const agents = [{ id: AGENT, agent_code: 'SYN-AGENT-1', display_name: 'Synthetic lab PC', centre_id: CENTRE, status: 'active' }];
const created = (o: Record<string, unknown> = {}) => ({ id: INST, instrument_code: 'SIM-H80E-1', display_name: 'Sim H80E', vendor: 'x', model: 'x', protocol: 'hl7v2', agent_id: AGENT, agent_code: 'SYN-AGENT-1', centre_id: CENTRE, driver_code: 'truth_h80e', driver_status: 'generic', state: 'draft', version: 1, link_state: 'unknown', unmapped_code_count: 0, driver_version: '0.1.0', transport: {}, protocol_options: {}, capabilities: { host_query: false, worklist_download: false }, status: {}, ...o });

const calls: { method: string; url: URL; body?: any }[] = [];
const seen: string[] = [];
const api = setupServer(
  http.post(IM, async ({ request }) => { calls.push({ method: 'POST', url: new URL(request.url), body: await request.clone().json().catch(() => undefined) }); return HttpResponse.json(created(), { status: 201 }); }),
  http.all(`${ORIGIN}/v1/catalog/*`, ({ request }) => { seen.push(`${request.method} ${request.url}`); return HttpResponse.json({ data: [] }); }),
);
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { cleanup(); api.resetHandlers(); calls.length = 0; seen.length = 0; push.mockReset(); refresh.mockReset(); localStorage.clear(); sessionStorage.clear(); });
afterAll(() => api.close());

const wrap = (ui: ReactNode) => render(<ToastProvider>{ui}</ToastProvider>);
const noAxeViolations = async () => {
  const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
  expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
};
const choose = async (scope: HTMLElement, label: RegExp, option: string | RegExp) => {
  await userEvent.click(within(scope).getByRole('button', { name: label }));
  await userEvent.click(await screen.findByRole('option', { name: option }));
};
const open = async (drivers: unknown[] = DRIVERS) => {
  const { InstrumentForm } = await import('../components/InstrumentForm');
  wrap(<InstrumentForm mode="create" agents={agents as never} drivers={drivers as never} permissions={MANAGE} />);
  return document.body;
};
const withPreset = async (drivers?: unknown[]) => { const b = await open(drivers); await choose(b, /preset/i, /truth h80e/i); return b; };
const input = (name: string) => document.querySelector(`input[name="${name}"]`) as HTMLInputElement | null;
const labelOf = (el: HTMLInputElement | null) => Array.from(el?.labels ?? []).map((l) => l.textContent).join(' ');
const describedBy = (el: Element | null) => (el?.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
const region = (name: RegExp) => screen.getByRole('region', { name });
const submit = () => userEvent.click(screen.getByRole('button', { name: /create instrument/i }));

const CHECKLIST: [string, RegExp[]][] = [
  ['1 static IPs, LIS address, ping, green icon', [/static IP/i, /ping/i, /LIS/]],
  ['2 bridge agent on a static-IP lab PC, tcp_server instrument, enrolment code', [/bridge agent/i, /static/i, /enrolment code/i]],
  ['3 commissioning (shadow): 5 patient samples + 2 QC runs, compare with printout', [/commissioning/i, /5 patient/i, /2 QC/i]],
  ['4 map analyte codes and review', [/map/i, /analyte codes/i]],
  ['5 host query in shadow: QCK OK + DSR, ACK^Q03', [/host query/i, /QCK/, /DSR/]],
  ['6 unregistered tube and tube without HbA1c, record NF behaviour', [/unregistered/i, /without HbA1c/i, /NF/]],
  ['7 Devanagari name', [/Devanagari/i]],
  ['8 pull the internet link, restore, no duplicates', [/internet/i, /duplicate/i]],
  ['9 sign off; promotion to verified is a reviewed migration', [/sign/i, /verified/i, /migration/i]],
];
const CODES = ['HbA1c_NGSP', 'HbA1c_IFCC', 'HbF', 'HbA1', 'eAG', 'A1ab', 'HbLA1C+', 'HbA0', 'A1A', 'A1B'];

describe('H80-T06 preset "Truth H80E" — offering and prefill (done_when 1)', () => {
  it('create mode offers a "Preset" select with "Custom" and "Truth H80E"; nothing is sent', async () => {
    const b = await open();
    await userEvent.click(within(b).getByRole('button', { name: /preset/i }));
    const names = (await screen.findAllByRole('option')).map((o) => o.textContent);
    expect(names.some((n) => /^custom/i.test(n ?? ''))).toBe(true);
    expect(names.some((n) => /truth h80e/i.test(n ?? ''))).toBe(true);
    expect(calls).toEqual([]);
  });

  it('edit mode has no preset control', async () => {
    const { InstrumentForm } = await import('../components/InstrumentForm');
    wrap(<InstrumentForm mode="edit" agents={agents as never} drivers={DRIVERS as never} permissions={MANAGE} instrument={created({ vendor: 'Truth', model: 'Truth-H80E' }) as never} />);
    expect(screen.queryByRole('button', { name: /preset/i })).toBeNull();
    expect(screen.queryByRole('region', { name: /commissioning checklist/i })).toBeNull();
  });

  it('choosing it selects HL7 v2, transport TCP server, driver truth_h80e and pre-fills vendor/model; no request is made', async () => {
    const b = await withPreset();
    expect((within(b).getByRole('radio', { name: /hl7 v2/i }) as HTMLInputElement).checked).toBe(true);
    expect(within(b).getByRole('button', { name: /transport kind/i }).textContent).toMatch(/tcp server/i);
    expect(within(b).getByRole('button', { name: /driver/i }).textContent).toMatch(/Truth-H80E/);
    expect((within(b).getByLabelText(/^vendor/i) as HTMLInputElement).value).toMatch(/truth/i);
    expect((within(b).getByLabelText(/^model/i) as HTMLInputElement).value).toMatch(/H80E/i);
    expect(calls).toEqual([]);
    expect(seen).toEqual([]);
  });

  it('choosing "Custom" again removes the checklist and the code suggestions', async () => {
    const b = await withPreset();
    expect(screen.queryByRole('region', { name: /commissioning checklist/i })).not.toBeNull();
    await choose(b, /preset/i, /^custom/i);
    expect(screen.queryByRole('region', { name: /commissioning checklist/i })).toBeNull();
    expect(screen.queryByRole('region', { name: /suggested analyte codes/i })).toBeNull();
  });
});

describe('H80-T06 preset — bind address is the lab PC, never 0.0.0.0 (done_when 2, LD-139, addendum §1/§7)', () => {
  it('bind field starts empty (no 0.0.0.0 default/placeholder) and its label names the lab PC and a static LAN IP', async () => {
    await withPreset();
    const bind = input('transport.bind_address')!;
    expect(bind).not.toBeNull();
    expect(bind.value).toBe('');
    expect(`${bind.value} ${bind.placeholder}`).not.toMatch(/0\.0\.0\.0/);
    expect(labelOf(bind)).toMatch(/lab pc/i);
    expect(labelOf(bind)).toMatch(/static/i);
  });

  it('allowed-peer field is labelled as the analyser address', async () => {
    await withPreset();
    expect(labelOf(input('transport.allowed_peers'))).toMatch(/analy[sz]er/i);
  });

  it('says the address typed into the analyser is the lab PC, not the cloud server', async () => {
    const b = await withPreset();
    const t = b.textContent ?? '';
    expect(t).toMatch(/typed into the analy[sz]er/i);
    expect(t).toMatch(/lab pc/i);
    expect(t).toMatch(/not the cloud server/i);
  });

  it.each(['0.0.0.0', '127.0.0.1', 'lab-pc.local', '192.168.1.256'])('bind address %s is refused client-side: error shown, nothing sent', async (bad) => {
    const b = await withPreset();
    await fillCommon(b);
    await userEvent.type(input('transport.bind_address')!, bad);
    await userEvent.type(within(b).getByLabelText(/^port/i), '5100');
    await userEvent.type(input('transport.allowed_peers')!, '192.168.1.3');
    await submit();
    await waitFor(() => expect(screen.queryAllByText(/lab network|ipv4|not 0\.0\.0\.0/i).length).toBeGreaterThan(0));
    expect(calls).toEqual([]);
    expect(push).not.toHaveBeenCalled();
  });

  it('port below 1024 is refused (addendum §7), nothing sent', async () => {
    const b = await withPreset();
    await fillCommon(b);
    await userEvent.type(input('transport.bind_address')!, '192.168.1.2');
    await userEvent.type(within(b).getByLabelText(/^port/i), '80');
    await userEvent.type(input('transport.allowed_peers')!, '192.168.1.3');
    await submit();
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toEqual([]);
  });

  it('happy path: ONE POST with hl7v2 / truth_h80e / tcp_server + lab PC address + analyser peer; host query stays false', async () => {
    const b = await withPreset();
    await fillCommon(b);
    await userEvent.type(input('transport.bind_address')!, '192.168.1.2');
    await userEvent.type(within(b).getByLabelText(/^port/i), '5100');
    await userEvent.type(input('transport.allowed_peers')!, '192.168.1.3');
    await submit();
    await waitFor(() => expect(calls).toHaveLength(1));
    const body = calls[0]!.body;
    expect(body).toMatchObject({ instrument_code: 'SIM-H80E-1', agent_id: AGENT, protocol: 'hl7v2', driver_code: 'truth_h80e', transport: { kind: 'tcp_server', bind_address: '192.168.1.2', port: 5100, allowed_peers: ['192.168.1.3'] }, capabilities: { host_query: false, worklist_download: false } });
    expect(body.display_name).toContain('Sim H80E');
    expect(JSON.stringify(body)).not.toMatch(/0\.0\.0\.0/);
    await waitFor(() => expect(push).toHaveBeenCalledWith(`/instruments/instruments/${INST}`));
  });
});

async function fillCommon(b: HTMLElement) {
  await userEvent.type(within(b).getByLabelText(/^code/i), 'SIM-H80E-1');
  await userEvent.type(within(b).getByLabelText(/^name/i), 'Sim H80E');
  await choose(b, /agent/i, /SYN-AGENT-1/);
}

describe('H80-T06 preset — options form from the driver schema (done_when 3, addendum §8)', () => {
  it('renders one field per string/enum property, labelled by the schema title and pre-filled with the schema default', async () => {
    const b = await withPreset();
    expect((within(b).getByLabelText(/detection mode field/i) as HTMLInputElement).value).toBe('OBR.15');
    expect((within(b).getByLabelText(/type flag field/i) as HTMLInputElement).value).toBe('MSH.16');
    expect(within(b).getByRole('button', { name: /host query detection mode/i }).textContent).toMatch(/0/);
    expect(within(b).getByRole('button', { name: /name script/i }).textContent).toMatch(/as[_ ]registered/i);
  });

  it('string fields obey the schema maxLength', async () => {
    const b = await withPreset();
    expect(Number((within(b).getByLabelText(/detection mode field/i) as HTMLInputElement).maxLength)).toBe(64);
  });

  it('enum fields offer exactly the schema values', async () => {
    const b = await withPreset();
    await userEvent.click(within(b).getByRole('button', { name: /host query detection mode/i }));
    expect((await screen.findAllByRole('option')).map((o) => o.textContent?.trim())).toEqual(['0', '1', '2']);
  });

  it('changed values are sent as parser_options, every sent key belongs to the schema', async () => {
    const b = await withPreset();
    await fillCommon(b);
    await userEvent.type(input('transport.bind_address')!, '192.168.1.2');
    await userEvent.type(within(b).getByLabelText(/^port/i), '5100');
    await userEvent.type(input('transport.allowed_peers')!, '192.168.1.3');
    const dm = within(b).getByLabelText(/detection mode field/i);
    await userEvent.clear(dm);
    await userEvent.type(dm, 'OBR.16');
    await choose(b, /host query detection mode/i, '1');
    await choose(b, /name script/i, /latin[_ ]if[_ ]available/i);
    await submit();
    await waitFor(() => expect(calls).toHaveLength(1));
    const po = calls[0]!.body.parser_options as Record<string, unknown>;
    expect(po).toMatchObject({ detection_mode_field: 'OBR.16', host_query_detection_mode: 1, name_script: 'latin_if_available' });
    expect(typeof po['host_query_detection_mode']).toBe('number'); // server schema rejects "1"
    for (const k of Object.keys(po)) expect(Object.keys(OPTIONS_SCHEMA.properties)).toContain(k);
  });

  it('a type-less numeric enum property is rendered as a select and its chosen value is sent as a number', async () => {
    const schema = { type: 'object', additionalProperties: false, properties: { host_query_detection_mode: { title: 'Host query detection mode', enum: [0, 1, 2], default: 0 } } };
    const b = await withPreset([base(), h80({ options_schema: schema })]);
    await fillCommon(b);
    await userEvent.type(input('transport.bind_address')!, '192.168.1.2');
    await userEvent.type(within(b).getByLabelText(/^port/i), '5100');
    await userEvent.type(input('transport.allowed_peers')!, '192.168.1.3');
    await choose(b, /host query detection mode/i, '2');
    await submit();
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body.parser_options).toEqual({ host_query_detection_mode: 2 });
  });

  it('schema text is rendered as text, never as HTML; a "__proto__" property is not turned into a field or sent', async () => {
    const evil = '<img src=x onerror="alert(1)">';
    const schema = JSON.parse(JSON.stringify(OPTIONS_SCHEMA));
    schema.properties.detection_mode_field.title = evil;
    schema.properties = JSON.parse(`{"__proto__":{"type":"string","title":"Polluter"},${JSON.stringify(schema.properties).slice(1)}`);
    const b = await withPreset([base(), h80({ options_schema: schema })]);
    expect(document.querySelector('img')).toBeNull();
    expect(b.textContent).toContain(evil);
    expect(({} as Record<string, unknown>)['type']).toBeUndefined();
  });

  it('a driver without options_schema still opens the preset (no crash, no options section)', async () => {
    const b = await withPreset([base(), h80({ options_schema: undefined })]);
    expect(within(b).queryByLabelText(/detection mode field/i)).toBeNull();
    expect(screen.queryByRole('region', { name: /commissioning checklist/i })).not.toBeNull();
  });
});

describe('H80-T06 preset — code-map suggestions (done_when 3, addendum §3 analyte codes, C3 rows are tenant data)', () => {
  it('lists the manual\'s analyte codes in a "Suggested analyte codes" region', async () => {
    await withPreset();
    const r = region(/suggested analyte codes/i);
    for (const c of CODES) expect(r.textContent, c).toContain(c);
  });

  it('only suggests: no code-map request is made while the form is used or submitted (nothing seeded, C3 owns the rows)', async () => {
    const b = await withPreset();
    await fillCommon(b);
    await userEvent.type(input('transport.bind_address')!, '192.168.1.2');
    await userEvent.type(within(b).getByLabelText(/^port/i), '5100');
    await userEvent.type(input('transport.allowed_peers')!, '192.168.1.3');
    await submit();
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(seen).toEqual([]);
  });

  it('is absent without the preset', async () => {
    await open();
    expect(screen.queryByRole('region', { name: /suggested analyte codes/i })).toBeNull();
  });
});

describe('H80-T06 preset — nine-step commissioning checklist (done_when 3, addendum §9)', () => {
  it('shows an ordered list of exactly nine steps in order, each carrying its key terms', async () => {
    await withPreset();
    const r = region(/commissioning checklist/i);
    const items = within(r).getAllByRole('listitem');
    expect(items).toHaveLength(9);
    expect(r.querySelector('ol')).not.toBeNull();
    CHECKLIST.forEach(([name, res], i) => { for (const re of res) expect(items[i]!.textContent, `step ${name}`).toMatch(re); });
  });

  it('points to the runbook and says promotion is a reviewed migration, not a toggle', async () => {
    await withPreset();
    const r = region(/commissioning checklist/i);
    expect(r.textContent).toContain('docs/manual/instruments/truth-h80e-commissioning.md');
  });

  it('is absent without the preset', async () => {
    await open();
    expect(screen.queryByRole('region', { name: /commissioning checklist/i })).toBeNull();
  });
});

describe('H80-T06 preset — host-query toggle stays disabled with a reason while the driver is generic (done_when 4, LD-139)', () => {
  const sw = () => screen.getByRole('switch', { name: /host query/i }) as HTMLInputElement;

  it('disabled although the driver declares host_query; the reason names the generic status / commissioning', async () => {
    await withPreset();
    expect(sw().disabled || sw().getAttribute('aria-disabled') === 'true').toBe(true);
    expect(sw().checked).toBe(false);
    expect(describedBy(sw())).toMatch(/generic/i);
    expect(describedBy(sw())).toMatch(/commissioning|verified/i);
  });

  it('cannot be switched on by the user, so the body never asks for host_query', async () => {
    const b = await withPreset();
    await userEvent.click(sw());
    expect(sw().checked).toBe(false);
    await fillCommon(b);
    await userEvent.type(input('transport.bind_address')!, '192.168.1.2');
    await userEvent.type(within(b).getByLabelText(/^port/i), '5100');
    await userEvent.type(input('transport.allowed_peers')!, '192.168.1.3');
    await submit();
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body.capabilities.host_query).toBe(false);
  });

  it('regression: a VERIFIED driver that declares host_query still has an enabled toggle (after a later promotion)', async () => {
    await withPreset([base(), h80({ status: 'verified' })]);
    expect(sw().disabled).toBe(false);
  });

  it('worklist download stays disabled (AC-03.4)', async () => {
    await withPreset();
    const w = screen.getByRole('switch', { name: /worklist download/i }) as HTMLInputElement;
    expect(w.disabled || w.getAttribute('aria-disabled') === 'true').toBe(true);
  });
});

describe('H80-T06 preset — accessibility', () => {
  it('axe: form with the preset selected (options, suggestions, checklist, disabled toggle with reason)', async () => {
    await withPreset();
    await noAxeViolations();
  });
});
