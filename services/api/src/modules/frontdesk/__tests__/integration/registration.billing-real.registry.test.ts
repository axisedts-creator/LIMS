// J-T01 swap proof (06-IMPLEMENTATION-PLAN row J-T01: "remove BillingCommandPort from LIMS_CORE_FAKE_PORTS in C4 test config"; 02-TRD §6.3 port registry).
// Docker-free. The C4 test config must not force BillingCommandPort to a fake, and with the billing module loaded the registry must resolve the REAL implementation.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PORT_OWNERS } from '../../../../core/module.js';
import { resolvePorts } from '../../../../core/ports/registry.js';
import { manifest as billing } from '../../../billing/index.js';
import { billingCommandPort } from '../../../billing/ports/BillingCommandPort.impl.js';

const here = dirname(fileURLToPath(import.meta.url));
const fdTests = join(here, '..');
const sink = { debug() {}, info() {}, warn() {}, error() {} };
const metrics = { setGauge() {}, inc() {} };
const FAKE = { marker: 'fake' };

describe('J-T01: BillingCommandPort is real, not forced to a fake, in the C4 test config', () => {
  it('billing owns BillingCommandPort and its manifest exports the real implementation', () => {
    expect(PORT_OWNERS['BillingCommandPort']).toBe('billing');
    expect((billing.ports as Record<string, unknown>)['BillingCommandPort']).toBe(billingCommandPort);
  });

  it('LIMS_CORE_FAKE_PORTS (env of this test run) does not name BillingCommandPort', () => {
    const forced = (process.env['LIMS_CORE_FAKE_PORTS'] ?? '').split(',').map((s) => s.trim());
    expect(forced).not.toContain('BillingCommandPort');
  });

  it('frontdesk __tests__/test-env.ts (the per-module test config convention), if present, does not force it either', () => {
    const f = join(fdTests, 'test-env.ts');
    if (!existsSync(f)) return;
    const src = readFileSync(f, 'utf8');
    expect(/LIMS_CORE_FAKE_PORTS[^\n]*BillingCommandPort/.test(src)).toBe(false);
  });

  it('registry in ci with billing loaded and no forced fakes: resolution real, frontdesk gets the real object', () => {
    const r = resolvePorts({ env: 'ci', modules: [{ name: 'billing', ports: { BillingCommandPort: billingCommandPort } }], forceFake: [],
      fakes: { BillingCommandPort: FAKE }, stubs: {}, owners: { BillingCommandPort: 'billing' }, consumers: { BillingCommandPort: ['frontdesk'] }, log: sink, metrics });
    expect(r.resolution['BillingCommandPort']).toBe('real');
    expect((r.portsFor('frontdesk') as Record<string, unknown>)['BillingCommandPort']).toBe(billingCommandPort);
  });

  it('control: forcing the fake still works in ci, so the assertion above is meaningful', () => {
    const r = resolvePorts({ env: 'ci', modules: [{ name: 'billing', ports: { BillingCommandPort: billingCommandPort } }], forceFake: ['BillingCommandPort'],
      fakes: { BillingCommandPort: FAKE }, stubs: {}, owners: { BillingCommandPort: 'billing' }, consumers: { BillingCommandPort: ['frontdesk'] }, log: sink, metrics });
    expect(r.resolution['BillingCommandPort']).toBe('fake');
  });
});
