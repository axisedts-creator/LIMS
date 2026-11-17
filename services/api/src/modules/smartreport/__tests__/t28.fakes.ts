// C14 T28 (API side) emulators + ctx (not a test file). Loaded by vi.mock factories, so it must NOT import the handlers or llm.service. Synthetic data only.
//
// SEAMS pinned for T28 handlers #33 requestSmartLlmRephrase and #34 listSmartLlmRuns (the spec fixes behaviour 02-TRD §5 #33/#34, 03-APP-FLOW §2.9, not the TypeScript shapes):
//   - handlers run for real through the handlers map over the T15 emulators (t15.fakes.ts header) + the llmRuns.repo emulator below (insertLlmRun / listLlmRuns).
//   - flags: ctx.ports.IdentityPort.getTenantSettings(ctx, { keys: ['featureFlags'] }) -> { featureFlags: { smart_report, smart_report_llm } } (only boolean true enables).
//   - #33 enqueues with ONE `SELECT app.enqueue_job('smartreport.llm_rephrase', <payload json>, 'smartreport:llm:<summary_id>', ...)` through ctx.tx.query (the C0 consumer precedent, T14), payload
//     { tenant_id, summary_id, requested_by_membership_id }, and writes the history row through reviewsRepo.insertSummaryReview(rc, { id, centre_id, summary_id, action: 'llm_rephrase_requested',
//     actor_membership_id }). It never calls a rephraser or any network API itself (02-CV §7.3: only the worker does).
//   - #34 reads llmRunsRepo.listLlmRuns(rc, summaryId) (raw rows: Date created_at, snake_case jsonb items) and maps them to the contract LlmRun (additionalProperties false).
import { vi } from 'vitest';
import { makeCtx as makeT15Ctx, w, type Persona } from './t15.fakes.js';

export * from './t15.fakes.js';
type Row = Record<string, any>;
const clone = <T>(x: T): T => structuredClone(x);

export const runs = { rows: [] as Row[] };
export const llmRunsRepoFake = {
  insertLlmRun: vi.fn(async () => { throw new Error('the request handler must not write llm_runs (only the worker task does)'); }),
  listLlmRuns: vi.fn(async (rc: any, summaryId: string) => {
    w.calls.push({ fn: 'listLlmRuns', tenantId: rc.tenantId, args: [summaryId] });
    return clone(runs.rows.filter((r) => r.tenant_id === rc.tenantId && r.summary_id === summaryId).sort((a, b) => +a.created_at - +b.created_at));
  }),
};

export interface Enq { text: string; values: unknown[] }
export interface T28Ctx { ctx: any; asserted: { permission: string; centreId?: string }[]; access: Row[]; enqueued: Enq[] }
/** T15 handler ctx + the two flags + an enqueue-capturing tx. `flags` overrides featureFlags wholesale. */
export function makeCtx(persona: Persona, operationId: string, tenant: 'A' | 'B' = 'A', o: { flags?: Record<string, unknown> } = {}): T28Ctx {
  const c = makeT15Ctx(persona, operationId, tenant);
  const flags = o.flags ?? { smart_report: true, smart_report_llm: true };
  c.ctx.ports.IdentityPort.getTenantSettings = vi.fn(async (_c: unknown, input?: { keys?: string[] }) => {
    const all: Row = { featureFlags: flags };
    return input?.keys ? Object.fromEntries(input.keys.map((k) => [k, all[k]])) : all;
  });
  const enqueued: Enq[] = [];
  const orig = c.ctx.tx.query;
  c.ctx.tx.query = vi.fn(async (text: string, values: unknown[] = []) => {
    if (/app\.enqueue_job/i.test(String(text))) { enqueued.push({ text: String(text), values: clone(values) }); w.calls.push({ fn: 'enqueue', tenantId: c.ctx.tenantId, args: [] }); return { rows: [{}] }; }
    return orig(text, values);
  });
  return { ...c, enqueued };
}
