// Shared fixtures for T0D-07 tests. Synthetic only. No imports from other core tasks (tests inject everything).
export const PORT_NAMES = [
  'CatalogPort', 'FrontdeskPort', 'BillingPort', 'LabPort', 'ReportingPort', 'IdentityPort', 'NotificationPort',
  'PaymentProviderPort', 'SmartReportPort', 'QualityPort', 'BillingCommandPort', 'RenderPort', 'EngagementPort',
] as const;
export type PortName = (typeof PORT_NAMES)[number];

// PORT_OWNERS (02-TRD §6.3 autoloader paragraph)
export const OWNERS: Record<PortName, string> = {
  CatalogPort: 'catalog', FrontdeskPort: 'frontdesk', BillingPort: 'billing', LabPort: 'lab', ReportingPort: 'reporting',
  NotificationPort: 'reporting', IdentityPort: 'identity', PaymentProviderPort: 'payments', SmartReportPort: 'smartreport',
  QualityPort: 'quality', BillingCommandPort: 'billing', RenderPort: 'reporting', EngagementPort: 'engagement',
};

export const STUB_PORTS: readonly PortName[] = ['QualityPort', 'SmartReportPort', 'PaymentProviderPort', 'EngagementPort'];

export const ALL_MODULES = [
  'identity', 'catalog', 'frontdesk', 'billing', 'lab', 'instruments', 'reporting', 'quality', 'smartreport', 'payments', 'engagement',
] as const;

// Test consumer lists (stand-in for generated PORT_CONSUMERS). `billing` is deliberately NOT a BillingCommandPort consumer (IC §4.15: frontdesk only).
export const CONSUMERS: Record<PortName, readonly string[]> = {
  CatalogPort: ['frontdesk', 'billing', 'lab'],
  FrontdeskPort: ['lab', 'billing', 'reporting'],
  BillingPort: ['reporting', 'payments'],
  LabPort: ['frontdesk', 'reporting'],
  ReportingPort: ['engagement'],
  IdentityPort: ALL_MODULES,
  NotificationPort: ['frontdesk', 'lab'],
  PaymentProviderPort: ['frontdesk', 'reporting'],
  SmartReportPort: ['reporting'],
  QualityPort: ['lab'],
  BillingCommandPort: ['frontdesk'],
  RenderPort: ['frontdesk', 'engagement'],
  EngagementPort: ['frontdesk'],
};

export type Impl = { kind: 'real' | 'fake' | 'stub'; port: PortName; by?: string };
export const fakes = Object.fromEntries(PORT_NAMES.map((p) => [p, { kind: 'fake', port: p }])) as Record<PortName, Impl>;
export const stubs = Object.fromEntries(STUB_PORTS.map((p) => [p, { kind: 'stub', port: p }])) as Partial<Record<PortName, Impl>>;
export const real = (port: PortName): Impl => ({ kind: 'real', port, by: OWNERS[port] });

/** A loaded module that provides the real impls of the given ports (default: every port it owns). */
export function mod(name: string, ports?: readonly PortName[]) {
  const owned = ports ?? PORT_NAMES.filter((p) => OWNERS[p] === name);
  return { name, ports: Object.fromEntries(owned.map((p) => [p, real(p)])) as Record<string, Impl> };
}

/** Modules covering every port in PORT_NAMES except `without`. */
export function allModules(without: readonly PortName[] = []) {
  const owners = [...new Set(PORT_NAMES.filter((p) => !without.includes(p)).map((p) => OWNERS[p]))];
  return owners.map((o) => mod(o, PORT_NAMES.filter((p) => OWNERS[p] === o && !without.includes(p))));
}

export function makeLog() {
  const entries: Array<Record<string, unknown> & { level: string; event?: string }> = [];
  const at = (level: string) => (obj: Record<string, unknown>, msg?: string) => { entries.push({ level, ...obj, ...(msg ? { msg } : {}) } as never); };
  return {
    log: { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') },
    entries,
    events: (name: string) => entries.filter((e) => e.event === name),
  };
}

export function makeMetrics() {
  const gauges = new Map<string, number>();
  const counters = new Map<string, number>();
  const calls: Array<{ name: string; labels?: Record<string, string>; by: number }> = [];
  return {
    metrics: {
      setGauge: (name: string, v: number) => { gauges.set(name, v); },
      inc: (name: string, labels?: Record<string, string>, by = 1) => { calls.push({ name, labels, by }); counters.set(name, (counters.get(name) ?? 0) + by); },
    },
    gauge: (n: string) => gauges.get(n),
    counter: (n: string) => counters.get(n) ?? 0,
    labelsOf: (n: string) => calls.filter((c) => c.name === n).map((c) => c.labels),
  };
}

export const ENVS = ['dev', 'ci', 'staging', 'production'] as const;
export const LENIENT = ['dev', 'ci'] as const;
export const STRICT = ['staging', 'production'] as const;
