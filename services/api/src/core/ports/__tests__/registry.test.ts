// T0D-07 boot matrix: AC-0D-6.1, 6.2, 6.4; AB-15 (07-SECURITY); 03-APP-FLOW §3.4; 02-TRD §6.3 (PORT_CONSUMERS, 08 A19 P-46).
// Assumed API (impl must match or dispute): resolvePorts(opts) from ../registry.js
//   opts: { env, modules:[{name,ports?}], forceFake?:string[] (= LIMS_CORE_FAKE_PORTS), fakes, stubs, phaseStubs?, owners?, consumers?, log, metrics }
//   -> { resolution: Record<PortName,'real'|'fake'|'stub'>, portsFor(moduleName): PortRegistry }
//   Boot failure = synchronous throw whose message lists every offending port. Same function serves API and worker boot.
import { describe, expect, it } from 'vitest';
import { resolvePorts } from '../registry.js';
import {
  ALL_MODULES, CONSUMERS, ENVS, LENIENT, OWNERS, PORT_NAMES, STRICT, STUB_PORTS, allModules, fakes, makeLog, makeMetrics, mod, real, stubs,
  type PortName,
} from './helpers.js';

function thrown(fn: () => unknown): any {
  try { fn(); } catch (e) { return e; }
  return undefined;
}

function boot(over: Record<string, unknown> = {}) {
  const l = makeLog();
  const m = makeMetrics();
  const opts = {
    env: 'dev', modules: allModules(), forceFake: [] as string[], fakes, stubs, phaseStubs: STUB_PORTS, owners: OWNERS, consumers: CONSUMERS,
    log: l.log, metrics: m.metrics, ...over,
  };
  return { l, m, run: () => resolvePorts(opts as never) };
}
const FAKE_G = 'lims_core_fake_ports_active';
const STUB_G = 'lims_core_phase_stub_ports_active';

describe('resolution (AC-0D-6.1, 03-APP-FLOW §3.4)', () => {
  it.each(ENVS)('%s: every owner loaded -> all real, no fakes, gauges 0', (env) => {
    const { run, m, l } = boot({ env });
    const r = run();
    for (const p of PORT_NAMES) expect(r.resolution[p]).toBe('real');
    expect(m.gauge(FAKE_G)).toBe(0);
    expect(m.gauge(STUB_G) ?? 0).toBe(0);
    expect(l.events('fake_port_active')).toHaveLength(0);
  });

  it.each(LENIENT)('%s: no module provides CatalogPort -> ctx.ports.CatalogPort is the fake, gauge = 1, warn fake_port_active', (env) => {
    const { run, m, l } = boot({ env, modules: allModules(['CatalogPort']) });
    const r = run();
    expect(r.resolution.CatalogPort).toBe('fake');
    expect(r.portsFor('frontdesk').CatalogPort).toBe(fakes.CatalogPort);
    expect(m.gauge(FAKE_G)).toBe(1);
    const ev = l.events('fake_port_active');
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ level: 'warn', port: 'CatalogPort' });
  });

  it('dev: loaded owner returns its own impl, not the fake', () => {
    const r = boot().run();
    expect(r.portsFor('frontdesk').CatalogPort).toMatchObject({ kind: 'real', port: 'CatalogPort' });
  });

  it.each(LENIENT)('%s: LIMS_CORE_FAKE_PORTS forces a fake even when the owner is loaded', (env) => {
    const { run, m } = boot({ env, forceFake: ['CatalogPort'] });
    const r = run();
    expect(r.resolution.CatalogPort).toBe('fake');
    expect(r.portsFor('lab').CatalogPort).toBe(fakes.CatalogPort);
    expect(r.resolution.LabPort).toBe('real');
    expect(m.gauge(FAKE_G)).toBe(1);
  });

  it.each(LENIENT)('%s: stub-listed port without owner resolves to the rich fake, not the stub (stubs are staging/production only)', (env) => {
    const r = boot({ env, modules: allModules(STUB_PORTS) }).run();
    for (const p of STUB_PORTS) expect(r.resolution[p]).toBe('fake');
  });

  it('forced-fake name that is not a port fails boot instead of being ignored', () => {
    expect(boot({ forceFake: ['CatalogPorts'] }).run).toThrow(/CatalogPorts/);
  });
});

describe('production guard (AC-0D-6.2, AB-15)', () => {
  it.each(STRICT)('%s: owner module absent, no stub entry -> boot fails and lists the port', (env) => {
    expect(boot({ env, modules: allModules(['CatalogPort']) }).run).toThrow(/CatalogPort/);
  });

  it.each(STRICT)('%s: boot error lists every offending port', (env) => {
    const msg = thrown(boot({ env, modules: allModules(['CatalogPort', 'LabPort', 'RenderPort']) }).run)?.message ?? '';
    for (const p of ['CatalogPort', 'LabPort', 'RenderPort']) expect(msg).toContain(p);
    expect(msg).not.toContain('FrontdeskPort');
  });

  it.each(STRICT)('%s: LIMS_CORE_FAKE_PORTS naming a loaded port fails boot (forced fake is dev/ci only)', (env) => {
    expect(boot({ env, forceFake: ['LabPort'] }).run).toThrow(/LabPort/);
  });

  it.each(STRICT)('%s: forcing a stub-listed port to fake does not turn it into an allowed stub', (env) => {
    expect(boot({ env, modules: allModules(STUB_PORTS), forceFake: ['QualityPort'] }).run).toThrow(/QualityPort/);
  });

  it.each(STRICT)('%s: listed phase-stub ports with no owner resolve to their stub; boot ok; stub gauge = 4, fake gauge = 0', (env) => {
    const { run, m, l } = boot({ env, modules: allModules(STUB_PORTS) });
    const r = run();
    for (const p of STUB_PORTS) {
      expect(r.resolution[p]).toBe('stub');
      expect(r.portsFor(CONSUMERS[p][0])[p as PortName]).toBe(stubs[p]);
    }
    expect(m.gauge(STUB_G)).toBe(4);
    expect(m.gauge(FAKE_G)).toBe(0);
    expect(l.events('fake_port_active')).toHaveLength(0);
  });

  it.each(STRICT)('%s: a stub exists for the port but it is NOT in phase-stubs -> boot fails (the list, not the stub file, is the allowlist)', (env) => {
    const phaseStubs = STUB_PORTS.filter((p) => p !== 'SmartReportPort');
    expect(boot({ env, modules: allModules(STUB_PORTS), phaseStubs }).run).toThrow(/SmartReportPort/);
  });

  it.each(STRICT)('%s: listed in phase-stubs but no stub supplied -> boot fails', (env) => {
    const { QualityPort: _q, ...noQuality } = stubs;
    expect(boot({ env, modules: allModules(STUB_PORTS), stubs: noQuality }).run).toThrow(/QualityPort/);
  });

  it.each(STRICT)('%s: stub-listed port whose owner is now loaded resolves real (real beats stub)', (env) => {
    const r = boot({ env, modules: [...allModules(STUB_PORTS), mod('quality')] }).run();
    expect(r.resolution.QualityPort).toBe('real');
    expect(r.resolution.SmartReportPort).toBe('stub');
  });

  it.each(STRICT)('%s: RenderPort and BillingCommandPort have no stub; absent -> boot fails', (env) => {
    expect(boot({ env, modules: allModules(['RenderPort']) }).run).toThrow(/RenderPort/);
    expect(boot({ env, modules: allModules(['BillingCommandPort']) }).run).toThrow(/BillingCommandPort/);
  });
});

describe('ownership (03-APP-FLOW §3.4)', () => {
  it.each(ENVS)('%s: two modules export the same port -> boot fails', (env) => {
    const modules = [...allModules(), { name: 'lab', ports: { CatalogPort: real('CatalogPort') } }];
    expect(boot({ env, modules }).run).toThrow(/CatalogPort/);
  });

  it.each(ENVS)('%s: a module exports a port it does not own -> boot fails', (env) => {
    const modules = [...allModules(['CatalogPort']), { name: 'lab', ports: { CatalogPort: real('CatalogPort') } }];
    expect(boot({ env, modules }).run).toThrow(/CatalogPort/);
  });

  it('a module exporting a port name that does not exist fails boot', () => {
    expect(boot({ modules: [...allModules(), { name: 'lab', ports: { NopePort: {} } }] }).run).toThrow(/NopePort/);
  });
});

describe('PORT_CONSUMERS enforcement (AC-0D-6.4, 08 A19 P-46)', () => {
  it.each(ENVS)('%s: listed consumer reads the port', (env) => {
    const r = boot({ env }).run();
    expect(r.portsFor('frontdesk').CatalogPort).toMatchObject({ kind: 'real', port: 'CatalogPort' });
  });

  it('boot itself does not throw for non-listed modules; only the read does (lazy guard)', () => {
    const r = boot().run();
    expect(() => r.portsFor('instruments')).not.toThrow();
  });

  it.each(['dev', 'ci', 'staging'] as const)('%s: non-listed module reading ctx.ports.<Port> throws common.internal and logs port_consumer_not_listed{module,port}', (env) => {
    const { run, l } = boot({ env });
    const r = run();
    const err = thrown(() => r.portsFor('instruments').CatalogPort);
    expect(err).toBeDefined();
    expect(err.code).toBe('common.internal');
    const ev = l.events('port_consumer_not_listed');
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ module: 'instruments', port: 'CatalogPort' });
  });

  it('error detail does not reveal the consumer list', () => {
    const r = boot().run();
    const err = thrown(() => r.portsFor('instruments').CatalogPort);
    expect(String(err?.safeDetail ?? '')).not.toMatch(/frontdesk|billing|lab/);
  });

  it('production: non-listed read still returns the port, logs port_consumer_not_listed and counts lims_core_port_consumer_not_listed_total', () => {
    const { run, l, m } = boot({ env: 'production' });
    const r = run();
    const got = r.portsFor('instruments').CatalogPort;
    expect(got).toMatchObject({ kind: 'real', port: 'CatalogPort' });
    expect(l.events('port_consumer_not_listed')).toHaveLength(1);
    expect(m.counter('lims_core_port_consumer_not_listed_total')).toBe(1);
    expect(m.labelsOf('lims_core_port_consumer_not_listed_total')).toEqual([{ module: 'instruments', port: 'CatalogPort' }]);
  });

  it('no implicit owner access: billing owns BillingCommandPort but only frontdesk is listed -> billing read throws', () => {
    const r = boot().run();
    expect(thrown(() => r.portsFor('billing').BillingCommandPort)?.code).toBe('common.internal');
    expect(r.portsFor('frontdesk').BillingCommandPort).toMatchObject({ kind: 'real' });
  });

  it('IdentityPort (consumers: all) is readable by every module', () => {
    const r = boot().run();
    for (const m of ALL_MODULES) expect(r.portsFor(m).IdentityPort).toMatchObject({ port: 'IdentityPort' });
  });

  it('a fake or a stub is guarded exactly like a real impl', () => {
    const r = boot({ env: 'dev', modules: allModules(['CatalogPort']) }).run();
    expect(r.portsFor('frontdesk').CatalogPort).toBe(fakes.CatalogPort);
    expect(thrown(() => r.portsFor('instruments').CatalogPort)?.code).toBe('common.internal');
    const s = boot({ env: 'production', modules: allModules(STUB_PORTS) }).run();
    expect(s.portsFor('lab').QualityPort).toBe(stubs.QualityPort);
    expect(() => s.portsFor('instruments').QualityPort).not.toThrow(); // production: log + metric only
  });

  it('the view is read-only: assigning or deleting a port does not swap the implementation', () => {
    const r = boot().run();
    const view = r.portsFor('frontdesk') as any;
    const before = view.CatalogPort;
    try { view.CatalogPort = { evil: true }; } catch { /* strict mode throws; both outcomes are fine */ }
    try { delete view.CatalogPort; } catch { /* idem */ }
    expect(view.CatalogPort).toBe(before);
    expect(r.portsFor('lab').CatalogPort).toBe(before);
  });

  it('forceFake / modules / fakes inputs are not mutated by resolution', () => {
    const forceFake = ['CatalogPort'];
    const modules = allModules();
    const snap = JSON.stringify({ forceFake, modules });
    boot({ forceFake, modules }).run();
    expect(JSON.stringify({ forceFake, modules })).toBe(snap);
  });
});
