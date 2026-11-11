// C7 INT-T03 — cross-tenant / cross-centre / device probe suite (07-SECURITY §6 S-01, S-02, S-05; abuse cases AB1, AB2, AB2a, AB4; REQ-SEC-040/041/044).
// The operation list comes from contracts/openapi/instruments.yaml, NOT from the probe tables: an operation without a probe is a failing test (100 % operation coverage).
// Each operation is probed twice: 'tenant' (object of tenant B, S-01) and 'centre' (object of centre A2, caller holds centre A1 only, S-02). Device operations also get the credential-kind probe (S-05).
// Seams, fidelity and what is NOT covered: harness.ts header. Fails now (right reason) for operations whose handler is still the `common.internal` stub (E05, E22-E32, E40, E41).
import { describe, expect, it, vi } from 'vitest';
import { OPENAPI_OPS, call, fails, isDeviceOp, type Mode } from './harness.js';
import { DEVICE_PROBES, KIND_PROBES, kindFor } from './matrix.device.js';
import { STAFF_PROBES } from './matrix.staff.js';

// The repo factories are replaced before any handler module is imported (handlers build their service at import): each returns a delegate to the repo the running probe installed.
async function install(factory: string, name: string) { const { delegate } = await import('./harness.js'); return { [factory]: () => delegate(name as never) }; }
vi.mock('../../repo/agents.repo.js', async (orig) => ({ ...(await orig<object>()), ...(await install('createAgentsRepo', 'agents')) }));
vi.mock('../../repo/device.repo.js', async (orig) => ({ ...(await orig<object>()), ...(await install('createDeviceRepo', 'device')) }));
vi.mock('../../repo/instruments.repo.js', async (orig) => ({ ...(await orig<object>()), ...(await install('createInstrumentsRepo', 'instruments')) }));
vi.mock('../../repo/ingest.repo.js', async (orig) => ({ ...(await orig<object>()), ...(await install('createIngestRepo', 'ingest')) }));
vi.mock('../../repo/messages.repo.js', async (orig) => ({ ...(await orig<object>()), ...(await install('createMessagesRepo', 'messages')) }));
vi.mock('../../repo/reprocess.repo.js', async (orig) => ({ ...(await orig<object>()), ...(await install('createReprocessRepo', 'reprocess')) }));
vi.mock('../../repo/attachments.repo.js', async (orig) => ({ ...(await orig<object>()), ...(await install('createAttachmentsRepo', 'attachments')) }));

const MODES: Array<[Mode, string]> = [['tenant', 'S-01 cross-tenant'], ['centre', 'S-02 cross-centre']];

describe.each(OPENAPI_OPS.map((o) => [o.id, o] as const))('%s', (id, o) => {
  const probes = isDeviceOp(o) ? DEVICE_PROBES : STAFF_PROBES;
  it('has a probe registered (100 % operation coverage)', () => { expect(probes[id], `no ${isDeviceOp(o) ? 'device' : 'staff'} probe for ${id}`).toBeTypeOf('function'); });
  it.each(MODES)('%s -> %s', async (mode) => { await probes[id]!(mode); });
  if (isDeviceOp(o)) {
    it('S-05 credential kind: the wrong kind of credential -> 401 auth.device_token_invalid before any repo access (AB4)', async () => {
      const k = KIND_PROBES[id]!; expect(k, `no kind probe for ${id}`).toBeDefined();
      for (const kind of [kindFor(id), 'something_else', null]) {
        const { ctx, calls } = k.wrong(kind)();
        const e = await fails(call(id, k.req(), ctx)); expect(e.code, `credential kind ${kind}`).toBe('auth.device_token_invalid'); expect(calls, 'no repo access before the kind gate').toEqual([]);
      }
    });
  }
});
