// C9 T-09 observation import + classification (02-TRD §6.2 steps 1-6, §6.3; PRD AC-02.1-02.3, AC-05.1, AC-05.3-05.5; 07-SECURITY tenant/log hygiene).
// Tenant, actor and ids come from ctx / this service, never from the view row. Reads ONLY lab.v_pub_qc_result (through the repo). Runs on the caller's transaction (the worker job tx).
// [CONV] pair lock = one FOR UPDATE per (instrument, analyte) group per page, taken on the job tx (held until the job commits) instead of a transaction per group.
// [CONV] the run assembler (T-10) is injected; an `assigned` row gets its qc_run_id from assembler.assign BEFORE the insert (05-SCHEMA qc_observations__assigned__ck). The assembler call and the
//        insert share the row's savepoint, so a duplicate (lost race) or a poison row also undoes whatever the assembler wrote.
// [CONV] only SQLSTATE class 22 / 23 insert errors are import_error; anything else aborts the run (the job retries; the cursor was not advanced past the failing page).
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { div, parseDecimal, roundDp, sub, toDecimalString, type Decimal } from '../../../../../../packages/shared-ts/src/decimal/index.js';
import { LimsError } from '../../../core/errors.js';
import { loadQualityConfig } from '../config.js';
import { createQcViewRepo, type Row, type SyncRepo } from '../repository/qcview.repo.js';
import { createSettingsService } from './settings.service.js';

export type ObservationDraft = Row;
export type Classification = ObservationDraft;
export interface RunAssembler { assign(ctx: ObsCtx, draft: ObservationDraft): Promise<{ qc_run_id: string }> }
export interface ObsCtx { readonly tenantId: string; readonly actor: { readonly id: string }; readonly tx: any; readonly now: () => string; readonly ports?: any; readonly log?: any }
export interface SyncResult {
  imported: number; duplicates: number; importErrors: number; pages: number; budgetExhausted: boolean;
  counts: Record<string, number>; cursor: { at: string; id: string } | null;
}

const DAY_MS = 86_400_000;
const SAVEPOINT = 'qc_row';
const ms = (iso: string): number => Date.parse(iso.replace(/(\.\d{3})\d*Z$/, '$1Z'));   // µs text -> ms (Date.parse is not specified beyond 3 digits)
const keyCmp = (a: { at: string; id: string }, b: { at: string; id: string }): number => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const isDataError = (e: any): boolean => /^(22|23)/.test(String(e?.code ?? ''));

/** Half-up to exactly 6 places, plain decimal string (numeric(20,6) / numeric(14,6)). */
function fixed6(d: Decimal): string {
  const r = roundDp(d, 6);
  return toDecimalString(r.s < 6 ? { m: r.m * 10n ** BigInt(6 - r.s), s: 6 } : r);
}

const unassignedRunAssembler: RunAssembler = {
  async assign() { throw new LimsError('common.internal'); },   // T-10 injects the real assembler; fail loudly rather than store a run-less `assigned` row
};

export function createObservationService(deps: {
  repo?: SyncRepo; assembler?: RunAssembler; config?: { syncBatch?: number; syncOverlapSeconds?: number; syncTimeBudgetSeconds?: number }; nowMs?: () => number;
} = {}) {
  const repo = deps.repo ?? createQcViewRepo();
  const assembler = deps.assembler ?? unassignedRunAssembler;
  const nowMs = deps.nowMs ?? Date.now;
  const cfg = () => ({ ...loadQualityConfig(), ...(deps.config ?? {}) });

  /** The tenant's calendar date of an instant (08 A13 P-15). Fail closed when the zone is unusable. */
  function dateIn(tz: string, iso: string): string {
    try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso)); }
    catch { throw new LimsError('common.internal'); }
  }
  async function tenantZone(ctx: ObsCtx): Promise<string> {
    const tz = (await ctx.ports?.IdentityPort?.getTenantSettings?.(ctx, { keys: ['timezone'] }))?.timezone;
    if (typeof tz !== 'string' || !tz) throw new LimsError('common.internal');
    return tz;
  }

  /** §6.3: first matching row wins. Returns the observation to insert (minus qc_run_id for `assigned`). The pair must already be locked. */
  async function classify(ctx: ObsCtx, v: Row, tzIn?: string): Promise<Classification> {
    const t = ctx.tenantId;
    const recv = ms(v['received_at']), irt = v['instrument_result_time'] ? ms(v['instrument_result_time']) : NaN;
    const byInstrument = !Number.isNaN(irt) && Math.abs(irt - recv) <= DAY_MS;   // ±24 h [CONV]
    const observedMs = byInstrument ? irt : recv;
    const o: Row = {
      id: uuidv7(), tenant_id: t, source_qc_result_id: v['qc_result_id'], source: v['source'], instrument_id: v['instrument_id'], analyte_id: v['analyte_id'] ?? null,
      control_id_raw: v['control_id_raw'], control_lot_raw: v['control_lot_raw'] ?? null, control_level_raw: v['control_level'] ?? null, value: v['value_numeric'] ?? null, unit_code: v['unit_code'] ?? null,
      instrument_result_time: v['instrument_result_time'] ?? null, received_at: v['received_at'], observed_at: new Date(observedMs).toISOString(), observed_at_basis: byInstrument ? 'instrument' : 'server',
      status: '', plan_id: null, level_id: null, lot_id: null, target_id: null, mean: null, sd: null, z: null, qc_run_id: null,
      classified_at: ctx.now(), created_by: ctx.actor.id, updated_by: ctx.actor.id,
    };
    const done = (status: string): Classification => { o['status'] = status; return o; };

    if (!o['analyte_id']) return done('unmapped_analyte');                                                // row 1
    const value = o['value'] === null ? undefined : parseDecimal(o['value']);
    if (!value) return done('non_numeric');                                                               // row 2
    const plan = await repo.findActivePlan(ctx.tx, t, o['instrument_id'], o['analyte_id']);
    if (!plan) return done('no_plan');                                                                    // row 3
    o['plan_id'] = plan['id'];
    const maps = await repo.findControlMaps(ctx.tx, t, o['instrument_id'], o['control_id_raw']);
    const map = (o['control_lot_raw'] !== null ? maps.find((m) => m['control_lot_raw'] === o['control_lot_raw']) : undefined) ?? maps.find((m) => m['control_lot_raw'] == null);   // exact lot first, else any lot
    const lot = map ? await repo.findLot(ctx.tx, t, map['lot_id']) : undefined;
    if (!map || !lot) return done('unmapped_control');                                                    // row 4
    o['lot_id'] = lot['id']; o['level_id'] = lot['level_id'];
    if (!(plan['composition'] as Array<{ level_id: string }>).some((c) => c.level_id === lot['level_id'])) return done('level_not_in_plan');   // row 5
    if (String(lot['expires_on']).slice(0, 10) < dateIn(tzIn ?? await tenantZone(ctx), o['observed_at'])) return done('lot_expired');           // row 6
    const target = (await repo.listTargets(ctx.tx, t, o['plan_id'], o['lot_id']))                         // row 7: active|superseded, effective_from <= observed_at < effective_to
      .filter((x) => (x['status'] === 'active' || x['status'] === 'superseded') && x['effective_from'] != null && ms(x['effective_from']) <= observedMs && (x['effective_to'] == null || observedMs < ms(x['effective_to'])))
      .sort((a, b) => ms(b['effective_from']) - ms(a['effective_from']))[0];
    if (!target) return done('no_target');
    if (o['unit_code'] !== null && o['unit_code'] !== target['unit_code']) return done('unit_mismatch'); // row 8 (absent unit = analyte unit, ASSUMPTION in §6.3)
    const mean = parseDecimal(target['mean']), sd = parseDecimal(target['sd']);
    if (!mean || !sd || sd.m === 0n) return done('no_target');
    o['target_id'] = target['id']; o['mean'] = fixed6(mean); o['sd'] = fixed6(sd); o['z'] = fixed6(div(sub(value, mean), sd));
    const lastRun = await repo.latestEvaluatedRunAt(ctx.tx, t, o['plan_id']);
    if (lastRun !== undefined && observedMs < ms(lastRun)) return done('late_unassigned');                // row 9 (charted, no run)
    return done('assigned');                                                                              // row 10
  }

  /** One page: drop already-imported rows, group by pair, lock, then classify + insert each row in its own savepoint. */
  async function importPage(ctx: ObsCtx, page: Row[], res: SyncResult, tz: string): Promise<void> {
    const t = ctx.tenantId;
    const existing = new Set(await repo.findExistingSourceIds(ctx.tx, t, page.map((r) => r['qc_result_id'])));
    const fresh = page.filter((r) => !existing.has(r['qc_result_id']));
    res.duplicates += page.length - fresh.length;
    const groups = new Map<string, Row[]>();
    for (const r of fresh) { const k = `${r['instrument_id']}|${r['analyte_id'] ?? ''}`; (groups.get(k) ?? groups.set(k, []).get(k)!).push(r); }

    for (const rows of groups.values()) {
      await repo.lockPair(ctx.tx, t, rows[0]!['instrument_id'], rows[0]!['analyte_id'] ?? null);
      const ordered = rows.map((r) => ({ r, at: observedOf(r) })).sort((a, b) => a.at - b.at || cmpStr(a.r['received_at'], b.r['received_at']) || cmpStr(a.r['qc_result_id'], b.r['qc_result_id'])).map((x) => x.r);
      for (const r of ordered) {
        const draft = await classify(ctx, r, tz);
        await ctx.tx.query(`SAVEPOINT ${SAVEPOINT}`);
        let inserted: { id: string } | undefined;
        try {
          if (draft['status'] === 'assigned') draft['qc_run_id'] = (await assembler.assign(ctx, withoutRun(draft))).qc_run_id;
          inserted = await repo.insertObservation(ctx.tx, t, draft);
        } catch (e: any) {
          if (!isDataError(e)) throw e;   // not a poison row: abort the run (the job tx rolls back, the cursor stays)
          await ctx.tx.query(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`);
          res.importErrors++; res.counts['import_error'] = (res.counts['import_error'] ?? 0) + 1;
          ctx.log?.warn?.({ event: 'quality_qc_import_error', qc_result_id: r['qc_result_id'], sqlstate: String(e.code) });   // no values, no raw ids
          continue;
        }
        if (!inserted) { await ctx.tx.query(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`); res.duplicates++; continue; }   // lost a race with an overlapping job
        await ctx.tx.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);
        res.imported++; res.counts[draft['status']] = (res.counts[draft['status']] ?? 0) + 1;
      }
    }
  }
  const observedOf = (r: Row): number => {
    const recv = ms(r['received_at']), irt = r['instrument_result_time'] ? ms(r['instrument_result_time']) : NaN;
    return !Number.isNaN(irt) && Math.abs(irt - recv) <= DAY_MS ? irt : recv;
  };
  const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const withoutRun = (d: ObservationDraft): ObservationDraft => { const { qc_run_id: _drop, ...rest } = d; return rest; };

  return {
    classify,

    /** §6.2 steps 1-6 on ctx.tx. Resolves with the counters; any non-data error rejects. The caller (task) enqueues the continuation when budgetExhausted. */
    async syncQcObservations(ctx: ObsCtx): Promise<SyncResult> {
      const { syncBatch: batch, syncOverlapSeconds: overlap, syncTimeBudgetSeconds: budget } = cfg();
      const t = ctx.tenantId;
      const started = nowMs();
      let state = await repo.getSyncState(ctx.tx, t);
      if (!state) {   // step 1: first run for the tenant
        await createSettingsService().ensure(ctx.tx, { tenantId: t, actorId: ctx.actor.id });
        state = await repo.getSyncState(ctx.tx, t);
        if (!state) throw new LimsError('common.internal');
      }
      const tz = await tenantZone(ctx);
      const res: SyncResult = { imported: 0, duplicates: 0, importErrors: 0, pages: 0, budgetExhausted: false, counts: {}, cursor: null };

      let page = await repo.readFirstPage(ctx.tx, t, { cursorAt: state.qc_cursor_at, overlapSeconds: overlap!, limit: batch! });
      let prev: { at: string; id: string } | null = null;   // the first page is never subject to the "key advanced" stop
      while (page.length > 0) {
        res.pages++;
        await importPage(ctx, page, res, tz);
        const last = page[page.length - 1]!;
        const key = { at: last['created_at'] as string, id: last['qc_result_id'] as string };
        await repo.advanceCursor(ctx.tx, t, key);   // step 5: both columns, after EVERY page; never backwards
        res.cursor = key;
        if (page.length < batch! || (prev !== null && keyCmp(key, prev) <= 0)) break;   // step 6: only while full AND the key advanced
        if (nowMs() - started >= budget! * 1000) { res.budgetExhausted = true; break; }
        prev = key;
        page = await repo.readPageAfter(ctx.tx, t, { afterAt: key.at, afterId: key.id, limit: batch! });
      }
      return res;
    },
  };
}
