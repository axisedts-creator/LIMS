// C14 T28 — task smartreport.llm_rephrase (06-PLAN row T28; 02-TRD §4.11, §4.12, §9.1; 03-APP-FLOW §2.9, E17; PRD AC-20.2, AC-20.3, AC-20.5; 07-SECURITY 007, 101).
// done_when: "input has no filled placeholders/values; overlay only while draft". Runs through the real C0 task wrapper; seams: see t28.fakes.ts header.
// Fails now: the task is the SR-T01 fail-closed stub ("smartreport.llm_rephrase not implemented") and ../../../../../api/src/modules/smartreport/llm.service.ts does not exist.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setup, type Setup } from '../../../core/__tests__/helpers.js';
import { manifest } from '../index.js';
import {
  B, ENDPOINT, llmCircuit, registerRephraser, setMetrics, EXPECTED_SECONDS, MEMBER, MODEL, ProbeRephraser, R_ALT, R_HGB, RULE_FU, SENSITIVE, SUMMARY, SYS, TA, TB, TEXT_EN, TEXT_NE, bigSummary, content, makePorts, reset, store,
  summaryRow, withPorts,
} from './t28.fakes.js';

vi.mock('../../../../../api/src/modules/smartreport/repository/summaries.repo.js', async (orig) => ({ ...(await orig<any>()), ...(await import('./t28.fakes.js')).summariesRepo }));
vi.mock('../../../../../api/src/modules/smartreport/repository/llmRuns.repo.js', async (orig) => ({ ...(await orig<any>()), ...(await import('./t28.fakes.js')).llmRunsRepo }));
vi.mock('../../../../../api/src/modules/smartreport/repository/blocks.repo.js', async (orig) => ({ ...(await orig<any>()), ...(await import('./t28.fakes.js')).blocksRepo }));
vi.mock('../../../../../api/src/modules/smartreport/repository/rules.repo.js', async (orig) => ({ ...(await orig<any>()), ...(await import('./t28.fakes.js')).rulesRepo }));
vi.mock('../../../../../api/src/modules/smartreport/repository/denyTerms.repo.js', async (orig) => ({ ...(await orig<any>()), ...(await import('./t28.fakes.js')).denyTermsRepo }));

const TASK = 'smartreport.llm_rephrase';
const ENV = { LIMS_SMARTREPORT_LLM_ADAPTER: 'fake-t28', LIMS_SMARTREPORT_LLM_ENDPOINT: ENDPOINT, LIMS_SMARTREPORT_LLM_ALLOWED_HOSTS: 'llm.internal.example',
  LIMS_SMARTREPORT_LLM_TIMEOUT_MS: String(EXPECTED_SECONDS), LIMS_SMARTREPORT_LLM_MODEL_REF: MODEL };
const saved: Record<string, string | undefined> = {};
const probe = new ProbeRephraser();
let s: Setup;
let clock = Date.UTC(2026, 10, 12);

beforeEach(async () => {
  reset(); probe.calls.length = 0; probe.behaviour = 'echo'; probe.during = null;
  for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v; }
  registerRephraser('fake-t28', () => probe);
  vi.useFakeTimers({ toFake: ['Date'] }); clock += 3_600_000; vi.setSystemTime(clock);   // any breaker opened by an earlier test has expired
  llmCircuit.recordSuccess();                                                              // consecutive-failure count back to 0
  s = await setup([withPorts(manifest as any, makePorts())]);
  setMetrics(s.metrics);
});
afterEach(() => { vi.useRealTimers(); for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

const payload = (o: Record<string, unknown> = {}) => ({ tenant_id: TA, summary_id: SUMMARY, requested_by_membership_id: MEMBER, ...o });
const run = (p: unknown = payload(), job: { attempts?: number } = {}) => s.run(TASK, p, job);
const settle = (p: Promise<unknown>) => p.then(() => undefined, (e) => e as Error);
const row = () => store.summaries.find((x) => x.id === SUMMARY)!;
const untouched = () => { expect(probe.calls).toEqual([]); expect(store.runs).toEqual([]); expect(store.updates).toEqual([]); };
const REFS = { d1: `deranged:${R_HGB}`, d2: `deranged:${R_ALT}`, adv: `advice:${B.adv}`, fu: `followup:${RULE_FU}` };
const ALL_REFS = [REFS.d1, REFS.d2, REFS.adv, REFS.fu];

describe('C14-T28 llm_rephrase — registration', () => {
  it('is a per-tenant task with 3 attempts (TRD §9.1 [CONV])', () => {
    expect(s.entry(TASK)).toMatchObject({ module: 'smartreport', kind: 'task', scope: 'per_tenant', maxAttempts: 3 });
  });
});

describe('llm_rephrase — gating: flags on? summary still draft? (TRD §9.1, 03-APP-FLOW §2.9 step 2)', () => {
  it.each<[string, Record<string, unknown>]>([
    ['smart_report off', { smart_report: false }], ['smart_report_llm off (default)', { smart_report_llm: false }], ['smart_report_llm string "true"', { smart_report_llm: 'true' }],
    ['smart_report_llm absent', { smart_report_llm: undefined }], ['smart_report_llm number 1', { smart_report_llm: 1 }],
  ])('%s -> done: no rephraser call (no network), no run row, no overlay', async (_n, flags) => {
    Object.assign(store.flags, flags);
    await run();
    untouched();
  });

  it.each(['approved', 'rejected', 'superseded'])('summary already %s -> done: nothing sent, nothing stored', async (status) => {
    row().status = status;
    await run();
    untouched();
  });

  it.each<[string, unknown]>([
    ['summary of another tenant (payload tenant = caller tenant, id belongs to B)', payload({ summary_id: '0190a000-0000-7000-8000-0000000b5001' })],
    ['payload tenant differs from the job tenant', payload({ tenant_id: TB })],
    ['summary_id not a uuid', payload({ summary_id: 'not-a-uuid' })],
    ['summary_id missing', { tenant_id: TA }],
  ])('bad payload / foreign summary: %s -> done, nothing sent, nothing stored', async (_n, p) => {
    store.summaries.push(summaryRow({ id: '0190a000-0000-7000-8000-0000000b5001', tenant_id: TB }));
    await run(p);
    untouched();
  });

  it('payload null -> rejected by the C0 wrapper (no tenant), nothing sent, nothing stored', async () => {
    expect(await settle(run(null))).toBeInstanceOf(Error);
    untouched();
  });

  it('summary not found -> done, nothing sent', async () => {
    store.summaries.length = 0;
    await run();
    untouched();
  });
});

describe('llm_rephrase — the request (AC-20.2: unfilled placeholders, no values, no names)', () => {
  it('one call: items = template block text of every deranged / advice / follow-up item, placeholders unfilled, prompt p1, summary language', async () => {
    await run();
    expect(probe.calls).toHaveLength(1);
    const input = probe.calls[0]!.input;
    expect(input.language).toBe('en');
    expect(input.promptTemplateVersion).toBe('p1');
    expect([...input.items].sort((a, b) => a.itemRef.localeCompare(b.itemRef))).toEqual([
      { itemRef: REFS.adv, templateText: TEXT_EN.adv }, { itemRef: REFS.d1, templateText: TEXT_EN.low }, { itemRef: REFS.d2, templateText: TEXT_EN.high }, { itemRef: REFS.fu, templateText: TEXT_EN.fu },
    ]);
  });

  it('AC-20.2: the captured request contains no filled value, analyte/test name, registration number, patient/order/tenant id', async () => {
    await run();
    const wire = JSON.stringify(probe.calls[0]!.input);
    for (const secret of SENSITIVE) expect(wire, secret).not.toContain(secret);
    for (const it of probe.calls[0]!.input.items) expect(it.templateText).toMatch(/\{[a-z_]+\}/);       // every fixture block still carries its placeholder tokens
  });

  it('the request holds exactly the keys language / promptTemplateVersion / items; each item exactly itemRef + templateText (nothing else rides along)', async () => {
    await run();
    const input = probe.calls[0]!.input as any;
    expect(Object.keys(input).sort()).toEqual(['items', 'language', 'promptTemplateVersion']);
    for (const it of input.items) expect(Object.keys(it).sort()).toEqual(['itemRef', 'templateText']);
  });

  it('language ne: the Nepali block text is sent (text_ne), language "ne"', async () => {
    row().content = content({ language: 'ne', deranged: 1 }); row().language = 'ne';
    row().content.advice = []; row().content.followUps = [];
    probe.behaviour = 'echo';
    await run();
    const input = probe.calls[0]!.input;
    expect(input.language).toBe('ne');
    expect(input.items).toEqual([{ itemRef: REFS.d1, templateText: TEXT_NE.low }]);
  });

  it('timeout comes from LIMS_SMARTREPORT_LLM_TIMEOUT_MS and an AbortSignal is passed', async () => {
    await run();
    expect(probe.calls[0]!.opts.timeoutMs).toBe(EXPECTED_SECONDS);
    expect(probe.calls[0]!.opts.signal).toBeInstanceOf(AbortSignal);
  });

  it('more than 30 candidate items: no single call carries more than 30 items (interface cap)', async () => {
    store.summaries[0] = bigSummary();
    await run();
    expect(probe.calls.length).toBeGreaterThanOrEqual(1);
    for (const c of probe.calls) expect(c.input.items.length).toBeLessThanOrEqual(30);
  });

  it('a block of another tenant with the same id is never used', async () => {
    await run();
    expect(JSON.stringify(probe.calls[0]!.input)).not.toContain('OTHER TENANT TEXT');
  });
});

describe('llm_rephrase — llm_runs + overlay on success (AC-20.2, 03-APP-FLOW §2.9 step 2)', () => {
  it('stores ONE run: prompt p1, configured model ref, 64-hex input hash, per-item output + validator report, latency, system actor, summary centre', async () => {
    probe.behaviour = 'rephrase';
    await run();
    expect(store.runs).toHaveLength(1);
    const r = store.runs[0]!;
    expect(r).toMatchObject({ summary_id: SUMMARY, centre_id: row().centre_id, tenant_id: TA, status: 'succeeded', prompt_template_version: 'p1', model_ref: MODEL, created_by: SYS });
    expect(r.input_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Number.isInteger(r.latency_ms) && r.latency_ms >= 0).toBe(true);
    expect(r.items.map((i: any) => i.item_ref).sort()).toEqual([...ALL_REFS].sort());
    for (const i of r.items) {
      expect(Object.keys(i).sort()).toEqual(['failure_codes', 'item_ref', 'output_text', 'passed', 'template_text']);
      expect(i.passed).toBe(true); expect(i.failure_codes).toEqual([]);
      expect(typeof i.output_text).toBe('string'); expect(i.output_text).not.toBe(i.template_text);
    }
    expect(r.items.find((i: any) => i.item_ref === REFS.d1).template_text).toBe(TEXT_EN.low);
  });

  it('input hash is deterministic for the same request and differs for a different one', async () => {
    await run(); const first = store.runs[0]!.input_sha256;
    await run(); expect(store.runs[1]!.input_sha256).toBe(first);
    row().content.advice = []; row().llm_overlay = null;
    await run(); expect(store.runs[2]!.input_sha256).not.toBe(first);
  });

  it('sets llm_overlay = { run_id, items: { itemRef: text } } for every passed item, with ONE updateSummary(expected = version read) touching only llm_overlay', async () => {
    probe.behaviour = 'rephrase';
    await run();
    expect(store.updates).toHaveLength(1);
    expect(store.updates[0]).toMatchObject({ id: SUMMARY, expected: 4, tenantId: TA, actorId: SYS });
    expect(Object.keys(store.updates[0]!.patch)).toEqual(['llm_overlay']);
    expect(row()).toMatchObject({ status: 'draft', use_llm_text: false, version: 5 });
    expect(row().llm_overlay.run_id).toBe(store.runs[0]!.id);
    expect(Object.keys(row().llm_overlay.items).sort()).toEqual([...ALL_REFS].sort());
    for (const t of Object.values(row().llm_overlay.items)) expect(typeof t).toBe('string');
  });

  it('use_llm_text stays false: the overlay is a proposal, only the pathologist\'s approval turns it on', async () => {
    await run();
    expect(row().use_llm_text).toBe(false);
    expect(store.updates.every((u) => !('use_llm_text' in u.patch) && !('status' in u.patch))).toBe(true);
  });

  it('a second run replaces the overlay (new run_id; items of the old run are not merged in)', async () => {
    probe.behaviour = 'rephrase'; await run();
    const first = store.runs[0]!.id;
    probe.behaviour = (input) => input.items.filter((i) => i.itemRef === REFS.d1).map((i) => ({ itemRef: i.itemRef, text: i.templateText }));   // only one item answered -> others item_mismatch
    await run();
    expect(store.runs).toHaveLength(2);
    expect(row().llm_overlay.run_id).toBe(store.runs[1]!.id); expect(row().llm_overlay.run_id).not.toBe(first);
    expect(Object.keys(row().llm_overlay.items)).toEqual([REFS.d1]);
  });
});

describe('llm_rephrase — validator outcomes (AC-20.3: a failing item keeps the template text, nothing thrown)', () => {
  it('one item adds a digit -> run partially_passed; that item passed=false [digit_added] and is NOT in the overlay; the others are; task resolves', async () => {
    probe.behaviour = (input) => input.items.map((i) => ({ itemRef: i.itemRef, text: i.itemRef === REFS.d2 ? `${i.templateText} 5` : i.templateText }));
    await run();
    const r = store.runs[0]!;
    expect(r.status).toBe('partially_passed');
    const bad = r.items.find((i: any) => i.item_ref === REFS.d2);
    expect(bad).toMatchObject({ passed: false, failure_codes: ['digit_added'] });
    expect(bad.output_text).toBe(`${TEXT_EN.high} 5`);                                          // the raw output is kept on the run for the audit / diff
    expect(Object.keys(row().llm_overlay.items).sort()).toEqual([REFS.d1, REFS.adv, REFS.fu].sort());
  });

  it('every item fails -> run validator_failed, overlay NOT written (no updateSummary), summary untouched', async () => {
    probe.behaviour = (input) => input.items.map((i) => ({ itemRef: i.itemRef, text: i.templateText.replace(/\{[a-z_]+\}/g, '') }));    // drops every placeholder
    await run();
    expect(store.runs).toHaveLength(1);
    expect(store.runs[0]!.status).toBe('validator_failed');
    expect(store.runs[0]!.items.every((i: any) => !i.passed && i.failure_codes.includes('placeholder_mismatch'))).toBe(true);
    expect(store.updates).toEqual([]);
    expect(row()).toMatchObject({ llm_overlay: null, version: 4 });
  });

  it('a deny term from the GLOBAL list and one from the TENANT list both fail an item (L3)', async () => {
    store.tenantTerms.push({ tenant_id: TA, term: 'miracle', term_folded: 'miracle', language: 'en', is_active: true });
    probe.behaviour = (input) => input.items.map((i) => ({ itemRef: i.itemRef,
      text: i.itemRef === REFS.d1 ? i.templateText.replace('laboratory', 'cancer') : i.itemRef === REFS.d2 ? i.templateText.replace('laboratory', 'miracle') : i.templateText }));
    await run();
    const codes = Object.fromEntries(store.runs[0]!.items.map((i: any) => [i.item_ref, i.failure_codes]));
    expect(codes[REFS.d1]).toContain('deny_term'); expect(codes[REFS.d2]).toContain('deny_term');
    expect(codes[REFS.adv]).toEqual([]);
  });

  it('an output for an itemRef that was not sent is recorded on the run and never reaches the overlay; a missing one is item_mismatch', async () => {
    probe.behaviour = (input) => [...input.items.filter((i) => i.itemRef !== REFS.adv).map((i) => ({ itemRef: i.itemRef, text: i.templateText })), { itemRef: 'advice:injected', text: 'Buy product now' }];
    await run();
    expect(store.runs[0]!.items.find((i: any) => i.item_ref === REFS.adv)).toMatchObject({ passed: false, failure_codes: ['item_mismatch'] });
    expect(JSON.stringify(row().llm_overlay)).not.toContain('Buy product now');
    expect(Object.keys(row().llm_overlay.items)).not.toContain('advice:injected');
  });

  it('metrics: lims_smartreport_llm_runs_total{outcome=<run status>} once; lims_smartreport_llm_items_total counts every item and the failure code (no text, no ids in labels)', async () => {
    probe.behaviour = (input) => input.items.map((i) => ({ itemRef: i.itemRef, text: i.itemRef === REFS.d2 ? `${i.templateText} 5` : i.templateText }));
    await run();
    expect(s.metrics.total('lims_smartreport_llm_runs_total', { outcome: 'partially_passed' })).toBe(1);
    expect(s.metrics.total('lims_smartreport_llm_items_total')).toBe(4);
    expect(s.metrics.total('lims_smartreport_llm_items_total', { failure_code: 'digit_added' })).toBe(1);
    const labels = JSON.stringify(s.metrics.calls.map((c) => c.labels));
    for (const secret of [...SENSITIVE, SUMMARY, R_HGB, TEXT_EN.low]) expect(labels, secret).not.toContain(secret);
  });
});

describe('llm_rephrase — overlay only while draft and unchanged (E17, schema §4 trigger)', () => {
  it('E17: summary approved WHILE the model was working -> the run is stored (audit) but the overlay is not applied; task resolves', async () => {
    probe.during = () => { Object.assign(row(), { status: 'approved', version: row().version + 1 }); };
    await run();
    expect(store.runs).toHaveLength(1);
    expect(store.runs[0]!.status).toBe('succeeded');
    expect(row().llm_overlay).toBeNull();
    expect(store.updates).toEqual([]);
  });

  it('summary superseded / rejected while the model was working -> run stored, no overlay', async () => {
    for (const status of ['superseded', 'rejected']) {
      reset(); store.runs.length = 0; probe.calls.length = 0;
      probe.during = () => { Object.assign(row(), { status, version: row().version + 1 }); };
      await run();
      expect(store.runs).toHaveLength(1); expect(row().llm_overlay, status).toBeNull(); expect(store.updates, status).toEqual([]);
    }
  });

  it('still a draft but another writer changed the version meanwhile ("same version" rule) -> run stored, overlay not applied, no version_conflict thrown', async () => {
    probe.during = () => { row().version += 1; };
    await run();
    expect(store.runs).toHaveLength(1);
    expect(row().llm_overlay).toBeNull();
    expect(store.updates).toEqual([]);
  });

  it('the overlay never overwrites a summary that was already approved when the task started (gating) and the stored content is never touched', async () => {
    const before = JSON.stringify(row().content);
    await run();
    expect(JSON.stringify(row().content)).toBe(before);
    expect(store.updates.every((u) => Object.keys(u.patch).join() === 'llm_overlay')).toBe(true);
  });
});

describe('llm_rephrase — host allowlist, failures, circuit breaker (AC-20.5, TRD §9.1, 07-SECURITY 101)', () => {
  it('AC-20.5: endpoint host not on LIMS_SMARTREPORT_LLM_ALLOWED_HOSTS -> the client is never started: no call, alert metric lims_smartreport_llm_endpoint_refused_total, task fails (never silently acked)', async () => {
    process.env.LIMS_SMARTREPORT_LLM_ALLOWED_HOSTS = 'other.internal.example';
    const e = await settle(run());
    expect(e).toBeInstanceOf(Error);
    expect(probe.calls).toEqual([]);
    expect(store.updates).toEqual([]);
    expect(s.metrics.total('lims_smartreport_llm_endpoint_refused_total')).toBeGreaterThanOrEqual(1);
  });

  it('AC-20.5: empty allowlist (default) with an adapter configured -> refused the same way', async () => {
    delete process.env.LIMS_SMARTREPORT_LLM_ALLOWED_HOSTS;
    expect(await settle(run())).toBeInstanceOf(Error);
    expect(probe.calls).toEqual([]);
    expect(s.metrics.total('lims_smartreport_llm_endpoint_refused_total')).toBeGreaterThanOrEqual(1);
  });

  it('adapter "disabled" with both flags on -> nothing is sent anywhere, no overlay, task does not pretend success with a run row', async () => {
    process.env.LIMS_SMARTREPORT_LLM_ADAPTER = 'disabled';
    await settle(run());
    expect(probe.calls).toEqual([]);
    expect(store.updates).toEqual([]);
    expect(store.runs.filter((r) => r.status === 'succeeded')).toEqual([]);
  });

  it('transport failure on a non-final attempt -> the task throws (queue retries), no run row, no overlay', async () => {
    probe.behaviour = 'throw';
    expect(await settle(run(payload(), { attempts: 1 }))).toBeInstanceOf(Error);
    expect(store.runs).toEqual([]); expect(store.updates).toEqual([]);
  });

  it('transport failure on the FINAL attempt -> resolves, run row status failed with an error code and no items; summary and overlay untouched (TRD §9.1)', async () => {
    probe.behaviour = 'throw';
    await run(payload(), { attempts: 3 });
    expect(store.runs).toHaveLength(1);
    expect(store.runs[0]).toMatchObject({ status: 'failed', summary_id: SUMMARY, prompt_template_version: 'p1', model_ref: MODEL });
    expect(store.runs[0]!.input_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof store.runs[0]!.error_code).toBe('string');
    expect(store.runs[0]!.items).toEqual([]);
    expect(JSON.stringify(store.runs[0])).not.toContain('synthetic transport failure');       // no raw upstream message stored
    expect(store.updates).toEqual([]);
    expect(s.metrics.total('lims_smartreport_llm_runs_total', { outcome: 'failed' })).toBe(1);
  });

  it('circuit breaker: 5 consecutive failures open it -> the 6th attempt does not call the model, the task fails, gauge lims_smartreport_llm_circuit_open = 1', async () => {
    probe.behaviour = 'throw';
    for (let i = 0; i < 5; i++) await settle(run(payload(), { attempts: 1 }));
    expect(probe.calls).toHaveLength(5);
    expect(await settle(run(payload(), { attempts: 1 }))).toBeInstanceOf(Error);
    expect(probe.calls).toHaveLength(5);
    expect(s.metrics.last('set', 'lims_smartreport_llm_circuit_open')?.value).toBe(1);
  });

  it('circuit open on the FINAL attempt -> resolves (no dead-letter), model not called, one failed llm_runs row, runs_total{failed} +1 (TRD §9.1: final failure -> run row failed)', async () => {
    probe.behaviour = 'throw';
    for (let i = 0; i < 5; i++) await settle(run(payload(), { attempts: 1 }));
    expect(probe.calls).toHaveLength(5);
    expect(store.runs).toEqual([]);
    await run(payload(), { attempts: 3 });
    expect(probe.calls).toHaveLength(5);
    expect(store.runs).toHaveLength(1);
    expect(store.runs[0]).toMatchObject({ status: 'failed', summary_id: SUMMARY, items: [] });
    expect(store.updates).toEqual([]);
    expect(s.metrics.total('lims_smartreport_llm_runs_total', { outcome: 'failed' })).toBe(1);
  });

  it('a successful run in between keeps the breaker closed (4 failures, 1 success, 4 failures -> still calling)', async () => {
    probe.behaviour = 'throw';
    for (let i = 0; i < 4; i++) await settle(run(payload(), { attempts: 1 }));
    probe.behaviour = 'echo'; await run();
    probe.behaviour = 'throw'; row().llm_overlay = null;
    for (let i = 0; i < 4; i++) await settle(run(payload(), { attempts: 1 }));
    expect(probe.calls).toHaveLength(9);
  });

  it('the log never contains the template text, the model output or the payload ids beyond codes (P3 hygiene)', async () => {
    probe.behaviour = 'rephrase';
    await run();
    const text = s.logs.text();
    for (const t of [TEXT_EN.low, TEXT_EN.adv, 'Hemoglobin', '13.40']) expect(text, t).not.toContain(t);
  });
});
