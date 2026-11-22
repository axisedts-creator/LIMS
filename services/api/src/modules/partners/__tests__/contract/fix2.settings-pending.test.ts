// T0D-FIX-2 (LD-446, CR DEPLOY-AXIS-012 item 8) made the UNBUILT getPartnerSettings answer 501 operation_pending in every environment instead of the 500 stub.
// T0D-BUILD-2 (LD-447) BUILDS the operation (done_when 1: a new tenant answers 200 with the defaults), so the 501 pin is superseded and inverted here:
// getPartnerSettings must no longer answer operation_pending in ANY environment, must not be listed in pendingOperations, and the answer for a caller without ports or a tx
// must still not echo request input. (The behaviour of the built operation is pinned in settings/settings.test.ts on a real PG17.)
// If the task ends with the get operation left unbuilt (notes/T0D-BUILD-2-left.md), the lead must restore the FIX-2 pin instead: this file is the only place that changes.
import { afterEach, describe, expect, it, vi } from 'vitest';

const ID = 'getPartnerSettings';
const PLANTED = 'PLANTED-TOKEN-7c1e';
const noop = () => undefined;
const req = { params: { id: PLANTED }, query: { q: PLANTED }, headers: { authorization: PLANTED }, body: { name: PLANTED } };
const ctx = { operationId: ID, requestId: '01900000-0000-7000-8000-000000000001', clientIp: '127.0.0.1', log: { info: noop, warn: noop, error: noop } } as any;

type Outcome = { kind: 'pending' | 'other' | 'unbound'; text: string };

async function outcome(env: string): Promise<Outcome> {
  vi.resetModules();
  vi.stubEnv('LIMS_CORE_ENV', env);
  vi.stubEnv('NODE_ENV', env === 'dev' ? 'development' : 'production');
  const { manifest } = await import('../../index.js');
  const { isLimsError } = await import('../../../../core/errors.js');
  const handler = (manifest.handlers as Record<string, any>)[ID];
  if (((manifest as { pendingOperations?: readonly string[] }).pendingOperations ?? []).includes(ID)) return { kind: 'pending', text: 'pendingOperations' };
  if (typeof handler !== 'function') return { kind: 'unbound', text: 'no handler' };
  try {
    const r = await handler(req, ctx); // no tx / no ports: a built handler fails closed here, it does not answer 501
    const text = JSON.stringify(r);
    return r?.status === 501 && r?.body?.code === 'operation_pending' ? { kind: 'pending', text } : { kind: 'other', text };
  } catch (e) {
    return isLimsError(e, 'operation_pending') ? { kind: 'pending', text: String((e as any)?.detail ?? '') } : { kind: 'other', text: `threw ${(e as any)?.code ?? e} ${(e as any)?.message ?? ''}` };
  }
}

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

describe('T0D-BUILD-2: partners getPartnerSettings is built, no longer operation_pending (supersedes the T0D-FIX-2 pin)', () => {
  it.each(['dev', 'staging', 'production'])('LIMS_CORE_ENV=%s: bound to a real handler, not pending, not the 501 pending problem', async (env) => {
    const o = await outcome(env);
    expect(o.kind, `${env}: ${o.text}`).toBe('other');
  });

  it('the answer of a call without a tx never echoes request input (no PHI / token reflection)', async () => {
    const o = await outcome('production');
    expect(o.text).not.toContain(PLANTED);
  });
});
