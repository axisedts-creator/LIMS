// PHLEBO-UI-FULL-1 updateVisitTracking: who may share a position, when, and what is kept. The database is a small in-memory
// fake of the one visit_tracking row (the table's rules and RLS are proven by db/tests/homecollection/visit_tracking.scenario.sql).
import { describe, expect, it } from 'vitest';
import { updateVisitTracking } from '../../tracking.service.js';

const TENANT = '01a1a98a-ac40-7000-8000-00000000a001';
const VISIT = '01a1a98a-ac40-7000-8000-000000130001';
const ME = '01a1a98a-ac40-7000-8000-0000000000m1'.replace('m', 'a');
const OTHER = '01a1a98a-ac40-7000-8000-0000000000b1';
const BOOKING = '01a1a98a-ac40-7000-8000-000000093001';

function world(visit: Record<string, unknown> | null = { id: VISIT, status: 'assigned', assigned_membership_id: ME, centre_id: 'c1', booking_id: BOOKING }) {
  let row: Record<string, any> | null = null;
  const sql: string[] = [];
  let clock = Date.parse('2026-11-26T04:00:00.000Z');
  const tx = {
    async query(text: string, v: unknown[] = []) {
      sql.push(text);
      if (text.includes('FROM homecollection.visits')) return { rows: visit ? [visit] : [] };
      if (text.startsWith('SELECT * FROM homecollection.visit_tracking')) return { rows: row ? [row] : [] };
      if (text.startsWith('INSERT INTO homecollection.visit_tracking')) {
        if (row) return { rows: [] };
        const cols = /\(([^)]+)\) VALUES/.exec(text)![1]!.split(', ');
        row = { latitude: null, longitude: null, accuracy_m: null, position_at: null, stop_reason: null, stopped_at: null };
        cols.forEach((c, i) => { if (c !== 'created_by' && c !== 'updated_by') row![c] = v[i]; });
        return { rows: [row] };
      }
      if (text.includes("SET state = 'en_route'")) { Object.assign(row!, { state: 'en_route', stop_reason: null, stopped_at: null, started_at: v[2], membership_id: v[3], collector_display_name: v[4], latitude: null, longitude: null, accuracy_m: null, position_at: null }); return { rows: [row] }; }
      if (text.includes('SET latitude = $4')) {
        if (!row || row['state'] !== 'en_route' || row['membership_id'] !== v[2]) return { rows: [] };
        Object.assign(row, { latitude: v[3], longitude: v[4], accuracy_m: v[5], position_at: v[6] });
        return { rows: [row] };
      }
      if (text.includes("SET state = 'stopped'")) {
        if (!row || row['state'] !== 'en_route') return { rows: [], rowCount: 0 };
        Object.assign(row, { state: 'stopped', stop_reason: v[2], stopped_at: v[3], latitude: null, longitude: null, accuracy_m: null, position_at: null });
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected SQL: ${text}`);
    },
  };
  const roles: string[] = [];
  const ctx = (membershipId: string | null = ME) => ({
    tenantId: TENANT, tx, actor: { id: 'u1', ...(membershipId ? { membershipId } : {}) }, now: () => new Date((clock += 1000)),
    db: { tx: async (fn: any) => fn({}) },
    ports: { IdentityPort: { assertRole: async (_c: unknown, r: { permission: string }) => { roles.push(r.permission); } } },
    core: { memberships: { list: async () => [{ membershipId: ME, displayName: 'Sanjay Demo' }] } },
  });
  return { ctx, sql, roles, row: () => row };
}
const code = async (p: Promise<unknown>) => p.then(() => 'ok', (e) => e.code as string);
const pos = { latitude: '27.700000', longitude: '85.300000', accuracy_m: 12 };

describe('updateVisitTracking', () => {
  it('"On my way" starts sharing with the collector name and the booking, then positions overwrite each other (no trail)', async () => {
    const w = world();
    const a: any = await updateVisitTracking(w.ctx(), { visit_id: VISIT }, { state: 'en_route' });
    expect(a.body).toMatchObject({ state: 'en_route' });
    expect(a.body.position_at).toBeUndefined();
    expect(w.row()).toMatchObject({ booking_id: BOOKING, collector_display_name: 'Sanjay Demo', membership_id: ME, state: 'en_route' });
    const b: any = await updateVisitTracking(w.ctx(), { visit_id: VISIT }, { state: 'en_route', position: pos });
    expect(b.body.position_at).toBeDefined();
    await updateVisitTracking(w.ctx(), { visit_id: VISIT }, { state: 'en_route', position: { latitude: '27.710000', longitude: '85.310000' } });
    expect(w.row()).toMatchObject({ latitude: '27.710000', longitude: '85.310000', accuracy_m: null });
    expect(w.sql.filter((s) => s.startsWith('INSERT')).length).toBe(1);
    expect(w.roles.every((r) => r === 'homecollection.sync.upload')).toBe(true);
    expect(JSON.stringify(b.body)).not.toContain('27.7');   // the answer never echoes a position
  });

  it('stopping clears the coordinates; starting again reuses the row with no position', async () => {
    const w = world();
    await updateVisitTracking(w.ctx(), { visit_id: VISIT }, { state: 'en_route', position: pos });
    const s: any = await updateVisitTracking(w.ctx(), { visit_id: VISIT }, { state: 'stopped' });
    expect(s.body).toMatchObject({ state: 'stopped', stop_reason: 'stopped' });
    expect(w.row()).toMatchObject({ latitude: null, longitude: null, position_at: null });
    await updateVisitTracking(w.ctx(), { visit_id: VISIT }, { state: 'en_route' });
    expect(w.row()).toMatchObject({ state: 'en_route', stop_reason: null, latitude: null });
  });

  it("only the assigned phlebotomist can track: another member, an unknown visit and a caller with no membership are refused the same way", async () => {
    expect(await code(updateVisitTracking(world().ctx(OTHER), { visit_id: VISIT }, { state: 'en_route', position: pos }))).toBe('homecollection.visit_not_assigned');
    expect(await code(updateVisitTracking(world(null).ctx(), { visit_id: VISIT }, { state: 'en_route' }))).toBe('homecollection.visit_not_assigned');
    expect(await code(updateVisitTracking(world().ctx(null), { visit_id: VISIT }, { state: 'en_route' }))).toBe('auth.forbidden');
  });

  it('a visit that has arrived, closed or been cancelled cannot be tracked, but can still be stopped', async () => {
    for (const status of ['in_progress', 'completed', 'failed', 'cancelled']) {
      const w = world({ id: VISIT, status, assigned_membership_id: ME, centre_id: 'c1', booking_id: null });
      expect(await code(updateVisitTracking(w.ctx(), { visit_id: VISIT }, { state: 'en_route', position: pos })), status).toBe('homecollection.visit_closed');
      expect(await code(updateVisitTracking(w.ctx(), { visit_id: VISIT }, { state: 'stopped' })), status).toBe('ok');
    }
  });

  it('bad input is refused before the visit is read', async () => {
    const bads: Array<[unknown, unknown]> = [
      [{ visit_id: 'not-a-uuid' }, { state: 'en_route' }], [{ visit_id: VISIT }, { state: 'arrived' }], [{ visit_id: VISIT }, { state: 'en_route', extra: 1 }],
      [{ visit_id: VISIT }, { state: 'stopped', position: pos }], [{ visit_id: VISIT }, { state: 'en_route', position: { latitude: '91', longitude: '85' } }],
      [{ visit_id: VISIT }, { state: 'en_route', position: { latitude: 27.7, longitude: 85.3 } }], [{ visit_id: VISIT }, { state: 'en_route', position: { latitude: '27.7', longitude: '181' } }],
      [{ visit_id: VISIT }, { state: 'en_route', position: { ...pos, accuracy_m: -1 } }], [{ visit_id: VISIT }, { state: 'en_route', position: { ...pos, speed: 3 } }],
      [{ visit_id: VISIT }, { state: 'en_route', position: { latitude: "27'; DROP", longitude: '85' } }],
    ];
    for (const [params, body] of bads) {
      const w = world();
      expect(await code(updateVisitTracking(w.ctx(), params, body)), JSON.stringify(body)).toBe('common.validation_failed');
      expect(w.sql).toEqual([]);
    }
  });
});
