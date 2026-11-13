// C14 T28 emulators + fixtures for task smartreport.llm_rephrase (not a test file). Loaded by vi.mock factories, so it must NOT import the task or ../index.js. Synthetic data only.
// Handlers run through the REAL C0 task wrapper on the core fake DB (core/__tests__/helpers.ts); smartreport repositories are replaced by in-memory fakes.
//
// SEAMS pinned for T28 (the spec fixes behaviour 02-TRD §4.11/§4.12/§9.1, 03-APP-FLOW §2.9, not the TypeScript shapes):
//   - the task is reached ONLY through `manifest.tasks['smartreport.llm_rephrase']` of ../index.js; payload `{ tenant_id, summary_id, requested_by_membership_id }` (TRD §9.1).
//   - ports come from `ctx.ports` (T14 precedent; both spellings offered): Identity getTenantSettings(ctx, { keys: ['featureFlags'] }) -> { featureFlags: { smart_report, smart_report_llm } }.
//   - repositories (no raw SQL on smartreport.* tables): summaries.repo.getSummary + updateSummary, llmRuns.repo.insertLlmRun, blocks.repo (getBlock | listBlocks), rules.repo (getRule | listRules |
//     listRulesByKind), denyTerms.repo (listDenyTerms + listGlobalDenyTerms). RepoCtx = { tx, tenantId, actorId }, actorId = the smartreport system actor.
//   - template text = the stored template block's text in the summary's language (text_en | text_ne), looked up through content.deranged[].templateBlockId, content.advice[].templateBlockId and
//     content.followUps[].ruleId -> rule.block_id. itemRef = `deranged:<resultId>` | `advice:<blockId>` | `followup:<ruleId>` (TRD §4.12).
//   - the rephraser is resolved through llm.service resolveRephraser(loadSmartreportConfig(process.env)) at run time: env LIMS_SMARTREPORT_LLM_ADAPTER / _ENDPOINT / _ALLOWED_HOSTS / _TIMEOUT_MS / _MODEL_REF
//     are read per run; the test registers the adapter name 'fake-t28' (llm.service registerRephraser).
//   - llm_runs row passed to insertLlmRun: { id, centre_id, summary_id, status, prompt_template_version, model_ref, input_sha256, items, latency_ms, error_code? } where
//     items = [{ item_ref, template_text, output_text?, passed, failure_codes[] }] (the shape of endpoint #34, contracts LlmRun) and status in succeeded | partially_passed | validator_failed | failed.
//   - overlay = updateSummary(rc, id, <version read>, { llm_overlay: { run_id, items: { itemRef: text } } }) and NOTHING else in the patch; the summaries emulator refuses it unless the row is a draft
//     (05-SCHEMA §4 trigger) and refuses a stale expected version.
//   - the final attempt of the job (job.attempts >= job.max_attempts, the row the C0 harness hands the task) does NOT throw: it inserts the `failed` run (a throw would roll the row back).
import { FakeRephraser } from '../../../../../api/src/modules/smartreport/llm/FakeRephraser.js';
import type { LlmRephraseInput, LlmRephraseOutput } from '../../../../../api/src/modules/smartreport/llm/LlmRephraser.js';
import { LimsError } from '../../../../../api/src/core/errors.js';
import { llmCircuit, registerRephraser } from '../../../../../api/src/modules/smartreport/llm.service.js';
import { systemActorOf } from '../../../core/__tests__/helpers.js';

export { LimsError, llmCircuit, registerRephraser };
/** C0 JobContext has no `metrics`; the harness injects the Setup's sink (assigned in beforeEach, read lazily per run). */
let metricsSink: unknown;
export const setMetrics = (m: unknown): void => { metricsSink = m; };
type Row = Record<string, any>;

export const TA = '0190a000-0000-7000-8000-00000000aaaa';
export const TB = '0190a000-0000-7000-8000-00000000bbbb';
export const SYS = systemActorOf('smartreport');
const u = (n: number) => `0190a000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
export const SUMMARY = u(0x5001), ORDER = u(0xf001), PATIENT = u(0xf101), CENTRE = u(0xc001), LIB = u(0x1b01), MEMBER = u(0xa001);
export const R_HGB = u(0xe001), R_ALT = u(0xe002);
export const B = { low: u(0xb001), high: u(0xb002), adv: u(0xb003), fu: u(0xb004) };
export const RULE_FU = u(0xd001);
export const MODEL = 't28-model';
export const ENDPOINT = 'https://llm.internal.example/v1';
export const EXPECTED_SECONDS = 15000;
/** Filled values that must NEVER reach the rephraser (they are in the stored content, the request has to be built from the unfilled blocks). */
export const SENSITIVE = ['Hemoglobin', 'Repeat hemoglobin', '13.40', 'g/dL', 'SYN-REG-PRIVATE', PATIENT, ORDER, TA];

export const TEXT_EN = {
  low: '{analyte_name} is below the reference range of this laboratory.',
  high: '{analyte_name} is above the reference range of this laboratory.',
  adv: 'Please discuss {analyte_name} with your doctor soon.',
  fu: 'Repeat {test_name} after {interval_days} days.',
};
export const TEXT_NE = { low: 'प्रयोगशालाको सन्दर्भ दायराभन्दा {analyte_name} कम छ।' };

export const store = {
  summaries: [] as Row[], runs: [] as Row[], updates: [] as { id: string; expected: number; patch: Row; tenantId: string; actorId: string }[],
  blocks: [] as Row[], rules: [] as Row[], tenantTerms: [] as Row[], globalTerms: [] as Row[],
  flags: { smart_report: true as unknown, smart_report_llm: true as unknown }, calls: [] as string[], seq: 0,
};

export function content(o: { language?: 'en' | 'ne'; deranged?: number } = {}): Row {
  const n = o.deranged ?? 2;
  const deranged = Array.from({ length: n }, (_, i) => i === 0
    ? { resultId: R_HGB, analyteId: u(0x9001), direction: 'low', severity: 'out_of_range', templateBlockId: B.low, text: 'Hemoglobin is below the reference range of this laboratory.', analyteName: 'Hemoglobin' }
    : { resultId: i === 1 ? R_ALT : u(0xe100 + i), analyteId: u(0x9100 + i), direction: 'high', severity: 'borderline', templateBlockId: B.high, text: `ALT${i} is above the reference range of this laboratory.`, analyteName: `ALT${i}` });
  return { language: o.language ?? 'en', builtAt: '2026-11-12T00:00:00.000Z', panels: [], deranged, advice: [{ templateBlockId: B.adv, text: 'Please discuss Hemoglobin with your doctor soon.' }],
    followUps: [{ ruleId: RULE_FU, suggestedTestCode: 'HGB2', suggestedTestName: 'Repeat hemoglobin', intervalDays: 30, text: 'Repeat Repeat hemoglobin after 30 days.' }], trends: [],
    disclaimerBlockId: u(0xb009), disclaimerText: 'Synthetic disclaimer.' };
}
export const summaryRow = (o: Row = {}): Row => ({ id: SUMMARY, tenant_id: TA, centre_id: CENTRE, order_id: ORDER, patient_id: PATIENT, status: 'draft', version: 4, library_version_id: LIB,
  language: 'en', content: content(), use_llm_text: false, llm_overlay: null, ...o });

export function reset(): void {
  Object.assign(store, { summaries: [summaryRow()], runs: [], updates: [], calls: [], seq: 0, flags: { smart_report: true, smart_report_llm: true },
    blocks: [
      { id: B.low, tenant_id: TA, library_version_id: LIB, kind: 'deranged', block_key: 'deranged.low', text_en: TEXT_EN.low, text_ne: TEXT_NE.low, is_active: true },
      { id: B.high, tenant_id: TA, library_version_id: LIB, kind: 'deranged', block_key: 'deranged.high', text_en: TEXT_EN.high, text_ne: null, is_active: true },
      { id: B.adv, tenant_id: TA, library_version_id: LIB, kind: 'advice', block_key: 'advice.discuss', text_en: TEXT_EN.adv, text_ne: null, is_active: true },
      { id: B.fu, tenant_id: TA, library_version_id: LIB, kind: 'followup', block_key: 'followup.repeat', text_en: TEXT_EN.fu, text_ne: null, is_active: true },
      { id: B.low, tenant_id: TB, library_version_id: u(0x1b99), kind: 'deranged', block_key: 'deranged.low', text_en: 'OTHER TENANT TEXT {analyte_name}', text_ne: null, is_active: true },
    ],
    rules: [{ id: RULE_FU, tenant_id: TA, library_version_id: LIB, rule_kind: 'followup', block_id: B.fu, block_kind: 'followup', is_active: true }],
    tenantTerms: [], globalTerms: [{ term: 'cancer', term_folded: 'cancer', language: 'en' }] });
}
/** `n` extra deranged entries so a summary has more than 30 candidate items. */
export const bigSummary = (): Row => summaryRow({ content: content({ deranged: 35 }) });

const clone = <T>(x: T): T => structuredClone(x);
const mine = (rows: Row[], rc: Row) => rows.filter((r) => r.tenant_id === rc.tenantId);
const pg = (code: string, message: string): Error => Object.assign(new Error(message), { code });
const HEX64 = /^[0-9a-f]{64}$/;

// ------------------------------------------------------------------------------------------------ repository fakes (merged over the real module exports)
export const summariesRepo = {
  async getSummary(rc: Row, id: string): Promise<Row | null> { store.calls.push('getSummary'); const r = mine(store.summaries, rc).find((s) => s.id === id); return r ? clone(r) : null; },
  async updateSummary(rc: Row, id: string, expected: number, patch: Row): Promise<Row> {
    store.calls.push('updateSummary');
    const r = mine(store.summaries, rc).find((s) => s.id === id);
    if (!r) throw new LimsError('common.not_found');
    if (r.version !== expected) throw new LimsError('common.version_conflict');
    if ('llm_overlay' in patch && r.status !== 'draft') throw pg('P0001', 'summaries: invalid_transition (llm_overlay changes only while draft)');
    store.updates.push({ id, expected, patch: clone(patch), tenantId: rc.tenantId, actorId: rc.actorId });
    Object.assign(r, patch, { version: r.version + 1 });
    return clone(r);
  },
};
export const llmRunsRepo = {
  async insertLlmRun(rc: Row, row: Row): Promise<Row> {
    store.calls.push('insertLlmRun');
    if (!['succeeded', 'partially_passed', 'validator_failed', 'failed'].includes(row.status)) throw pg('23514', 'llm_runs__status__ck');
    if (!/^p[0-9]{1,3}$/.test(row.prompt_template_version)) throw pg('23514', 'llm_runs__prompt__ck');
    if (typeof row.model_ref !== 'string' || row.model_ref.length < 1 || row.model_ref.length > 100) throw pg('23514', 'llm_runs__model__ck');
    if (!HEX64.test(row.input_sha256)) throw pg('23514', 'llm_runs__hash__ck');
    if (row.latency_ms != null && (!Number.isInteger(row.latency_ms) || row.latency_ms < 0)) throw pg('23514', 'llm_runs__latency__ck');
    if (!Array.isArray(row.items)) throw pg('23502', 'llm_runs.items null');
    if (!store.summaries.some((s) => s.tenant_id === rc.tenantId && s.id === row.summary_id)) throw pg('23503', 'llm_runs__summary__fk');
    const r = { ...clone(row), tenant_id: rc.tenantId, created_by: rc.actorId, created_at: new Date(Date.UTC(2026, 10, 12, 1, 0, ++store.seq)).toISOString() };
    store.runs.push(r); return clone(r);
  },
  async listLlmRuns(rc: Row, summaryId: string): Promise<Row[]> { return clone(mine(store.runs, rc).filter((r) => r.summary_id === summaryId)); },
};
export const blocksRepo = {
  async getBlock(rc: Row, id: string): Promise<Row | null> { const r = mine(store.blocks, rc).find((b) => b.id === id); return r ? clone(r) : null; },
  async listBlocks(rc: Row, libraryVersionId: string): Promise<Row[]> { return clone(mine(store.blocks, rc).filter((b) => b.library_version_id === libraryVersionId)); },
};
export const rulesRepo = {
  async getRule(rc: Row, id: string): Promise<Row | null> { const r = mine(store.rules, rc).find((x) => x.id === id); return r ? clone(r) : null; },
  async listRules(rc: Row, libraryVersionId: string): Promise<Row[]> { return clone(mine(store.rules, rc).filter((x) => x.library_version_id === libraryVersionId)); },
  async listRulesByKind(rc: Row, libraryVersionId: string, kind: string): Promise<Row[]> { return clone(mine(store.rules, rc).filter((x) => x.library_version_id === libraryVersionId && x.rule_kind === kind)); },
};
export const denyTermsRepo = {
  async listDenyTerms(rc: Row): Promise<Row[]> { return clone(mine(store.tenantTerms, rc)); },
  async listGlobalDenyTerms(): Promise<Row[]> { return clone(store.globalTerms); },
};

// ------------------------------------------------------------------------------------------------ ports + manifest wrapper (ctx.ports; store snapshot restored when the handler throws = tx rollback)
export function makePorts() {
  const identity = { async getTenantSettings(_ctx: unknown, _i: unknown) { store.calls.push('getTenantSettings'); return { featureFlags: { ...store.flags } }; } };
  return { identity, IdentityPort: identity };
}
const snap = () => clone({ summaries: store.summaries, runs: store.runs, updates: store.updates });
export function withPorts<M extends { tasks?: Record<string, any> }>(manifest: M, ports = makePorts()): M {
  const wrap = (h: (a: any, c: any) => Promise<void>) => async (a: any, ctx: any) => {
    const before = snap();
    const base = ctx.tx;
    const tx: any = Object.assign(Object.create(base), {
      async query(text: string, values: unknown[] = []) {
        if (/pg_advisory_xact_lock|^\s*(SAVEPOINT|RELEASE|ROLLBACK TO)/i.test(String(text))) return { rows: [{}] };
        return base.query(text, values);
      },
      async savepoint<T>(fn: (t: unknown) => Promise<T>): Promise<T> { return fn(tx); },
    });
    try { return await h(a, { ...ctx, ports, tx, metrics: metricsSink }); } catch (e) { Object.assign(store, before); throw e; }
  };
  return { ...manifest, tasks: Object.fromEntries(Object.entries(manifest.tasks ?? {}).map(([k, h]) => [k, wrap(h)])) } as M;
}

// ------------------------------------------------------------------------------------------------ rephraser double
export type Behaviour = 'echo' | 'rephrase' | ((input: LlmRephraseInput) => LlmRephraseOutput['items']) | 'throw';
/** Records every request (FakeRephraser.calls); `behaviour` decides the output; `during` runs inside the call (a concurrent writer). */
export class ProbeRephraser extends FakeRephraser {
  behaviour: Behaviour = 'echo';
  during: null | (() => void) = null;
  override async rephrase(input: LlmRephraseInput, opts: { readonly timeoutMs: number; readonly signal: AbortSignal }): Promise<LlmRephraseOutput> {
    this.calls.push({ input: clone(input), opts });
    this.during?.();
    if (this.behaviour === 'throw') throw new Error('synthetic transport failure');
    const items = typeof this.behaviour === 'function' ? this.behaviour(input)
      : input.items.map((i) => ({ itemRef: i.itemRef, text: this.behaviour === 'echo' ? i.templateText : shuffleWords(i.templateText) }));
    return { items, modelRef: MODEL };
  }
}
/** Same words, same placeholders, same length (passes L1-L8): swaps the first and last word. */
export function shuffleWords(t: string): string {
  const w = t.split(' ');
  if (w.length < 3) return t;
  const last = w[w.length - 1]!.replace(/[.।]$/, ''), first = w[0]!;
  const tail = w[w.length - 1]!.slice(last.length);
  return [last, ...w.slice(1, -1), first + tail].join(' ');
}
