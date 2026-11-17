// T0B-PERF-1 (done_when 3): test helpers that fail a list endpoint over its query budget or showing an N+1 pattern.
// Two views of the same rule:
//   1. runtime: analyzeStatements(texts) over the statements one request issued (fake pgbouncer log or a tx.query spy);
//   2. static : scanNPlusOne(source) finds a read query awaited inside a block loop / async map in a repository file.
// Synthetic data only. No dependency on the implementation: this file is the spec of the rule.

/** transaction plumbing, not the endpoint's queries (BEGIN/COMMIT/ROLLBACK/SAVEPOINT/RELEASE + the context set_config). */
const CONTROL = /^\s*(BEGIN|COMMIT|ROLLBACK|ABORT|SAVEPOINT|RELEASE|SET\s+LOCAL)\b/i;
const CONTEXT = /set_config\(\s*'request\.jwt\.claims'/i;

export const isControlStatement = (t: string): boolean => CONTROL.test(t) || CONTEXT.test(t);

/** literals and placeholders removed, so `WHERE id = $1`, `WHERE id = 'x'` and two different ids are one shape. */
export const normalizeSql = (t: string): string =>
  t.replace(/'(?:[^']|'')*'/g, '?').replace(/\$\d+/g, '?').replace(/\b\d+\b/g, '?').replace(/\s+/g, ' ').trim().toLowerCase();

export interface StatementReport {
  readonly count: number;
  /** shapes issued 3 or more times in one request (one query per row = N+1). */
  readonly repeated: ReadonlyArray<{ readonly shape: string; readonly times: number }>;
}

export const N_PLUS_ONE_MIN_REPEATS = 3;

export function analyzeStatements(texts: readonly string[]): StatementReport {
  const own = texts.filter((t) => !isControlStatement(t));
  const by = new Map<string, number>();
  for (const t of own) { const k = normalizeSql(t); by.set(k, (by.get(k) ?? 0) + 1); }
  return {
    count: own.length,
    repeated: [...by].filter(([, n]) => n >= N_PLUS_ONE_MIN_REPEATS).map(([shape, times]) => ({ shape, times })),
  };
}

/** Throws (fails the calling test) when a list endpoint issues more than `max` queries (default 4, the founder bar) or repeats a shape. */
export function expectListBudget(texts: readonly string[], opts: { max?: number; label?: string } = {}): StatementReport {
  const max = opts.max ?? 4;
  const r = analyzeStatements(texts);
  const label = opts.label ?? 'list endpoint';
  if (r.count > max) throw new Error(`${label}: ${r.count} queries for an empty list, budget is ${max}`);
  if (r.repeated.length > 0) throw new Error(`${label}: N+1 pattern, ${r.repeated.map((x) => `${x.times}x ${x.shape}`).join('; ')}`);
  return r;
}

export interface LoopHit { readonly line: number; readonly loop: string }

// a block loop (`for (...) {`, `for await (...) {`, `while (...) {`) or a map / forEach / flatMap with an async callback
const LOOP_OPEN = /^\s*(?:for|for\s+await|while)\s*\(.*\)\s*\{\s*$|\.(?:map|forEach|flatMap)\s*\(\s*async\b/;
const QUERY_AWAIT = /\bawait\s+(?:[\w$.?!]+\.)?(?:query|q)\s*\(/;
const STRINGS = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g;
const count = (s: string, ch: string): number => s.split(ch).length - 1;

/**
 * Static N+1 scan: a READ (SELECT / WITH within 3 lines of the awaited call) awaited inside a loop body.
 * Writes in a loop are batch work, not a list read, and are out of this rule. Comment lines are skipped.
 * ponytail: line and brace based, not an AST; a false hit is fixed by hoisting the query (= ANY($1)) or batching, never by editing this file.
 */
export function scanNPlusOne(source: string): LoopHit[] {
  const lines = source.split('\n');
  const hits: LoopHit[] = [];
  lines.forEach((opener, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(opener) || !LOOP_OPEN.test(opener)) return;
    // a bounded pointer-chain walk (merged_into_id, `hop` capped by MAX_HOPS) is one record followed link by link, not a query per row
    if (/\bhop\b/.test(opener)) return;
    let depth = 0;
    for (let j = i; j < Math.min(lines.length, i + 40); j++) {
      const t = lines[j]!.replace(STRINGS, '""').replace(/\/\/.*$/, '');
      if (j > i && depth > 0 && QUERY_AWAIT.test(t) && /\(\s*[^`'"(]*[`'"]\s*(select|with)\b/i.test(lines.slice(j, j + 2).join(' '))) {
        hits.push({ line: j + 1, loop: opener.trim() });
        return;
      }
      depth += count(t, '{') - count(t, '}');
      if (depth <= 0 && (j > i || count(t, '{') === 0)) return;
    }
  });
  return hits;
}
