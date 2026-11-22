// T0D-FIX-2 (LD-446, CR DEPLOY-AXIS-012 item 8, done_when 3): partners getPartnerSettings is an unbuilt operation. It answered 500 common.internal
// ("partners getPartnerSettings not implemented") outside dev; it must answer 501 operation_pending like billing listAccountSummaries, in EVERY environment
// (a deployed API runs with LIMS_CORE_ENV=production|staging, where the T01 scaffold stub rejects with common.internal), and without echoing request input.
// The fix may be a pendingOperations entry (core mounts the 501) or a handler that returns/throws the pending problem; the test accepts both, nothing else.
// The 500 for the other T01 scaffold stubs is not part of this task (boot.test.ts keeps pinning it).
import { afterEach, describe, expect, it, vi } from 'vitest';

const ID = 'getPartnerSettings';
const PLANTED = 'PLANTED-TOKEN-7c1e';
const noop = () => undefined;
const req = { params: { id: PLANTED }, query: { q: PLANTED }, headers: { authorization: PLANTED }, body: { name: PLANTED } };
const ctx = { operationId: ID, requestId: '01900000-0000-7000-8000-000000000001', clientIp: '127.0.0.1', log: { info: noop, warn: noop, error: noop } } as any;

type Outcome = { kind: 'pending'; body?: any; text: string } | { kind: 'other'; text: string };

async function outcome(env: string): Promise<Outcome> {
  vi.resetModules();
  vi.stubEnv('LIMS_CORE_ENV', env);
  vi.stubEnv('NODE_ENV', env === 'dev' ? 'development' : 'production');
  const { manifest } = await import('../../index.js');
  const { isLimsError } = await import('../../../../core/errors.js');
  const handler = (manifest.handlers as Record<string, any>)[ID];
  const pending = ((manifest as { pendingOperations?: readonly string[] }).pendingOperations ?? []).includes(ID);
  if (typeof handler !== 'function') {
    // no handler: core/openapi.ts mounts the 501 operation_pending stub for a pending id (pinned in core/__tests__/pending-operations.test.ts)
    return pending ? { kind: 'pending', text: 'pendingOperations' } : { kind: 'other', text: 'no handler and not pending' };
  }
  try {
    const r = await handler(req, ctx);
    const text = JSON.stringify(r);
    return r?.status === 501 && r?.body?.code === 'operation_pending' ? { kind: 'pending', body: r.body, text } : { kind: 'other', text };
  } catch (e) {
    return isLimsError(e, 'operation_pending') ? { kind: 'pending', text: String((e as any)?.detail ?? '') } : { kind: 'other', text: `threw ${(e as any)?.code ?? e}` };
  }
}

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

describe('T0D-FIX-2: partners getPartnerSettings answers 501 operation_pending, not 500', () => {
  it.each(['dev', 'staging', 'production'])('LIMS_CORE_ENV=%s: operation_pending (not the bare dev 501, not common.internal)', async (env) => {
    const o = await outcome(env);
    expect(o.kind, `${env}: ${o.text}`).toBe('pending');
  });

  it('the pending answer never echoes request input (no PHI / token reflection)', async () => {
    const o = await outcome('production');
    expect(o.text).not.toContain(PLANTED);
  });

  it('a handler-level answer is a problem body that names the operation and carries no stack or SQL', async () => {
    const o = await outcome('production');
    if (o.kind === 'pending' && o.body) {
      expect(o.body.status).toBe(501);
      expect(JSON.stringify(o.body)).toContain(ID);
      expect(JSON.stringify(o.body)).not.toMatch(/\bat\s+\S+\s+\(|select\s.+from/i);
    }
  });
});
