// @vitest-environment jsdom
// MET-T05 — SCR-06 Instrument form: preset "Getein Metis series" (09-ADDENDUM-GETEIN-METIS §1 topology, §3 item ids, §7 transport, §8 optionsSchema, §9 checklist).
// Binding: LD-163 (D-MET-3 transport tcp_server on the lab PC, analyser assumed to connect out = U1; every U value is a configurable default;
// driver status stays generic and host query inert until a reviewed migration promotes it) + LD-139 wording pattern from H80-T06.
// The existing "Truth H80E" preset and its tests (h80-t06.*) must stay unchanged and green.
// ASSUMED contract (spec fixes only the behaviour; dispute to rename — see .orchestra/notes/MET-T05-tests.md):
//   components/InstrumentForm.tsx "Preset" Select (create mode only) gains a third option "Getein Metis series" next to "Custom" and "Truth H80E".
//   Choosing it pre-fills protocol hl7v2, transport kind tcp_server, driver getein_metis, vendor "Getein", model containing "Metis", and shows:
//     - bind field labelled with "lab PC" + "static", peers field labelled with "analyser", text "typed into the analyser" / "not the cloud server";
//     - options form rendered from the Driver's `options_schema` (same optional field H80-T06 uses; sent back as parser_options, changed keys only);
//     - a region "Suggested analyte codes": the item ids the addendum §3 shows (0 ALT, 1 AST, 1112 CoV2Ag) and the words that item ids are the
//       analyser's own and which ones a lab runs is confirmed at commissioning (U2); nothing is created by the form;
//     - a region "Commissioning checklist": an ordered list of the nine §9 steps + the runbook path.
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
const INST = '01a1a98a-ac40-7000-8000-0000000e0002';
const AGENT = '01a1a98a-ac40-7000-8000-0000000d0101';
const CENTRE = '01a1a98a-ac40-7000-8000-0000000c0001';
const MANAGE = ['instruments.instrument.read', 'instruments.instrument.manage'];
const IM = `${ORIGIN}/v1/instruments/instruments`;

// §8 optionsSchema of getein_metis (fixture = the schema; the tests derive expectations from it).
const OPTIONS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    type_flag_field: { type: 'string', title: 'Type flag field', default: 'MSH.16', maxLength: 64 },
    qc_level_map: { type: 'object', title: 'QC level map', default: { L: 'low', M: 'mid', H: 'high' } },
    name_script: { type: 'string', title: 'Name script', enum: ['as_registered', 'latin_if_available'], default: 'as_registered' },
    specimen_type_map: { type: 'object', title: 'Specimen type map', default: {} },
    dsr_item_details: { type: 'string', title: 'DSR item details', enum: ['id_only', 'full'], default: 'id_only' },
  },
};
const H80_SCHEMA = { type: 'object', additionalProperties: false, properties: { detection_mode_field: { type: 'string', title: 'Detection mode field', default: 'OBR.15', maxLength: 64 } } };
const base = (o: Record<string, unknown> = {}) => ({ code: 'astm_generic_e1394', display_name: 'Generic ASTM E1394', protocol: 'astm', status: 'generic', driver_version: '1.0.0', is_active: true, capabilities: { host_query: false, worklist_download: false, qc: true, attachments: false, calibration: false }, ...o });
const h80 = (o: Record<string, unknown> = {}) => base({ code: 'truth_h80e', display_name: 'Truth-H80E HbA1c analyser', protocol: 'hl7v2', status: 'generic', driver_version: '0.1.0', capabilities: { host_query: true, worklist_download: false, qc: true, attachments: true, calibration: false }, options_schema: H80_SCHEMA, ...o });
const metis = (o: Record<string, unknown> = {}) => base({ code: 'getein_metis', display_name: 'Getein Metis series analyser', protocol: 'hl7v2', status: 'generic', driver_version: '0.1.0', capabilities: { host_query: true, worklist_download: false, qc: true, attachments: false, calibration: false }, options_schema: OPTIONS_SCHEMA, ...o });
const DRIVERS = [base(), h80(), metis()];
const agents = [{ id: AGENT, agent_code: 'SYN-AGENT-1', display_name: 'Synthetic lab PC', centre_id: CENTRE, status: 'active' }];
const created = (o: Record<string, unknown> = {}) => ({ id: INST, instrument_code: 'SIM-METIS-1', display_name: 'Sim Metis', vendor: 'x', model: 'x', protocol: 'hl7v2', agent_id: AGENT, agent_code: 'SYN-AGENT-1', centre_id: CENTRE, driver_code: 'getein_metis', driver_status: 'generic', state: 'draft', version: 1, link_state: 'unknown', unmapped_code_count: 0, driver_version: '0.1.0', transport: {}, protocol_options: {}, capabilities: { host_query: false, worklist_download: false }, status: {}, ...o });

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
const METIS = /getein metis series/i;
const withPreset = async (drivers?: unknown[]) => { const b = await open(drivers); await choose(b, /preset/i, METIS); return b; };
const input = (name: string) => document.querySelector(`input[name="${name}"]`) as HTMLInputElement | null;
const labelOf = (el: HTMLInputElement | null) => Array.from(el?.labels ?? []).map((l) => l.textContent).join(' ');
const describedBy = (el: Element | null) => (el?.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
const region = (name: RegExp) => screen.getByRole('region', { name });
const submit = () => userEvent.click(screen.getByRole('button', { name: /create instrument/i }));
async function fillCommon(b: HTMLElement) {
  await userEvent.type(within(b).getByLabelText(/^code/i), 'SIM-METIS-1');
  await userEvent.type(within(b).getByLabelText(/^name/i), 'Sim Metis');
  await choose(b, /agent/i, /SYN-AGENT-1/);
}
async function fillNet(b: HTMLElement, bind = '192.168.1.2', port = '5100', peer = '192.168.1.3') {
  await userEvent.type(input('transport.bind_address')!, bind);
  await userEvent.type(within(b).getByLabelText(/^port/i), port);
  await userEvent.type(input('transport.allowed_peers')!, peer);
}

// Addendum §9, nine steps, in order (wording kept loose: every step must carry its key terms).
const CHECKLIST: [string, RegExp[]][] = [
  ['1 static IP + LIS settings; does the analyser connect out or listen; stop and CR-C7-021 if it listens', [/static IP/i, /LIS/, /connects? out/i, /listens/i, /CR-C7-021/]],
  ['2 bridge agent on a static-IP lab PC, tcp_server instrument, enrolment code', [/bridge agent/i, /static/i, /tcp_server/, /enrolment code/i]],
  ['3 commissioning (shadow): 5 patient samples + 2 QC runs per level, compare with printout', [/commissioning/i, /5 patient/i, /2 QC/i, /printout/i]],
  ['4 read the analyser item list, record the ids, map and review', [/item list/i, /ids/i, /map/i]],
  ['5 host query in shadow: QCK OK + DSR, ACK^Q03', [/host query/i, /QCK/, /DSR/, /ACK\^Q03/]],
  ['6 unregistered tube and tube without any test mapped, record NF behaviour', [/unregistered/i, /without any test mapped/i, /NF/]],
  ['7 sample-number-range and time-range download once, LIS-pushed request, CR-C7-022', [/sample-number-range/i, /time-range/i, /CR-C7-022/]],
  ['8 Devanagari name; calibration run archived harmlessly', [/Devanagari/i, /calibration/i]],
  ['9 pull the internet link, restore, no duplicates, sign off, promotion = reviewed migration', [/internet/i, /duplicate/i, /sign/i, /verified/i, /migration/i]],
];

describe('MET-T05 preset "Getein Metis series" — offering and prefill (done_when 1)', () => {
  it('create mode offers "Custom", "Truth H80E" and "Getein Metis series"; nothing is sent', async () => {
    const b = await open();
    await userEvent.click(within(b).getByRole('button', { name: /preset/i }));
    const names = (await screen.findAllByRole('option')).map((o) => o.textContent ?? '');
    expect(names.some((n) => /^custom/i.test(n))).toBe(true);
    expect(names.some((n) => /truth h80e/i.test(n))).toBe(true);
    expect(names.some((n) => METIS.test(n))).toBe(true);
    expect(calls).toEqual([]);
  });

  it('"Getein Metis series" is listed next to "Truth H80E" (adjacent options)', async () => {
    const b = await open();
    await userEvent.click(within(b).getByRole('button', { name: /preset/i }));
    const names = (await screen.findAllByRole('option')).map((o) => o.textContent ?? '');
    const i = names.findIndex((n) => /truth h80e/i.test(n));
    expect(i).toBeGreaterThanOrEqual(0);
    expect(METIS.test(names[i + 1] ?? '') || METIS.test(names[i - 1] ?? '')).toBe(true);
  });

  it('edit mode has no preset control and no checklist', async () => {
    const { InstrumentForm } = await import('../components/InstrumentForm');
    wrap(<InstrumentForm mode="edit" agents={agents as never} drivers={DRIVERS as never} permissions={MANAGE} instrument={created({ vendor: 'Getein', model: 'Metis' }) as never} />);
    expect(screen.queryByRole('button', { name: /preset/i })).toBeNull();
    expect(screen.queryByRole('region', { name: /commissioning checklist/i })).toBeNull();
  });

  it('choosing it selects HL7 v2, transport TCP server, driver getein_metis and pre-fills vendor/model; no request is made', async () => {
    const b = await withPreset();
    expect((within(b).getByRole('radio', { name: /hl7 v2/i }) as HTMLInputElement).checked).toBe(true);
    expect(within(b).getByRole('button', { name: /transport kind/i }).textContent).toMatch(/tcp server/i);
    expect(within(b).getByRole('button', { name: /driver/i }).textContent).toMatch(/Metis/i);
    expect((within(b).getByLabelText(/^vendor/i) as HTMLInputElement).value).toMatch(/getein/i);
    expect((within(b).getByLabelText(/^model/i) as HTMLInputElement).value).toMatch(/metis/i);
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

  it('switching from Truth H80E to Metis replaces vendor/model/driver, the options form, the codes and the checklist (no H80E leftovers)', async () => {
    const b = await open();
    await choose(b, /preset/i, /truth h80e/i);
    expect((within(b).getByLabelText(/^vendor/i) as HTMLInputElement).value).toMatch(/truth/i);
    await choose(b, /preset/i, METIS);
    expect((within(b).getByLabelText(/^vendor/i) as HTMLInputElement).value).toMatch(/getein/i);
    expect((within(b).getByLabelText(/^model/i) as HTMLInputElement).value).toMatch(/metis/i);
    expect(within(b).getByRole('button', { name: /driver/i }).textContent).toMatch(/Metis/i);
    expect(within(b).queryByLabelText(/detection mode field/i)).toBeNull();
    expect(within(b).getByLabelText(/type flag field/i)).not.toBeNull();
    expect(region(/suggested analyte codes/i).textContent).not.toContain('HbA1c_NGSP');
    expect(region(/commissioning checklist/i).textContent).not.toMatch(/truth-h80e-commissioning/);
    expect(region(/commissioning checklist/i).textContent).toContain('docs/manual/instruments/getein-metis-commissioning.md');
  });

  it('switching from Metis to Truth H80E leaves no Metis leftovers (H80E preset unchanged)', async () => {
    const b = await withPreset();
    await choose(b, /preset/i, /truth h80e/i);
    expect((within(b).getByLabelText(/^vendor/i) as HTMLInputElement).value).toMatch(/truth/i);
    expect(within(b).queryByLabelText(/type flag field/i)).toBeNull();
    expect(region(/suggested analyte codes/i).textContent).toContain('HbA1c_NGSP');
    expect(region(/suggested analyte codes/i).textContent).not.toMatch(/CoV2Ag/);
    expect(region(/commissioning checklist/i).textContent).toContain('docs/manual/instruments/truth-h80e-commissioning.md');
  });

  it('if the driver row getein_metis is not in the list, the preset still opens without a driver selected (no crash, nothing guessed)', async () => {
    const b = await withPreset([base(), h80()]);
    expect(region(/commissioning checklist/i)).not.toBeNull();
    expect(within(b).getByRole('button', { name: /driver/i }).textContent).not.toMatch(/Metis/i);
  });
});

describe('MET-T05 preset — bind address is the lab PC, never 0.0.0.0 (done_when 2, LD-163 D-MET-3, addendum §1/§7)', () => {
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

  it('says the address typed into the analyser is the lab PC, not the cloud server (analyser speaks raw MLLP, no TLS)', async () => {
    const b = await withPreset();
    const t = b.textContent ?? '';
    expect(t).toMatch(/typed into the analy[sz]er/i);
    expect(t).toMatch(/lab pc/i);
    expect(t).toMatch(/not the cloud server/i);
  });

  it('never tells the operator to use 0.0.0.0 as the address (only as the thing to avoid)', async () => {
    const b = await withPreset();
    for (const m of (b.textContent ?? '').matchAll(/.{0,40}0\.0\.0\.0.{0,20}/g)) expect(m[0]).toMatch(/never|not|refus|avoid/i);
  });

  it.each(['0.0.0.0', '127.0.0.1', 'lab-pc.local', '192.168.1.256'])('bind address %s is refused client-side: error shown, nothing sent', async (bad) => {
    const b = await withPreset();
    await fillCommon(b);
    await fillNet(b, bad);
    await submit();
    await waitFor(() => expect(screen.queryAllByText(/lab network|ipv4|not 0\.0\.0\.0/i).length).toBeGreaterThan(0));
    expect(calls).toEqual([]);
    expect(push).not.toHaveBeenCalled();
  });

  it('port below 1024 is refused (addendum §7), nothing sent', async () => {
    const b = await withPreset();
    await fillCommon(b);
    await fillNet(b, '192.168.1.2', '80');
    await submit();
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toEqual([]);
  });

  it('happy path: ONE POST with hl7v2 / getein_metis / tcp_server + lab PC address + analyser peer; host query stays false', async () => {
    const b = await withPreset();
    await fillCommon(b);
    await fillNet(b);
    await submit();
    await waitFor(() => expect(calls).toHaveLength(1));
    const body = calls[0]!.body;
    expect(body).toMatchObject({ instrument_code: 'SIM-METIS-1', agent_id: AGENT, protocol: 'hl7v2', driver_code: 'getein_metis', transport: { kind: 'tcp_server', bind_address: '192.168.1.2', port: 5100, allowed_peers: ['192.168.1.3'] }, capabilities: { host_query: false, worklist_download: false } });
    expect(body.display_name).toContain('Sim Metis');
    expect(JSON.stringify(body)).not.toMatch(/0\.0\.0\.0/);
    await waitFor(() => expect(push).toHaveBeenCalledWith(`/instruments/instruments/${INST}`));
  });
});

describe('MET-T05 preset — options form from the driver schema (done_when 3, addendum §8)', () => {
  it('renders string/enum properties labelled by the schema title and pre-filled with the schema default', async () => {
    const b = await withPreset();
    expect((within(b).getByLabelText(/type flag field/i) as HTMLInputElement).value).toBe('MSH.16');
    expect(within(b).getByRole('button', { name: /name script/i }).textContent).toMatch(/as[_ ]registered/i);
    expect(within(b).getByRole('button', { name: /dsr item details/i }).textContent).toMatch(/id[_ ]only/i);
  });

  it('string fields obey the schema maxLength', async () => {
    const b = await withPreset();
    expect(Number((within(b).getByLabelText(/type flag field/i) as HTMLInputElement).maxLength)).toBe(64);
  });

  it('dsr_item_details offers exactly the schema values', async () => {
    const b = await withPreset();
    await userEvent.click(within(b).getByRole('button', { name: /dsr item details/i }));
    expect((await screen.findAllByRole('option')).map((o) => o.textContent?.trim().replace(/\s+/g, '_'))).toEqual(['id_only', 'full']);
  });

  it('changed values are sent as parser_options (changed keys only, every sent key belongs to the schema); untouched defaults are not sent', async () => {
    const b = await withPreset();
    await fillCommon(b);
    await fillNet(b);
    const tf = within(b).getByLabelText(/type flag field/i);
    await userEvent.clear(tf);
    await userEvent.type(tf, 'MSH.17');
    await choose(b, /dsr item details/i, /^full$/i);
    await submit();
    await waitFor(() => expect(calls).toHaveLength(1));
    const po = calls[0]!.body.parser_options as Record<string, unknown>;
    expect(po).toEqual({ type_flag_field: 'MSH.17', dsr_item_details: 'full' });
    for (const k of Object.keys(po)) expect(Object.keys(OPTIONS_SCHEMA.properties)).toContain(k);
  });

  it('schema text is rendered as text, never as HTML; a "__proto__" property is not turned into a field or sent', async () => {
    const evil = '<img src=x onerror="alert(1)">';
    const schema = JSON.parse(JSON.stringify(OPTIONS_SCHEMA));
    schema.properties.type_flag_field.title = evil;
    schema.properties = JSON.parse(`{"__proto__":{"type":"string","title":"Polluter"},${JSON.stringify(schema.properties).slice(1)}`);
    const b = await withPreset([base(), h80(), metis({ options_schema: schema })]);
    expect(document.querySelector('img')).toBeNull();
    expect(b.textContent).toContain(evil);
    expect(({} as Record<string, unknown>)['type']).toBeUndefined();
  });

  it('a driver without options_schema still opens the preset (no crash, no options section, checklist present)', async () => {
    const b = await withPreset([base(), h80(), metis({ options_schema: undefined })]);
    expect(within(b).queryByLabelText(/type flag field/i)).toBeNull();
    expect(screen.queryByRole('region', { name: /commissioning checklist/i })).not.toBeNull();
  });
});

describe('MET-T05 preset — code-map suggestions (done_when 3, addendum §3 item ids; U2: which ids a lab runs is unknown, C3 rows are tenant data)', () => {
  it('lists the addendum\'s example item ids and names in a "Suggested analyte codes" region', async () => {
    await withPreset();
    const t = region(/suggested analyte codes/i).textContent ?? '';
    for (const c of ['ALT', 'AST', 'CoV2Ag']) expect(t, c).toContain(c);
    for (const id of ['0', '1', '1112']) expect(t, `id ${id}`).toMatch(new RegExp(`(^|[^0-9])${id}([^0-9]|$)`));
  });

  it('says the ids are the analyser\'s own and that the lab\'s ids are confirmed at commissioning (U2); nothing is claimed as the full list', async () => {
    await withPreset();
    const t = region(/suggested analyte codes/i).textContent ?? '';
    expect(t).toMatch(/analy[sz]er'?s own/i);
    expect(t).toMatch(/commissioning/i);
    expect(t).toMatch(/item list/i);
  });

  it('only suggests: no code-map request is made while the form is used or submitted (nothing seeded, C3 owns the rows)', async () => {
    const b = await withPreset();
    await fillCommon(b);
    await fillNet(b);
    await submit();
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(seen).toEqual([]);
    expect(JSON.stringify(calls[0]!.body)).not.toMatch(/code_map|CoV2Ag/);
  });

  it('is absent without the preset', async () => {
    await open();
    expect(screen.queryByRole('region', { name: /suggested analyte codes/i })).toBeNull();
  });
});

describe('MET-T05 preset — nine-step commissioning checklist (done_when 3, addendum §9)', () => {
  it('shows an ordered list of exactly nine steps in order, each carrying its key terms', async () => {
    await withPreset();
    const r = region(/commissioning checklist/i);
    const items = within(r).getAllByRole('listitem');
    expect(items).toHaveLength(9);
    expect(r.querySelector('ol')).not.toBeNull();
    CHECKLIST.forEach(([name, res], i) => { for (const re of res) expect(items[i]!.textContent, `step ${name}`).toMatch(re); });
  });

  it('points to the Metis runbook (not the H80E one)', async () => {
    await withPreset();
    const t = region(/commissioning checklist/i).textContent ?? '';
    expect(t).toContain('docs/manual/instruments/getein-metis-commissioning.md');
    expect(t).not.toContain('truth-h80e-commissioning');
  });

  it('says promotion to verified is a reviewed migration and the host-query switch comes after, not before', async () => {
    await withPreset();
    const t = region(/commissioning checklist/i).textContent ?? '';
    expect(t).toMatch(/reviewed migration/i);
  });

  it('uses no wording copied from Truth H80E (HbA1c) in the Metis checklist', async () => {
    await withPreset();
    expect(region(/commissioning checklist/i).textContent).not.toMatch(/HbA1c|H80E/i);
  });

  it('is absent without the preset', async () => {
    await open();
    expect(screen.queryByRole('region', { name: /commissioning checklist/i })).toBeNull();
  });
});

describe('MET-T05 preset — host-query toggle stays disabled with a reason while the driver is generic (done_when 4, LD-163)', () => {
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
    await fillNet(b);
    await submit();
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body.capabilities.host_query).toBe(false);
  });

  it('regression: a VERIFIED Metis driver that declares host_query has an enabled toggle (after a later promotion)', async () => {
    await withPreset([base(), h80(), metis({ status: 'verified' })]);
    expect(sw().disabled).toBe(false);
  });

  it('worklist download stays disabled (D-MET-1, AC-03.4)', async () => {
    await withPreset();
    const w = screen.getByRole('switch', { name: /worklist download/i }) as HTMLInputElement;
    expect(w.disabled || w.getAttribute('aria-disabled') === 'true').toBe(true);
  });
});

describe('MET-T05 preset — accessibility', () => {
  it('axe: form with the Metis preset selected (options, suggestions, checklist, disabled toggle with reason)', async () => {
    await withPreset();
    await noAxeViolations();
  });
});
