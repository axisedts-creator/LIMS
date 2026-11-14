// SR-T24 integration gate — compose stack with REAL C5 (lab) + C6 (reporting) + C14 (smartreport). Synthetic data only.
// ACs: AC-15.4, AC-16.1, AC-17.2, AC-17.3, AC-17.4, US-14. Follows LD-134 (C5.T-34 / tests/e2e README): no harness service, no seeded
// sessions in a file; the nightly pipeline supplies tokens + non-secret ids through env. A test skips, naming the missing vars, when any is unset.
// LD-140 is UI-only and does not apply: these journeys drive the public /v1 API (UI covered by SR-T19).
// ENV: E2E_BASE_URL; tokens E2E_LAB_COLLECT_TOKEN (register), E2E_LAB_TECH_TOKEN (verify), E2E_PATHOLOGIST_TOKEN (approve results, smartreport.*,
//      reporting.report.regenerate/release; aal2), E2E_LAB_MANAGER_TOKEN (smartreport.template.manage), E2E_DEVICE_TOKEN (instrument result);
//      ids E2E_CENTRE_ID, E2E_HB_ORDERABLE_ID, E2E_INSTRUMENT_ID, E2E_SMART_LIBRARY_VERSION_ID (a seeded DRAFT library version, valid, mapping HB).
// ASSUMED (flag to lead): staff getReport/getReportVersion expose `smart_summary_id` (null when no snapshot) on each version; the PDF's text is
// recoverable by inflating its FlateDecode streams (else the PDF check must move to a C6 sandbox text endpoint).
import { test, expect } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { inflateSync } from 'node:zlib';

const env = (k: string) => (process.env[k] ?? '').trim();
const BASE = env('E2E_BASE_URL').replace(/\/+$/, '');
const TOK = { collect: env('E2E_LAB_COLLECT_TOKEN'), tech: env('E2E_LAB_TECH_TOKEN'), patho: env('E2E_PATHOLOGIST_TOKEN'), manager: env('E2E_LAB_MANAGER_TOKEN'), device: env('E2E_DEVICE_TOKEN') };
const CFG = { centre: env('E2E_CENTRE_ID'), hb: env('E2E_HB_ORDERABLE_ID'), instrument: env('E2E_INSTRUMENT_ID'), library: env('E2E_SMART_LIBRARY_VERSION_ID') };
const ENV_NAME = { collect: 'E2E_LAB_COLLECT_TOKEN', tech: 'E2E_LAB_TECH_TOKEN', patho: 'E2E_PATHOLOGIST_TOKEN', manager: 'E2E_LAB_MANAGER_TOKEN', device: 'E2E_DEVICE_TOKEN' } as const;
function need() {
  const missing = [BASE ? '' : 'E2E_BASE_URL', ...Object.entries(TOK).map(([k, v]) => (v ? '' : ENV_NAME[k as keyof typeof ENV_NAME])),
    CFG.centre ? '' : 'E2E_CENTRE_ID', CFG.hb ? '' : 'E2E_HB_ORDERABLE_ID', CFG.instrument ? '' : 'E2E_INSTRUMENT_ID', CFG.library ? '' : 'E2E_SMART_LIBRARY_VERSION_ID'].filter(Boolean);
  test.skip(missing.length > 0, `E2E nightly env not supplied: ${missing.join(', ')}`);
}

type J = Record<string, any>;
type Res = { status: number; json: J; headers: Headers };
async function api(method: string, path: string, token: string, body?: unknown, h: Record<string, string> = {}): Promise<Res> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID(), ...h };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(BASE + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  let json: J = {};
  try { json = JSON.parse(await r.text()); } catch { /* empty or binary */ }
  return { status: r.status, json, headers: r.headers };
}
const ok = (r: Res, what: string) => { if (r.status >= 300) throw new Error(`${what} -> ${r.status} ${r.json?.code ?? ''}`); return r.json; };
const poll = async <T>(fn: () => Promise<T | undefined | false>, what: string, ms = 60_000): Promise<T> => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 1000)); }
  throw new Error(`timeout: ${what}`);
};
const etag = (r: Res) => (r.headers.get('etag') ? { 'if-match': r.headers.get('etag')! } : {});
function uuidv7(): string {
  const b = Buffer.from(randomUUID().replace(/-/g, ''), 'hex');
  b.writeUIntBE(Date.now(), 0, 6); b[6] = (b[6]! & 0x0f) | 0x70; b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// ---- real C4/C5 steps (same shape as C5.T-34) ----
async function register(): Promise<{ order_id: string; barcode: string }> {
  const draft = {
    patient: { new_patient: { full_name: `Synthetic SR ${Date.now().toString(36)}`, sex: 'unknown', age: { value: 30, unit: 'y' }, consents: { processing: true, sms: false, whatsapp: false, email: false, share_with_referrer: false, consent_text_version: 'e2e' } } },
    centre_id: CFG.centre, visit_type: 'opd', billing_mode: 'cash', items: [{ orderable_id: CFG.hb }],
  };
  const quote = ok(await api('POST', '/v1/frontdesk/registrations/quote', TOK.collect, draft), 'quote');
  const reg = ok(await api('POST', '/v1/frontdesk/registrations', TOK.collect, { ...draft, quote_fingerprint: quote.quote_fingerprint, payments: [{ method_code: env('E2E_PAYMENT_METHOD') || 'cash', amount_received_paisa: Number(quote.totals?.net ?? 1) || 1 }] }), 'register');
  const orderId: string = reg.order.id;
  const sp = await poll(async () => { const d = ok(await api('GET', `/v1/lab/specimens?order_id=${orderId}`, TOK.collect), 'specimens').data as J[] | undefined; return d?.length ? d : false; }, 'specimens');
  return { order_id: orderId, barcode: sp[0]!.barcode as string };
}
async function instrumentResult(barcode: string, value: string) {
  const raw = Buffer.from(['H|\\^&|||SYN^1|||||||P|1', 'P|1', `O|1|${barcode}||^^^HB|R`, `R|1|^^^HB|${value}|g/dL||N||F`, 'L|1|N'].join('\r') + '\r', 'latin1');
  const now = new Date().toISOString();
  ok(await api('POST', '/v1/instruments/agent/message-batches', TOK.device, { sent_at_agent: now, clock_offset_ms: 0, messages: [{ agent_message_id: uuidv7(), instrument_id: CFG.instrument, protocol: 'astm', kind: 'data', raw_base64: raw.toString('base64'), raw_sha256: createHash('sha256').update(raw).digest('hex'), captured_at_agent: now, clock_offset_ms: 0 }] }), 'instrument batch');
}
const hb = async (orderId: string, token: string): Promise<J | undefined> => {
  const d = ok(await api('GET', `/v1/lab/orders/${orderId}/results`, token), 'order results');
  return (d.items as J[]).flatMap((i) => i.results as J[]).find((x) => x.analyte_code === 'HB');
};
async function approveResults(orderId: string) {
  const r = await poll(async () => { const x = await hb(orderId, TOK.tech); return x?.status === 'resulted' ? x : false; }, 'HB resulted');
  ok(await api('POST', '/v1/lab/results/bulk-verify', TOK.tech, { items: [{ id: r.id, version: r.version }] }), 'verify');
  const v = await poll(async () => { const x = await hb(orderId, TOK.patho); return x?.status === 'verified' ? x : false; }, 'HB verified');
  ok(await api('POST', '/v1/lab/results/bulk-approve', TOK.patho, { items: [{ id: v.id, version: v.version }] }), 'approve');
}
async function amendHb(orderId: string, value: string) {
  const a = await hb(orderId, TOK.patho);
  // C5 02-TRD #32 amendResult: POST /results/{result_id}/amend, body { value_numeric, amendment_reason_code } ('transcription_error' is in lab.amendment_reasons, C5 05-SCHEMA)
  ok(await api('POST', `/v1/lab/results/${a!.id}/amend`, TOK.patho, { value_numeric: Number(value), amendment_reason_code: 'transcription_error' }, { 'if-match': `"${a!.version}"` }), 'amend HB');
  await poll(async () => { const x = await hb(orderId, TOK.patho); return x?.status === 'approved' && x.version > a!.version ? x : false; }, 'HB amended');
}

// ---- C14 steps ----
const SR = '/v1/smartreport';
async function approveLibrary() {
  const g = await api('GET', `${SR}/library-versions/${CFG.library}`, TOK.manager);
  if (g.json.status === 'approved') return; // idempotent across nightly reruns
  const s = ok(await api('POST', `${SR}/library-versions/${CFG.library}/submit`, TOK.manager, {}, etag(g)), 'submit library');
  const g2 = await api('GET', `${SR}/library-versions/${CFG.library}`, TOK.patho);
  ok(await api('POST', `${SR}/library-versions/${CFG.library}/approve`, TOK.patho, {}, etag(g2)), `approve library (submit status ${s.status})`);
}
const buildDraft = async (orderId: string): Promise<J> => ok(await api('POST', `${SR}/orders/${orderId}/summaries`, TOK.patho, {}), 'buildSmartSummary');
const getSummary = async (id: string) => { const r = await api('GET', `${SR}/summaries/${id}`, TOK.patho); return { r, body: ok(r, 'getSmartSummary') }; };
async function approveSummary(id: string): Promise<J> {
  const { r } = await getSummary(id);
  return ok(await api('POST', `${SR}/summaries/${id}/approve`, TOK.patho, { attestation: true }, etag(r)), 'approveSmartSummary');
}
// ---- C6 steps ----
const findReport = (orderId: string) => poll(async () => ((await api('POST', '/v1/reporting/reports/search', TOK.patho, { order_id: orderId })).json.data as J[] | undefined)?.[0], 'report of the order');
const versions = async (reportId: string): Promise<J[]> => ok(await api('GET', `/v1/reporting/reports/${reportId}`, TOK.patho), 'report detail').versions as J[];
const newest = (vs: J[]) => vs.reduce((m, v) => (v.version_no > m.version_no ? v : m));
async function regenerate(reportId: string, afterVersionNo: number) {
  ok(await api('POST', `/v1/reporting/reports/${reportId}/regenerations`, TOK.patho, { reason_code: 'smart_summary_added' }), 'regenerateReport');
  return poll(async () => { const v = newest(await versions(reportId)); return v.version_no > afterVersionNo ? v : false; }, 'regenerated version');
}
/** Text of a PDF: inflate every FlateDecode stream and keep printable runs (ASSUMED, see header). */
async function pdfText(versionId: string): Promise<string> {
  const r = await fetch(`${BASE}/v1/reporting/report-versions/${versionId}/pdf`, { headers: { authorization: `Bearer ${TOK.patho}` } });
  expect(r.status).toBe(200);
  const buf = Buffer.from(await r.arrayBuffer());
  const parts: string[] = [buf.toString('latin1')];
  for (const m of buf.toString('latin1').matchAll(/stream\r?\n/g)) {
    const start = m.index! + m[0].length; const end = buf.indexOf('endstream', start);
    try { parts.push(inflateSync(buf.subarray(start, end)).toString('latin1')); } catch { /* not flate */ }
  }
  return parts.join('\n').replace(/\\\(|\\\)/g, '');
}
const NOTICE_N1 = 'It is not a diagnosis or a prescription'; // 04-UI-UX §4.3 N1 (fixed notice, AC-16.1/AC-18.1)

test.describe.configure({ mode: 'serial' });

test.describe('SR-T24 journey: library -> results -> draft -> approve -> Regenerate -> PDF section', () => {
  test('approved summary reaches a new C6 version as snapshot and as a PDF section (AC-16.1, AC-17.2, US-14)', async () => {
    need();
    await approveLibrary();
    const o = await register();
    await instrumentResult(o.barcode, '13.4');
    await approveResults(o.order_id);
    const report = await findReport(o.order_id);
    const before = newest(await versions(report.id));
    expect(before.smart_summary_id ?? null).toBeNull(); // no summary yet -> no snapshot, section omitted

    const draft = await buildDraft(o.order_id);
    expect(draft.status).toBe('draft');
    expect(await pdfText(before.id)).not.toContain(NOTICE_N1); // a draft never reaches the PDF
    const approved = await approveSummary(draft.id);
    expect(approved.status).toBe('approved');

    const v2 = await regenerate(report.id, before.version_no);
    expect(v2.smart_summary_id).toBe(approved.id); // AC-17.2: snapshot attached at Regenerate (smart_summary_added)
    expect(await pdfText(v2.id)).toContain(NOTICE_N1); // AC-16.1: rendered section present
  });

  test('summary approved BEFORE first assembly -> first report version carries the snapshot (AC-17.4)', async () => {
    need();
    await approveLibrary();
    const o = await register();
    await instrumentResult(o.barcode, '13.1');
    // Approve the HB result, then the summary, as fast as the stack allows: C6 first assembly must still find the approved summary.
    // The ordering is NOT forced by this test: C6 may assemble before the summary is approved (08 A4.4). See CR .orchestra/cr/C14.T24.md.
    await approveResults(o.order_id);
    const draft = await buildDraft(o.order_id);
    await approveSummary(draft.id);
    const report = await findReport(o.order_id);
    const vs = await versions(report.id);
    const first = vs.reduce((m, v) => (v.version_no < m.version_no ? v : m));
    // If the stack assembled before the summary was approved the first version has no snapshot and this fails. Determinism needs a spec'd way to hold
    // first assembly in the compose profile — requested in CR .orchestra/cr/C14.T24.md; assertion intentionally not weakened.
    expect(first.smart_summary_id).toBe(draft.id);
  });
});

test.describe('SR-T24 journey: amendment -> old summary never shown (AC-15.4, AC-17.3)', () => {
  test('after amend the superseded summary is neither returned nor approvable; new draft has a new hash; old snapshot is not re-attached', async () => {
    need();
    await approveLibrary();
    const o = await register();
    await instrumentResult(o.barcode, '13.4');
    await approveResults(o.order_id);
    const report = await findReport(o.order_id);
    const old = await approveSummary((await buildDraft(o.order_id)).id);
    const v2 = await regenerate(report.id, newest(await versions(report.id)).version_no);
    expect(v2.smart_summary_id).toBe(old.id);

    await amendHb(o.order_id, '9.8');
    // AC-15.4 path 1 (event may not be consumed yet): buildSummary recomputes the hash and must not return the old summary
    const rebuilt = await buildDraft(o.order_id);
    expect(rebuilt.id).not.toBe(old.id);
    expect(rebuilt.status).toBe('draft');
    expect(rebuilt.approved_set_hash ?? rebuilt.approvedSetHash).not.toBe(old.approved_set_hash ?? old.approvedSetHash);
    // old one is superseded: reading it shows status superseded, approving it again is refused with the spec code
    const { body: oldNow } = await getSummary(old.id);
    expect(oldNow.status).toBe('superseded');
    const cur = await api('GET', `${SR}/orders/${o.order_id}/summary`, TOK.patho);
    expect(cur.json.id).toBe(rebuilt.id); // getCurrentSmartSummary never returns the superseded one
    const re = await api('POST', `${SR}/summaries/${old.id}/approve`, TOK.patho, { attestation: true }, etag((await getSummary(old.id)).r));
    expect(re.status).toBe(409);
    expect(['smartreport.summary_superseded', 'smartreport.summary_invalid_transition']).toContain(re.json.code);

    // AC-17.3: Regenerate after the amendment with the NEW summary still a draft -> no snapshot, the superseded one is not re-attached
    const v3 = await regenerate(report.id, v2.version_no);
    expect(v3.smart_summary_id ?? null).toBeNull();
    expect(await pdfText(v3.id)).not.toContain(NOTICE_N1);
    // and once the new draft is approved + Regenerate, the new summary (not the old) is attached
    const fresh = await approveSummary(rebuilt.id);
    const v4 = await regenerate(report.id, v3.version_no);
    expect(v4.smart_summary_id).toBe(fresh.id);
    expect(v4.smart_summary_id).not.toBe(old.id);
  });
});
