// T0D-07: AC-0D-6.3 (CI fails when a listed port's owner module exists), 08 R9 initial list, 08 A17 P-20.
// Assumed API from ../phase-stubs.js:
//   PHASE_STUBS: readonly PortName[]  (committed allowlist)
//   findStalePhaseStubs({ phaseStubs?, modulesDir?, owners? }) -> Array<{ port, owner }>   (owner has <modulesDir>/<owner>/index.ts)
//   assertPhaseStubsCurrent(same opts) -> void; throws, message names each stale port and says to remove it from phase-stubs.ts
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PHASE_STUBS, assertPhaseStubsCurrent, findStalePhaseStubs } from '../phase-stubs.js';
import { OWNERS, STUB_PORTS } from './helpers.js';

const dirs: string[] = [];
function modulesDir(...owners: string[]) {
  const d = mkdtempSync(join(tmpdir(), 't0d07-mods-'));
  dirs.push(d);
  for (const o of owners) { mkdirSync(join(d, o)); writeFileSync(join(d, o, 'index.ts'), 'export {};\n'); }
  return d;
}
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe('committed list (08 R9)', () => {
  // PG-T01 / 08 A17 P-20: the PR that creates modules/payments removes PaymentProviderPort from phase-stubs.ts (AC-0D-6.3), so the committed
  // list is the 08 R9 initial list minus the ports whose owner module has shipped (payments, smartreport: C14-T01 / 06-PLAN T01; quality: C9-T-01, 08 A17 P-20).
  // C16-T01 (06-PLAN T-01) likewise removes EngagementPort.
  it('is exactly the 08 R9 initial list minus shipped owners: PaymentProviderPort, SmartReportPort, QualityPort, EngagementPort', () => {
    expect([...PHASE_STUBS].sort()).toEqual(STUB_PORTS.filter((p) => p !== 'PaymentProviderPort' && p !== 'SmartReportPort' && p !== 'QualityPort' && p !== 'EngagementPort').sort());
  });
  it('never lists RenderPort, BillingCommandPort or a Legacy*ImportPort', () => {
    for (const p of PHASE_STUBS) expect(p).not.toMatch(/^(RenderPort|BillingCommandPort|Legacy)/);
  });
  it('has no duplicates', () => {
    expect(new Set(PHASE_STUBS).size).toBe(PHASE_STUBS.length);
  });
});

describe('staleness check (AC-0D-6.3)', () => {
  it('no owner module present -> nothing stale, assert passes', () => {
    const d = modulesDir('catalog', 'identity');
    expect(findStalePhaseStubs({ phaseStubs: STUB_PORTS, modulesDir: d, owners: OWNERS })).toEqual([]);
    expect(() => assertPhaseStubsCurrent({ phaseStubs: STUB_PORTS, modulesDir: d, owners: OWNERS })).not.toThrow();
  });

  it('modules dir that does not exist yet -> nothing stale', () => {
    const d = join(tmpdir(), 't0d07-missing-' + Date.now());
    expect(findStalePhaseStubs({ phaseStubs: STUB_PORTS, modulesDir: d, owners: OWNERS })).toEqual([]);
  });

  it.each([
    ['QualityPort', 'quality'], ['SmartReportPort', 'smartreport'], ['PaymentProviderPort', 'payments'], ['EngagementPort', 'engagement'],
  ])('%s listed and <modules>/%s/index.ts exists -> stale; assert throws and says to remove it', (port, owner) => {
    const d = modulesDir(owner, 'catalog');
    expect(findStalePhaseStubs({ phaseStubs: STUB_PORTS, modulesDir: d, owners: OWNERS })).toEqual([{ port, owner }]);
    let err: any;
    try { assertPhaseStubsCurrent({ phaseStubs: STUB_PORTS, modulesDir: d, owners: OWNERS }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain(port);
    expect(err.message).toMatch(/remove/i);
    expect(err.message).toContain('phase-stubs.ts');
  });

  it('reports every stale port at once', () => {
    const d = modulesDir('quality', 'engagement');
    const stale = findStalePhaseStubs({ phaseStubs: STUB_PORTS, modulesDir: d, owners: OWNERS }).map((s) => s.port).sort();
    expect(stale).toEqual(['EngagementPort', 'QualityPort']);
  });

  it('owner module present but the port was already removed from the list -> passes (the paired PR did its job)', () => {
    const d = modulesDir('quality');
    const list = STUB_PORTS.filter((p) => p !== 'QualityPort');
    expect(() => assertPhaseStubsCurrent({ phaseStubs: list, modulesDir: d, owners: OWNERS })).not.toThrow();
  });

  it('owner directory without index.ts is not a module (matches autoloader glob) -> not stale', () => {
    const d = modulesDir();
    mkdirSync(join(d, 'quality'));
    expect(findStalePhaseStubs({ phaseStubs: STUB_PORTS, modulesDir: d, owners: OWNERS })).toEqual([]);
  });

  it('a port the owners map does not know fails loudly instead of being skipped', () => {
    expect(() => findStalePhaseStubs({ phaseStubs: ['NopePort'] as never, modulesDir: modulesDir(), owners: OWNERS })).toThrow(/NopePort/);
  });

  it('defaults: the committed list vs the real services/api/src/modules is current (this is the CI gate)', () => {
    expect(() => assertPhaseStubsCurrent()).not.toThrow();
  });
});
