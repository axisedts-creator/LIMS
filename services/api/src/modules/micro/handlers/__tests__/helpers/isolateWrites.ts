// C10 T-09 test helper — wraps the in-memory fake tx of cultureWrites.ts with the database rules M7–M10 depend on (05-SCHEMA §8):
//   micro.specimen_isolate_counters: `INSERT INTO micro.specimen_isolate_counters (cols) VALUES (...) ON CONFLICT (tenant_id, specimen_id) DO UPDATE SET last_seq = <anything> + 1 RETURNING last_seq`
//     is applied ATOMICALLY in one synchronous step (a row lock in PostgreSQL): absent row -> inserted with the given last_seq (default 0), present row -> last_seq + 1;
//     CHECK specimen_isolate_counters__seq__ck (0..99) -> 23514. Any other statement on the counter table THROWS "fake dialect" (a plain SELECT max + 1 cannot pass as numbering).
//   micro.isolates INSERT/UPDATE: defaults (is_reportable true, version 1, is_active true, nulls), isolates__specimen_seq__uq (23505), isolates__seq__ck, __status__ck, __identified__ck, __source__ck,
//     __withdraw__ck, __texts__ck (23514), composite FKs to cultures / culture_plates (23503), isolates__final_lock (P0001 immutable_row when the parent culture is final_submitted).
//   Violating statements are rolled back (the isolates table is restored) before the error is thrown. Everything else is delegated to fakeTx (dialect in cultureWrites.ts).
// The fake applies NO row locks other than the counter upsert: a service that numbers with SELECT max(isolate_seq) + 1 collides on isolates__specimen_seq__uq under parallel creates, as it would in a race.
// Synthetic data only.
import { fakeTx, type Row, type World } from './cultureWrites.js';

export { NOW, HOUR, iso, writesOf, type Logged, type Row, type World } from './cultureWrites.js';

const pgErr = (code: string, message: string) => Object.assign(new Error(message), { code });
const same = (a: unknown, b: unknown) => String(a) === String(b);

function splitTop(s: string): string[] {
  const out: string[] = []; let depth = 0; let q = false; let cur = '';
  for (const ch of s) {
    if (ch === "'") q = !q;
    if (!q && ch === '(') depth++;
    if (!q && ch === ')') depth--;
    if (!q && depth === 0 && ch === ',') { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
function value(e: string, params: unknown[]): unknown {
  const t = e.trim(); let m: RegExpExecArray | null;
  if ((m = /^\$(\d+)(?:::[a-z_]+)?$/i.exec(t))) return params[Number(m[1]) - 1];
  if (/^-?\d+$/.test(t)) return Number(t);
  if (/^now\(\)$/i.test(t)) return new Date('2026-11-05T05:00:00.000Z');
  throw new Error(`fake dialect: counter value expression not supported: ${t}`);
}

const ISOLATE_DEFAULTS = (): Row => ({ is_reportable: true, version: 1, is_active: true, plate_id: null, organism_code: null, organism_source: null, identified_at: null, identified_by_membership_id: null,
  colony_description: null, quantity_text: null, withdraw_reason_code: null, withdraw_comment: null, ast_panel_id: null, ast_method: null });

export function isolateTx(w: World) {
  const base = fakeTx(w);
  const tbl = (t: string): Row[] => (w[t] ??= []);
  const parent = (r: Row) => tbl('cultures').find((c) => same(c['tenant_id'], r['tenant_id']) && same(c['id'], r['culture_id']));

  function checkIsolate(r: Row, before: Row | undefined): void {
    const p = parent(r);
    if (!p) throw pgErr('23503', 'isolates__culture__fk');
    if (p['status'] === 'final_submitted') throw pgErr('P0001', 'immutable_row');                                    // isolates__final_lock
    if (r['plate_id'] != null && !tbl('culture_plates').some((x) => same(x['tenant_id'], r['tenant_id']) && same(x['id'], r['plate_id']))) throw pgErr('23503', 'isolates__plate__fk');
    if (!(r['isolate_seq'] >= 1 && r['isolate_seq'] <= 99)) throw pgErr('23514', 'isolates__seq__ck');
    if (!['pending_id', 'identified', 'withdrawn'].includes(r['status'])) throw pgErr('23514', 'isolates__status__ck');
    if (r['status'] === 'identified' && (r['organism_code'] == null || r['organism_source'] == null)) throw pgErr('23514', 'isolates__identified__ck');
    if (r['organism_source'] != null && !['manual', 'instrument'].includes(r['organism_source'])) throw pgErr('23514', 'isolates__source__ck');
    if ((r['status'] === 'withdrawn') !== (r['withdraw_reason_code'] != null)) throw pgErr('23514', 'isolates__withdraw__ck');
    if ((r['colony_description'] != null && String(r['colony_description']).length > 500) || (r['quantity_text'] != null && String(r['quantity_text']).length > 80)
      || (r['withdraw_comment'] != null && String(r['withdraw_comment']).length > 500)) throw pgErr('23514', 'isolates__texts__ck');
    const dup = tbl('isolates').some((x) => x !== before && x['id'] !== r['id'] && same(x['tenant_id'], r['tenant_id']) && same(x['specimen_id'], r['specimen_id']) && x['isolate_seq'] === r['isolate_seq']);
    if (dup) throw pgErr('23505', 'isolates__specimen_seq__uq');
  }

  function counter(sql: string, params: unknown[]): Row[] {
    const m = /^\s*INSERT\s+INTO\s+(?:micro\.)?specimen_isolate_counters\s*\(([^)]*)\)\s*VALUES\s*\(([\s\S]*?)\)\s*ON\s+CONFLICT\s*\(\s*tenant_id\s*,\s*specimen_id\s*\)\s*DO\s+UPDATE\s+SET\s+last_seq\s*=\s*(?:\w+\.)?(?:specimen_isolate_counters\.)?last_seq\s*\+\s*1\b[\s\S]*?\bRETURNING\s+last_seq\b/i.exec(sql);
    if (!m) throw new Error(`fake dialect: only "INSERT INTO micro.specimen_isolate_counters (...) VALUES (...) ON CONFLICT (tenant_id, specimen_id) DO UPDATE SET last_seq = last_seq + 1 RETURNING last_seq" is allowed on the counter: ${sql.slice(0, 120)}`);
    const cols = m[1]!.split(',').map((c) => c.trim()); const vals = splitTop(m[2]!);
    if (cols.length !== vals.length) throw new Error('fake dialect: column/value count differs');
    const given: Row = {}; cols.forEach((c, i) => { given[c] = value(vals[i]!, params); });
    if (given['tenant_id'] == null || given['specimen_id'] == null) throw new Error('fake dialect: counter insert needs tenant_id and specimen_id');
    const hit = tbl('specimen_isolate_counters').find((r) => same(r['tenant_id'], given['tenant_id']) && same(r['specimen_id'], given['specimen_id']));
    const next = hit ? Number(hit['last_seq']) + 1 : Number(given['last_seq'] ?? 0);
    if (!(next >= 0 && next <= 99)) throw pgErr('23514', 'specimen_isolate_counters__seq__ck');
    if (hit) hit['last_seq'] = next; else tbl('specimen_isolate_counters').push({ ...given, last_seq: next });
    return [{ last_seq: next }];
  }

  const tx = {
    async query(sql: string, params: unknown[] = []): Promise<{ rows: Row[]; rowCount: number }> {
      const head = /^\s*(\w+)/.exec(sql)?.[1]?.toUpperCase();
      const table = /\b(?:FROM|INTO|UPDATE)\s+(?:micro\.)?(\w+)/i.exec(sql)?.[1];
      if (table === 'specimen_isolate_counters') {
        base.log.push({ sql, params, op: head === 'INSERT' ? 'INSERT' : head === 'UPDATE' ? 'UPDATE' : head === 'SELECT' ? 'SELECT' : 'OTHER', table });
        if (head !== 'INSERT') throw new Error(`fake dialect: ${head} on specimen_isolate_counters is not allowed (numbering = the single upsert, 08 A17 P-22)`);
        const rows = counter(sql, params); return { rows, rowCount: rows.length };
      }
      if (table === 'isolates' && (head === 'INSERT' || head === 'UPDATE')) {
        const snap = tbl('isolates').map((r) => ({ ...r })); const ids = new Set(snap.map((r) => r['id']));
        const out = await base.tx.query(sql, params);
        try {
          for (const r of tbl('isolates')) {
            const isNew = !ids.has(r['id']);
            if (isNew) { for (const [k, v] of Object.entries(ISOLATE_DEFAULTS())) if (!(k in r)) r[k] = v; }
            const before = snap.find((s) => s['id'] === r['id']);
            if (isNew || (before && JSON.stringify(before) !== JSON.stringify(r))) checkIsolate(r, before);
          }
        } catch (e) { w['isolates'] = snap; throw e; }
        const rows = out.rows.map((r) => ({ ...tbl('isolates').find((x) => x['id'] === r['id']), ...r }));
        return { rows, rowCount: rows.length };
      }
      return base.tx.query(sql, params);
    },
  };
  return { tx, log: base.log, world: w };
}
