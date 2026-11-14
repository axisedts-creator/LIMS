// FD-T11 static checks (no DB): manifest wiring (02-TRD §6.3 PORT_OWNERS), the six port methods, module-boundary and audit invariants (02-CV §5.13 CI grep, 03-IC §4.3 invariant, REQ-SEC-096/097).
// Fails now: ports/FrontdeskPort.impl.ts and service/booking.service.ts do not exist and the manifest has no `ports`.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { manifest } from '../../index.js';

const MOD = fileURLToPath(new URL('../../', import.meta.url));
const IMPL = join(MOD, 'ports', 'FrontdeskPort.impl.ts');
const BOOKING = join(MOD, 'service', 'booking.service.ts');
const text = (f: string) => readFileSync(f, 'utf8');
const sources = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
  const f = join(dir, n);
  return statSync(f).isDirectory() ? (n === '__tests__' ? [] : sources(f)) : /\.ts$/.test(n) && !/\.test\.ts$/.test(n) ? [f] : [];
});

describe('FD-T11 static', () => {
  it('the impl files exist and the manifest exposes ports.FrontdeskPort with exactly the six IC §4.3 / 08 methods', () => {
    expect(existsSync(IMPL), 'ports/FrontdeskPort.impl.ts').toBe(true);
    expect(existsSync(BOOKING), 'service/booking.service.ts').toBe(true);
    const p = (manifest.ports as Record<string, Record<string, unknown>> | undefined)?.['FrontdeskPort'];
    expect(p, 'manifest.ports.FrontdeskPort').toBeDefined();
    expect(Object.keys(p!).sort()).toEqual(['createOrderFromBooking', 'createSelfRegisteredPatient', 'getOrderSummary', 'getPatientDemographics', 'getPatientDemographicsBatch']
      .sort());
    for (const m of Object.keys(p!)) expect(typeof p![m], m).toBe('function');
    expect(Object.keys(manifest.ports ?? {})).toEqual(['FrontdeskPort']);
  });

  it('frontdesk never reads or writes billing.* tables (02-CV §5.13); billing goes through ctx.ports only', () => {
    for (const f of sources(MOD)) expect(text(f), f).not.toMatch(/\b(FROM|JOIN|INTO|UPDATE)\s+billing\./i);
  });

  it('the port and booking service write no access_log, open no transaction of their own, and log nothing with console', () => {
    for (const f of [IMPL, BOOKING].filter(existsSync)) {
      const t = text(f);
      expect(t, f).not.toMatch(/access_log|audit\.access|ctx\.audit/);
      expect(t, f).not.toMatch(/\b(BEGIN|COMMIT|ROLLBACK)\b|\.tx\(/);
      expect(t, f).not.toMatch(/console\./);
    }
  });

  it('the booking service exports the consumer entry points the FD-T12 worker wraps (TRD §3.1 subscription names)', () => {
    expect(existsSync(BOOKING)).toBe(true);
    const t = text(BOOKING);
    expect(t).toMatch(/export (async )?(function|const) onBookingConfirmed\b/);
    expect(t).toMatch(/export (async )?(function|const) onBookingCancelled\b/);
  });
});
