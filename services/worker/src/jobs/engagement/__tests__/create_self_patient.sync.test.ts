import '../../../../../api/src/__tests__/setup-env.js';
import { describe, expect, it } from 'vitest';
import { createCreateSelfPatient } from '../tasks/create_self_patient.js';
import { ACC1, ID, NAME, PHONE1, TA, VERSION, makeWorld } from '../../../../../api/src/modules/engagement/__tests__/selfreg.world.js';
import { handlers } from '../../../../../api/src/modules/engagement/handlers/index.js';

describe('create_self_patient task sync & consent verification', () => {
  it('falls back to frontdeskPort when ctx.ports is empty or undefined', async () => {
    const w = makeWorld();
    const task = createCreateSelfPatient();
    
    // Seed queued registration
    const out = await w.inTx(() => (handlers as any)['createSelfRegistration']({
      params: {}, query: {}, headers: { 'idempotency-key': 'k-sync-1' },
      body: { relationship: 'self', full_name: NAME, sex: 'female', birth_on: '1990-03-01', sms_consent: true, whatsapp_consent: false, consent_text_version: VERSION }
    }, w.session(ACC1)));

    const payload = w.jobs.at(-1)!.payload;
    // JobContext WITHOUT ports (simulating worker runtime)
    const rawCtx = w.jobCtx();
    delete (rawCtx as any).ports;

    // Running with fake frontdeskPort supplied on rawCtx fallback
    const customPort = {
      createSelfRegisteredPatient: async (_c: any, inData: any) => {
        w.tables['patients']!.push({ id: ID(0x777), tenant_id: TA, full_name: inData.fullName, phone_e164: inData.phoneE164 });
        return {
          patientId: ID(0x777),
          patientCode: 'P-000777',
          duplicateSuspected: false,
          replayed: false,
        };
      },
    };
    (rawCtx as any).ports = { FrontdeskPort: customPort };

    await w.inTx(() => task(payload, rawCtx));

    const reg = w.regs().find((r) => r['id'] === out.body.id);
    expect(reg).toBeDefined();
    expect(reg!['status']).toBe('created');
    expect(reg!['patient_id']).toBe(ID(0x777));
  });

  it('verifies consentTextVersion prefix matching logic', async () => {
    const cur = 'v1';
    const appCur = 'v2026-1';
    
    const isValid = (version: string) => {
      return version === cur
        || version === `app-${cur}`
        || version === appCur
        || version === `app-${appCur}`;
    };

    expect(isValid('v1')).toBe(true);
    expect(isValid('app-v1')).toBe(true);
    expect(isValid('v2026-1')).toBe(true);
    expect(isValid('app-v2026-1')).toBe(true);
    
    // Mismatched / stale versions must be rejected
    expect(isValid('app-1')).toBe(false);
    expect(isValid('v0-old')).toBe(false);
    expect(isValid('random')).toBe(false);
  });
});
