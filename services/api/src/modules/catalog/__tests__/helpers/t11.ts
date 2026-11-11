// T-11 (C3) shared fixtures: formula analytes over the T-07 SQL fake (helpers/t7.ts). Synthetic data only. No new seam of its own — it only builds seed rows.
// A "formula node" = an analyte + its PUBLISHED version carrying formula_expression / formula_inputs + the formula_dependencies edges written at its publish (02-TRD §7.2 step 6).
import { TENANT_A, USER } from './catalogDb.js';
import { CBC, HB, MICRO, RBC, T0, T1, ana, draftOf, pubOf, setup7, type Env7 } from './t7.js';
import type { Row } from './testsDb.js';

export type { Env7, Row };
export { CBC, HB, MICRO, RBC, T0, T1, draftOf, pubOf, setup7 };
export const A = TENANT_A;

/** A leaf analyte (numeric, published v1, no formula). `n` must be unique per world (ids 0x3000+n / 0x4000+n); the base world uses 1–4 and T-09 21–23. */
export const leaf = (n: number, code: string, o: Row = {}): { analyte: Row; version: Row; edges: Row[] } => {
  const analyte = ana(n, A, (o['test'] as Row | undefined)?.['id'] as string ?? CBC.test.id as string, { code, name: code, ...(o['analyte'] as Row ?? {}) });
  const version = pubOf(n, analyte.id as string, { unit_code: 'u_' + n, method_id: null, decimals: 1, ...(o['version'] as Row ?? {}) });
  return { analyte, version, edges: [] };
};

/** A published formula analyte reading `inputs` (rows from leaf()/fnode()/HB/RBC). */
export const fnode = (n: number, code: string, expr: string, inputs: ReadonlyArray<{ id?: unknown; code?: unknown; analyte?: Row }>, o: Row = {}) => {
  const base = leaf(n, code, { ...o, version: { formula_expression: expr, formula_inputs: inputs.map((i) => (i.analyte ?? i).code), decimals: 2, ...(o['version'] as Row ?? {}) } });
  const edges = inputs.map((i) => ({ tenant_id: A, analyte_version_id: base.version['id'], analyte_id: base.analyte.id, input_analyte_id: (i.analyte ?? i).id, created_by: USER }));
  return { ...base, edges };
};

type Node = { analyte: Row; version: Row; edges: Row[] };
/** Seed rows for setup7({ t6 }) from nodes + extras. */
export const rowsOf = (nodes: Node[], extra: { versions?: Row[]; edges?: Row[]; analytes?: Row[] } = {}) => ({
  analytes: [...nodes.map((x) => x.analyte), ...(extra.analytes ?? [])],
  analyte_versions: [...nodes.map((x) => x.version), ...(extra.versions ?? [])],
  formula_dependencies: [...nodes.flatMap((x) => x.edges), ...(extra.edges ?? [])],
});
export const world = (nodes: Node[], extra: { versions?: Row[]; edges?: Row[]; analytes?: Row[] } = {}): Env7 => setup7({ t6: rowsOf(nodes, extra) as never });

/** Chain C1 = LEAF + 1, C2 = C1 + 1, … C<len> (depth of C<k> is k formula analytes). Ids start at `from`. */
export const chain = (from: number, len: number, leafNode: { analyte: Row }) => {
  const nodes: Node[] = [];
  for (let k = 1; k <= len; k++) {
    const prev = k === 1 ? leafNode : nodes[k - 2]!;
    nodes.push(fnode(from + k, `C${k}`, `${prev.analyte['code']} + 1`, [prev.analyte]));
  }
  return nodes;
};

/** Everything a rejected / read-only call must leave untouched. */
export const snap = (db: Env7['db']) => JSON.stringify({
  a: db.rows('analytes'), v: db.rows('analyte_versions'), d: db.rows('formula_dependencies'), o: db.rows('orderables'), n: db.events.length, r: db.revisionOf(A),
});
export const writes = (db: Env7['db']) => db.stmts.filter((s) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(s.text));
