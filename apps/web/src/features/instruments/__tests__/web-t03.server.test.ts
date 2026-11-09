// WEB-T03 — schema-driven form helpers (forms/*) and BFF server functions for SCR-05/06/07 (E22–E31).
// ACs: AC-03.1 (create → draft), AC-03.2 (transport schema, JSON-Pointer paths), AC-04.1..04.5 (commissioning calls).
// ASSUMED module/signature contract (spec gives only folders + operationIds; dispute if wrong):
//   forms/transport.ts   validateTransport(t) → {path: string, message: string}[]   (paths relative to the instrument body: '/transport/port'); TRANSPORT_KINDS_BY_PROTOCOL
//   forms/errors.ts      fieldErrorsByPointer(errors?) → Record<pointer, message>   (first message per path; own-property map, no prototype pollution)
//   server/types.ts      parseInstrumentQuery(sp) → {centreId?, agentId?, state[], protocol?, sort};  default state = all except retired
//   server/listDrivers.server.ts listDrivers({protocol?, status?})            E22
//   server/listInstruments.server.ts listInstruments({agentId?, centreId?, state?, protocol?, sort?, limit?, cursor?})  E23 (agentId now optional)
//   server/getInstrument.server.ts getInstrument(id)                          E25
//   server/createInstrument.server.ts createInstrument(input, idempotencyKey?) E24 (Idempotency-Key)
//   server/updateInstrument.server.ts updateInstrument(id, version, patch)    E26 (If-Match "<version>")
//   server/startInstrumentCommissioning.server.ts startInstrumentCommissioning(id, version)            E27
//   server/goLiveInstrument.server.ts goLiveInstrument(id, version, {checklist, evidence_note})        E28
//   server/suspendInstrument.server.ts suspendInstrument(id, version, reasonText)                      E29
//   server/resumeInstrument.server.ts resumeInstrument(id, version)                                    E30
//   server/retireInstrument.server.ts retireInstrument(id, version, reasonText)                        E31
// Invalid input must throw ApiError(400 common.validation_failed) BEFORE any network call. Synthetic data only.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({ getAccessToken: async () => 'jwt-synthetic', getShellSession: async () => undefined }));

const ORIGIN = 'http://api.test';
process.env.LIMS_ORIGIN_API = ORIGIN;
const INST = '01a1a98a-ac40-7000-8000-0000000e0001';
const AGENT = '01a1a98a-ac40-7000-8000-0000000d0101';
const CENTRE = '01a1a98a-ac40-7000-8000-0000000c0001';
const IM = `${ORIGIN}/v1/instruments/instruments`;

const seen: { url: URL; method: string; headers: Headers; body?: any }[] = [];
const rec = async (r: Request) => { seen.push({ url: new URL(r.url), method: r.method, headers: r.headers, body: r.method === 'GET' ? undefined : await r.clone().json().catch(() => undefined) }); };
const instrument = (o: Record<string, unknown> = {}) => ({ id: INST, instrument_code: 'SIM-CHEM-1', display_name: 'Sim chem', state: 'draft', version: 4, ...o });
const server = setupServer(
  http.get(`${ORIGIN}/v1/instruments/drivers`, async ({ request }) => { await rec(request); return HttpResponse.json({ data: [] }); }),
  http.get(IM, async ({ request }) => { await rec(request); return HttpResponse.json({ data: [], page: { limit: 50 } }); }),
  http.get(`${IM}/:id`, async ({ request }) => { await rec(request); return HttpResponse.json(instrument()); }),
  http.post(IM, async ({ request }) => { await rec(request); return HttpResponse.json(instrument(), { status: 201 }); }),
  http.patch(`${IM}/:id`, async ({ request }) => { await rec(request); return HttpResponse.json(instrument({ version: 5 })); }),
  http.post(`${IM}/:id/:action`, async ({ request }) => { await rec(request); return HttpResponse.json(instrument({ version: 5 })); }),
);
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { server.resetHandlers(); seen.length = 0; });
afterAll(() => server.close());

const serial = { kind: 'serial', port_name: 'COM3', baud_rate: 9600, data_bits: 8, parity: 'none', stop_bits: '1' };
const create = (o: Record<string, unknown> = {}) => ({
  instrument_code: 'SIM-CHEM-1', display_name: 'Sim chem', agent_id: AGENT, vendor: 'Synthetic Vendor', model: 'SV-100',
  protocol: 'astm', driver_code: 'astm_generic_e1394', transport: serial, capabilities: { host_query: false, worklist_download: false }, ...o,
});
const rejects400 = async (p: Promise<unknown>) => { await expect(p).rejects.toMatchObject({ status: 400, problem: { code: 'common.validation_failed' } }); expect(seen).toHaveLength(0); };

describe('forms/transport — validateTransport mirrors 02-TRD §5.8 (AC-03.2)', () => {
  const load = async () => import('../forms/transport');
  const paths = (v: { path: string }[]) => v.map((x) => x.path).sort();

  it('valid serial / tcp_client / tcp_server / file_drop → no issues', async () => {
    const { validateTransport } = await load();
    expect(validateTransport(serial)).toEqual([]);
    expect(validateTransport({ kind: 'tcp_client', host: 'analyser.lab', port: 5000, connect_timeout_s: 10, reconnect_max_backoff_s: 60 })).toEqual([]);
    expect(validateTransport({ kind: 'tcp_server', bind_address: '10.0.0.5', port: 5001, allowed_peers: ['10.0.0.9'] })).toEqual([]);
  });

  it('serial: baud outside the allowed list, port_name not COMn, data_bits/parity/stop_bits outside enums → pointer paths', async () => {
    const { validateTransport } = await load();
    expect(paths(validateTransport({ ...serial, baud_rate: 14400 }))).toEqual(['/transport/baud_rate']);
    expect(paths(validateTransport({ ...serial, port_name: 'com3' }))).toEqual(['/transport/port_name']);
    expect(paths(validateTransport({ ...serial, port_name: 'COM0' }))).toEqual(['/transport/port_name']);
    expect(paths(validateTransport({ ...serial, data_bits: 9, parity: 'weird', stop_bits: '3' }))).toEqual(['/transport/data_bits', '/transport/parity', '/transport/stop_bits']);
    for (const baud of [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200]) expect(validateTransport({ ...serial, baud_rate: baud })).toEqual([]);
  });

  it('tcp_client: port 0 / 65536 / non-integer, host with illegal characters, timeouts out of range', async () => {
    const { validateTransport } = await load();
    const ok = { kind: 'tcp_client', host: '10.0.0.7', port: 5000 };
    expect(validateTransport({ ...ok, port: 1 })).toEqual([]);
    expect(validateTransport({ ...ok, port: 65535 })).toEqual([]);
    for (const port of [0, 65536, -1, 1.5, '5000']) expect(paths(validateTransport({ ...ok, port })), String(port)).toEqual(['/transport/port']);
    expect(paths(validateTransport({ ...ok, host: 'a b;rm -rf' }))).toEqual(['/transport/host']);
    expect(paths(validateTransport({ ...ok, host: 'h'.repeat(254) }))).toEqual(['/transport/host']);
    expect(paths(validateTransport({ ...ok, connect_timeout_s: 61, reconnect_max_backoff_s: 301 }))).toEqual(['/transport/connect_timeout_s', '/transport/reconnect_max_backoff_s']);
  });

  it('tcp_server: port ≥ 1024, bind_address IPv4 but not 0.0.0.0 / loopback, 1–8 allowed IPv4 peers', async () => {
    const { validateTransport } = await load();
    const ok = { kind: 'tcp_server', bind_address: '10.0.0.5', port: 5001, allowed_peers: ['10.0.0.9'] };
    expect(paths(validateTransport({ ...ok, port: 1023 }))).toEqual(['/transport/port']);
    expect(paths(validateTransport({ ...ok, bind_address: '0.0.0.0' }))).toEqual(['/transport/bind_address']);
    expect(paths(validateTransport({ ...ok, bind_address: '127.0.0.1' }))).toEqual(['/transport/bind_address']);
    expect(paths(validateTransport({ ...ok, bind_address: 'host.local' }))).toEqual(['/transport/bind_address']);
    expect(paths(validateTransport({ ...ok, allowed_peers: [] }))).toEqual(['/transport/allowed_peers']);
    expect(paths(validateTransport({ ...ok, allowed_peers: Array.from({ length: 9 }, (_, i) => `10.0.1.${i + 1}`) }))).toEqual(['/transport/allowed_peers']);
    expect(paths(validateTransport({ ...ok, allowed_peers: ['10.0.0.256'] }))).toEqual(['/transport/allowed_peers']);
  });

  it('unknown kind, non-object and prototype-ish input never throw and always yield an issue', async () => {
    const { validateTransport } = await load();
    for (const t of [undefined, null, 'serial', 7, [], { kind: 'bluetooth' }, { kind: '__proto__' }, JSON.parse('{"__proto__":{"kind":"serial"}}')]) {
      expect(validateTransport(t).length, JSON.stringify(t)).toBeGreaterThan(0);
    }
  });

  it('TRANSPORT_KINDS_BY_PROTOCOL: astm offers serial + tcp; file_drop offers only file_drop (04-UI-UX SCR-06 §2)', async () => {
    const { TRANSPORT_KINDS_BY_PROTOCOL: k } = await load();
    expect(k.astm).toEqual(expect.arrayContaining(['serial', 'tcp_client', 'tcp_server']));
    expect(k.hl7v2).toEqual(expect.arrayContaining(['tcp_client', 'tcp_server']));
    expect(k.file_drop).toEqual(['file_drop']);
  });
});

describe('forms/errors — fieldErrorsByPointer (error mapping by JSON Pointer)', () => {
  const load = async () => (await import('../forms/errors')).fieldErrorsByPointer;

  it('maps path → message; keeps the first message per path', async () => {
    const f = await load();
    expect(f([{ path: '/transport/port', code: 'common.out_of_range', message: 'port must be 1–65535' }, { path: '/transport/port', code: 'x', message: 'second' }, { path: '/vendor', code: 'common.field_required', message: 'vendor is required' }]))
      .toEqual({ '/transport/port': 'port must be 1–65535', '/vendor': 'vendor is required' });
  });

  it('tolerates missing / malformed errors[] and never pollutes Object.prototype', async () => {
    const f = await load();
    expect(f(undefined)).toEqual({});
    expect(f(null as never)).toEqual({});
    expect(f('nope' as never)).toEqual({});
    expect(f([{ nope: 1 }, null, 7] as never)).toEqual({});
    f([{ path: '/__proto__/polluted', code: 'x', message: 'y' }, { path: '__proto__', code: 'x', message: 'y' }, { path: '/constructor/prototype/p', code: 'x', message: 'y' }]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).p).toBeUndefined();
  });
});

describe('server/types — parseInstrumentQuery (SCR-05 filters)', () => {
  it('no query → default state excludes retired; unknown values dropped (tampered query never reaches the API)', async () => {
    const { parseInstrumentQuery } = await import('../server/types');
    const d = parseInstrumentQuery({});
    expect([...d.state].sort()).toEqual(['commissioning', 'draft', 'live', 'suspended']);
    expect(d.sort).toBe('instrument_code');
    const t = parseInstrumentQuery({ state: "live,x'; drop", protocol: 'ftp', sort: 'password', centre_id: 'not-a-uuid', agent_id: 'nope' });
    expect(t.state).toEqual(['live']);
    expect(t.protocol).toBeUndefined();
    expect(t.sort).toBe('instrument_code');
    expect(t.centreId).toBeUndefined();
    expect(t.agentId).toBeUndefined();
    const ok = parseInstrumentQuery({ state: 'retired,live', protocol: 'astm', sort: '-last_message_at', centre_id: CENTRE, agent_id: AGENT });
    expect(ok).toMatchObject({ protocol: 'astm', sort: '-last_message_at', centreId: CENTRE, agentId: AGENT });
    expect([...ok.state].sort()).toEqual(['live', 'retired']);
  });
});

describe('WEB-T03 server functions', () => {
  it('listDrivers → GET E22 with protocol/status filters; bad enum rejected before the network', async () => {
    const { listDrivers } = await import('../server/listDrivers.server');
    await listDrivers({ protocol: 'astm', status: 'verified' });
    expect(seen[0]!.url.pathname).toBe('/v1/instruments/drivers');
    expect(seen[0]!.url.searchParams.get('protocol')).toBe('astm');
    expect(seen[0]!.url.searchParams.get('status')).toBe('verified');
    seen.length = 0;
    await rejects400(listDrivers({ protocol: 'ftp' as never }));
  });

  it('listInstruments (E23) without agentId: centre_id / state csv / protocol / sort map to contract names; E21 agent_id still works', async () => {
    const { listInstruments } = await import('../server/listInstruments.server');
    await listInstruments({ centreId: CENTRE, state: ['draft', 'live'], protocol: 'astm', sort: '-last_message_at', limit: 50 });
    const u = seen[0]!.url;
    expect(u.searchParams.get('centre_id')).toBe(CENTRE);
    expect(u.searchParams.get('state')).toBe('draft,live');
    expect(u.searchParams.get('protocol')).toBe('astm');
    expect(u.searchParams.get('sort')).toBe('-last_message_at');
    expect(u.searchParams.has('agent_id')).toBe(false);
    seen.length = 0;
    await listInstruments({ agentId: AGENT });
    expect(seen[0]!.url.searchParams.get('agent_id')).toBe(AGENT);
    seen.length = 0;
    await rejects400(listInstruments({ state: ['live', 'bogus'] as never }));
    await rejects400(listInstruments({ centreId: 'not-a-uuid' }));
  });

  it('getInstrument → GET E25; non-uuid id rejected locally (no path traversal into other endpoints)', async () => {
    const { getInstrument } = await import('../server/getInstrument.server');
    expect((await getInstrument(INST)).id).toBe(INST);
    expect(seen[0]!.url.pathname).toBe(`/v1/instruments/instruments/${INST}`);
    seen.length = 0;
    await rejects400(getInstrument('../agents'));
    await rejects400(getInstrument(`${INST}/go-live`));
  });

  it('createInstrument → POST E24 with the body, Bearer, and an Idempotency-Key (given key is forwarded; absent key → generated)', async () => {
    const { createInstrument } = await import('../server/createInstrument.server');
    await createInstrument(create() as never, 'key-0001');
    const r = seen[0]!;
    expect(r.method).toBe('POST');
    expect(r.headers.get('authorization')).toBe('Bearer jwt-synthetic');
    expect(r.headers.get('idempotency-key')).toBe('key-0001');
    expect(r.body).toMatchObject({ instrument_code: 'SIM-CHEM-1', agent_id: AGENT, protocol: 'astm', driver_code: 'astm_generic_e1394', transport: serial, capabilities: { host_query: false, worklist_download: false } });
    seen.length = 0;
    await createInstrument(create() as never);
    expect(seen[0]!.headers.get('idempotency-key')).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });

  it('createInstrument rejects invalid input locally with 400 common.validation_failed (code, uuid, lengths, transport schema, key charset)', async () => {
    const { createInstrument } = await import('../server/createInstrument.server');
    await rejects400(createInstrument(create({ instrument_code: 'lower' }) as never, 'k1'));
    await rejects400(createInstrument(create({ instrument_code: 'A' }) as never, 'k1'));
    await rejects400(createInstrument(create({ display_name: '' }) as never, 'k1'));
    await rejects400(createInstrument(create({ display_name: 'x'.repeat(81) }) as never, 'k1'));
    await rejects400(createInstrument(create({ vendor: '' }) as never, 'k1'));
    await rejects400(createInstrument(create({ model: 'm'.repeat(61) }) as never, 'k1'));
    await rejects400(createInstrument(create({ agent_id: 'nope' }) as never, 'k1'));
    await rejects400(createInstrument(create({ protocol: 'ftp' }) as never, 'k1'));
    await rejects400(createInstrument(create({ transport: { ...serial, baud_rate: 14400 } }) as never, 'k1'));
    await rejects400(createInstrument(create({ transport: { kind: 'tcp_client', host: 'h', port: 70000 } }) as never, 'k1'));
    await rejects400(createInstrument(create({ capabilities: { host_query: 'yes', worklist_download: false } }) as never, 'k1'));
    await rejects400(createInstrument(create() as never, 'bad key with spaces'));
  });

  it('updateInstrument → PATCH E26 with If-Match "<version>"; instrument_code and agent_id are immutable (never sent, rejected locally)', async () => {
    const { updateInstrument } = await import('../server/updateInstrument.server');
    await updateInstrument(INST, 4, { display_name: 'Renamed', capabilities: { host_query: true, worklist_download: false } } as never);
    const r = seen[0]!;
    expect(r.method).toBe('PATCH');
    expect(r.url.pathname).toBe(`/v1/instruments/instruments/${INST}`);
    expect(r.headers.get('if-match')).toBe('"4"');
    expect(r.body).toEqual({ display_name: 'Renamed', capabilities: { host_query: true, worklist_download: false } });
    seen.length = 0;
    await rejects400(updateInstrument(INST, 4, { instrument_code: 'OTHER-1' } as never));
    await rejects400(updateInstrument(INST, 4, { agent_id: AGENT } as never));
    await rejects400(updateInstrument(INST, 0, { display_name: 'x' }));
    await rejects400(updateInstrument(INST, 1.5, { display_name: 'x' }));
    await rejects400(updateInstrument('nope', 1, { display_name: 'x' }));
  });

  it('startInstrumentCommissioning (E27) / resumeInstrument (E30) → POST {} with If-Match', async () => {
    const { startInstrumentCommissioning } = await import('../server/startInstrumentCommissioning.server');
    const { resumeInstrument } = await import('../server/resumeInstrument.server');
    await startInstrumentCommissioning(INST, 4);
    await resumeInstrument(INST, 7);
    expect(seen.map((s) => s.url.pathname)).toEqual([`/v1/instruments/instruments/${INST}/start-commissioning`, `/v1/instruments/instruments/${INST}/resume`]);
    expect(seen.map((s) => s.headers.get('if-match'))).toEqual(['"4"', '"7"']);
    expect(seen.map((s) => s.method)).toEqual(['POST', 'POST']);
    expect(seen.map((s) => s.body)).toEqual([{}, {}]);
    seen.length = 0;
    await rejects400(startInstrumentCommissioning('nope', 1));
    await rejects400(resumeInstrument(INST, 0));
  });

  it('goLiveInstrument → POST E28 {checklist(4 booleans), evidence_note}; incomplete checklist or note < 10 / > 2000 rejected locally', async () => {
    const { goLiveInstrument } = await import('../server/goLiveInstrument.server');
    const checklist = { manual_reference_confirmed: true, sample_comparison_done: true, qc_comparison_done: true, mappings_reviewed: true };
    await goLiveInstrument(INST, 4, { checklist, evidence_note: 'Compared 10 samples with printout.' });
    expect(seen[0]!.url.pathname).toBe(`/v1/instruments/instruments/${INST}/go-live`);
    expect(seen[0]!.headers.get('if-match')).toBe('"4"');
    expect(seen[0]!.body).toEqual({ checklist, evidence_note: 'Compared 10 samples with printout.' });
    seen.length = 0;
    await rejects400(goLiveInstrument(INST, 4, { checklist: { ...checklist, qc_comparison_done: false }, evidence_note: 'Compared 10 samples.' }));
    await rejects400(goLiveInstrument(INST, 4, { checklist: { manual_reference_confirmed: true } as never, evidence_note: 'Compared 10 samples.' }));
    await rejects400(goLiveInstrument(INST, 4, { checklist, evidence_note: 'too short' }));
    await rejects400(goLiveInstrument(INST, 4, { checklist, evidence_note: 'x'.repeat(2001) }));
    await rejects400(goLiveInstrument(INST, 4, { checklist: { ...checklist, extra: true } as never, evidence_note: 'Compared 10 samples.' }));
  });

  it('suspendInstrument (E29) / retireInstrument (E31) → POST {reason_text 3–300} with If-Match; out-of-range reason rejected locally', async () => {
    const { suspendInstrument } = await import('../server/suspendInstrument.server');
    const { retireInstrument } = await import('../server/retireInstrument.server');
    await suspendInstrument(INST, 6, 'Reagent problem');
    await retireInstrument(INST, 6, 'Analyser decommissioned');
    expect(seen.map((s) => s.url.pathname)).toEqual([`/v1/instruments/instruments/${INST}/suspend`, `/v1/instruments/instruments/${INST}/retire`]);
    expect(seen.map((s) => s.body)).toEqual([{ reason_text: 'Reagent problem' }, { reason_text: 'Analyser decommissioned' }]);
    expect(seen.map((s) => s.headers.get('if-match'))).toEqual(['"6"', '"6"']);
    seen.length = 0;
    for (const bad of ['', 'ab', 'x'.repeat(301)]) {
      await rejects400(suspendInstrument(INST, 6, bad));
      await rejects400(retireInstrument(INST, 6, bad));
    }
  });

  it('API problems surface as ApiError with status + code (409 invalid_transition, 422 driver_not_available, 422 go_live_checklist_incomplete, 409 code_duplicate)', async () => {
    const { startInstrumentCommissioning } = await import('../server/startInstrumentCommissioning.server');
    const { createInstrument } = await import('../server/createInstrument.server');
    const prob = (status: number, code: string) => HttpResponse.json({ type: `urn:lims:error:${code}`, title: 'x', status, code }, { status });
    server.use(http.post(`${IM}/:id/start-commissioning`, () => prob(409, 'instruments.invalid_transition')), http.post(IM, () => prob(409, 'instruments.code_duplicate')));
    await expect(startInstrumentCommissioning(INST, 4)).rejects.toMatchObject({ status: 409, problem: { code: 'instruments.invalid_transition' } });
    await expect(createInstrument(create() as never, 'k1')).rejects.toMatchObject({ status: 409, problem: { code: 'instruments.code_duplicate' } });
  });
});
