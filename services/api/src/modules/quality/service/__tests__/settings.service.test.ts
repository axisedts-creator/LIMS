// C9 T-01: settings.service.ensure — bootstrap of quality.settings + quality.sync_state (02-TRD §12.1; 08 A17 D-56, P-22; 06-PLAN row T-01).
// done_when: "settings.service.ensure inserts quality.settings defaults with activated_at=now() ON CONFLICT (tenant_id) DO NOTHING and ensures sync_state
// qc_cursor_at=activated_at-400 days"; tests: "ensure idempotency + concurrent-ensure test". Synthetic ids only.
// The DB is an in-memory emulator that classifies statements by their TEXT (05-SCHEMA quality.settings / quality.sync_state) and applies the DDL defaults,
// the UNIQUE (tenant_id) constraint and ON CONFLICT (tenant_id) DO NOTHING; it never runs SQL. An INSERT without ON CONFLICT on an existing tenant raises
// SQLSTATE 23505, and every statement yields to the event loop, so a check-then-insert implementation LOSES the concurrent race here (as it would in PG).
// No live-DB variant: the quality schema is not in db/migrations yet (C0 wave-2 DDL), so there is nothing to run it against; see the T-01 notes.
//
// SEAMS the writer must honour (the spec fixes the behaviour, not these names):
//   ../settings.service.ts   export function createSettingsService(): { ensure(tx, who: { tenantId: string; actorId: string }): Promise<QualitySettings> }
//                            (tenant and actor are explicit: the Tx facade carries neither). The result carries camelCase fields (02-CV [CONV]):
//                            tenantId, activatedAt (Date | ISO string), tatAlertsEnabled, tatWarnPct, tatEscalatePct, tatOrphanCloseHours, targetMinPoints,
//                            simMinDays, simMinDecisions, reprocessWindowDays, defaultPlanParams.
//   Statement forms understood by the emulator:
//     INSERT INTO quality.settings | quality.sync_state (col, ...) VALUES (expr, ...) [ON CONFLICT (tenant_id) DO NOTHING]   expr = $n | 'lit' | number | now() | NULL | DEFAULT
//       sync_state.qc_cursor_at may be `$n` (JS-computed Date/ISO, taken from the settings row that ensure read back), `$n::timestamptz - interval '400 days'`
//       or `<sub-select/expr mentioning activated_at> - interval '400 days'`; the emulator evaluates all three.
//     SELECT ... FROM quality.settings | quality.sync_state WHERE tenant_id = $n   -> full row(s) of that tenant.
//   Anything else is a test failure (the emulator throws "unexpected statement"): ensure needs no lock, no DELETE, no UPDATE.
import { describe, expect, it } from 'vitest';
import { createSettingsService } from '../settings.service.js';

const T_A = '01a1a98a-ac40-7000-8000-00000000c9a1';
const T_B = '01a1a98a-ac40-7000-8000-00000000c9b2';
const ACTOR = '01a1b34e-1000-7eee-9d29-00000000c9a1';
const DAY = 86_400_000;
const DEFAULTS = { tat_alerts_enabled: true, tat_warn_pct: 80, tat_escalate_pct: 150, tat_orphan_close_hours: 72, target_min_points: 20, sim_min_days: 7,
  sim_min_decisions: 100, reprocess_window_days: 7, default_plan_params: {}, is_active: true, version: 1 };

type Row = Record<string, any>;
interface Stmt { text: string; values: unknown[] }

function splitTop(s: string): string[] {
  const out: string[] = []; let depth = 0, q = false, cur = '';
  for (const c of s) {
    if (c === "'") q = !q;
    if (!q && c === '(') depth++;
    if (!q && c === ')') depth--;
    if (!q && depth === 0 && c === ',') { out.push(cur.trim()); cur = ''; } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
const sql = (t: string) => t.replace(/\s+/g, ' ').trim();
const unique23505 = (table: string) => Object.assign(new Error(`duplicate key value violates unique constraint "${table}__tenant__uq"`), { code: '23505' });

function makeDb(opts: { now?: Date; failOn?: RegExp } = {}) {
  const db = {
    now: opts.now ?? new Date('2026-11-12T03:00:00.000Z'),
    settings: new Map<string, Row>(),
    syncState: new Map<string, Row>(),
    stmts: [] as Stmt[],
    seq: 0,
    tx() {
      return {
        startedAt: db.now, operation: { module: 'quality', operationId: 'T-01.ensure' },
        savepoint: async (fn: (t: unknown) => Promise<unknown>) => fn(db.tx()),
        query: async (text: string, values: unknown[] = []) => {
          await new Promise((r) => setImmediate(r)); // every statement yields: concurrent ensures interleave
          const t = sql(text);
          db.stmts.push({ text: t, values });
          if (opts.failOn?.test(t)) throw Object.assign(new Error('connection terminated'), { code: '08006' });
          return db.exec(t, values);
        },
      };
    },
    evalExpr(expr: string, values: unknown[], col: string, row: Row): any {
      const e = expr.trim();
      if (/^DEFAULT$/i.test(e)) return undefined;
      if (/^NULL$/i.test(e)) return null;
      if (/^now\(\)$/i.test(e)) return db.now;
      if (/^true$/i.test(e)) return true;
      if (/^false$/i.test(e)) return false;
      if (/^-?\d+$/.test(e)) return Number(e);
      const lit = /^'((?:[^']|'')*)'(?:::\w+)?$/.exec(e);
      if (lit) return col === 'default_plan_params' ? JSON.parse(lit[1]!) : lit[1]!.replace(/''/g, "'");
      if (col === 'qc_cursor_at') {
        const minus = /-\s*interval\s*'(\d+)\s*days?'/i.exec(e);
        const p = /\$(\d+)/.exec(e);
        const base = p ? new Date(values[Number(p[1]) - 1] as any) : /activated_at/.test(e) ? db.settings.get(row['tenant_id'])?.['activated_at'] : undefined;
        if (!base || Number.isNaN(+base)) throw new Error(`unexpected statement: cannot evaluate qc_cursor_at expression ${e}`);
        return new Date(+base - (minus ? Number(minus[1]) * DAY : 0));
      }
      const p = /^\$(\d+)(?:::\w+)?$/.exec(e);
      if (p) {
        const v = values[Number(p[1]) - 1];
        return col === 'default_plan_params' && typeof v === 'string' ? JSON.parse(v) : v;
      }
      throw new Error(`unexpected statement: cannot evaluate ${col} = ${e}`);
    },
    exec(t: string, values: unknown[]): { rows: Row[] } {
      const ins = /^INSERT INTO quality\.(settings|sync_state)\s*\(([^)]*)\)\s*VALUES\s*\((.*)\)( ON CONFLICT \(tenant_id\) DO NOTHING)?( RETURNING .*)?$/i.exec(t);
      if (ins) {
        const [, table, colsRaw, valsRaw, onConflict] = ins;
        const cols = colsRaw!.split(',').map((c) => c.trim());
        const exprs = splitTop(valsRaw!);
        if (cols.length !== exprs.length) throw new Error('unexpected statement: column / value count mismatch');
        const row: Row = {};
        cols.forEach((c, i) => { const v = db.evalExpr(exprs[i]!, values, c, row); if (v !== undefined) row[c] = v; });
        const store = table === 'settings' ? db.settings : db.syncState;
        if (!row['tenant_id']) throw new Error('unexpected statement: no tenant_id');
        if (store.has(row['tenant_id'])) {
          if (onConflict) return { rows: [] };
          throw unique23505(table!);
        }
        if (table === 'settings') {
          const missing = ['id', 'activated_at', 'created_by', 'updated_by'].filter((k) => row[k] === undefined || row[k] === null);
          if (missing.length) throw Object.assign(new Error(`null value in column "${missing[0]}" violates not-null constraint`), { code: '23502' });
          Object.assign(row, { ...DEFAULTS, ...row, created_at: db.now, updated_at: db.now });
        } else {
          if (!row['id'] || !row['qc_cursor_at']) throw Object.assign(new Error('null value violates not-null constraint'), { code: '23502' });
          Object.assign(row, { qc_cursor_id: null, expires_at: null, ...row, created_at: db.now, updated_at: db.now });
        }
        store.set(row['tenant_id'], row);
        return { rows: ins[5] ? [{ ...row }] : [] };
      }
      const sel = /^SELECT .* FROM quality\.(settings|sync_state)\b.*$/i.exec(t);
      if (sel && !/^SELECT .*INSERT/i.test(t)) {
        const tenant = values.find((v) => v === T_A || v === T_B) as string | undefined;
        const store = sel[1] === 'settings' ? db.settings : db.syncState;
        const r = tenant ? store.get(tenant) : undefined;
        return { rows: r ? [{ ...r }] : [] };
      }
      throw new Error(`unexpected statement: ${t}`);
    },
    count: (re: RegExp) => db.stmts.filter((s) => re.test(s.text)).length,
  };
  return db;
}

const who = (tenantId = T_A) => ({ tenantId, actorId: ACTOR });
const ms = (v: unknown) => +new Date(v as any);

describe('C9 T-01 settings.service.ensure — first use', () => {
  it('inserts the defaults of 02-TRD §12.1 with activated_at = now() and the caller as created_by / updated_by; returns the row', async () => {
    const db = makeDb();
    const r: any = await createSettingsService().ensure(db.tx() as any, who());
    const row = db.settings.get(T_A)!;
    expect(db.settings.size).toBe(1);
    expect(row).toMatchObject({ tenant_id: T_A, ...DEFAULTS, created_by: ACTOR, updated_by: ACTOR });
    expect(row['id']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/); // uuidv7
    expect(ms(row['activated_at'])).toBe(+db.now);
    expect(r).toMatchObject({ tenantId: T_A, tatAlertsEnabled: true, tatWarnPct: 80, tatEscalatePct: 150, tatOrphanCloseHours: 72, targetMinPoints: 20,
      simMinDays: 7, simMinDecisions: 100, reprocessWindowDays: 7, defaultPlanParams: {} });
    expect(ms(r.activatedAt)).toBe(+db.now);
  });

  it('the settings INSERT is the spec statement: activated_at is SQL now(), conflict target is exactly (tenant_id), action DO NOTHING (never DO UPDATE)', async () => {
    const db = makeDb();
    await createSettingsService().ensure(db.tx() as any, who());
    const ins = db.stmts.find((s) => /^INSERT INTO quality\.settings/i.test(s.text))!;
    expect(ins, 'no INSERT INTO quality.settings').toBeTruthy();
    expect(ins.text).toMatch(/\bnow\(\)/i);
    expect(ins.text).toMatch(/ON CONFLICT \(tenant_id\) DO NOTHING/i);
    expect(db.stmts.some((s) => /DO UPDATE/i.test(s.text))).toBe(false);
    expect(db.stmts.some((s) => /^(UPDATE|DELETE)\b/i.test(s.text))).toBe(false);
  });

  it('ensures quality.sync_state in the same call: one row, qc_cursor_at = activated_at − 400 days exactly, no cursor id (08 A17 D-56)', async () => {
    const db = makeDb();
    await createSettingsService().ensure(db.tx() as any, who());
    const ss = db.syncState.get(T_A)!;
    expect(db.syncState.size).toBe(1);
    expect(ss).toBeTruthy();
    expect(ms(ss['qc_cursor_at'])).toBe(+db.now - 400 * DAY);
    expect(ss['qc_cursor_id'] ?? null).toBeNull();
    expect(ss['expires_at'] ?? null).toBeNull(); // live state for the life of the tenant (05-SCHEMA §7)
    const ins = db.stmts.find((s) => /^INSERT INTO quality\.sync_state/i.test(s.text))!;
    expect(ins.text).toMatch(/ON CONFLICT \(tenant_id\) DO NOTHING/i);
  });

  it('is parameterised: tenant and actor ids travel as bind values, never inside statement text', async () => {
    const db = makeDb();
    await createSettingsService().ensure(db.tx() as any, who());
    for (const s of db.stmts) {
      expect(s.text, s.text).not.toContain(T_A);
      expect(s.text, s.text).not.toContain(ACTOR);
    }
    expect(db.stmts.flatMap((s) => s.values)).toContain(T_A);
  });
});

describe('C9 T-01 settings.service.ensure — idempotency', () => {
  it('a second ensure later in time changes nothing: same row id, same activated_at, same cursor, same result; no second row', async () => {
    const db = makeDb();
    const svc = createSettingsService();
    const first: any = await svc.ensure(db.tx() as any, who());
    const id = db.settings.get(T_A)!['id'];
    const t0 = db.now;
    db.now = new Date(+t0 + 90 * DAY);
    const second: any = await svc.ensure(db.tx() as any, who());
    expect(db.settings.size).toBe(1);
    expect(db.syncState.size).toBe(1);
    expect(db.settings.get(T_A)!['id']).toBe(id);
    expect(ms(db.settings.get(T_A)!['activated_at'])).toBe(+t0);
    expect(ms(db.syncState.get(T_A)!['qc_cursor_at'])).toBe(+t0 - 400 * DAY);
    expect(ms(second.activatedAt)).toBe(+t0);
    expect(second).toEqual(first);
  });

  it('never rewinds or resets an advanced sync cursor and never resets edited settings (ON CONFLICT DO NOTHING, not DO UPDATE)', async () => {
    const db = makeDb();
    const svc = createSettingsService();
    await svc.ensure(db.tx() as any, who());
    const advanced = new Date(+db.now - 5 * 60_000);
    Object.assign(db.syncState.get(T_A)!, { qc_cursor_at: advanced, qc_cursor_id: '01a1a98a-ac40-7000-8000-00000000c9ff' });
    Object.assign(db.settings.get(T_A)!, { tat_warn_pct: 90, tat_escalate_pct: 300, default_plan_params: { controlsPerRun: 3 }, version: 4 });
    db.now = new Date(+db.now + DAY);
    const r: any = await svc.ensure(db.tx() as any, who());
    expect(db.syncState.get(T_A)).toMatchObject({ qc_cursor_at: advanced, qc_cursor_id: '01a1a98a-ac40-7000-8000-00000000c9ff' });
    expect(db.settings.get(T_A)).toMatchObject({ tat_warn_pct: 90, tat_escalate_pct: 300, version: 4 });
    expect(r).toMatchObject({ tatWarnPct: 90, tatEscalatePct: 300, defaultPlanParams: { controlsPerRun: 3 } });
  });

  it('a settings row that already exists but has no sync_state row (seeded fixture): sync_state is created from THAT row\'s activated_at, not from now', async () => {
    const db = makeDb();
    const seeded = new Date(+db.now - 120 * DAY); // 05-SCHEMA seed: activated_at = seed time − 120 days
    db.settings.set(T_A, { id: '01a1a98a-ac40-7000-8000-00000000c9d1', tenant_id: T_A, ...DEFAULTS, activated_at: seeded, created_by: ACTOR, updated_by: ACTOR });
    const r: any = await createSettingsService().ensure(db.tx() as any, who());
    expect(ms(r.activatedAt)).toBe(+seeded);
    expect(ms(db.syncState.get(T_A)!['qc_cursor_at'])).toBe(+seeded - 400 * DAY);
    expect(db.settings.size).toBe(1);
  });

  it('a sync_state row that already exists with a settings row missing: settings is created, the cursor is left alone', async () => {
    const db = makeDb();
    const cur = new Date(+db.now - 3600_000);
    db.syncState.set(T_A, { id: '01a1a98a-ac40-7000-8000-00000000c9d2', tenant_id: T_A, qc_cursor_at: cur, qc_cursor_id: null });
    await createSettingsService().ensure(db.tx() as any, who());
    expect(db.settings.has(T_A)).toBe(true);
    expect(ms(db.syncState.get(T_A)!['qc_cursor_at'])).toBe(+cur);
  });
});

describe('C9 T-01 settings.service.ensure — concurrent ensure', () => {
  it('25 concurrent first-use calls for one tenant (separate transactions): exactly one settings row and one sync_state row, nobody throws, all see the same row', async () => {
    const db = makeDb();
    const svc = createSettingsService();
    const out: any[] = await Promise.all(Array.from({ length: 25 }, () => svc.ensure(db.tx() as any, who())));
    expect(db.settings.size).toBe(1);
    expect(db.syncState.size).toBe(1);
    const at = ms(db.settings.get(T_A)!['activated_at']);
    for (const r of out) { expect(r.tenantId).toBe(T_A); expect(ms(r.activatedAt)).toBe(at); }
    expect(new Set(out.map((r) => JSON.stringify(r))).size).toBe(1);
    expect(ms(db.syncState.get(T_A)!['qc_cursor_at'])).toBe(at - 400 * DAY);
  });

  it('concurrent ensures for two tenants stay separate: one row each, each with its own activated_at − 400 days', async () => {
    const db = makeDb();
    const svc = createSettingsService();
    // tenant B was activated earlier (its row exists), tenant A is created now: "insert" and "no-op" paths racing
    const bAt = new Date('2026-09-01T00:00:00.000Z');
    db.settings.set(T_B, { id: '01a1a98a-ac40-7000-8000-00000000c9d3', tenant_id: T_B, ...DEFAULTS, tat_warn_pct: 95, activated_at: bAt, created_by: ACTOR, updated_by: ACTOR });
    const out: any[] = await Promise.all(Array.from({ length: 12 }, (_, i) => svc.ensure(db.tx() as any, who(i % 2 ? T_A : T_B))));
    expect(db.settings.size).toBe(2);
    expect(db.syncState.size).toBe(2);
    expect(ms(db.syncState.get(T_B)!['qc_cursor_at'])).toBe(+bAt - 400 * DAY);
    expect(ms(db.syncState.get(T_A)!['qc_cursor_at'])).toBe(ms(db.settings.get(T_A)!['activated_at']) - 400 * DAY);
    expect(db.settings.get(T_B)!['tat_warn_pct']).toBe(95);
    for (const r of out) expect([T_A, T_B]).toContain(r.tenantId);
  });

  it('ensure for tenant A never reads or writes tenant B (no statement of an A-only ensure carries B\'s id)', async () => {
    const db = makeDb();
    db.settings.set(T_B, { id: '01a1a98a-ac40-7000-8000-00000000c9d3', tenant_id: T_B, ...DEFAULTS, activated_at: new Date('2026-01-01T00:00:00Z'), created_by: ACTOR, updated_by: ACTOR });
    const r: any = await createSettingsService().ensure(db.tx() as any, who(T_A));
    expect(r.tenantId).toBe(T_A);
    expect(ms(r.activatedAt)).toBe(+db.now);
    expect(db.stmts.flatMap((s) => s.values)).not.toContain(T_B);
    expect(db.settings.get(T_B)!['activated_at']).toEqual(new Date('2026-01-01T00:00:00Z'));
  });
});

describe('C9 T-01 settings.service.ensure — failure of the dependency', () => {
  it('a database error propagates (no swallowed error, no fabricated defaults returned for a row that was not written)', async () => {
    const db = makeDb({ failOn: /^INSERT INTO quality\.settings/i });
    await expect(createSettingsService().ensure(db.tx() as any, who())).rejects.toMatchObject({ code: '08006' });
    expect(db.settings.size).toBe(0);
    expect(db.syncState.size).toBe(0); // sync_state is never created without the settings row it derives from
  });

  it('a failure on the sync_state step propagates too (the caller\'s transaction rolls back as a whole)', async () => {
    const db = makeDb({ failOn: /^INSERT INTO quality\.sync_state/i });
    await expect(createSettingsService().ensure(db.tx() as any, who())).rejects.toMatchObject({ code: '08006' });
  });
});
