// Task smartreport.llm_rephrase {tenant_id, summary_id, requested_by_membership_id} (02-TRD §4.11, §4.12, §9.1; 03-APP-FLOW §2.9 step 2, E17; PRD AC-20.2, AC-20.3, AC-20.5).
// Gates (both flags on, summary still a draft) -> request from the UNFILLED approved template blocks only (no values, names or ids leave the system) -> rephraser (host allowlist,
// circuit breaker) -> validator L1-L8 -> ONE llm_runs row -> overlay on the draft IF it is still that same draft. The stored content and use_llm_text are never touched.
// A transport failure retries (throw) until the last attempt, which stores a `failed` run and resolves (a throw would roll the row back).
import { createHash } from 'node:crypto';
import type { TaskHandler } from '../../../core/manifest.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError } from '../../../../../api/src/core/errors.js';
import { loadSmartreportConfig } from '../../../../../api/src/modules/smartreport/config.js';
import { llmCircuit, resolveRephraser } from '../../../../../api/src/modules/smartreport/llm.service.js';
import type { LlmRephraseInput, LlmRephraseItem, LlmRephraseOutput } from '../../../../../api/src/modules/smartreport/llm/LlmRephraser.js';
import { validateLlmOutput } from '../../../../../api/src/modules/smartreport/llm/validator.js';
import * as blocksRepo from '../../../../../api/src/modules/smartreport/repository/blocks.repo.js';
import * as denyTermsRepo from '../../../../../api/src/modules/smartreport/repository/denyTerms.repo.js';
import * as llmRunsRepo from '../../../../../api/src/modules/smartreport/repository/llmRuns.repo.js';
import * as rulesRepo from '../../../../../api/src/modules/smartreport/repository/rules.repo.js';
import * as summariesRepo from '../../../../../api/src/modules/smartreport/repository/summaries.repo.js';
import type { RepoCtx } from '../../../../../api/src/modules/smartreport/repository/common.repo.js';
import { portOf } from '../consumers/supersede.js';

export const LLM_REPHRASE = 'smartreport.llm_rephrase';
export const LLM_MAX_ATTEMPTS = 3;                                             // 02-TRD §9.1 [CONV]
type Row = Record<string, any>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PER_CALL = 30;                                                           // LlmRephraseInput.items cap
const PER_RUN = 100;                                                           // contract LlmRun.items maxItems; ponytail: candidates beyond 100 keep their template text
const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);

/** Unfilled template text per item, from the summary's library version (tenant-scoped repos): deranged by templateBlockId, advice by templateBlockId, follow-up via rule.block_id. */
async function candidates(rc: RepoCtx, s: Row): Promise<LlmRephraseItem[]> {
  const lang = s['language'] === 'ne' ? 'text_ne' : 'text_en';
  const lib: string = s['library_version_id'];
  const all = { includeInactive: true };                                       // an approved library's retired block still backs this draft
  const blocks = new Map<string, Row>((await blocksRepo.listBlocks(rc, lib, all)).map((b: Row) => [b['id'], b]));
  const rules = new Map<string, Row>((await rulesRepo.listRules(rc, lib, all)).map((r: Row) => [r['id'], r]));
  const c: Row = s['content'] ?? {};
  const out = new Map<string, string>();
  const add = (ref: string, blockId: unknown): void => {
    const t = typeof blockId === 'string' ? blocks.get(blockId)?.[lang] : undefined;
    if (typeof t === 'string' && t !== '' && !out.has(ref)) out.set(ref, t);
  };
  for (const d of (c['deranged'] ?? []) as Row[]) add(`deranged:${d['resultId']}`, d['templateBlockId']);
  for (const a of (c['advice'] ?? []) as Row[]) add(`advice:${a['templateBlockId']}`, a['templateBlockId']);
  for (const f of (c['followUps'] ?? []) as Row[]) add(`followup:${f['ruleId']}`, rules.get(f['ruleId'])?.['block_id']);
  return [...out].slice(0, PER_RUN).map(([itemRef, templateText]) => ({ itemRef, templateText }));
}

const statusOf = (passed: number, total: number, all: boolean): string => (passed === 0 && total > 0 ? 'validator_failed' : all ? 'succeeded' : 'partially_passed');

export const llmRephrase: TaskHandler = async (payload, jobCtx) => {
  const ctx = jobCtx as unknown as Row;
  const tenantId: string | undefined = ctx['tenantId'];
  const summaryId = payload?.['summary_id'];
  if (!tenantId || payload?.tenant_id !== tenantId || typeof summaryId !== 'string' || !UUID.test(summaryId)) {
    ctx['log']?.warn?.({ event: 'llm_rephrase_skipped', reason: 'bad_payload' });
    return;
  }
  const rc: RepoCtx = { tx: ctx['tx'], tenantId, actorId: ctx['actor'].id };
  const flags = (await portOf(ctx, 'Identity').getTenantSettings(ctx, { keys: ['featureFlags'] }))?.featureFlags;
  if (flags?.smart_report !== true || flags?.smart_report_llm !== true) return;    // only boolean true enables (AC-20.1)
  const s: Row | null = await summariesRepo.getSummary(rc, summaryId);
  if (!s || s['tenant_id'] !== tenantId || s['status'] !== 'draft') return;

  const cfg = loadSmartreportConfig(process.env);                                  // per run: the allowlist and adapter are never cached
  if (cfg.llmAdapter === 'disabled') {
    ctx['metrics']?.inc?.('lims_smartreport_llm_calls_while_disabled_total');
    ctx['log']?.warn?.({ event: 'llm_rephrase_skipped', reason: 'adapter_disabled' });
    return;
  }
  const rephraser = resolveRephraser(cfg, ctx);                                    // throws (alert) for a host off the allowlist: no client is built
  const items = await candidates(rc, s);
  if (items.length === 0) return;
  const language: 'en' | 'ne' = s['language'] === 'ne' ? 'ne' : 'en';
  const input: LlmRephraseInput = { language, promptTemplateVersion: 'p1', items };
  const inputSha = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const model = cfg.llmModelRef ?? cfg.llmAdapter;
  const base = { id: uuidv7(), centre_id: s['centre_id'], summary_id: s['id'], prompt_template_version: 'p1', input_sha256: inputSha };
  if (llmCircuit.isOpen(ctx)) {                                                    // 02-TRD §9.1: final failure -> run row `failed`, also while the breaker is open
    if (ctx['attempt'] < ctx['maxAttempts']) throw new Error('smartreport.llm_rephrase: circuit open');
    await llmRunsRepo.insertLlmRun(rc, { ...base, status: 'failed', model_ref: clip(model, 100), items: [], latency_ms: 0, error_code: 'llm_call_failed' });
    ctx['metrics']?.inc?.('lims_smartreport_llm_runs_total', { outcome: 'failed' });
    return;
  }
  const started = Date.now();
  const latency = (): number => Math.max(0, Math.round(Date.now() - started));

  const got: LlmRephraseOutput['items'][number][] = [];
  let modelRef: string | undefined;
  try {
    for (let i = 0; i < items.length; i += PER_CALL) {
      const r = await rephraser.rephrase({ ...input, items: items.slice(i, i + PER_CALL) }, { timeoutMs: cfg.llmTimeoutMs, signal: AbortSignal.timeout(cfg.llmTimeoutMs) });
      got.push(...r.items); modelRef ??= r.modelRef;
    }
  } catch (e) {
    llmCircuit.recordFailure(ctx);
    const code = e instanceof LimsError ? e.code : 'llm_call_failed';              // codes only: the upstream message is never stored or logged
    ctx['log']?.warn?.({ event: 'llm_rephrase_call_failed', error_code: code, attempt: ctx['attempt'] });
    if (ctx['attempt'] < ctx['maxAttempts']) throw new Error('smartreport.llm_rephrase: model call failed');
    await llmRunsRepo.insertLlmRun(rc, { ...base, status: 'failed', model_ref: model, items: [], latency_ms: latency(), error_code: code });
    ctx['metrics']?.inc?.('lims_smartreport_llm_runs_total', { outcome: 'failed' });
    return;
  }
  llmCircuit.recordSuccess(ctx);

  const denyTerms = [...(await denyTermsRepo.listDenyTerms(rc)), ...(await denyTermsRepo.listGlobalDenyTerms(rc))].map((t: Row) => ({ term: t['term'] as string }));
  const report = validateLlmOutput(input, got, { denyTerms });
  const raw = new Map<string, string>();
  for (const o of got) if (!raw.has(o.itemRef)) raw.set(o.itemRef, o.text);
  const runItems: Row[] = report.items.map((r, i) => {
    const out = raw.get(r.itemRef);
    return { item_ref: r.itemRef, template_text: (items[i] as LlmRephraseItem).templateText, ...(out !== undefined ? { output_text: clip(out, 2000) } : {}), passed: r.passed, failure_codes: r.failureCodes };
  });
  for (const ref of report.extraItemRefs.slice(0, Math.max(0, PER_RUN - runItems.length))) {   // recorded for the audit, never in the overlay
    runItems.push({ item_ref: clip(ref, 100), template_text: '', output_text: clip(raw.get(ref) ?? '', 2000), passed: false, failure_codes: ['item_mismatch'] });
  }
  const passed = report.items.filter((r) => r.passed);
  const status = statusOf(passed.length, report.items.length, report.allPassed);
  await llmRunsRepo.insertLlmRun(rc, { ...base, status, model_ref: clip(cfg.llmModelRef ?? modelRef ?? model, 100), items: runItems, latency_ms: latency() });
  ctx['metrics']?.inc?.('lims_smartreport_llm_runs_total', { outcome: status });
  for (const r of report.items) ctx['metrics']?.inc?.('lims_smartreport_llm_items_total', { outcome: r.passed ? 'passed' : 'failed', failure_code: r.failureCodes[0] ?? 'none' });   // ponytail: first failure code only
  ctx['log']?.info?.({ event: 'llm_rephrase_done', status, items: report.items.length, passed: passed.length });

  // E17: overlay only while it is still THIS draft. One writer per order: re-read under the same lock approval / supersede take.
  if (passed.length === 0) return;
  await rc.tx.query(`SELECT pg_advisory_xact_lock(hashtextextended('smartreport:' || $1::text || ':' || $2::text, 0))`, [tenantId, s['order_id']]);
  const now: Row | null = await summariesRepo.getSummary(rc, summaryId);
  if (!now || now['status'] !== 'draft' || now['version'] !== s['version']) return;
  await summariesRepo.updateSummary(rc, summaryId, s['version'], { llm_overlay: { run_id: base.id, items: Object.fromEntries(passed.map((r) => [r.itemRef, r.finalText])) } });
};
