// FD-T06 static/contract checks (no database). Files per 06-IMPLEMENTATION-PLAN row FD-T06; contract per contracts/openapi/frontdesk.yaml F9.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, loadSpec } from '../../../../core/module.js';

const F = 'services/api/src/modules/frontdesk';
const text = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8');
const spec: any = loadSpec(join(REPO_ROOT, 'contracts/openapi/frontdesk.yaml'));
const op = (): any => { for (const p of Object.values<any>(spec.paths)) for (const m of Object.values<any>(p)) if (m?.operationId === 'createRegistration') return m; };

describe('FD-T06 files and wiring', () => {
  it('the files of the plan row exist', () => {
    expect(existsSync(join(REPO_ROOT, F, 'service/registration.service.ts'))).toBe(true);
    expect(existsSync(join(REPO_ROOT, F, 'events/publish.ts'))).toBe(true);
    expect(existsSync(join(REPO_ROOT, F, 'handlers/createRegistration.ts'))).toBe(true);
  });
  it('registration.service.ts exports create() and keeps quote()', async () => {
    const m = await import('../../service/registration.service.js');
    expect(m.create).toBeTypeOf('function');
    expect(m.quote).toBeTypeOf('function');
  }, 60_000);
  it('events/publish.ts exports createFrontdeskEvents', async () => {
    expect(((await import('../../events/publish.js')) as any).createFrontdeskEvents).toBeTypeOf('function');
  });
  it('handlers/createRegistration.ts exports `handler`; index.ts wires it as the real createRegistration (not the 503 stub)', async () => {
    const m = await import('../../handlers/createRegistration.js');
    expect(m.handler).toBeTypeOf('function');
    const idx = await import('../../handlers/index.js');
    expect((idx.handlers as any).createRegistration).toBe(m.handler);
  }, 60_000);
  it('the handler is thin: delegates to the service, no repositories/ports imported', () => {
    const src = text(`${F}/handlers/createRegistration.ts`);
    expect(src).toMatch(/registration\.service/);
    expect(src).not.toMatch(/repository\//);
  });
});

describe('FD-T06 service structure (02-TRD §6.10, 03-APP-FLOW §2.3)', () => {
  const svc = () => text(`${F}/service/registration.service.ts`);
  it('publishes through the typed publisher only: no direct ctx.events.publish / core.event_log SQL in the service', () => {
    expect(svc()).toMatch(/orderCreated/);
    expect(svc()).not.toMatch(/\.publish\(/);
    expect(svc()).not.toMatch(/core\.event_log/);
  });
  it('opens no transaction of its own (BEGIN/COMMIT/ROLLBACK/SAVEPOINT): the request tx is the one atomic unit', () => {
    expect(svc()).not.toMatch(/\b(BEGIN|COMMIT|ROLLBACK|SAVEPOINT)\b/);
  });
  it('billing only through BillingCommandPort (no SQL on billing.*), SMS only through NotificationPort', () => {
    expect(svc()).not.toMatch(/\bbilling\.(invoices|ledger|credit_accounts|credit_charges|number_counters)\b/);
    expect(svc()).toMatch(/issueOrderInvoice/);
    expect(svc()).toMatch(/sendSms/);
  });
  it('never logs request bodies or patient fields', () => {
    expect(svc()).not.toMatch(/log\.(info|warn|error)\([^)]*(body|full_name|phone|patient\b)/);
  });
  it('no process.env / no clock other than ctx.now() in create (testable time)', () => {
    expect(svc()).not.toMatch(/process\.env/);
  });
});

describe('FD-T06 contract (F9)', () => {
  it('POST /v1/frontdesk/registrations, idempotency required, permission frontdesk.registration.create, 201 RegistrationResult', () => {
    const o = op();
    expect(o['x-permission']).toBe('frontdesk.registration.create');
    expect(o['x-idempotency']).toBe('required');
    expect(Object.keys(o.responses)).toContain('201');
    expect(o['x-error-codes']).toEqual(expect.arrayContaining(['common.version_conflict', 'billing.payment_exceeds_due', 'billing.counter_busy', 'frontdesk.discount_approval_required']));
  });
});
