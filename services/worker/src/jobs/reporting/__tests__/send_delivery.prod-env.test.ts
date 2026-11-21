// SEC-ENV-1 (LD-236; audit 10.2): site 4, worker reporting.send_delivery. The provider choice must follow the SAME helper as the API: production when
// LIMS_CORE_ENV or NODE_ENV is production. In production only a real, allowed provider is used and the `recording` provider is unreachable; outside production
// EVERY delivery goes through `recording` and a real provider is never called (staging: LIMS_CORE_ENV=staging, NODE_ENV unset, unchanged).
// Table over LIMS_CORE_ENV x NODE_ENV; the expectation is written independently of the implementation, so API helper and worker must agree on every cell.
// Fails now: the task reads NODE_ENV only, so LIMS_CORE_ENV=production without NODE_ENV still sends through `recording`.
import '../../../../../api/src/__tests__/setup-env.js';
import { describe, expect, it } from 'vitest';
import { isProductionEnv } from '../../../../../api/src/core/config.js';
import { D, dRow, deliveryWorld, makeTransport } from './delivery.helpers.js';

const CORE = [undefined, 'dev', 'ci', 'staging', 'production'] as const;
const NODE = [undefined, 'test', 'development', 'production'] as const;
const prodMode = (core: string | undefined, node: string | undefined): boolean => core === 'production' || node === 'production';

type Opts = { account?: string | null; allow?: string | undefined; recording?: ReturnType<typeof makeTransport>; real?: ReturnType<typeof makeTransport> };
async function run(core: string | undefined, node: string | undefined, o: Opts = {}) {
  const account = o.account === undefined ? 'whatsapp_cloud_api' : o.account;
  const w = deliveryWorld({ deliveries: [dRow(1)], accounts: { whatsapp: account } });
  const m: any = await import('../tasks/send_delivery.js');
  const real = o.real ?? makeTransport('whatsapp_cloud_api'); const recording = o.recording ?? makeTransport('recording');
  const task = m.createSendDelivery({
    env: { LIMS_CORE_ENV: core, NODE_ENV: node, LIMS_REPORTING_ALLOW_REAL_PROVIDERS: o.allow, LIMS_ORIGIN_PORTAL: w.env['LIMS_ORIGIN_PORTAL'] },
    transports: { whatsapp_cloud_api: real, recording },
  });
  const r = await w.run(task, { delivery_id: D(1) });
  return { w, r, real, recording, row: w.delivery(D(1)) };
}

describe('send_delivery provider choice: LIMS_CORE_ENV x NODE_ENV', () => {
  for (const core of CORE) for (const node of NODE) {
    it(`LIMS_CORE_ENV=${core} NODE_ENV=${node}, real provider allowed -> ${prodMode(core, node) ? 'real provider only' : 'recording only'}`, async () => {
      const { r, real, recording, row } = await run(core, node, { allow: 'true' });
      expect(r).toBe('ok');
      if (prodMode(core, node)) {
        expect(real.calls).toBe(1); expect(recording.calls).toBe(0);
        expect(row).toMatchObject({ status: 'sent', provider_kind: 'whatsapp_cloud_api' });
      } else {
        expect(real.calls).toBe(0); expect(recording.calls).toBe(1);
        expect(row).toMatchObject({ status: 'sent', provider_kind: 'recording' });
      }
    });
  }
  it('the worker table agrees with the API helper on every cell', () => {
    for (const core of CORE) for (const node of NODE) expect(isProductionEnv({ LIMS_CORE_ENV: core, NODE_ENV: node }), `${core}/${node}`).toBe(prodMode(core, node));
  });
});

describe('production (by either variable): the recording provider is unreachable', () => {
  const PROD: Array<[string | undefined, string | undefined]> = [['production', undefined], [undefined, 'production'], ['staging', 'production'], ['production', 'production']];
  for (const [core, node] of PROD) {
    it(`LIMS_CORE_ENV=${core} NODE_ENV=${node}: a \`recording\` account sends nothing and is not a provider`, async () => {
      const { recording, row, w } = await run(core, node, { account: 'recording', allow: 'true' });
      expect(recording.calls).toBe(0); expect(row['status']).not.toBe('sent'); expect(w.attempts(D(1)).some((a) => a['outcome'] === 'accepted')).toBe(false);
    });
    it(`LIMS_CORE_ENV=${core} NODE_ENV=${node}: real provider without LIMS_REPORTING_ALLOW_REAL_PROVIDERS=true -> provider_not_permitted, nothing sent`, async () => {
      for (const allow of [undefined, 'false', 'TRUE', '1']) {
        const { real, recording, row } = await run(core, node, { allow });
        expect(real.calls, `allow=${allow}`).toBe(0); expect(recording.calls, `allow=${allow}`).toBe(0);
        expect(row, `allow=${allow}`).toMatchObject({ status: 'failed', failure_code: 'provider_not_permitted' });
      }
    });
    it(`LIMS_CORE_ENV=${core} NODE_ENV=${node}: no channel account -> channel_not_configured, never falls back to recording`, async () => {
      const { recording, real, row } = await run(core, node, { account: null, allow: 'true' });
      expect(recording.calls).toBe(0); expect(real.calls).toBe(0);
      expect(row).toMatchObject({ status: 'failed', failure_code: 'channel_not_configured' });
    });
  }
});

describe('non-production (staging, NODE_ENV unset) is unchanged', () => {
  it('LIMS_CORE_ENV=staging, NODE_ENV unset: recording provider even when a real account and the allow flag are present; the real transport is never called', async () => {
    const { real, recording, row } = await run('staging', undefined, { allow: 'true' });
    expect(real.calls).toBe(0); expect(recording.calls).toBe(1); expect(row).toMatchObject({ status: 'sent', provider_kind: 'recording' });
  });
  it('LIMS_CORE_ENV=staging, NODE_ENV unset, no channel account: still recorded (no channel_not_configured)', async () => {
    const { recording, row } = await run('staging', undefined, { account: null });
    expect(recording.calls).toBe(1); expect(row['status']).toBe('sent');
  });
});
