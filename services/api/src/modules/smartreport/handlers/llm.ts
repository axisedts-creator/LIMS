// #33 requestSmartLlmRephrase, #34 listSmartLlmRuns (02-TRD §5 #33/#34; 03-APP-FLOW §2.9 step 1; PRD AC-20.1, AC-20.2).
// #33 only records the request and enqueues smartreport.llm_rephrase: no network, no llm_runs / summary write here (02-CV §7.3: only the worker rephrases).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError } from '../../../core/errors.js';
import type { Handler } from '../../../core/module.js';
import { checkVersion, isUuid } from '../library.service.js';
import * as llmRunsRepo from '../repository/llmRuns.repo.js';
import type { RepoCtx, Row } from '../repository/common.repo.js';
import * as reviewsRepo from '../repository/reviews.repo.js';
import * as summariesRepo from '../repository/summaries.repo.js';
import { ifMatch, param, parseBody } from './libraryInput.js';
import { authorise, type SrCtx } from './shared.js';

const APPROVE = 'smartreport.summary.approve';
const TASK = 'smartreport.llm_rephrase';
const MAX_ATTEMPTS = 3;                                                            // 02-TRD §9.1 [CONV]
const ENQUEUE = 'SELECT app.enqueue_job($1, $2::jsonb, $3, $4, $5)';              // (identifier, payload, job_key, run_at, max_attempts)

type K = Omit<SrCtx, 'ports' | 'actor'> & {
  readonly actor: { readonly id: string; readonly membershipId?: string };
  readonly ports: SrCtx['ports'] & { readonly IdentityPort: { getTenantSettings(c: never, i: { keys: string[] }): Promise<{ featureFlags?: Record<string, unknown> } | undefined> } };
  now?(): string;
};
const srOf = (k: K): SrCtx => k as unknown as SrCtx;

async function loadSummary(rc: RepoCtx, id: unknown): Promise<Row> {
  const row = isUuid(id) ? await summariesRepo.getSummary(rc, id) : null;
  if (!row || row.tenant_id !== rc.tenantId) throw new LimsError('common.not_found');
  return row;
}

export const requestSmartLlmRephrase: Handler = async (req, ctx) => {
  const k = ctx as unknown as K;
  const rc = await authorise(srOf(k), APPROVE);
  const flags = (await k.ports.IdentityPort.getTenantSettings(k as never, { keys: ['featureFlags'] }))?.featureFlags;
  if (flags?.smart_report !== true || flags?.smart_report_llm !== true) throw new LimsError('smartreport.feature_disabled');   // only boolean true enables (AC-20.1)
  const expected = ifMatch(req.headers)!;
  parseBody(req.body ?? {}, {});                                                    // the contract body is the empty object
  if (!k.actor.membershipId) throw new LimsError('auth.forbidden');
  const row = await loadSummary(rc, param(req, 'summary_id'));
  await authorise(srOf(k), APPROVE, row.centre_id);
  checkVersion(row, expected);
  if (row.status !== 'draft') throw new LimsError('smartreport.summary_invalid_transition');
  const now = typeof k.now === 'function' ? k.now() : new Date().toISOString();
  await reviewsRepo.insertSummaryReview(rc, { id: uuidv7(), centre_id: row.centre_id, summary_id: row.id, action: 'llm_rephrase_requested', actor_membership_id: k.actor.membershipId });
  await rc.tx.query(ENQUEUE, [TASK, JSON.stringify({ tenant_id: rc.tenantId, summary_id: row.id, requested_by_membership_id: k.actor.membershipId }), `smartreport:llm:${row.id}`, now, MAX_ATTEMPTS]);
  return { status: 202, body: { summary_id: row.id, requested_at: now } };
};

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());

/** Raw llm_runs row -> contract LlmRun (allow-list: no tenant / centre / summary ids, hash, actor or error code). */
const runDto = (r: Row): Record<string, unknown> => ({
  id: r.id, status: r.status, prompt_template_version: r.prompt_template_version, model_ref: r.model_ref,
  items: (r.items as Row[]).map((i) => ({
    item_ref: i.item_ref, template_text: i.template_text, ...(typeof i.output_text === 'string' ? { output_text: i.output_text } : {}), passed: i.passed, failure_codes: i.failure_codes,
  })),
  ...(r.latency_ms != null ? { latency_ms: r.latency_ms } : {}), created_at: iso(r.created_at),
});

export const listSmartLlmRuns: Handler = async (req, ctx) => {
  const k = ctx as unknown as K;
  const rc = await authorise(srOf(k), APPROVE);
  const row = await loadSummary(rc, param(req, 'summary_id'));
  await authorise(srOf(k), APPROVE, row.centre_id);
  return { status: 200, body: { data: (await llmRunsRepo.listLlmRuns(rc, row.id)).slice(-200).map(runDto) } };   // contract maxItems 200: the newest 200
};
