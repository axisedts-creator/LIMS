// Tenant instrument settings E40/E41 (02-TRD §5.10 settings_changed, §7.3; 05-SCHEMA §2.17; 01-PRD AC-15.5 update-window part; 07-SECURITY S-04).
// Row is created lazily on first read. A change of the update window publishes ONE settings_changed config version for every non-retired agent of the tenant,
// in the E41 transaction (the agents carry the window in their signed config). Raw-archive retention is NOT a C7 setting (08 A13 D-42).
import { LimsError } from '../../../core/errors.js';
import { toSettings } from '../mappers/instruments.mapper.js';
import { createInstrumentsRepo, type InstrumentsRepo, type Row } from '../repo/instruments.repo.js';
import { fail, isInt, scope, version, type AgentsCtx, type Result } from './agents.service.js';
import { unwiredPublisher, type ConfigPublisher } from './instruments.service.js';

const READ = 'instruments.instrument.read';
const MANAGE = 'instruments.instrument.manage';
const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const RANGES: Array<[string, number, number]> = [
  ['default_backlog_threshold', 10, 100000], ['backlog_max_oldest_pending_seconds', 60, 86400], ['clock_offset_warn_seconds', 30, 3600], ['agent_uploaded_retention_hours', 1, 72],
];
const WINDOW = ['update_window_from', 'update_window_to'] as const;
const hhmm = (v: unknown): string | null => (v == null ? null : String(v).slice(0, 5));   // the DB may hand back HH:MM:SS

export function createSettingsService(deps: { repo?: InstrumentsRepo; publish?: ConfigPublisher; now?: () => Date } = {}) {
  const repo = deps.repo ?? createInstrumentsRepo();
  const publish = deps.publish ?? unwiredPublisher;

  return {
    /** E40 — creates the tenant row with the defaults on first read (after the permission check: a 403 writes nothing). */
    async getInstrumentSettings(ctx: AgentsCtx, _input: unknown = {}): Promise<Result> {
      const s = scope(ctx);
      await s.assert(READ);
      const row = (await repo.getSettings(s.tx, s.tenantId)) ?? (await repo.insertDefaultSettings(s.tx, s.tenantId, s.actorId));
      return { status: 200, body: toSettings(row), version: row['version'] };
    },

    /** E41 — closed body, all four values required, window both-or-neither (absent pair = cleared). */
    async updateInstrumentSettings(ctx: AgentsCtx, input: { expectedVersion?: unknown; body?: unknown }): Promise<Result> {
      const s = scope(ctx);
      const v = version(input?.expectedVersion);
      const b = input?.body as Row | undefined;
      if (b === null || typeof b !== 'object' || Array.isArray(b)) fail('/');
      const body = b as Row;
      const known = [...RANGES.map(([k]) => k), ...WINDOW];
      for (const k of Object.keys(body)) if (!known.includes(k)) fail(/^[a-z_]{1,40}$/.test(k) ? `/${k}` : '/');
      for (const [k, min, max] of RANGES) if (!isInt(body[k], min, max)) fail(`/${k}`);
      for (const k of WINDOW) if (body[k] !== undefined && (typeof body[k] !== 'string' || !HHMM.test(body[k]))) fail(`/${k}`);
      if ((body['update_window_from'] === undefined) !== (body['update_window_to'] === undefined)) fail(body['update_window_from'] === undefined ? '/update_window_from' : '/update_window_to');
      await s.assert(MANAGE);

      const current = (await repo.getSettings(s.tx, s.tenantId)) ?? (await repo.insertDefaultSettings(s.tx, s.tenantId, s.actorId));
      const row: Row = {
        ...Object.fromEntries(RANGES.map(([k]) => [k, body[k]])),
        update_window_from: body['update_window_from'] ?? null, update_window_to: body['update_window_to'] ?? null, updated_by: s.actorId,
      };
      const out = await repo.updateSettings(s.tx, s.tenantId, v, row);
      if (!out) throw new LimsError('common.version_conflict');
      if (hhmm(current['update_window_from']) !== row['update_window_from'] || hhmm(current['update_window_to']) !== row['update_window_to']) {
        for (const agentId of await repo.listNonRetiredAgentIds(s.tx, s.tenantId)) {
          await publish(s.tx, { tenantId: s.tenantId, agentId, reason: 'settings_changed', actorId: s.actorId });   // a failure propagates: the core rolls the whole tx back
        }
      }
      return { status: 200, body: toSettings(out), version: out['version'] };
    },
  };
}
export type SettingsService = ReturnType<typeof createSettingsService>;
