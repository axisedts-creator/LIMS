// T0D-FIX-2 (LD-446, CR DEPLOY-AXIS-012 item 8, done_when 3): identity listAccessReviews and recordAccessReview are unbuilt (the /admin/access-review page is a
// static NotAvailable, LD-301). Their stubs threw common.internal "not implemented" (HTTP 500); they must answer 501 operation_pending like billing
// listAccountSummaries. The fix may be a handler that returns/throws the pending problem (handlers/index.ts) or a pendingOperations entry; both are accepted.
// The CR-C2-RM-001 role pack stubs (listRolePacks, applyRolePack) are not part of this task and still fail closed with common.internal.
import { describe, expect, it } from 'vitest';
import { isLimsError } from '../../../core/errors.js';
import { handlers } from '../handlers/index.js';
import { manifest } from '../index.js';

const IDS = ['listAccessReviews', 'recordAccessReview'] as const;
const PLANTED = 'PLANTED-TOKEN-5b2d';
const noop = () => undefined;
const req: any = { params: { id: PLANTED }, query: { q: PLANTED }, headers: { authorization: PLANTED }, body: { note: PLANTED } };
const ctx: any = { requestId: '01900000-0000-7000-8000-000000000002', clientIp: '127.0.0.1', log: { info: noop, warn: noop, error: noop } };

async function run(op: string): Promise<{ pending: boolean; text: string; body?: any }> {
  const h = (handlers as Record<string, any>)[op];
  const listed = (((manifest as { pendingOperations?: readonly string[] }).pendingOperations) ?? []).includes(op);
  if (typeof h !== 'function') return { pending: listed, text: listed ? 'pendingOperations' : 'no handler and not pending' };
  try {
    const r = await h(req, { ...ctx, operationId: op });
    return { pending: r?.status === 501 && r?.body?.code === 'operation_pending', text: JSON.stringify(r), body: r?.body };
  } catch (e: any) {
    return { pending: isLimsError(e, 'operation_pending'), text: `threw ${e?.code ?? e}` };
  }
}

describe('T0D-FIX-2: identity access review stubs answer 501 operation_pending, not 500', () => {
  it.each(IDS)('%s: operation_pending (not common.internal)', async (op) => {
    const o = await run(op);
    expect(o.pending, `${op}: ${o.text}`).toBe(true);
  });

  it.each(IDS)('%s: the pending answer never echoes request input and carries no stack or SQL', async (op) => {
    const o = await run(op);
    expect(o.text).not.toContain(PLANTED);
    if (o.body) {
      expect(JSON.stringify(o.body)).toContain(op);
      expect(JSON.stringify(o.body)).not.toMatch(/\bat\s+\S+\s+\(|select\s.+from/i);
    }
  });

  it('the role pack stubs keep failing closed with common.internal (out of scope here)', async () => {
    for (const op of ['listRolePacks']) {
      const e: any = await (handlers as Record<string, any>)[op](req, ctx).then(() => undefined, (x: unknown) => x);
      expect(e?.code, op).toBe('common.internal');
    }
  });
});
