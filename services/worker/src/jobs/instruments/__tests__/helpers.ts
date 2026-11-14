// API-T14 shared fixtures (synthetic data only). A table-aware fake of the worker transaction for the C7 tasks plus a hand-built JobContext.
// SEAM CONTRACT (the tests fix it; the implementation must meet it, or raise a CR):
//  * Handlers are called as `manifest.tasks[id](payload, ctx)`; ctx is built here: { tenantId, actor, requestId, tx, events, storage, log, metrics, ports, now() ... }.
//      - ctx.events      = the REAL core publisher (createEvents) -> every published event is validated against contracts/events/*.schema.json.
//      - ctx.ports.IdentityPort.getTenantSettings(ctx, { keys }) -> { timezone, retention: { rawInstrumentYears } }   (TRD §10 purge step 1; §5.10)
//      - ctx.ports.CatalogPort.mapInstrumentCode(ctx, { instrumentId, direction: 'inbound', instrumentCode })        (TRD §10 refresh)
//      - ctx.storage.delete(bucket, objectPath)                                                                       (08 A13 P-12 (b))
//      - ctx.metrics.set(name, value, labels) / inc(name, labels, by)  (worker WorkerDeps.metrics shape; JobContext has no metrics field yet)
//      - ctx.now() -> ISO string; every "now" the tasks use comes from it.
//  * SQL is routed by the TABLES / FUNCTIONS a statement names (never by layout). Reads return "wide" rows with schema column names:
//      SELECT naming instruments.agent_status / instruments.agents    -> agent rows  (agent_id, centre_id, status, retired_at, update_channel, pinned_release_id,
//                                                                          backlog_threshold, health_state, health_version, last_heartbeat_at, agent_version, queue_depth,
//                                                                          oldest_pending_age_seconds, clock_offset_ms, silent_instrument_ids, latest_config_version)
//      ... also naming instruments.agent_config_versions               -> agent rows + latest config (config_version, document)
//      SELECT naming instruments.instruments / instrument_status       -> live-instrument rows (agent_id, instrument_id, state, live_at, last_message_at,
//                                                                          silence_window_minutes, silence_active_from/to as 'HH:MM:SS'); if the same statement also names an agent table the
//                                                                          rows are agent x instrument (left join; instrument columns null when the agent has none)
//      SELECT naming instruments.settings / g_agent_releases / observed_codes / attachments -> their rows; a SELECT naming observed_codes or attachments is served ONCE per ctx (a paging loop ends).
//      Retired agents are removed only if the SQL text mentions 'retired'; non-live instruments only if the SQL text/values mention 'live'; inactive releases only if the text
//      mentions is_active; releases of other channels only if the text mentions channel (then only the channels found in the values). Otherwise the implementation must filter in code.
//      Timestamps come back as Date, `time` columns as 'HH:MM:SS', bigint (package_size) as string, like node-pg.
//  * app.purge_instruments_archive(int) mimics the DEFINER guard (raises P0001 with no tenant claim or days < 365). app.instruments_agent_state_snapshot() returns world.snapshot.
import { createEvents } from '../../../../../api/src/core/events/publish.js';
import { makeLog, makeMetrics } from '../../../core/__tests__/helpers.js';

export { TENANT_A, TENANT_B, UUIDV7, makeLog, makeMetrics, pgError, rejects } from '../../../core/__tests__/helpers.js';

export const NOW = '2026-11-07T12:00:30.000Z';                       // 17:45:30 in Asia/Kathmandu (UTC+05:45)
export const ago = (seconds: number): Date => new Date(Date.parse(NOW) - seconds * 1000);
export const daysAgo = (d: number): Date => ago(d * 86_400);
export const T_A = '0190a000-0000-7000-8000-00000000aaaa';
export const T_B = '0190a000-0000-7000-8000-00000000bbbb';
export const SYSTEM_ACTOR = '0190a000-0000-7000-8000-0000000a0008';
export const CENTRE_1 = '0190a000-0000-7000-8000-00000000c001';
export const CENTRE_2 = '0190a000-0000-7000-8000-00000000c002';
export const uid = (n: number): string => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
export const AGENT = (n: number): string => uid(0xd0100 + n);
export const INSTR = (n: number): string => uid(0xd0200 + n);
export const REL = (n: number): string => uid(0xd0300 + n);
export const SENTINEL = 'SENTINEL-PHI-Sita-Karki';

export interface Stmt { text: string; values: unknown[]; claims: any }
const semverKey = (v: string) => v.split('.').map(Number);
const semverDesc = (a: any, b: any) => { const x = semverKey(a.version), y = semverKey(b.version); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return y[i]! - x[i]!; return 0; };
const err = (code: string, message: string) => Object.assign(new Error(message), { code });

export function agentRow(n: number, over: Record<string, unknown> = {}): any {
  return {
    tenant_id: T_A, agent_id: AGENT(n), id: AGENT(n), centre_id: CENTRE_1, status: 'active', retired_at: null, update_channel: 'stable', pinned_release_id: null,
    backlog_threshold: null, health_state: 'online', health_version: 3, last_heartbeat_at: ago(30), agent_version: '1.4.0', queue_depth: 0,
    oldest_pending_age_seconds: 0, clock_offset_ms: 0, silent_instrument_ids: [], latest_config_version: 7, ...over,
  };
}
export function liveInstrument(n: number, agent: number, over: Record<string, unknown> = {}): any {
  return {
    tenant_id: T_A, agent_id: AGENT(agent), instrument_id: INSTR(n), id: INSTR(n), centre_id: CENTRE_1, state: 'live', live_at: daysAgo(30),
    last_message_at: ago(60), silence_window_minutes: 60, silence_active_from: null, silence_active_to: null, ...over,
  };
}

export function makeWorld() {
  const w = {
    tenantSettings: { timezone: 'Asia/Kathmandu', retention: { clinicalYears: 5, auditYears: 5, rawInstrumentYears: 1 } } as any,
    settings: [{ default_backlog_threshold: 500, backlog_max_oldest_pending_seconds: 900 }] as any[],
    agents: [] as any[], instruments: [] as any[], configs: [] as any[], releases: [] as any[], observed: [] as any[], attachments: [] as any[], snapshot: [] as any[],
    purgeRows: ['message_records', 'attachments', 'message_duplicates', 'processing_runs', 'messages', 'message_rejections', 'agent_log_bundles', 'agent_commands',
      'agent_health_transitions', 'observed_codes'].map((t) => ({ table_name: t, deleted: 0 })) as Array<{ table_name: string; deleted: number }>,
    stmts: [] as Stmt[], jobs: [] as Array<{ identifier: string; payload: any; jobKey: string | null }>, events: [] as Array<{ type: string; envelope: any }>,
    purgeCalls: [] as Array<{ days: unknown; tenant: string | undefined }>, storageDeleted: [] as Array<{ bucket: string; path: string }>,
    storageFail: new Set<string>(), mapCalls: [] as any[], settingsCalls: [] as any[],
    mapping: (_input: any): Promise<any> => Promise.reject(Object.assign(new Error('catalog.instrument_code_unmapped'), { code: 'catalog.instrument_code_unmapped' })),
    publishError: undefined as Error | undefined,
  };
  const keys = new Set<string>();
  const logs = makeLog();
  const metrics = makeMetrics();

  /** `claims` is {tenant_id} for per-tenant tasks and undefined for the platform task. */
  function makeCtx(opts: { tenantId?: string | undefined } = {}) {
    const tenantId = 'tenantId' in opts ? opts.tenantId : T_A;
    const served = new Set<string>();
    const claims = tenantId ? { sub: SYSTEM_ACTOR, tenant_id: tenantId, actor_type: 'system' } : undefined;
    const tx: any = { startedAt: new Date(NOW), claims };
    tx.query = async (rawText: string, values: unknown[] = []) => {
      const t = rawText.replace(/\s+/g, ' ').trim();
      w.stmts.push({ text: t, values, claims });
      const has = (re: RegExp) => re.test(t);
      let m: RegExpExecArray | null;
      if (has(/INSERT INTO core\.event_log/i)) {
        const [tenant, eventId, type, , idem] = values as string[];
        const k = `${tenant}|${type}|${idem}`;
        if (keys.has(k)) return { rows: [] };
        keys.add(k); w.events.push({ type: type!, envelope: (values as any[])[9] });
        return { rows: [{ event_id: eventId }] };
      }
      if (has(/SELECT event_id FROM core\.event_log/i)) return { rows: [{ event_id: uid(0xe0000) }] };
      if (has(/app\.enqueue_job/i)) {
        const lit = /enqueue_job\(\s*'([^']+)'/i.exec(t)?.[1];
        if (lit) { w.jobs.push({ identifier: lit, payload: { event_id: values[0], tenant_id: values[1] }, jobKey: null }); return { rows: [{ enqueue_job: null }] }; }   // core.event_fanout from publish()
        const [identifier, rawPayload, jobKey] = values as [string, unknown, string | null];
        w.jobs.push({ identifier, payload: typeof rawPayload === 'string' ? JSON.parse(rawPayload) : rawPayload, jobKey: jobKey ?? null });
        return { rows: [{ enqueue_job: null }] };
      }
      if (has(/app\.instruments_agent_state_snapshot/i)) return { rows: w.snapshot };
      if ((m = /app\.purge_instruments_archive\s*\(/i.exec(t))) {
        const days = values[0] ?? Number(/purge_instruments_archive\s*\(\s*(\d+)/i.exec(t)?.[1]);
        w.purgeCalls.push({ days, tenant: tenantId });
        if (!tenantId) throw err('P0001', 'purge_instruments_archive: tenant claims required');
        if (typeof days !== 'number' || !Number.isFinite(days) || days < 365) throw err('P0001', 'purge_instruments_archive: retention below 365 days');
        return { rows: w.purgeRows.map((r) => ({ ...r })) };
      }
      if (/^SELECT/i.test(t) || /^WITH/i.test(t)) {
        const agentTbl = has(/instruments\.agent_status\b/i) || has(/instruments\.agents\b/i);
        const instrTbl = has(/instruments\.instruments\b/i) || has(/instruments\.instrument_status\b/i);
        if (has(/instruments\.settings\b/i)) return { rows: w.settings };
        if (has(/instruments\.g_agent_releases\b/i) && !agentTbl) {
          let rows = [...w.releases].sort(semverDesc);
          if (has(/is_active/i)) rows = rows.filter((r) => r.is_active);
          if (has(/channel/i)) { const ch = values.filter((v) => v === 'stable' || v === 'beta'); if (ch.length) rows = rows.filter((r) => ch.includes(r.channel)); }
          const byId = rows.filter((r) => values.includes(r.id));
          return { rows: byId.length ? byId : rows };
        }
        if (has(/instruments\.observed_codes\b/i)) { if (served.has('o')) return { rows: [] }; served.add('o'); return { rows: w.observed }; }
        if (has(/instruments\.attachments\b/i)) {
          if (served.has('a')) return { rows: [] }; served.add('a');
          let rows = w.attachments;
          if (has(/#deleted/)) rows = rows.filter((r) => !String(r.object_path).endsWith('#deleted'));
          const num = values.find((v) => typeof v === 'number' && v >= 365) as number | undefined;
          const date = values.find((v) => v instanceof Date || (typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v))) as Date | string | undefined;
          const lit = /(\d+)\s*days/i.exec(t)?.[1];
          const cut = date ? new Date(date).getTime() : num !== undefined ? Date.parse(NOW) - num * 86_400_000 : lit ? Date.parse(NOW) - Number(lit) * 86_400_000 : undefined;
          if (cut !== undefined) rows = rows.filter((r) => r.created_at.getTime() < cut);
          return { rows };
        }
        if (has(/instruments\.agent_config_versions\b/i) && !agentTbl) return { rows: w.configs };
        if (agentTbl || instrTbl) {
          let agents = w.agents;
          if (has(/retired/i)) agents = agents.filter((a) => a.status !== 'retired');
          const cfgs = new Map(w.configs.map((c) => [c.agent_id, c]));
          const withCfg = has(/agent_config_versions/i);
          const aRows = agents.map((a) => (withCfg ? { ...a, config_version: cfgs.get(a.agent_id)?.config_version, document: cfgs.get(a.agent_id)?.document } : a));
          let inst = w.instruments;
          if (has(/\blive\b/i) || values.includes('live')) inst = inst.filter((i) => i.state === 'live');
          if (!instrTbl) return { rows: aRows };
          if (!agentTbl) return { rows: inst };
          return { rows: aRows.flatMap((a) => { const mine = inst.filter((i) => i.agent_id === a.agent_id); return mine.length ? mine.map((i) => ({ ...i, ...a, instrument_id: i.instrument_id })) : [{ ...a, instrument_id: null, last_message_at: null }]; }) };
        }
        return { rows: [] };
      }
      return { rows: [], rowCount: 1 };                                      // INSERT / UPDATE / DELETE
    };
    const ctx: any = {
      tenantId, actor: { type: 'system', id: SYSTEM_ACTOR }, requestId: uid(0xf0001), tx, log: logs.log, metrics,
      events: (() => { const real = createEvents({ producer: 'instruments' }); return { publish: async (c: any, type: string, input: any) => { if (w.publishError) throw w.publishError; return real.publish(c, type, input); } }; })(),
      core: {}, files: {}, audit: {}, attempt: 1, maxAttempts: 3, jobId: '1', now: () => NOW, isNewer: () => true,
      storage: {
        delete: async (bucket: string, path: string) => { if (w.storageFail.has(path)) throw new Error('storage unavailable'); w.storageDeleted.push({ bucket, path }); },
        read: async () => new Uint8Array(),
      },
      ports: {
        IdentityPort: { getTenantSettings: async (_c: unknown, input: any) => { w.settingsCalls.push({ ctxTenant: tenantId, input }); return w.tenantSettings; } },
        CatalogPort: { mapInstrumentCode: async (_c: unknown, input: any) => { w.mapCalls.push(input); return w.mapping(input); } },
      },
    };
    ctx.db = { tx: async (fn: (c: any) => Promise<unknown>) => fn(ctx) };
    return ctx;
  }

  const writes = () => w.stmts.filter((s) => /^(INSERT|UPDATE|DELETE)/i.test(s.text) && !/core\.event_log/i.test(s.text));
  /** statement text + JSON(values) contains every needle (a needle may be a string, number, or an array of alternatives). */
  const touches = (s: Stmt, ...needles: Array<string | number | RegExp | Array<string | number | RegExp>>) => {
    const hay = `${s.text} ${JSON.stringify(s.values)}`;
    return needles.every((n) => (Array.isArray(n) ? n : [n]).some((x) => (x instanceof RegExp ? x.test(hay) : hay.includes(String(x)))));
  };
  return Object.assign(w, { logs, metrics, makeCtx, writes, touches, jobsOf: (id: string) => w.jobs.filter((j) => j.identifier === id) });
}
export type World = ReturnType<typeof makeWorld>;

/** Canonical JSON of TRD §5.10 (keys sorted by code point, no whitespace); the fixtures contain no control characters. */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as any)[k])}`).join(',')}}`;
}

/** Event envelope for catalog.changed.v1 (valid against contracts/events). */
export function catalogChanged(entityType: string, over: Record<string, unknown> = {}, eventId = uid(0xe0001)): any {
  return {
    event_id: eventId, event_type: 'catalog.changed.v1', tenant_id: T_A, occurred_at: '2026-11-07T12:00:00.000Z',
    actor: { type: 'user', id: uid(0xa0001) }, idempotency_key: `catalog-${eventId}`, producer: 'catalog',
    aggregate: { type: 'catalog', id: uid(0xc0001), seq: 1 }, request_id: uid(0xf0002),
    payload: { catalog_revision: 5, entity_type: entityType, entity_id: uid(0xc0002), change_kind: 'updated', effective_from: '2026-11-07T12:00:00.000Z' },
    ...over,
  };
}
