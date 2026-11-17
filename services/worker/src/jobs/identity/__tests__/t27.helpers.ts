// C2-T27 shared test doubles (synthetic data only). Seams ASSUMED where the spec is silent: see the header of each T27 test file.
import { vi } from 'vitest';
import { LimsError } from '../../../../../api/src/core/errors.js';
import { ACTOR, TENANT, idN, makeCtx } from './t11.helpers.js';

export { ACTOR, LimsError, TENANT, idN };
export const OTHER = idN(0xa2);
export const NPT_OFFSET_MS = (5 * 60 + 45) * 60_000;   // Asia/Kathmandu = UTC+05:45, no DST (08 A13 P-15)

export type Rule = (sql: string, values: unknown[]) => unknown[] | undefined;
/** A tx double: records every statement (whitespace-normalised); `rules` answer SELECT-like statements, anything else returns no rows. */
export function makeTx(rules: Rule[] = [], failOn?: { match: RegExp; error: () => unknown }) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const query = vi.fn(async (text: string, values: unknown[] = []) => {
    const sql = text.replace(/\s+/g, ' ').trim(); calls.push({ sql, values });
    if (failOn?.match.test(sql)) throw failOn.error();
    for (const r of rules) { const rows = r(sql, values); if (rows) return { rows, rowCount: rows.length }; }
    return { rows: [], rowCount: 0 };
  });
  return { tx: { query }, calls, sqls: () => calls.map((c) => c.sql) };
}

/** JobContext double with an injectable clock, tx and storage. `tenantId` undefined = platform job. */
export function ctx27(o: { tenantId?: string | undefined; now?: string; tx?: unknown; storage?: unknown } = {}) {
  const base = makeCtx({ tenantId: o.tenantId });
  const ctx = base.ctx;
  if (o.now) ctx.now = () => o.now!;
  if (o.tx) ctx.tx = o.tx;
  ctx.storage = o.storage ?? { delete: vi.fn(async () => undefined), put: vi.fn(), read: vi.fn() };
  return { ...base, ctx };
}

export const err = (p: Promise<unknown>): Promise<any> => p.then(() => undefined, (e) => e);
