// Shared helpers for the anatomic repos. No SQL statements live here (each repo keeps its own, so tenant_id is visible in every one).

/** A table row / insert input: snake_case column names as in 05-SCHEMA §6. */
export type Row = Record<string, any>;

/** jsonb parameter: pg would send a JS array as a PG array literal, so serialise explicitly. */
export const json = (v: unknown): string | null => (v === undefined || v === null ? null : JSON.stringify(v));

const DEFAULT_LIMIT = 200, MAX_LIMIT = 500;

/** Bounded LIMIT/OFFSET from untrusted-ish input. */
export function page(i: { limit?: unknown; offset?: unknown }): { limit: number; offset: number } {
  const limit = Math.trunc(Number(i.limit ?? DEFAULT_LIMIT));
  const offset = Math.trunc(Number(i.offset ?? 0));
  return {
    limit: Number.isFinite(limit) && limit >= 1 ? Math.min(limit, MAX_LIMIT) : DEFAULT_LIMIT,
    offset: Number.isFinite(offset) && offset >= 0 ? offset : 0,
  };
}

/**
 * `SET` list for an UPDATE from a patch. Column names come ONLY from `allowed` (never from the caller), so the
 * generated text is a fixed identifier list; values are bound from `first` upward. A value of undefined is skipped;
 * an unknown column or an empty patch throws (programmer error, not user input).
 */
export function setClause(patch: Row, allowed: Readonly<Record<string, string>>, first: number): [string, unknown[]] {
  const sets: string[] = [], args: unknown[] = [];
  for (const [col, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (!Object.hasOwn(allowed, col)) throw new Error(`anatomic repo: column '${col}' is not updatable`);
    const cast = allowed[col] === 'jsonb' ? '::jsonb' : '';
    sets.push(`${col} = $${first + args.length}${cast}`);
    args.push(allowed[col] === 'jsonb' ? json(v) : v);
  }
  if (sets.length === 0) throw new Error('anatomic repo: empty patch');
  return [sets.join(', '), args];
}
