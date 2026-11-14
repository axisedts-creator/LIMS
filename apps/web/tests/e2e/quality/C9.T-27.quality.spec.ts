// C9.T-27 nightly E2E (02-TRD §15 "E2E (nightly)", compose stack with real C5 + C7 + C6 + C9 worker). Synthetic data only. No ACs listed on the task; scenarios cover
// AC-06.6/06.8 (reject → one event), AC-07.1–07.4 (corrective action, close guards, closed state), AC-12.1–12.3 + AC-13.3/13.4 (four-eyes activation, live decision, C5 auto-verify),
// AC-14.1/14.6/14.8 (TAT breach visible, acknowledge, segment named) and 03-IC §10.2 (C5 holds results of a rejected run; release stays in C5).
// LD-140 (2026-11-13): UI assertions use the design-system roles/labels only (role + accessible name), never styles or tokens.
// LD-134 convention (as C5.T-34): NO harness service, NO committed sessions. The scenarios drive the public /v1 API and the web app through a base URL and per-role
// tokens supplied by the nightly pipeline via environment, never stored in a file. A scenario skips, naming the missing variables, when anything it needs is unset.
//
//  E2E_BASE_URL                 stack under test (required)
//  E2E_LAB_COLLECT_TOKEN        register orders (frontdesk)          E2E_LAB_TECH_TOKEN      read C5 results (lab.result.read)
//  E2E_DEVICE_TOKEN             instrument ingest (C7 submitMessageBatch)
//  E2E_QC_TECH_TOKEN            technologist: quality.qc_run.read + quality.qc_run.review
//  E2E_PATHOLOGIST_TOKEN        aal2 holder of quality.autoverify.manage + .read = draft author
//  E2E_AV_ACTIVATOR_TOKEN       aal2 holder of quality.autoverify.manage, a DIFFERENT person from the author
//  E2E_AV_AAL1_TOKEN            same permission set as the activator but a session at aal1
//  E2E_TAT_TOKEN                quality.tat_alert.read + quality.tat_alert.ack (also used as the web session cookie)
//  E2E_CENTRE_ID, E2E_HB_ORDERABLE_ID, E2E_INSTRUMENT_ID           synthetic centre / Hb orderable / analyser (as C5.T-34)
//  E2E_QC_PLAN_ID               active QC plan of E2E_INSTRUMENT_ID for analyte HB (controls_per_run = number of ids below, classic mode)
//  E2E_QC_CONTROL_IDS           comma list: instrument-side control id of each level of that plan, in level order (mapped by quality control id maps)
//  E2E_QC_MEAN, E2E_QC_SD       decimal strings: the plan's established target (level 1) in force; level k uses the same values unless E2E_QC_MEAN_<k>/E2E_QC_SD_<k> is set
//  E2E_AV_VERSION_ID            rule-set version (author = E2E_PATHOLOGIST_TOKEN) in `simulating` with the stack's simulation minimums already met (nightly seed backdates the shadow rows)
//  E2E_AV_HB_OK, E2E_AV_HB_OUT  Hb values (g/dL) that the version's HB rule allows / denies (out of its limits)
//  E2E_TAT_ORDERABLE_ID         synthetic orderable whose total-segment TAT target is seeded at ≤ 60 s for priority routine (AC-14.3, vectors T12–T14)
//
// ASSUMPTIONS the spec does not pin (lead to confirm; see .orchestra/notes/C9.T-27-tests.md): QC reaches C9 as an ASTM order record with action code Q (O.12) whose specimen id is the
// instrument-side control id, result time in R.12 (YYYYMMDDHHMMSS UTC); alert list is polled until the worker evaluator has run (≤ 120 s).
import { test, expect, type BrowserContext } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';

const env = (k: string) => (process.env[k] ?? '').trim();
const BASE = env('E2E_BASE_URL').replace(/\/+$/, '');
const TOK = {
  collect: env('E2E_LAB_COLLECT_TOKEN'), tech: env('E2E_LAB_TECH_TOKEN'), device: env('E2E_DEVICE_TOKEN'), qc: env('E2E_QC_TECH_TOKEN'),
  author: env('E2E_PATHOLOGIST_TOKEN'), activator: env('E2E_AV_ACTIVATOR_TOKEN'), aal1: env('E2E_AV_AAL1_TOKEN'), tat: env('E2E_TAT_TOKEN'),
};
const VAR: Record<keyof typeof TOK, string> = {
  collect: 'E2E_LAB_COLLECT_TOKEN', tech: 'E2E_LAB_TECH_TOKEN', device: 'E2E_DEVICE_TOKEN', qc: 'E2E_QC_TECH_TOKEN',
  author: 'E2E_PATHOLOGIST_TOKEN', activator: 'E2E_AV_ACTIVATOR_TOKEN', aal1: 'E2E_AV_AAL1_TOKEN', tat: 'E2E_TAT_TOKEN',
};
const ID = {
  centre: env('E2E_CENTRE_ID'), hb: env('E2E_HB_ORDERABLE_ID'), instrument: env('E2E_INSTRUMENT_ID'), plan: env('E2E_QC_PLAN_ID'),
  controls: env('E2E_QC_CONTROL_IDS').split(',').map((s) => s.trim()).filter(Boolean), mean: env('E2E_QC_MEAN'), sd: env('E2E_QC_SD'),
  version: env('E2E_AV_VERSION_ID'), hbOk: env('E2E_AV_HB_OK'), hbOut: env('E2E_AV_HB_OUT'), tatTest: env('E2E_TAT_ORDERABLE_ID'), pay: env('E2E_PAYMENT_METHOD') || 'cash',
};
const IDVAR: Record<string, keyof typeof ID> = {
  E2E_CENTRE_ID: 'centre', E2E_HB_ORDERABLE_ID: 'hb', E2E_INSTRUMENT_ID: 'instrument', E2E_QC_PLAN_ID: 'plan', E2E_QC_CONTROL_IDS: 'controls', E2E_QC_MEAN: 'mean', E2E_QC_SD: 'sd',
  E2E_AV_VERSION_ID: 'version', E2E_AV_HB_OK: 'hbOk', E2E_AV_HB_OUT: 'hbOut', E2E_TAT_ORDERABLE_ID: 'tatTest',
};
/** Skip (with the reason) unless E2E_BASE_URL, the listed tokens and the listed stack ids are set. */
function need(roles: (keyof typeof TOK)[], ids: string[]) {
  const missing = [BASE ? '' : 'E2E_BASE_URL', ...roles.map((r) => (TOK[r] ? '' : VAR[r])), ...ids.map((v) => { const x = ID[IDVAR[v]!]; return (Array.isArray(x) ? x.length : x) ? '' : v; })].filter(Boolean);
  test.skip(missing.length > 0, `E2E nightly env not supplied: ${missing.join(', ')}`);
}

type J = Record<string, any>;
type Res = { status: number; json: J; headers: Headers };
async function api(method: string, path: string, token: string, body?: unknown, h: Record<string, string> = {}): Promise<Res> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID(), ...h };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(BASE + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  let json: J = {};
  try { json = JSON.parse(await r.text()); } catch { /* empty body */ }
  return { status: r.status, json, headers: r.headers };
}
const ok = (r: Res, what: string) => { if (r.status >= 300) throw new Error(`${what} → ${r.status} ${r.json?.code ?? ''}`); return r.json; };
const ifMatch = (v: unknown) => ({ 'if-match': `"${String(v)}"` });
const poll = async <T>(fn: () => Promise<T | undefined | false>, what: string, ms = 120_000): Promise<T> => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 2000)); }
  throw new Error(`timeout: ${what}`);
};
const useSession = (ctx: BrowserContext, token: string) =>
  ctx.addCookies([{ name: '__Host-lims_sid', value: token, url: BASE, httpOnly: true, secure: BASE.startsWith('https'), sameSite: 'Lax' }]);

function uuidv7(): string {
  const b = Buffer.from(randomUUID().replace(/-/g, ''), 'hex');
  b.writeUIntBE(Date.now(), 0, 6); b[6] = (b[6]! & 0x0f) | 0x70; b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
const astmTs = (d: Date) => d.toISOString().replace(/[-:T]/g, '').slice(0, 14);
async function sendAstm(records: string[]) {
  const raw = Buffer.from(records.join('\r') + '\r', 'latin1');
  const now = new Date().toISOString();
  ok(await api('POST', '/v1/instruments/agent/message-batches', TOK.device, {
    sent_at_agent: now, clock_offset_ms: 0,
    messages: [{ agent_message_id: uuidv7(), instrument_id: ID.instrument, protocol: 'astm', kind: 'data', raw_base64: raw.toString('base64'), raw_sha256: createHash('sha256').update(raw).digest('hex'), captured_at_agent: now, clock_offset_ms: 0 }],
  }), 'instrument message batch');
}
/** Patient Hb result (as C5.T-34). */
const patientHb = (barcode: string, value: string) => sendAstm(['H|\\^&|||SYN^1|||||||P|1', 'P|1', `O|1|${barcode}||^^^HB|R`, `R|1|^^^HB|${value}|g/dL||N||F`, 'L|1|N']);
/** One QC event (one record per level of the plan) at `at`; offsetsSd[k] = value of level k in SD units from its target mean. */
function qcEvent(at: Date, offsetsSd: number[]) {
  const recs = ['H|\\^&|||SYN^1|||||||P|1'];
  ID.controls.forEach((ctl, k) => {
    const mean = Number(env(`E2E_QC_MEAN_${k + 1}`) || ID.mean), sd = Number(env(`E2E_QC_SD_${k + 1}`) || ID.sd);
    recs.push('P|' + (k + 1), `O|1|${ctl}||^^^HB|R||||||Q`, `R|1|^^^HB|${(mean + (offsetsSd[k] ?? 0) * sd).toFixed(3)}|g/dL||N||F|||${astmTs(at)}`);
  });
  recs.push('L|1|N');
  return sendAstm(recs);
}
const inControl = (at: Date) => qcEvent(at, ID.controls.map(() => 0));

type Registered = { order_id: string; barcodes: string[] };
async function register(orderable: string): Promise<Registered> {
  const draft = {
    patient: { new_patient: { full_name: `Synthetic E2E ${Date.now().toString(36)}`, sex: 'unknown', age: { value: 30, unit: 'y' }, consents: { processing: true, sms: false, whatsapp: false, email: false, share_with_referrer: false, consent_text_version: 'e2e' } } },
    centre_id: ID.centre, visit_type: 'opd', billing_mode: 'cash', items: [{ orderable_id: orderable }],
  };
  const quote = ok(await api('POST', '/v1/frontdesk/registrations/quote', TOK.collect, draft), 'quote');
  const reg = ok(await api('POST', '/v1/frontdesk/registrations', TOK.collect, { ...draft, quote_fingerprint: quote.quote_fingerprint, payments: [{ method_code: ID.pay, amount_received_paisa: Number(quote.totals?.net ?? 1) || 1 }] }), 'register');
  const orderId: string = reg.order.id;
  const specimens = await poll(async () => {
    const d = ok(await api('GET', `/v1/lab/specimens?order_id=${orderId}`, TOK.collect), 'list specimens').data as J[] | undefined;
    return d && d.length ? d : false;
  }, 'specimens of the registered order');
  return { order_id: orderId, barcodes: specimens.map((s) => s.barcode as string) };
}
const hbResult = async (orderId: string): Promise<J | undefined> => {
  const d = ok(await api('GET', `/v1/lab/orders/${orderId}/results`, TOK.tech), 'order results');
  return (d.items as J[]).flatMap((i) => i.results as J[]).find((x) => x.analyte_code === 'HB');
};
const runs = async (query: string): Promise<J[]> => ok(await api('GET', `/v1/quality/qc-runs?plan_id=${ID.plan}&${query}`, TOK.qc), 'list qc runs').data as J[];

const QC_NEEDS = { roles: ['collect', 'tech', 'device', 'qc'] as (keyof typeof TOK)[], ids: ['E2E_CENTRE_ID', 'E2E_HB_ORDERABLE_ID', 'E2E_INSTRUMENT_ID', 'E2E_QC_PLAN_ID', 'E2E_QC_CONTROL_IDS', 'E2E_QC_MEAN', 'E2E_QC_SD'] };

test.describe.serial('S-QC synthetic QC → run rejected → C5 hold → corrective action → accepted rerun → close', () => {
  const state: { run?: J; order?: Registered } = {};

  test('a 1-3s QC event rejects the run (AC-06.6/06.8) and C5 holds the instrument\'s patient result (03-IC §10.2)', async () => {
    need(QC_NEEDS.roles, QC_NEEDS.ids);
    await inControl(new Date(Date.now() - 60 * 60_000)); // establishes last_in_control_run_at before the failure
    state.order = await register(ID.hb);
    await patientHb(state.order.barcodes[0]!, ID.hbOk || '13.5');
    await poll(async () => (await hbResult(state.order!.order_id))?.status === 'resulted', 'patient HB resulted');
    // failing event 45 min in the past so a later rerun can sit beyond run_at + run_window_minutes (30 default) without waiting (AC-07.3)
    await qcEvent(new Date(Date.now() - 45 * 60_000), ID.controls.map((_, k) => (k === 0 ? 3.5 : 0)));
    state.run = await poll(async () => (await runs('outcome=rejected&sort=-run_at')).find((r) => r.status !== 'collecting'), 'rejected QC run');
    expect(state.run!.outcome).toBe('rejected');
    const held = await poll(async () => { const r = await hbResult(state.order!.order_id); return r?.on_hold === true ? r : false; }, 'C5 hold on the patient result');
    expect(held.on_hold).toBe(true);
  });

  test('close is refused until a corrective action and a later accepted run exist; closing leaves the C5 hold in place (AC-07.1–07.4)', async () => {
    need(QC_NEEDS.roles, QC_NEEDS.ids);
    test.skip(!state.run, 'depends on the rejection scenario');
    const id = state.run!.id as string;
    const close = (v: unknown) => api('POST', `/v1/quality/qc-runs/${id}/close`, TOK.qc, { comment: 'Synthetic nightly close' }, ifMatch(v));
    let cur = ok(await api('GET', `/v1/quality/qc-runs/${id}`, TOK.qc), 'get run');
    const r1 = await close(cur.version);
    expect([r1.status, r1.json.code]).toEqual([409, 'quality.corrective_action_required']); // AC-07.2
    ok(await api('POST', `/v1/quality/qc-runs/${id}/corrective-actions`, TOK.qc, { action_code: 'recalibrated', description: 'Synthetic: recalibrated and reran controls', performed_at: new Date().toISOString() }), 'corrective action'); // AC-07.1
    cur = ok(await api('GET', `/v1/quality/qc-runs/${id}`, TOK.qc), 'get run');
    const r2 = await close(cur.version);
    expect([r2.status, r2.json.code]).toEqual([409, 'quality.rerun_required']); // AC-07.3: no accepted run after run_at + window yet
    await inControl(new Date()); // accepted rerun, > run_at + 30 min
    await poll(async () => (await runs('outcome=accepted&run_at_from=' + encodeURIComponent(new Date(Date.now() - 5 * 60_000).toISOString()))).length > 0, 'accepted rerun evaluated');
    cur = ok(await api('GET', `/v1/quality/qc-runs/${id}`, TOK.qc), 'get run');
    const done = ok(await close(cur.version), 'close run'); // AC-07.4
    expect(done.status).toBe('closed');
    expect(done.closed_at).toBeTruthy();
    expect((await hbResult(state.order!.order_id))?.on_hold).toBe(true); // C5 owns the release (Lab › Settings › QC holds)
  });

  test('the run page shows the closed run and the corrective action (AC-07.4; the C5 release hint is a close-action toast, covered by the T-21 component test)', async ({ page, context }) => {
    need(QC_NEEDS.roles, QC_NEEDS.ids);
    test.skip(!state.run, 'depends on the rejection scenario');
    await useSession(context, TOK.qc);
    await page.goto(`/quality/qc-runs/${state.run!.id}`);
    await expect(page.getByText(/closed/i).first()).toBeVisible();
    await expect(page.getByText(/recalibrated/i).first()).toBeVisible();
  });
});

test.describe.serial('S-AV simulation → four-eyes activation → C5 result auto-verified', () => {
  const NEEDS = { roles: ['collect', 'tech', 'device', 'qc', 'author', 'activator', 'aal1'] as (keyof typeof TOK)[], ids: [...QC_NEEDS.ids, 'E2E_AV_VERSION_ID', 'E2E_AV_HB_OK', 'E2E_AV_HB_OUT'] };
  const getV = async () => ok(await api('GET', `/v1/quality/autoverify/versions/${ID.version}`, TOK.author), 'get version');
  const activate = (token: string, v: unknown) => api('POST', `/v1/quality/autoverify/versions/${ID.version}/activate`, token, { confirmation_text: 'ACTIVATE' }, ifMatch(v));

  test('activation: the author is refused (AC-12.1), an aal1 holder is refused (AC-12.3), a second aal2 user activates (AC-12.2)', async () => {
    need(NEEDS.roles, NEEDS.ids);
    let v = await getV();
    expect(v.status).toBe('simulating');
    const report = ok(await api('GET', `/v1/quality/autoverify/versions/${ID.version}/simulation-report`, TOK.author), 'simulation report'); // AC-11.3 / AC-13.7 access-logged
    expect(report).toBeTruthy();
    const self = await activate(TOK.author, v.version);
    expect([self.status, self.json.code]).toEqual([403, 'quality.self_activation_forbidden']);
    const low = await activate(TOK.aal1, v.version);
    expect([low.status, low.json.code]).toEqual([403, 'auth.mfa_required']);
    v = await getV();
    const act = ok(await activate(TOK.activator, v.version), 'activate');
    expect(act.status).toBe('active');
  });

  test('with QC in control, an in-limits Hb is auto-verified by C5 with a live allow decision; an out-of-limits Hb is not; approval stays manual (AC-13.3/13.4, 04 R2)', async () => {
    need(NEEDS.roles, NEEDS.ids);
    test.skip((await getV()).status !== 'active', 'depends on the activation scenario');
    await inControl(new Date());
    const good = await register(ID.hb);
    await patientHb(good.barcodes[0]!, ID.hbOk);
    const verified = await poll(async () => { const r = await hbResult(good.order_id); return r && ['verified', 'approved'].includes(r.status) ? r : false; }, 'auto-verified HB');
    expect(verified.status).toBe('verified'); // never approved by the engine
    const live = (ok(await api('GET', `/v1/quality/autoverify/decisions?mode=live&decision=allow&result_id=${verified.id}`, TOK.author), 'decisions').data as J[]);
    expect(live).toHaveLength(1); // exactly one live row per call (AC-13.3)
    expect(live[0]!.version_id).toBe(ID.version); // AC-13.4
    expect(live[0]!.reasons).toEqual([]); // "no reason ⇔ allow"

    const bad = await register(ID.hb);
    await patientHb(bad.barcodes[0]!, ID.hbOut);
    const held = await poll(async () => { const r = await hbResult(bad.order_id); return r?.status === 'resulted' ? r : false; }, 'out-of-limits HB resulted');
    await new Promise((r) => setTimeout(r, 10_000)); // give an erroneous auto-verify time to show
    expect((await hbResult(bad.order_id))?.status).toBe('resulted');
    const deny = (ok(await api('GET', `/v1/quality/autoverify/decisions?mode=live&decision=deny&result_id=${held.id}`, TOK.author), 'decisions').data as J[]);
    expect(deny.length).toBeGreaterThan(0);
    expect(deny.every((d) => (d.reasons as string[]).length > 0)).toBe(true);
  });
});

test.describe.serial('S-TAT breach visible and acknowledgeable', () => {
  const NEEDS = { roles: ['collect', 'tat'] as (keyof typeof TOK)[], ids: ['E2E_CENTRE_ID', 'E2E_TAT_ORDERABLE_ID'] };
  const state: { order?: Registered; alert?: J } = {};

  test('an order past its total-TAT target raises an alert that names its segment (AC-14.1, AC-14.3, AC-14.8)', async () => {
    need(NEEDS.roles, NEEDS.ids);
    state.order = await register(ID.tatTest);
    state.alert = await poll(async () => {
      const d = ok(await api('GET', '/v1/quality/tat-alerts?segment=total&acknowledged=false', TOK.tat), 'list tat alerts').data as J[];
      return d.find((a) => a.order_id === state.order!.order_id);
    }, 'TAT alert for the registered order', 180_000);
    expect(['warning', 'breached', 'escalated']).toContain(state.alert!.alert_level);
    expect(state.alert!.segment).toBe('total');
    expect(String(state.alert!.segment_label)).toMatch(/^Total: registration/);
  });

  test('the TAT alerts page shows the alert with its segment; acknowledging it records who and when (AC-14.6, AC-14.8)', async ({ page, context }) => {
    need(NEEDS.roles, NEEDS.ids);
    test.skip(!state.alert, 'depends on the breach scenario');
    await useSession(context, TOK.tat);
    await page.goto('/quality/tat-alerts');
    await expect(page.getByRole('grid').or(page.getByRole('table')).first()).toContainText(String(state.alert!.test_code));
    await expect(page.getByText('Total', { exact: false }).first()).toBeVisible();
    const row = page.getByRole('row').filter({ hasText: String(state.alert!.test_code) }).first();
    await row.getByRole('button', { name: /acknowledge/i }).click();
    const dlg = page.getByRole('dialog');
    await dlg.getByRole('button', { name: /^acknowledge/i }).click();
    await expect(dlg).toBeHidden();
    const after = ok(await api('GET', `/v1/quality/tat-alerts/${state.alert!.tat_item_id}`, TOK.tat), 'get tat alert');
    expect(after.acknowledged_at).toBeTruthy();
    expect(after.acknowledged_by_display).toBeTruthy();
    expect(after.acknowledged_level).toBe(state.alert!.alert_level);
  });
});
