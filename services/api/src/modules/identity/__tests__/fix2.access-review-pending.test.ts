// T0D-FIX-2 (LD-446, CR DEPLOY-AXIS-012 item 8): identity listAccessReviews and recordAccessReview used to be unbuilt stubs answering 501 operation_pending.
// T0D-BUILD-3 (LD-447) BUILT both on the existing identity.access_reviews table; their behaviour is pinned in build3.access-review.test.ts, so the
// "answers 501" cases for them were retired here (the operations are no longer pending). Only the role pack stub check of this file remains.
// The CR-C2-RM-001 role pack stubs (listRolePacks, applyRolePack) are not part of this task and still fail closed with common.internal.
import { describe, expect, it } from 'vitest';
import { handlers } from '../handlers/index.js';
import { manifest } from '../index.js';

const noop = () => undefined;
const req: any = { params: { id: 'PLANTED-TOKEN-5b2d' }, query: {}, headers: {}, body: {} };
const ctx: any = { requestId: '01900000-0000-7000-8000-000000000002', clientIp: '127.0.0.1', log: { info: noop, warn: noop, error: noop } };

describe('T0D-FIX-2 (after T0D-BUILD-3): role pack stubs stay fail closed; the built access review operations are not pending', () => {
  it('the role pack stubs keep failing closed with common.internal (out of scope here)', async () => {
    for (const op of ['listRolePacks']) {
      const e: any = await (handlers as Record<string, any>)[op](req, ctx).then(() => undefined, (x: unknown) => x);
      expect(e?.code, op).toBe('common.internal');
    }
  });
  it.each(['listAccessReviews', 'recordAccessReview'])('%s is not listed as pending any more', (op) => {
    expect(((manifest as { pendingOperations?: readonly string[] }).pendingOperations) ?? []).not.toContain(op);
  });
});
