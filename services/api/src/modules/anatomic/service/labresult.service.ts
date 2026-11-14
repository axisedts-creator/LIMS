// CR-C11-011 — consumer logic of lab.result.approved.v1 / lab.result.amended.v1 -> case_items.lab_approved_version_no (02-TRD §8.2; 03-IC §3.10/§3.11; AC-13.1/13.2/13.4).
// Runs inside the worker consumer wrapper's transaction (inbox row + envelope validation are the wrapper's). Repositories only, no raw SQL. Tenant comes from ctx, never the payload.
// lab_approved_version_no = greatest(current, max(item_version_no) where lab_version_no = k): never lowers, so duplicate / out-of-order deliveries are harmless.
// A result without item_submissions at (result_id, k) is not ours (non-anatomic) -> no-op.
import { getCaseItem, updateCaseItem } from '../repository/cases.repo.js';
import { maxItemVersionForLabResult } from '../repository/submissions.repo.js';

type Obj = Record<string, any>;
interface Ctx { readonly tenantId: string; readonly actor: { readonly id: string }; readonly tx: any }

const MAX_TRIES = 5; // optimistic-lock re-reads before the job fails and retries (the wrapper rolls back)

async function raise(ctx: Ctx, resultId: string, k: number, at: string): Promise<void> {
  const tx = ctx.tx, tenantId = ctx.tenantId;
  const hit = await maxItemVersionForLabResult(tx, { tenantId, labResultId: resultId, labVersionNo: k });
  if (!hit) return;
  const m = Number(hit.max_item_version_no);
  for (let i = 0; i < MAX_TRIES; i++) {
    const item = await getCaseItem(tx, { tenantId, id: hit.case_item_id });
    if (!item || m <= Number(item['lab_approved_version_no'])) return;
    const done = await updateCaseItem(tx, { tenantId, id: hit.case_item_id, expectedVersion: Number(item['version']), actorId: ctx.actor.id, patch: { lab_approved_version_no: m, lab_approved_at: at } });
    if (done) return;
  }
  throw new Error(`case_items ${hit.case_item_id}: optimistic update lost ${MAX_TRIES} times`);
}

export async function onResultApproved(ctx: Ctx, env: Obj): Promise<void> {
  const p = env['payload'];
  await raise(ctx, p.result_id, Number(p.result_version_no), p.approved_at);
}

export async function onResultAmended(ctx: Ctx, env: Obj): Promise<void> {
  const p = env['payload'];
  await raise(ctx, p.result_id, Number(p.new_version_no), p.amended_at);
}
