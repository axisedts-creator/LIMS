// C6-T03 test helpers (not a test file). Synthetic data only.
// An in-memory fake of ONE Postgres transaction for the reporting settings tables. It models, by SQL CONTENT (never by statement position):
//   - equality predicates `col = $n` (also `t.col = $n::uuid`) as row filters for SELECT / UPDATE  -> optimistic locking (`version = $n`) and the
//     explicit tenant predicate (REQ-SEC-024) are observable: a statement WITHOUT a tenant predicate sees / changes ALL tenants' rows (RLS is deliberately off here)
//   - INSERT ... VALUES (...) [, (...)] with $n params, DEFAULT, now(), true/false/number literals; ON CONFLICT DO NOTHING / DO UPDATE SET; unique keys
//     (a plain INSERT hitting a unique key raises 23505, as the real table does); DDL defaults of 05-SCHEMA §6
//   - FKs to core.collection_centres / core.memberships / catalog.doctors (23503) and a per-test RLS denial list for centres (42501)
//   - lims_app has NO DELETE grant on these tables (05-SCHEMA §6.3) -> DELETE raises 42501
// Anything else (set_config, advisory locks, ...) answers []. INSERT must use VALUES lists with $n parameters (documented in .orchestra/notes/C6-T03-tests.md).

export const TENANT_A = '0190a000-0000-7000-8000-00000000aaaa';
export const TENANT_B = '0190a000-0000-7000-8000-00000000bbbb';
export const USER = '0190a000-0000-7000-8000-000000004001';
export const MEM = '0190a000-0000-7000-8000-000000003001';
export const REQ_ID = '0190a000-0000-7000-8000-0000000000f1';
export const idN = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
export const CENTRE_A1 = idN(0xc1);
export const CENTRE_A2 = idN(0xc2);
export const CENTRE_B1 = idN(0xcb);
export const DOCTOR_A = idN(0xd1);
export const DOCTOR_B = idN(0xdb);
export const MEM_SIGNER = idN(0x3101);   // holds lab.result.approve
export const MEM_NARR = idN(0x3102);     // holds reporting.narrative.sign
export const MEM_CLERK = idN(0x3103);    // holds neither
export const MEM_B = idN(0x31b0);        // tenant B member
export const SENTINEL = 'ADDR-SENTINEL-77';

export type Row = Record<string, any>;
export const pgError = (code: string, message = 'db error', constraint?: string) => Object.assign(new Error(message), { code, constraint });

export const SETTINGS_DEFAULTS = Object.freeze({
  auto_release: 'when_eligible', narrative_report_mode: 'separate', patient_mobile_channel_order: ['whatsapp', 'sms'], patient_email_enabled: true,
  referrer_delivery_enabled: true, referrer_channels: ['sms'], centre_delivery_enabled: false, whatsapp_fallback_minutes: 30,
  critical_alert_referrer_enabled: true, bulk_release_max: 200, print_critical_label: false, link_reissue_max_per_day: 3,
  dues_link_enabled: true, portal_payment_gateways: [] as string[], version: 1,
});

const DDL_DEFAULTS: Record<string, Row> = {
  settings: { ...SETTINGS_DEFAULTS, is_active: true },
  staff_assignments: { sort_order: 0, version: 1, is_active: true },
  centre_contacts: { label: null, version: 1, is_active: true },
  referrer_preferences: { disabled_channels: [], version: 1, is_active: true },
  cs_reasons: { system: 'tenant', system_version: '1', sort_order: 0, version: 1, is_active: true },
};
const UNIQUE: Record<string, string[][]> = {
  settings: [['tenant_id']],
  staff_assignments: [['tenant_id', 'assignment', 'membership_id']],
  referrer_preferences: [['tenant_id', 'referrer_id']],
  cs_reasons: [['tenant_id', 'set_name', 'code']],
  centre_contacts: [],
};
const TABLES = ['settings', 'staff_assignments', 'centre_contacts', 'referrer_preferences', 'cs_reasons', 'g_cs_reasons'] as const;

export interface Seed {
  settings?: Row[]; staff_assignments?: Row[]; centre_contacts?: Row[]; referrer_preferences?: Row[]; cs_reasons?: Row[]; g_cs_reasons?: Row[];
  centres?: Row[]; memberships?: Row[]; doctors?: Row[];
}
export interface Stmt { readonly text: string; readonly values: readonly unknown[]; readonly verb: string }

const pOf = (s: string) => /\$(\d+)/.exec(s)?.[1];
function topLevelGroups(s: string): string[] {   // "(a,b),(c,d)" -> ["a,b","c,d"]
  const out: string[] = []; let depth = 0; let cur = '';
  for (const ch of s) {
    if (ch === '(') { if (depth++ === 0) { cur = ''; continue; } }
    else if (ch === ')') { if (--depth === 0) { out.push(cur); continue; } }
    if (depth > 0) cur += ch;
  }
  return out;
}
function splitComma(s: string): string[] {
  const out: string[] = []; let d = 0; let q = false; let cur = '';
  for (const ch of s) {
    if (ch === "'") q = !q;
    if (!q && ch === '(') d++;
    if (!q && ch === ')') d--;
    if (!q && d === 0 && ch === ',') { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export function makeDb(seed: Seed = {}, opts: { deniedCentres?: string[]; failOn?: Array<{ match: RegExp; error: () => Error }> } = {}) {
  const store: Record<string, Row[]> = {};
  for (const t of TABLES) store[t] = (seed[t] ?? []).map((r) => ({ ...(DDL_DEFAULTS[t] ?? {}), ...r }));
  const centres = seed.centres ?? [{ id: CENTRE_A1, tenant_id: TENANT_A }, { id: CENTRE_A2, tenant_id: TENANT_A }, { id: CENTRE_B1, tenant_id: TENANT_B }];
  const memberships = seed.memberships ?? [MEM, MEM_SIGNER, MEM_NARR, MEM_CLERK].map((id) => ({ id, tenant_id: TENANT_A })).concat([{ id: MEM_B, tenant_id: TENANT_B }]);
  const doctors = seed.doctors ?? [{ id: DOCTOR_A, tenant_id: TENANT_A }, { id: DOCTOR_B, tenant_id: TENANT_B }];
  const stmts: Stmt[] = [];

  const eqFilters = (where: string, values: readonly unknown[]) =>
    [...where.matchAll(/(?:\b\w+\.)?(\w+)\s*=\s*\$(\d+)(?:::\w+)?/g)].map((m) => [m[1]!, values[Number(m[2]) - 1]] as const)
      .filter(([, v]) => v !== null && v !== undefined);   // optional filters (`$n IS NULL OR col = $n`) with a NULL argument do not narrow
  const matches = (r: Row, f: ReadonlyArray<readonly [string, unknown]>) => f.every(([c, v]) => !(c in r) || r[c] === v);
  const hasTenantPred = (f: ReadonlyArray<readonly [string, unknown]>) => f.some(([c]) => c === 'tenant_id');
  const tenantOf = (values: readonly unknown[]) => values.find((v) => v === TENANT_A || v === TENANT_B) as string | undefined;

  function fk(table: string, row: Row) {
    const exists = (rows: Row[], id: unknown) => rows.some((x) => x.id === id && x.tenant_id === row.tenant_id);
    if (table === 'centre_contacts' && !exists(centres, row.centre_id)) throw pgError('23503', 'fk centre');
    if (table === 'staff_assignments' && !exists(memberships, row.membership_id)) throw pgError('23503', 'fk membership');
    if (table === 'referrer_preferences' && !exists(doctors, row.referrer_id)) throw pgError('23503', 'fk referrer');
    if (table === 'centre_contacts' && opts.deniedCentres?.includes(row.centre_id)) throw pgError('42501', 'rls');
  }
  const uniqueHit = (table: string, row: Row) =>
    store[table]!.find((e) => (UNIQUE[table] ?? []).some((cols) => cols.every((c) => e[c] === row[c])));

  function exec(text: string, values: readonly unknown[]): Row[] {
    for (const f of opts.failOn ?? []) if (f.match.test(text)) throw f.error();
    const verb = (/^\s*(select|insert|update|delete)/i.exec(text)?.[1] ?? 'other').toLowerCase();
    const bothCs = /\bg_cs_reasons\b/.test(text) && /(?<![g_\w])cs_reasons\b/.test(text);
    if (verb === 'select' && bothCs) {                       // a correct single-statement merge: tenant rows shadow global rows by code
      const t = tenantOf(values); const set = values.find((v) => typeof v === 'string' && /_reasons$/.test(v));
      const g = store['g_cs_reasons']!.filter((r) => !set || r['set_name'] === set);
      const tn = store['cs_reasons']!.filter((r) => r['tenant_id'] === t && (!set || r['set_name'] === set));
      const byCode = new Map<string, Row>(g.map((r) => [r['code'], r]));
      for (const r of tn) byCode.set(r['code'], r);
      return [...byCode.values()].filter((r) => r['is_active']).sort((a, b) => a['sort_order'] - b['sort_order'] || a['code'].localeCompare(b['code'])).map((r) => ({ ...r }));
    }
    const table = /(?:from|into|update)\s+reporting\.(\w+)/i.exec(text)?.[1];
    if (!table || !(table in store)) return [];
    const rows = store[table]!;
    if (verb === 'delete') throw pgError('42501', 'permission denied: no DELETE grant');
    if (verb === 'select') {
      const where = /\bwhere\b([\s\S]*)$/i.exec(text)?.[1] ?? '';
      const f = eqFilters(where, values);
      let out = rows.filter((r) => matches(r, f));
      if (/\bis_active\s*(=\s*true|\b)/i.test(where) && !/\bis_active\s*=\s*\$/i.test(where)) out = out.filter((r) => r['is_active'] !== false);
      return out.map((r) => ({ ...r }));
    }
    if (verb === 'update') {
      const m = /\bset\b([\s\S]*?)\bwhere\b([\s\S]*)$/i.exec(text);
      if (!m) throw new Error('FAKE-UNSUPPORTED-SQL: UPDATE without WHERE');
      const f = eqFilters(m[2]!, values);
      const hit = rows.filter((r) => matches(r, f));
      for (const r of hit) applySet(r, m[1]!, values);
      return /\breturning\b/i.test(text) ? hit.map((r) => ({ ...r })) : [];
    }
    if (verb === 'insert') {
      const m = /into\s+reporting\.\w+\s*\(([^)]*)\)\s*values\s*([\s\S]*?)(?:\bon\s+conflict\b([\s\S]*?))?(?:\breturning\b[\s\S]*)?$/i.exec(text);
      if (!m) throw new Error('FAKE-UNSUPPORTED-SQL: INSERT must be `INSERT INTO reporting.t (cols) VALUES ($1, ...)`');
      const cols = m[1]!.split(',').map((c) => c.trim());
      const out: Row[] = [];
      for (const g of topLevelGroups(m[2]!)) {
        const toks = splitComma(g);
        const row: Row = { ...(DDL_DEFAULTS[table] ?? {}) };
        cols.forEach((c, i) => { const t = toks[i]!; if (/^default$/i.test(t)) return; row[c] = tokenValue(t, values); });
        fk(table, row);
        const dup = uniqueHit(table, row);
        if (dup) {
          const oc = m[3];
          if (!oc) throw pgError('23505', 'duplicate key', 'unique');
          if (/do\s+nothing/i.test(oc)) continue;
          applySet(dup, /do\s+update\s+set([\s\S]*)$/i.exec(oc)?.[1] ?? '', values, row);
          out.push({ ...dup });
        } else { rows.push(row); out.push({ ...row }); }
      }
      return /\breturning\b/i.test(text) ? out : [];
    }
    return [];
  }
  function tokenValue(t: string, values: readonly unknown[]): unknown {
    const p = pOf(t); if (p) return values[Number(p) - 1];
    if (/^now\(\)$/i.test(t)) return '2026-11-07T12:00:00.000Z';
    if (/^true$/i.test(t)) return true; if (/^false$/i.test(t)) return false;
    if (/^-?\d+$/.test(t)) return Number(t);
    return t.replace(/^'|'$/g, '');
  }
  function applySet(r: Row, set: string, values: readonly unknown[], excluded?: Row) {
    for (const a of splitComma(set.replace(/\bwhere\b[\s\S]*$/i, ''))) {
      const m = /^(?:\w+\.)?(\w+)\s*=\s*([\s\S]+)$/.exec(a); if (!m) continue;
      const [, col, rhs] = m as unknown as [string, string, string];
      if (/^(?:[\w.]+\.)?version\s*\+\s*1$/i.test(rhs.trim())) r[col] = (r[col] ?? 0) + 1;
      else if (/^excluded\.(\w+)/i.test(rhs.trim())) r[col] = excluded?.[/^excluded\.(\w+)/i.exec(rhs.trim())![1]!];
      else if (/^coalesce\(\s*\$(\d+)/i.test(rhs.trim())) { const v = values[Number(/^coalesce\(\s*\$(\d+)/i.exec(rhs.trim())![1]) - 1]; if (v !== null && v !== undefined) r[col] = v; }
      else if (!/\(/.test(rhs) || /^\$\d+/.test(rhs.trim())) r[col] = tokenValue(rhs.trim().replace(/::\w+(\[\])?$/, ''), values);
    }
  }

  const tx = {
    startedAt: new Date('2026-11-07T12:00:00.000Z'),
    async query(text: string, values: unknown[] = []) {
      const verb = (/^\s*(select|insert|update|delete)/i.exec(text)?.[1] ?? 'other').toLowerCase();
      stmts.push({ text, values: [...values], verb });
      return { rows: exec(text, values) };
    },
    savepoint: async <T>(fn: (t: unknown) => Promise<T>): Promise<T> => fn(tx),
  };
  return {
    tx, stmts, store,
    writes: () => stmts.filter((s) => ['insert', 'update', 'delete'].includes(s.verb)),
    reporting: () => stmts.filter((s) => /\breporting\./i.test(s.text)),
    allValues: () => stmts.flatMap((s) => s.values),
  };
}

export function makeCtx(db: ReturnType<typeof makeDb>, over: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT_A, actor: { type: 'user', id: USER, membershipId: MEM }, requestId: REQ_ID, tx: db.tx,
    now: () => '2026-11-07T12:00:00.000Z', ports: {}, ...over,
  } as any;
}

/** membership id -> permission codes (tenant-scoped like core.membershipPermissions). */
export function makeCore(perms: Record<string, string[]> = {
  [MEM_SIGNER]: ['lab.result.approve'], [MEM_NARR]: ['reporting.narrative.sign'], [MEM_CLERK]: ['frontdesk.order.create'], [MEM]: ['reporting.settings.manage'],
}) {
  const calls: string[] = [];
  return { calls, async membershipPermissions(_ctx: unknown, input: { membershipId: string }): Promise<readonly string[]> { calls.push(input.membershipId); return perms[input.membershipId] ?? []; } };
}

let n = 0x7000;
export const counterId = () => idN(++n);

export const rejection = async (p: Promise<unknown>): Promise<any> => { try { await p; } catch (e) { return e; } throw new Error('expected rejection, got success'); };
export const isDbDenied = (e: any) => e?.code === 'common.not_found' || e?.code === '23503' || e?.code === '42501';
