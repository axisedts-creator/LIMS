// @vitest-environment jsdom
// WEB-T05 — SCR-09 Messages `/instruments/messages` and SCR-10 Message detail `/instruments/messages/{instrument_message_id}`
// (04-UI-UX §3 SCR-09/SCR-10, 03-APP-FLOW §12 attachment viewing). Data: E33–E39, E42.
// ACs: AC-12.6 (attachment "Open" streams through the BFF — no Storage URL), AC-18.1 (list, filters, barcode search by POST only), AC-18.2 (detail, records, C5 exception hint),
//      AC-18.3 (Show raw → E36, state cleared on close), AC-19.1–19.5 (reprocess / re-match dialogs + outcome table + error surfaces).
//      done_when: "barcode only in POST body; raw cleared on close; download via stream, no URL".
// Component tests + MSW (server actions run for real against MSW) + axe. Synthetic data only.
// ASSUMED module/prop contract (spec fixes folders + copy + kit components only; dispute to rename):
//   components/MessagesList.tsx    export MessagesList({messages, rejections, instruments, agents, permissions})      SCR-09; filters live in the URL (useSearchParams → router.replace)
//        messages: MessageSummary[] (E33)   rejections: MessageRejection[] (E42)   instruments: InstrumentSummary[] (E23)   agents: AgentSummary[] (E10)
//        Label "Barcode" (BarcodeInput, Enter submits) · Switch "Has QC records" · Select "Instrument" · tab "Rejected uploads" · chip text "Search results for scanned barcode" + button "Clear"
//   components/MessageDetail.tsx   export MessageDetail({message, permissions})   SCR-10 (message: MessageDetail DTO of E35)
//        Buttons "Show raw" (Alt+R), "Reprocess" (Alt+P, rematch only), row action "Re-match…" (rematch only; patient/attachment records), link "Open" (clean attachment only) → href /instruments/messages/{id}/attachment
//        Raw = Drawer (role dialog) with CodeBlock region "Raw message" (renderControlChars, no copy) and caption "Viewing raw messages is recorded."
//        Reprocess = ConfirmDialog (confirm button "Reprocess", Select "Reason"); Re-match = dialog (original barcode read-only, BarcodeInput "New barcode", Select "Reason" default barcode_keypad_error, TextArea "Note", button "Re-match")
//        Both dialogs end with an outcome table (record barcode + port outcome text); success → router.refresh()
//   app/(staff)/instruments/messages/page.tsx                                  default async Page({searchParams: Promise<…>}) → element with props above
//   app/(staff)/instruments/messages/[instrument_message_id]/page.tsx          default async Page({params: Promise<{instrument_message_id}>}) → element with props {message, permissions}
// permissions: readonly string[] (session.actor.permissions); read = instruments.message.read; rematch = instruments.message.rematch.
// NOT tested (spec silent): DateRangePicker interaction (range is covered at page + BFF level), Agent/Centre/Kind/Latest-outcome filter widgets, the `preview: true` banner of E38,
//   records_expired preview-parse button copy beyond the spec text, Alt+R/Alt+P key chords beyond registry presence, retired-instrument copy (the API's 409 is shown as an alert).
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { delay, http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { ReactNode } from 'react';
import { ToastProvider } from '@lims/ui/components/Toast';

const push = vi.fn();
const replace = vi.fn();
const refresh = vi.fn();
const nav = vi.hoisted(() => ({ search: '' }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace, refresh, back: vi.fn() }),
  usePathname: () => '/instruments/messages',
  useSearchParams: () => new URLSearchParams(nav.search),
  notFound: () => { throw Object.assign(new Error('NEXT_NOT_FOUND'), { digest: 'NEXT_HTTP_ERROR_FALLBACK;404' }); },
}));
vi.mock('server-only', () => ({}));
const session = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: session.permissions, displayName: 'Synthetic Tech', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/instruments/messages',
}));

const ORIGIN = 'http://api.test';
process.env.LIMS_ORIGIN_API = ORIGIN;
const IM = `${ORIGIN}/v1/instruments`;
const READ = ['instruments.message.read'];
const REMATCH = ['instruments.message.read', 'instruments.message.rematch'];
session.permissions = REMATCH;

const MSG = '01a1a98a-ac40-7000-8000-0000000e0001';
const MSG2 = '01a1a98a-ac40-7000-8000-0000000e0002';
const INST = '01a1a98a-ac40-7000-8000-0000000d0001';
const AGENT = '01a1a98a-ac40-7000-8000-0000000d0101';
const CENTRE = '01a1a98a-ac40-7000-8000-000000020001';
const REC = (n: number) => `01a1a98a-ac40-7000-8000-0000000f000${n}`;
const EVT = (n: number) => `e${n}e${n}e${n}e${n}-ac40-7000-8000-0000000a000${n}`;
const BC = (n: number) => `SYN000000${n}`; // synthetic barcodes
const NEWBC = 'SYN0000009';
const RAWMARK = 'RAWMARKER42';
const RAW_TEXT = `\x02MSH|^~\\&|${RAWMARK}\rPID|1||SYN0000001\r\x03`;

const latest = (o: Record<string, unknown> = {}) => ({ run_no: 1, kind: 'live', outcome: 'parsed', patient_records: 3, qc_records: 0, calibrator_records: 0, unmapped_records: 1, emitted_events: 2, ...o });
const summary = (o: Record<string, unknown> = {}) => ({ id: MSG, instrument_id: INST, instrument_code: 'SIM-CHEM-1', agent_id: AGENT, centre_id: CENTRE, protocol: 'astm', message_kind: 'data', received_at: '2026-11-06T04:05:00.000Z', captured_at: '2026-11-06T04:00:00.000Z', size_bytes: 412, latest_run: latest(), ...o });
const SUMMARIES = [
  summary(),
  summary({ id: MSG2, instrument_code: 'SIM-HEM-2', message_kind: 'host_query', size_bytes: 1536, latest_run: latest({ outcome: 'quarantined', patient_records: 0, unmapped_records: 0, emitted_events: 0 }), sample_barcode: 'E2600000042' /* planted: lists must never show it */ }),
];
const REJECTIONS = [
  { id: '01a1a98a-ac40-7000-8000-0000000b0001', received_at: '2026-11-06T05:00:00.000Z', agent_id: AGENT, claimed_instrument_id: INST, agent_message_id: 'am-1', reason_code: 'instruments.device_mismatch', size_bytes: 2048, raw_sha256: 'b'.repeat(64), raw_bytes: 'PLANTED-RAW-BYTES' },
];
const INSTRUMENTS = [{ id: INST, instrument_code: 'SIM-CHEM-1', display_name: 'Sim chem', state: 'live' }, { id: '01a1a98a-ac40-7000-8000-0000000d0002', instrument_code: 'SIM-HEM-2', display_name: 'Sim hem', state: 'live' }];
const AGENTS = [{ id: AGENT, agent_code: 'AGT-1', display_name: 'Agent one', centre_id: CENTRE, status: 'active', update_channel: 'stable', version: 1, latest_config_version: 1, health: { state: 'online', queue_depth: 0, oldest_pending_age_seconds: 0 } }];

const rcd = (n: number, o: Record<string, unknown> = {}) => ({ id: REC(n), run_no: 2, record_seq: n, record_class: 'patient', sample_barcode: BC(n), instrument_analyte_code: `AN${n}`, mapping_status: 'mapped', value_raw: `1${n}.5`, unit_raw: 'g/dL', instrument_flags: [], emit_status: 'emitted', event_id: EVT(n), warnings: [], ...o });
const RECORDS = [
  rcd(1, { instrument_flags: ['H'], port_outcome: 'applied' }),
  rcd(2, { port_outcome: 'unmatched' }),
  rcd(3, { port_outcome: 'held' }),
  rcd(4, { port_outcome: 'rejected_state', port_reason_code: 'result_locked' }),
  rcd(5, { port_outcome: 'duplicate' }),
  rcd(6, { record_class: 'qc', sample_barcode: undefined, instrument_analyte_code: 'QC1', mapping_status: 'unmapped', emit_status: 'not_applicable', event_id: undefined }),
];
const run = (o: Record<string, unknown> = {}) => ({ id: '01a1a98a-ac40-7000-8000-0000000f0100', run_no: 1, kind: 'live', driver_code: 'astm_generic_e1394', driver_version: '0.1.0', outcome: 'parsed', patient_records: 5, qc_records: 1, calibrator_records: 0, host_query_records: 0, unmapped_records: 1, skipped_no_barcode_records: 0, emitted_events: 5, skipped_records: 0, actor_type: 'device', created_at: '2026-11-06T04:05:01.000Z', ...o });
const RUNS = [run(), run({ id: '01a1a98a-ac40-7000-8000-0000000f0101', run_no: 2, kind: 'reprocess', actor_type: 'user', actor_display: 'Synthetic Tech', reason_code: 'driver_fixed', created_at: '2026-11-07T01:00:00.000Z' })];
const detail = (o: Record<string, unknown> = {}) => ({ ...summary({ latest_run: latest({ run_no: 2, kind: 'reprocess', patient_records: 5, qc_records: 1, unmapped_records: 1, emitted_events: 5 }) }), message_control_id: 'CTRL-77', message_key_kind: 'msh10', warnings: ['unknown_segment'], runs: RUNS, records: RECORDS, records_expired: false, ...o });
const ATTACHMENT = { attachment_id: '01a1a98a-ac40-7000-8000-0000000c0001', scan_state: 'clean', mime_type: 'application/pdf', size_bytes: 20480, original_file_name: 'report-synthetic.pdf' };

const calls: { method: string; url: URL; headers: Headers; body?: any }[] = [];
const rec = async (r: Request) => { calls.push({ method: r.method, url: new URL(r.url), headers: r.headers, body: r.method === 'GET' ? undefined : await r.clone().json().catch(() => undefined) }); };
const problem = (status: number, code: string, extra: Record<string, unknown> = {}) => HttpResponse.json({ type: `urn:lims:error:${code}`, title: code, status, code, ...extra }, { status });
const sent = (method: string, re: RegExp) => calls.filter((c) => c.method === method && re.test(c.url.pathname));
const searches = () => sent('POST', /\/messages\/search$/);
const raws = () => sent('GET', /\/messages\/[^/]+\/raw$/);
const reprocesses = () => sent('POST', /\/reprocess$/);
const rematches = () => sent('POST', /\/rematch$/);
const reprocessResult = { run: run({ run_no: 3, kind: 'reprocess', actor_type: 'user' }), records: RECORDS.slice(0, 5).map((r) => ({ ...r, run_no: 3 })), preview: false };
const api = setupServer(
  http.get(`${IM}/messages`, async ({ request }) => { await rec(request); return HttpResponse.json({ data: SUMMARIES, page: { limit: 50 } }); }),
  http.post(`${IM}/messages/search`, async ({ request }) => { await rec(request); return HttpResponse.json({ data: [summary({ id: MSG2, instrument_code: 'SIM-HEM-2' })] }); }),
  http.get(`${IM}/messages/:id/raw`, async ({ request }) => { await rec(request); return HttpResponse.json({ raw_base64: 'AA==', raw_text_escaped: RAW_TEXT, raw_sha256: 'a'.repeat(64), size_bytes: RAW_TEXT.length }); }),
  http.get(`${IM}/messages/:id`, async ({ request }) => { await rec(request); return HttpResponse.json(detail({ records_expired: false })); }),
  http.post(`${IM}/messages/:id/reprocess`, async ({ request }) => { await rec(request); return HttpResponse.json(reprocessResult); }),
  http.post(`${IM}/message-records/:id/rematch`, async ({ request }) => { await rec(request); return HttpResponse.json({ run: run({ run_no: 3, kind: 'rematch', actor_type: 'user' }), record: rcd(2, { id: '01a1a98a-ac40-7000-8000-0000000f0222', sample_barcode: NEWBC, source_record_id: REC(2), port_outcome: 'applied' }) }); }),
  http.get(`${IM}/rejections`, async ({ request }) => { await rec(request); return HttpResponse.json({ data: REJECTIONS, page: { limit: 50 } }); }),
  http.get(`${IM}/instruments`, async ({ request }) => { await rec(request); return HttpResponse.json({ data: INSTRUMENTS, page: { limit: 200 } }); }),
  http.get(`${IM}/agents`, async ({ request }) => { await rec(request); return HttpResponse.json({ data: AGENTS, page: { limit: 200 } }); }),
);
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { cleanup(); api.resetHandlers(); calls.length = 0; push.mockReset(); replace.mockReset(); refresh.mockReset(); localStorage.clear(); sessionStorage.clear(); nav.search = ''; session.permissions = REMATCH; });
afterAll(() => api.close());

const wrap = (ui: ReactNode) => render(<ToastProvider>{ui}</ToastProvider>);
const noAxeViolations = async () => {
  const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
  expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
};
const text = (root: HTMLElement = document.body) => root.textContent ?? '';
const bodyHas = (s: string | RegExp) => (typeof s === 'string' ? text().includes(s) : s.test(text()));
const rowOf = (re: RegExp) => screen.getByRole('row', { name: re });
const dialog = () => screen.getByRole('dialog');
const isDisabled = (el: HTMLElement) => (el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true';
const urlsPushed = () => [...push.mock.calls, ...replace.mock.calls].map((c) => String(c[0]));

const showList = async (props: Record<string, unknown> = {}) => {
  const { MessagesList } = await import('../components/MessagesList');
  return wrap(<MessagesList messages={SUMMARIES as never} rejections={REJECTIONS as never} instruments={INSTRUMENTS as never} agents={AGENTS as never} permissions={READ} {...(props as object)} />);
};
const showDetail = async (props: Record<string, unknown> = {}) => {
  const { MessageDetail } = await import('../components/MessageDetail');
  return wrap(<MessageDetail message={detail() as never} permissions={REMATCH} {...(props as object)} />);
};
const scan = async (value: string) => { const box = screen.getByLabelText(/barcode/i); await userEvent.type(box, `${value}{Enter}`); };

// ================================================================================================================ SCR-09 list
describe('SCR-09 / AC-18.1 — message list', () => {
  it('one row per message: instrument · kind · outcome chip as TEXT · unmapped · events · size; the row links to SCR-10 by id only', async () => {
    await showList();
    const r1 = rowOf(/SIM-CHEM-1/);
    expect(text(r1)).toMatch(/Parsed/);
    expect(text(r1)).toMatch(/412/);
    const link = within(r1).getAllByRole('link').find((a) => a.getAttribute('href')?.includes(MSG));
    expect(link?.getAttribute('href')).toBe(`/instruments/messages/${MSG}`);
    const r2 = rowOf(/SIM-HEM-2/);
    expect(text(r2)).toMatch(/Quarantined/);
    expect(text(r2)).toMatch(/host query/i);
    expect(within(r2).getAllByRole('link').some((a) => a.getAttribute('href') === `/instruments/messages/${MSG2}`)).toBe(true);
  });

  it('SECURITY (REQ-SEC-098, TRD §7.3): lists carry no barcode — a barcode planted on a summary is never rendered', async () => {
    await showList();
    expect(bodyHas('E2600000042')).toBe(false);
    expect(document.body.innerHTML).not.toContain('E2600000042');
  });

  it('empty → "No messages in this period."', async () => {
    await showList({ messages: [] });
    expect(bodyHas('No messages in this period.')).toBe(true);
  });

  it('rendering alone makes no request (data arrives through props from the page)', async () => {
    await showList();
    expect(calls).toHaveLength(0);
  });

  it('"Has QC records" switch → URL gets has_qc=true (E33 filter, review #35); Instrument select → instrument_id; no barcode in any pushed URL', async () => {
    await showList();
    await userEvent.click(screen.getByLabelText(/has qc records/i));
    await waitFor(() => expect(urlsPushed().some((u) => /[?&]has_qc=true/.test(u))).toBe(true));
    replace.mockReset(); push.mockReset();
    await userEvent.click(screen.getAllByRole('button', { name: /instrument/i })[0]!);
    await userEvent.click(await screen.findByRole('option', { name: /SIM-CHEM-1/ }));
    await waitFor(() => expect(urlsPushed().some((u) => u.includes(`instrument_id=${INST}`))).toBe(true));
  });

  it('axe', async () => {
    await showList();
    await noAxeViolations();
  });
});

describe('SCR-09 / AC-18.1 / REQ-SEC-098 — barcode search is a POST; the barcode is never in a URL, history or storage', () => {
  it('scan → E34 POST body {sample_barcode}; results replace the table with the chip "Search results for scanned barcode" + Clear', async () => {
    await showList();
    const histBefore = window.history.length;
    const hrefBefore = window.location.href;
    await scan(NEWBC);
    await waitFor(() => expect(searches()).toHaveLength(1));
    const c = searches()[0]!;
    expect(c.body).toMatchObject({ sample_barcode: NEWBC });
    expect(c.url.search).toBe('');
    expect(c.headers.get('authorization')).toBe('Bearer jwt-synthetic');
    expect(await screen.findByText(/Search results for scanned barcode/)).toBeTruthy();
    expect(screen.queryByRole('row', { name: /SIM-CHEM-1/ })).toBeNull(); // original table replaced
    expect(rowOf(/SIM-HEM-2/)).toBeTruthy();
    // the barcode left no trace
    expect(window.location.href).toBe(hrefBefore);
    expect(window.history.length).toBe(histBefore);
    expect(urlsPushed().join(' ')).not.toContain(NEWBC);
    expect(JSON.stringify(calls.filter((x) => x.method === 'GET').map((x) => x.url.toString()))).not.toContain(NEWBC);
    expect(JSON.stringify({ ...localStorage })).not.toContain(NEWBC);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(NEWBC);
  });

  it('"Clear" restores the original list, removes the chip and makes no further request', async () => {
    await showList();
    await scan(NEWBC);
    await screen.findByText(/Search results for scanned barcode/);
    const before = calls.length;
    await userEvent.click(screen.getByRole('button', { name: /^clear$/i }));
    expect(screen.queryByText(/Search results for scanned barcode/)).toBeNull();
    expect(rowOf(/SIM-CHEM-1/)).toBeTruthy();
    expect(calls.length).toBe(before);
  });

  it('a barcode that violates ^[A-Z0-9]{1,40}$ is refused in the field: no request at all', async () => {
    await showList();
    await userEvent.type(screen.getByLabelText(/barcode/i), 'bad barcode!{Enter}');
    expect(await screen.findByText(/doesn't look like a sample barcode/i)).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it('API failure (403/500) does not crash and does not show or leak the barcode; the original list stays', async () => {
    api.use(http.post(`${IM}/messages/search`, async ({ request }) => { await rec(request); return problem(500, 'common.internal'); }));
    await showList();
    await scan(NEWBC);
    await waitFor(() => expect(searches()).toHaveLength(1));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(rowOf(/SIM-CHEM-1/)).toBeTruthy();
    expect(screen.queryByText(/Search results for scanned barcode/)).toBeNull();
    expect(bodyHas(NEWBC)).toBe(false); // a failed search must not echo the barcode into the page
  });

  it('shortcut "/" is registered for SCR-09 (focus barcode search) and focuses the field', async () => {
    const { act } = await import('@testing-library/react');
    await showList();
    const sc = (await import('@/core/shortcuts/registry')).shortcuts.list('staff.instruments.messages').find((s) => s.key === '/');
    expect(sc).toBeTruthy();
    (document.activeElement as HTMLElement | null)?.blur();
    act(() => sc!.run());
    expect(document.activeElement).toBe(screen.getByLabelText(/barcode/i));
  });
});

describe('SCR-09 — second tab "Rejected uploads" (E42)', () => {
  it('shows received · agent · claimed instrument id · reason code · size; never raw bytes', async () => {
    await showList();
    await userEvent.click(screen.getByRole('tab', { name: /rejected uploads/i }));
    const row = await screen.findByRole('row', { name: /device.?mismatch/i });
    expect(text(row)).toMatch(/2048|2\.0\s?KB|2 KB/i);
    expect(text(row)).toMatch(/AGT-1|01a1a98a/);
    expect(bodyHas('PLANTED-RAW-BYTES')).toBe(false);
  });
});

// ================================================================================================================ SCR-10 detail
describe('SCR-10 / AC-18.2 — message detail', () => {
  it('header + metadata: instrument, protocol, kind, control id, key kind, size, warnings; sha is truncated (IdText)', async () => {
    await showDetail();
    const t = text();
    expect(t).toMatch(/SIM-CHEM-1/);
    expect(t).toMatch(/astm/i);
    expect(t).toMatch(/CTRL-77/);
    expect(t).toMatch(/msh10/i);
    expect(t).toMatch(/412/);
    expect(t).toMatch(/unknown_segment/);
  });

  it('Runs timeline: run 1 live (device) and run 2 reprocess by the user with the reason', async () => {
    await showDetail();
    const t = text();
    expect(t).toMatch(/Run 1/);
    expect(t).toMatch(/Run 2/);
    expect(t).toMatch(/reprocess/i);
    expect(t).toMatch(/Synthetic Tech/);
    expect(t).toMatch(/driver.?fixed|Driver fixed/i);
  });

  it('Records table: barcode · code · value · unit · flags · mapping status (text) · emit status · event id (IdText, full id in title)', async () => {
    await showDetail();
    const r1 = rowOf(new RegExp(BC(1)));
    expect(text(r1)).toMatch(/AN1/);
    expect(text(r1)).toMatch(/11\.5/);
    expect(text(r1)).toMatch(/g\/dL/);
    expect(Array.from(r1.querySelectorAll('td')).some((c) => /^\s*H\s*$/.test(c.textContent ?? ''))).toBe(true);
    expect(text(r1)).toMatch(/Mapped/);
    expect(text(r1)).toMatch(/Applied/);
    expect(within(r1).getByTitle(EVT(1))).toBeTruthy();
    expect(text(rowOf(/\bQC1\b/))).toMatch(/Unmapped/);
  });

  it('AC-19.3 / AC-19.1 outcome texts: Applied · Already received · Not matched · Locked (approved — amend in Lab) · On QC hold', async () => {
    await showDetail();
    expect(text(rowOf(new RegExp(BC(1))))).toMatch(/Applied/);
    expect(text(rowOf(new RegExp(BC(2))))).toMatch(/Not matched/);
    expect(text(rowOf(new RegExp(BC(3))))).toMatch(/On QC hold/);
    expect(text(rowOf(new RegExp(BC(4))))).toMatch(/Locked/);
    expect(text(rowOf(new RegExp(BC(5))))).toMatch(/Already received/);
  });

  it('AC-18.2 / CR-C7-014: unmatched and held rows show "Check the lab\'s instrument exceptions" WITHOUT a link (route id not registered; no hand-built URL)', async () => {
    await showDetail();
    for (const n of [2, 3]) {
      const row = rowOf(new RegExp(BC(n)));
      expect(text(row)).toContain("Check the lab's instrument exceptions");
      expect(within(row).queryAllByRole('link').filter((a) => /exception|lab|ingest/i.test(a.getAttribute('href') ?? ''))).toHaveLength(0);
    }
    expect(text(rowOf(new RegExp(BC(1))))).not.toContain("Check the lab's instrument exceptions");
    expect(document.querySelector('a[href*="ingest-exceptions"]')).toBeNull();
  });

  it('no records → "This message has no result records."', async () => {
    await showDetail({ message: detail({ records: [] }) });
    expect(bodyHas('This message has no result records.')).toBe(true);
  });

  it('records_expired → info banner + preview-parse button → E35 with preview_parse=true; the parsed rows are then shown', async () => {
    api.use(http.get(`${IM}/messages/:id`, async ({ request }) => { await rec(request); return HttpResponse.json(detail({ records_expired: false })); }));
    await showDetail({ message: detail({ records: [], records_expired: true }) });
    expect(bodyHas('Parsed rows older than 90 days are not kept. Show a preview parse of the original message.')).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: /preview parse/i }));
    await waitFor(() => expect(sent('GET', /\/messages\/[^/]+$/)).toHaveLength(1));
    expect(sent('GET', /\/messages\/[^/]+$/)[0]!.url.searchParams.get('preview_parse')).toBe('true');
    expect(await screen.findByRole('row', { name: new RegExp(BC(1)) })).toBeTruthy();
  });

  it('axe (with the records table)', async () => {
    await showDetail();
    await noAxeViolations();
  });
});

// ================================================================================================================ raw drawer
describe('SCR-10 / AC-18.3 — "Show raw" drawer (E36): control characters as text badges, no copy, cleared on close', () => {
  const open = async () => { await userEvent.click(screen.getByRole('button', { name: /show raw/i })); return screen.findByRole('dialog'); };

  it('nothing is fetched until "Show raw" is pressed; then ONE E36 GET; the region "Raw message" shows <STX>/<CR>/<ETX> badges and the caption', async () => {
    await showDetail();
    expect(raws()).toHaveLength(0);
    const d = await open();
    await waitFor(() => expect(raws()).toHaveLength(1));
    const region = await within(d).findByRole('region', { name: 'Raw message' });
    await waitFor(() => expect(text(region)).toContain(RAWMARK));
    expect(text(region)).toMatch(/<STX>/);
    expect(text(region)).toMatch(/<CR>/);
    expect(text(region)).toMatch(/<ETX>/);
    expect(text(d)).toContain('Viewing raw messages is recorded.');
    expect(raws()[0]!.url.pathname).toBe(`/v1/instruments/messages/${MSG}/raw`);
  });

  it('allowCopy=false (PHI): no Copy button in the drawer and a copy event on the raw region is cancelled', async () => {
    await showDetail();
    const d = await open();
    const region = await within(d).findByRole('region', { name: 'Raw message' });
    expect(within(d).queryByRole('button', { name: /^copy/i })).toBeNull();
    expect(fireEvent.copy(region)).toBe(false);
    expect(fireEvent.cut(region)).toBe(false);
  });

  it('closing clears the raw text from the DOM, storage and component state; re-opening fetches AGAIN (every view is audited)', async () => {
    await showDetail();
    const d = await open();
    await within(d).findByRole('region', { name: 'Raw message' });
    await waitFor(() => expect(bodyHas(RAWMARK)).toBe(true));
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(bodyHas(RAWMARK)).toBe(false);
    expect(document.body.innerHTML).not.toContain(RAWMARK);
    expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain(RAWMARK);
    await open();
    await waitFor(() => expect(raws()).toHaveLength(2));
  });

  it('an in-flight raw load that finishes after the drawer was closed must not re-show the raw text', async () => {
    api.use(http.get(`${IM}/messages/:id/raw`, async ({ request }) => { await rec(request); await delay(150); return HttpResponse.json({ raw_base64: 'AA==', raw_text_escaped: RAW_TEXT, raw_sha256: 'a'.repeat(64), size_bytes: 9 }); }));
    await showDetail();
    await open();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await delay(400);
    expect(bodyHas(RAWMARK)).toBe(false);
  });

  it('E36 404 / 403 → the drawer shows an error alert and NO raw text', async () => {
    api.use(http.get(`${IM}/messages/:id/raw`, () => problem(403, 'auth.forbidden')));
    await showDetail();
    const d = await open();
    expect(await within(d).findByRole('alert')).toBeTruthy();
    expect(bodyHas(RAWMARK)).toBe(false);
  });

  it('XSS: raw text containing markup is rendered as text only', async () => {
    api.use(http.get(`${IM}/messages/:id/raw`, () => HttpResponse.json({ raw_base64: 'AA==', raw_text_escaped: '<img src=x onerror=alert(1)><script>alert(2)</script>', raw_sha256: 'a'.repeat(64), size_bytes: 9 })));
    await showDetail();
    const d = await open();
    await within(d).findByRole('region', { name: 'Raw message' });
    await waitFor(() => expect(text(d)).toContain('<img src=x'));
    expect(d.querySelector('img, script')).toBeNull();
  });

  it('axe with the drawer open', async () => {
    await showDetail();
    const d = await open();
    await within(d).findByRole('region', { name: 'Raw message' });
    await noAxeViolations();
  });

  it('page shortcuts: Alt+R (Show raw) is registered for SCR-10; Alt+P (Reprocess) only with instruments.message.rematch', async () => {
    const reg = (await import('@/core/shortcuts/registry')).shortcuts;
    const list = () => reg.list('staff.instruments.message').map((s) => s.key.toLowerCase());
    const { unmount } = await showDetail({ permissions: READ });
    expect(list()).toContain('alt+r');
    expect(list()).not.toContain('alt+p');
    unmount();
    await showDetail({ permissions: REMATCH });
    expect(list()).toContain('alt+r');
    expect(list()).toContain('alt+p');
    cleanup();
    expect(list()).toEqual([]);
  });
});

// ================================================================================================================ attachment
describe('SCR-10 / AC-12.6 — attachment card: "Open" streams through the BFF; no Storage URL anywhere', () => {
  const att = (o: Record<string, unknown> = {}) => detail({ message_kind: 'attachment', records: [], attachment: { ...ATTACHMENT, ...o } });

  it('clean: file name, type, size and scan state as text; "Open" is a same-origin link to the BFF stream route — not a Storage URL, not a blob', async () => {
    await showDetail({ message: att() });
    expect(text()).toMatch(/report-synthetic\.pdf/);
    expect(text()).toMatch(/application\/pdf|PDF/);
    expect(text()).toMatch(/20480|20 KB|20\.0 KB/i);
    expect(text()).toMatch(/Clean/);
    const open = screen.getByRole('link', { name: /^open/i });
    expect(open.getAttribute('href')).toBe(`/instruments/messages/${MSG}/attachment`);
    for (const a of document.querySelectorAll('a[href], [src], form[action]')) expect((a.getAttribute('href') ?? a.getAttribute('src') ?? a.getAttribute('action') ?? '')).not.toMatch(/^https?:|^blob:|^data:|storage|bucket|signature|X-Amz/i);
    expect(document.body.innerHTML).not.toMatch(/instruments-attachments|X-Amz|\/v1\//);
  });

  it.each([['pending'], ['quarantined'], ['failed']])('scan_state=%s → no "Open" control at all', async (s) => {
    await showDetail({ message: att({ scan_state: s }) });
    expect(screen.queryByRole('link', { name: /^open/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^open/i })).toBeNull();
    expect(document.querySelector(`a[href*="/attachment"]`)).toBeNull();
  });

  it('no attachment on a data message → no attachment card, no Open', async () => {
    await showDetail();
    expect(screen.queryByRole('link', { name: /^open/i })).toBeNull();
  });

  it('the component itself never calls the API for the file (the browser follows the BFF route): rendering + hovering makes no request', async () => {
    await showDetail({ message: att() });
    await userEvent.hover(screen.getByRole('link', { name: /^open/i }));
    expect(calls).toHaveLength(0);
  });
});

// ================================================================================================================ reprocess
describe('SCR-10 / AC-19.1 — Reprocess (E38)', () => {
  const openReprocess = async () => { await userEvent.click(screen.getByRole('button', { name: /^reprocess$/i })); return screen.findByRole('dialog'); };
  const pickReason = async (d: HTMLElement, option: string | RegExp) => { await userEvent.click(within(d).getByRole('button', { name: /reason/i })); await userEvent.click(await screen.findByRole('option', { name: option })); };
  const confirm = (d: HTMLElement) => userEvent.click(within(d).getByRole('button', { name: /^reprocess$/i }));

  it('without instruments.message.rematch: no Reprocess button, no "Re-match…" row actions (03-APP-FLOW §12)', async () => {
    await showDetail({ permissions: READ });
    expect(screen.queryByRole('button', { name: /reprocess/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /re-match/i })).toBeNull();
    expect(bodyHas(BC(1))).toBe(true); // the read view itself still works
  });

  it.each([['quarantined', 'data'], ['shadow', 'data'], ['parsed', 'data']])('latest outcome %s on a %s message → Reprocess enabled', async (outcome, kind) => {
    await showDetail({ message: detail({ message_kind: kind, latest_run: latest({ outcome }) }) });
    expect(isDisabled(screen.getByRole('button', { name: /^reprocess$/i }))).toBe(false);
  });

  it.each([['host_query', 'parsed'], ['data', 'rejected_capability']])('kind %s / outcome %s → Reprocess is not offered (disabled or absent) (AC-19.4)', async (kind, outcome) => {
    await showDetail({ message: detail({ message_kind: kind, latest_run: latest({ outcome }) }) });
    const b = screen.queryByRole('button', { name: /^reprocess$/i });
    expect(b === null || isDisabled(b)).toBe(true);
  });

  it('dialog: spec body text; reason is REQUIRED (no request without it); the coded-set reasons are offered', async () => {
    await showDetail();
    const d = await openReprocess();
    expect(text(d)).toContain('The original message is parsed again with the current driver and sent to the laboratory. Results already applied are not duplicated; approved results are never changed.');
    await confirm(d);
    expect(reprocesses()).toHaveLength(0);
    await userEvent.click(within(d).getByRole('button', { name: /reason/i }));
    for (const display of ['Driver fixed', 'Code mapping added', 'Quarantine reviewed', 'Barcode typed wrongly at instrument', 'Barcode label misread', 'Instrument sent wrong sample id', 'Other']) expect(await screen.findByRole('option', { name: display }), display).toBeTruthy();
  });

  it('confirm → ONE POST {reason_code} with Idempotency-Key and no If-Match; outcome table lists each record with its port outcome; page refreshes', async () => {
    await showDetail();
    const d = await openReprocess();
    await pickReason(d, 'Driver fixed');
    await confirm(d);
    await waitFor(() => expect(reprocesses()).toHaveLength(1));
    const c = reprocesses()[0]!;
    expect(c.url.pathname).toBe(`/v1/instruments/messages/${MSG}/reprocess`);
    expect(c.body).toMatchObject({ reason_code: 'driver_fixed' });
    expect(c.headers.get('idempotency-key')).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(c.headers.get('if-match')).toBeNull();
    const res = await screen.findByRole('dialog', { name: /./ }); // results dialog (may be the same element)
    await waitFor(() => expect(text(screen.getByRole('dialog'))).toMatch(/Applied/));
    const t = text(screen.getByRole('dialog'));
    for (const o of [/Applied/, /Already received/, /Not matched/, /Locked/, /On QC hold/]) expect(t).toMatch(o);
    expect(res).toBeTruthy();
    expect(refresh).toHaveBeenCalled();
  });

  it('a double click on confirm sends ONE request (no duplicate run)', async () => {
    api.use(http.post(`${IM}/messages/:id/reprocess`, async ({ request }) => { await rec(request); await delay(120); return HttpResponse.json(reprocessResult); }));
    await showDetail();
    const d = await openReprocess();
    await pickReason(d, 'Other');
    const b = within(d).getByRole('button', { name: /^reprocess$/i });
    await userEvent.dblClick(b);
    await waitFor(() => expect(screen.getByRole('dialog').textContent).toMatch(/Applied/));
    expect(reprocesses()).toHaveLength(1);
  });

  it('a retry after a failure reuses the SAME Idempotency-Key', async () => {
    let n = 0;
    api.use(http.post(`${IM}/messages/:id/reprocess`, async ({ request }) => { await rec(request); return n++ === 0 ? problem(500, 'common.internal') : HttpResponse.json(reprocessResult); }));
    await showDetail();
    const d = await openReprocess();
    await pickReason(d, 'Driver fixed');
    await confirm(d);
    await waitFor(() => expect(reprocesses()).toHaveLength(1));
    await waitFor(() => expect(within(screen.getByRole('dialog')).queryByRole('alert')).toBeTruthy());
    await confirm(screen.getByRole('dialog'));
    await waitFor(() => expect(reprocesses()).toHaveLength(2));
    expect(reprocesses()[1]!.headers.get('idempotency-key')).toBe(reprocesses()[0]!.headers.get('idempotency-key'));
  });

  it.each([[409, 'instruments.reprocess_not_allowed'], [422, 'instruments.driver_not_available'], [403, 'auth.forbidden']])('AC-19.4: API %s %s → an alert in the dialog, no outcome table, no refresh, nothing applied', async (status, code) => {
    api.use(http.post(`${IM}/messages/:id/reprocess`, async ({ request }) => { await rec(request); return problem(status, code); }));
    await showDetail();
    const d = await openReprocess();
    await pickReason(d, 'Driver fixed');
    await confirm(d);
    expect(await within(screen.getByRole('dialog')).findByRole('alert')).toBeTruthy();
    expect(text(screen.getByRole('dialog'))).not.toMatch(/Already received|On QC hold/);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('Cancel closes without a request', async () => {
    await showDetail();
    const d = await openReprocess();
    await userEvent.click(within(d).getByRole('button', { name: /^cancel$/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls).toHaveLength(0);
  });

  it('axe with the dialog open', async () => {
    await showDetail();
    await openReprocess();
    await noAxeViolations();
  });
});

// ================================================================================================================ re-match
describe('SCR-10 / AC-19.2, AC-19.5 — Re-match (E39): the corrected barcode travels only in the POST body', () => {
  const openRematch = async (n = 2) => { await userEvent.click(within(rowOf(new RegExp(BC(n)))).getByRole('button', { name: /re-match/i })); return screen.findByRole('dialog'); };
  const newBarcode = async (d: HTMLElement, v: string) => { await userEvent.type(within(d).getByLabelText(/new barcode/i), `${v}{Enter}`); };
  const confirm = (d: HTMLElement) => userEvent.click(within(d).getByRole('button', { name: /^re-match$/i }));

  it('row action exists on patient records; not on a QC record without a barcode', async () => {
    await showDetail();
    expect(within(rowOf(new RegExp(BC(2)))).getByRole('button', { name: /re-match/i })).toBeTruthy();
    expect(within(rowOf(/\bQC1\b/)).queryByRole('button', { name: /re-match/i })).toBeNull();
  });

  it('dialog: the ORIGINAL barcode is shown read-only; New barcode field; Reason defaults to "Barcode typed wrongly at instrument"; Note limited to 300', async () => {
    await showDetail();
    const d = await openRematch();
    expect(text(d)).toContain(BC(2));
    const editable = [...d.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')].filter((e) => !e.disabled && !e.readOnly);
    expect(editable.some((e) => e.value === BC(2))).toBe(false); // original is not an editable value
    expect(within(d).getByLabelText(/new barcode/i)).toBeTruthy();
    expect(text(d)).toContain('Barcode typed wrongly at instrument');
    const note = within(d).getByLabelText(/note/i) as HTMLTextAreaElement;
    expect(Number(note.maxLength)).toBe(300);
  });

  it('confirm → ONE POST to /message-records/{record_id}/rematch with {sample_barcode, reason_code, reason_text}; Idempotency-Key; barcode not in URL/headers/history/storage; the outcome table is shown; page refreshes', async () => {
    await showDetail();
    const histBefore = window.history.length;
    const d = await openRematch();
    await newBarcode(d, NEWBC);
    await userEvent.type(within(d).getByLabelText(/note/i), 'typo at analyser');
    await confirm(d);
    await waitFor(() => expect(rematches()).toHaveLength(1));
    const c = rematches()[0]!;
    expect(c.url.pathname).toBe(`/v1/instruments/message-records/${REC(2)}/rematch`);
    expect(c.url.search).toBe('');
    expect(c.body).toEqual({ sample_barcode: NEWBC, reason_code: 'barcode_keypad_error', reason_text: 'typo at analyser' });
    expect(c.headers.get('idempotency-key')).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(c.headers.get('if-match')).toBeNull();
    expect(c.url.toString()).not.toContain(NEWBC);
    expect(urlsPushed().join(' ')).not.toContain(NEWBC);
    expect(window.history.length).toBe(histBefore);
    expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain(NEWBC);
    await waitFor(() => expect(text(screen.getByRole('dialog'))).toMatch(/Applied/));
    expect(refresh).toHaveBeenCalled();
  });

  it('AC-19.5: the corrected barcode equal to the original is refused with a visible error and NO request', async () => {
    await showDetail();
    const d = await openRematch();
    await newBarcode(d, BC(2));
    await confirm(d);
    expect(rematches()).toHaveLength(0);
    expect(await within(screen.getByRole('dialog')).findByText(/differ|different|same|original/i)).toBeTruthy();
  });

  it('an invalid new barcode (space / symbol) is refused in the field: no request', async () => {
    await showDetail();
    const d = await openRematch();
    await userEvent.type(within(d).getByLabelText(/new barcode/i), 'not valid!{Enter}');
    await confirm(d);
    expect(rematches()).toHaveLength(0);
    expect(screen.getByRole('row', { name: new RegExp(BC(2)), hidden: true })).toBeTruthy();
  });

  it('confirming with no new barcode entered sends nothing', async () => {
    await showDetail();
    const d = await openRematch();
    await confirm(d);
    expect(rematches()).toHaveLength(0);
  });

  it.each([[400, 'common.validation_failed'], [409, 'instruments.reprocess_not_allowed'], [403, 'auth.forbidden']])('API %s %s → alert in the dialog; the original row is untouched; no refresh; the new barcode is not echoed in the alert', async (status, code) => {
    api.use(http.post(`${IM}/message-records/:id/rematch`, async ({ request }) => { await rec(request); return problem(status, code); }));
    await showDetail();
    const d = await openRematch();
    await newBarcode(d, NEWBC);
    await confirm(d);
    const alert = await within(screen.getByRole('dialog')).findByRole('alert');
    expect(text(alert)).not.toContain(NEWBC);
    expect(refresh).not.toHaveBeenCalled();
    expect(text(screen.getByRole('row', { name: new RegExp(BC(2)), hidden: true }))).toMatch(/Not matched/);
  });

  it('a double click on confirm sends ONE request', async () => {
    api.use(http.post(`${IM}/message-records/:id/rematch`, async ({ request }) => { await rec(request); await delay(120); return HttpResponse.json({ run: run({ kind: 'rematch' }), record: rcd(2, { sample_barcode: NEWBC, port_outcome: 'applied' }) }); }));
    await showDetail();
    const d = await openRematch();
    await newBarcode(d, NEWBC);
    await userEvent.dblClick(within(d).getByRole('button', { name: /^re-match$/i }));
    await waitFor(() => expect(text(screen.getByRole('dialog'))).toMatch(/Applied/));
    expect(rematches()).toHaveLength(1);
  });

  it('AC-19.3: an approved target shows "Locked" in the outcome table (rejected_state / result_locked), never "Applied"', async () => {
    api.use(http.post(`${IM}/message-records/:id/rematch`, async ({ request }) => { await rec(request); return HttpResponse.json({ run: run({ kind: 'rematch' }), record: rcd(2, { sample_barcode: NEWBC, port_outcome: 'rejected_state', port_reason_code: 'result_locked' }) }); }));
    await showDetail();
    const d = await openRematch();
    await newBarcode(d, NEWBC);
    await confirm(d);
    await waitFor(() => expect(text(screen.getByRole('dialog'))).toMatch(/Locked/));
    expect(text(screen.getByRole('dialog'))).not.toMatch(/\bApplied\b/);
  });

  it('axe with the dialog open', async () => {
    await showDetail();
    await openRematch();
    await noAxeViolations();
  });
});

// ================================================================================================================ pages
describe('pages → BFF', () => {
  const listPage = async (sp: Record<string, string | string[] | undefined> = {}) => (await import('../../../app/(staff)/instruments/messages/page')).default({ searchParams: Promise.resolve(sp) } as never);
  const detailPage = async (id: string = MSG) => (await import('../../../app/(staff)/instruments/messages/[instrument_message_id]/page')).default({ params: Promise.resolve({ instrument_message_id: id }) } as never);
  const e33 = () => sent('GET', /\/messages$/);
  const span = (u: URL) => Date.parse(u.searchParams.get('received_at_to')!) - Date.parse(u.searchParams.get('received_at_from')!);
  const DAY = 24 * 3600_000;

  it('list: default range is the last 24 h (AC-18.1) → one E33 call; props carry messages, rejections, instruments, agents and the session permissions', async () => {
    const el: any = await listPage();
    expect(e33()).toHaveLength(1);
    const q = e33()[0]!.url;
    expect(Math.abs(span(q) - DAY)).toBeLessThan(5 * 60_000);
    expect(Math.abs(Date.parse(q.searchParams.get('received_at_to')!) - Date.now())).toBeLessThan(5 * 60_000);
    expect(el.props.messages).toHaveLength(2);
    expect(el.props.rejections).toHaveLength(1);
    expect(el.props.permissions).toEqual(REMATCH);
    expect(el.props.instruments?.length).toBeGreaterThan(0);
  });

  it('list: URL filters are forwarded (instrument_id, has_qc, has_unmapped, message_kind csv, latest_outcome csv)', async () => {
    await listPage({ instrument_id: INST, has_qc: 'true', has_unmapped: 'true', message_kind: 'data,incomplete', latest_outcome: 'quarantined' });
    const q = e33()[0]!.url.searchParams;
    expect(q.get('instrument_id')).toBe(INST);
    expect(q.get('has_qc')).toBe('true');
    expect(q.get('has_unmapped')).toBe('true');
    expect(q.get('message_kind')).toBe('data,incomplete');
    expect(q.get('latest_outcome')).toBe('quarantined');
  });

  it('list: tampered filters are dropped, never forwarded (non-UUID instrument, unknown kind)', async () => {
    await listPage({ instrument_id: '../x', message_kind: 'evil', latest_outcome: 'nope', has_qc: 'maybe' });
    const q = e33()[0]!.url.searchParams;
    for (const k of ['instrument_id', 'message_kind', 'latest_outcome', 'has_qc']) expect(q.has(k), k).toBe(false);
  });

  it('list: a range longer than 31 days in the URL never reaches the API wider than 31 days and does not 400 the page', async () => {
    await listPage({ received_at_from: '2020-01-01T00:00:00.000Z', received_at_to: '2026-11-07T00:00:00.000Z' });
    const q = e33()[0]!.url;
    expect(span(q)).toBeLessThanOrEqual(31 * DAY);
    expect(span(q)).toBeGreaterThan(0);
  });

  it('SECURITY (REQ-SEC-098): a barcode smuggled into the page URL is neither forwarded to the API nor passed to the component', async () => {
    const el: any = await listPage({ barcode: NEWBC, sample_barcode: NEWBC, q: NEWBC });
    expect(calls.map((c) => c.url.toString()).join(' ')).not.toContain(NEWBC);
    expect(JSON.stringify(el.props)).not.toContain(NEWBC);
  });

  it('list: failing secondary lookups (instruments / agents / rejections 500) do NOT take the page down', async () => {
    api.use(http.get(`${IM}/instruments`, () => problem(500, 'common.internal')), http.get(`${IM}/agents`, () => problem(500, 'common.internal')), http.get(`${IM}/rejections`, () => problem(500, 'common.internal')));
    const el: any = await listPage();
    expect(el.props.messages).toHaveLength(2);
  });

  it('list: E33 403 propagates (error.tsx)', async () => {
    api.use(http.get(`${IM}/messages`, () => problem(403, 'auth.forbidden')));
    await expect(listPage()).rejects.toMatchObject({ status: 403 });
  });

  it('detail: one E35 call (no preview_parse) and props {message, permissions}', async () => {
    const el: any = await detailPage();
    const g = sent('GET', /\/messages\/[^/]+$/);
    expect(g).toHaveLength(1);
    expect(g[0]!.url.searchParams.has('preview_parse')).toBe(false);
    expect(el.props.message.id).toBe(MSG);
    expect(el.props.permissions).toEqual(REMATCH);
  });

  it('detail: 404 (incl. another centre\'s message) → notFound(); a malformed id → notFound() with NO API call; other errors propagate', async () => {
    api.use(http.get(`${IM}/messages/:id`, () => problem(404, 'common.not_found')));
    await expect(detailPage()).rejects.toMatchObject({ digest: expect.stringContaining('404') });
    calls.length = 0;
    await expect(detailPage('../x')).rejects.toMatchObject({ digest: expect.stringContaining('404') });
    expect(calls).toHaveLength(0);
    api.use(http.get(`${IM}/messages/:id`, () => problem(500, 'common.internal')));
    await expect(detailPage()).rejects.toMatchObject({ status: 500 });
  });

  it('detail: the page never fetches the raw bytes (raw is on demand only — each view is access-logged)', async () => {
    await detailPage();
    expect(raws()).toHaveLength(0);
  });
});
