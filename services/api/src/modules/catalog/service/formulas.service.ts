// Formula validation (02-TRD §7.1 validation list, §7.2 graph; PRD AC-04.1–04.8; 07-SECURITY S-1, S-14, AB-17) and #36 validateFormula (§5.2 row 36).
// `checkFormula` is shared by the analyte-version mutations (T-07 service: 422 catalog.formula_invalid) and the validate endpoint (200 valid:false).
// Reads only; every statement is tenant-scoped through repo.find. Graph = formula_dependencies of PUBLISHED versions (scheduled included; superseded / draft
// versions are history or not yet real), the candidate's own edges replacing the root's.
// [CONV] shared-ts via relative import until it is a services/api dependency (same as tests.service.ts).
import { evaluateFormula, formulaRefs, parseFormula, type FormulaAst, type Sex } from '../../../../../../packages/shared-ts/src/formula/index.js';
import { LimsError, type FieldError } from '../../../core/errors.js';
import { analyzeFormulaGraph } from '../domain/formulaGraph.js';
import * as lockRepo from '../repo/catalogState.repo.js';
import * as repo from '../repo/tests.repo.js';
import { fail, invalid, isObj, required, unknown as unknownField, UUID, type Ctx, type Tx } from './masters.service.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';

const MAX_CHAIN = 5;                                                 // §7.1 limits
const PATH = '/formula_expression';
const CODE_RE = /^[A-Z][A-Z0-9_]{0,31}$/;
const SELF = '(expression)';                                        // root code of an expression without analyte_id: not a legal analyte code, so it cannot collide
const IN_COLS = ['analyte_id', 'status', 'version_no', 'result_type', 'unit_code', 'effective_from', 'effective_to'];

const bad = (message: string, path = PATH): FieldError => ({ path, code: 'common.field_invalid', message });
const ms = (v: unknown) => new Date(v as string | Date).getTime();

export interface FormulaCheck {
  readonly errors: FieldError[];
  readonly ast?: FormulaAst;
  readonly normalised?: string;                                      // whitespace collapsed to single spaces (§7.1 Stored)
  readonly inputs: string[];                                         // refs in order of first appearance
  readonly inputIds: string[];                                       // analyte ids of the known inputs
  readonly inputUnits: Record<string, string | null>;                // unit of each input's version effective at `now`
  readonly dependencyOrder: string[];
  readonly chainDepth: number;
}

/** 422 catalog.formula_invalid. The Problem renderer only keeps errors[] for 400s, so the first message also travels as `detail`. */
export const formulaInvalid = (errors: FieldError[]) => new LimsError('catalog.formula_invalid', errors[0]?.message, errors);

/**
 * Validates `expression` as the candidate formula of the analyte with `code` (existing or new: the root of the graph); without a code the expression is its own root. `targetType` = the result type of the analyte that would carry the formula (AC-04.5), when known.
 */
export async function checkFormula(
  ctx: Pick<Ctx, 'tenantId' | 'tx'> & { now?: () => string },
  q: { expression: string; code?: string; targetType?: string },
): Promise<FormulaCheck> {
  const tx = ctx.tx as Tx, t = ctx.tenantId;
  const empty = (errors: FieldError[], inputs: string[] = []): FormulaCheck => ({ errors, inputs, inputIds: [], inputUnits: {}, dependencyOrder: [], chainDepth: 0 });

  const parsed = parseFormula(q.expression);
  if (parsed.errors.length || !parsed.ast) return empty(parsed.errors.map((e) => bad(`${e.code}: ${e.message}`)).slice(0, 50));
  const refs = [...formulaRefs(parsed.ast)];
  const errors: FieldError[] = [];

  if (q.targetType !== undefined && q.targetType !== 'numeric') errors.push(bad('formula analyte must be numeric'));

  // Inputs: active analytes of THIS tenant (a code of another tenant is as unknown as a made-up one, S-1).
  const found = refs.length ? await repo.find(tx, 'analytes', ['id', 'code', 'is_active'], t, {}, { anyOf: { col: 'code', values: refs } }) : [];
  const byCode = new Map<string, any>(found.map((a) => [a.code as string, a]));
  const known = refs.filter((c) => byCode.get(c)?.is_active === true);
  for (const c of refs) if (!known.includes(c)) errors.push(bad(`unknown analyte code ${c}`));

  // Result types (latest published version, else the open draft) and the unit effective now, in one read.
  const versions = known.length ? await repo.find(tx, 'analyte_versions', IN_COLS, t, {}, { anyOf: { col: 'analyte_id', values: known.map((c) => byCode.get(c).id as string) } }) : [];
  const now = ms(ctx.now?.() ?? new Date().toISOString());
  const inputUnits: Record<string, string | null> = {};
  for (const code of known) {
    const mine = versions.filter((v) => v.analyte_id === byCode.get(code).id);
    const latest = mine.filter((v) => v.status === 'published').sort((a, b) => Number(b.version_no) - Number(a.version_no))[0] ?? mine.find((v) => v.status === 'draft');
    // ponytail: every non-numeric input is rejected; TRD §7.1 exempts inputs used only in comparisons — needs AST node kinds from shared-ts
    if (latest && latest.result_type !== 'numeric') errors.push(bad(`analyte ${code} is not numeric`));
    const eff = mine.find((v) => v.status !== 'draft' && ms(v.effective_from) <= now && (v.effective_to == null || ms(v.effective_to) > now));
    inputUnits[code] = (eff?.unit_code as string | undefined) ?? null;
  }

  // Graph.
  const rootCode = q.code ?? SELF;
  const edges = await loadEdges(tx, t);
  const g = analyzeFormulaGraph({ root: rootCode, rootInputs: refs, edges });
  let dependencyOrder: string[] = [], chainDepth = 0;
  if (g.cycle) errors.push(bad(`cycle: ${g.cycle.join(' -> ')}`));
  else {
    chainDepth = g.chainDepth; dependencyOrder = g.dependencyOrder.filter((c) => c !== rootCode);
    if (chainDepth > MAX_CHAIN) errors.push(bad(`formula chain too deep (max ${MAX_CHAIN})`));
  }
  // Cycle errors first: they are the ones the author has to act on (AC-04.3).
  errors.sort((a, b) => Number(b.message.startsWith('cycle:')) - Number(a.message.startsWith('cycle:')));

  return {
    errors: errors.slice(0, 50), ast: parsed.ast, normalised: q.expression.replace(/\s+/g, ' ').trim(), inputs: refs,
    inputIds: known.map((c) => byCode.get(c).id as string), inputUnits, dependencyOrder, chainDepth,
  };
}

/** code -> input codes for every analyte whose PUBLISHED version (current or scheduled) has formula_dependencies. ponytail: whole-tenant read, fine at catalog scale. */
async function loadEdges(tx: Tx, t: string): Promise<Map<string, string[]>> {
  const rows = await repo.find(tx, 'formula_dependencies', ['analyte_version_id', 'analyte_id', 'input_analyte_id'], t, {});
  if (!rows.length) return new Map();
  const vids = [...new Set(rows.map((r) => r.analyte_version_id as string))];
  const live = new Set((await repo.find(tx, 'analyte_versions', ['id', 'status'], t, {}, { ids: vids })).filter((v) => v.status === 'published').map((v) => v.id as string));
  const used = rows.filter((r) => live.has(r.analyte_version_id));
  const ids = [...new Set(used.flatMap((r) => [r.analyte_id as string, r.input_analyte_id as string]))];
  const code = new Map((ids.length ? await repo.find(tx, 'analytes', ['id', 'code'], t, {}, { ids }) : []).map((a) => [a.id as string, a.code as string]));
  const edges = new Map<string, string[]>();
  for (const r of used) {
    const from = code.get(r.analyte_id), to = code.get(r.input_analyte_id);
    if (from && to) edges.set(from, [...(edges.get(from) ?? []), to]);
  }
  return edges;
}

/** Serialises formula publishes of a tenant before the graph is read, so two publishes cannot close a cycle together. Same lock the revision bump takes last. */
export async function lockFormulaGraph(ctx: Pick<Ctx, 'tenantId' | 'tx' | 'actor'>): Promise<void> {
  const tx = ctx.tx as Tx;
  if (await lockRepo.lockState(tx, ctx.tenantId)) return;
  await lockRepo.ensureState(tx, ctx.tenantId, uuidv7(), ctx.actor.id);
  await lockRepo.lockState(tx, ctx.tenantId);
}

// ---------------------------------------------------------------------------------------------------------------- #36
const KEYS = ['analyte_id', 'expression', 'sample_inputs', 'sample_context'], CTX_KEYS = ['age_days', 'sex'];
const SEX = ['male', 'female', 'other', 'unknown'];

function parseRequest(body: unknown) {
  if (!isObj(body)) return fail([body === undefined ? required('/expression') : invalid('')]);
  const errors: FieldError[] = [];
  for (const k of Object.keys(body)) if (body[k] !== undefined && !KEYS.includes(k)) errors.push(unknownField(`/${k}`));
  const { analyte_id: id, expression, sample_inputs: raw, sample_context: sc } = body;
  if (id !== undefined && !(typeof id === 'string' && UUID.test(id))) errors.push(invalid('/analyte_id'));
  if (typeof expression !== 'string' || expression.length < 1 || expression.length > 500) errors.push(invalid('/expression'));
  let sample: Record<string, string> | undefined;
  if (raw !== undefined) {
    if (typeof raw !== 'string' || raw.length > 4000) errors.push(invalid('/sample_inputs'));
    else {
      let j: unknown;
      try { j = JSON.parse(raw); } catch { j = undefined; }
      if (!isObj(j)) errors.push(invalid('/sample_inputs'));
      else sample = Object.fromEntries(Object.entries(j).filter((e): e is [string, string] => CODE_RE.test(e[0]) && typeof e[1] === 'string'));   // codes only: no prototype keys, no non-strings
    }
  }
  let ageDays: number | undefined, sex: Sex = 'unknown';
  if (sc !== undefined) {
    if (!isObj(sc)) errors.push(invalid('/sample_context'));
    else {
      for (const k of Object.keys(sc)) if (sc[k] !== undefined && !CTX_KEYS.includes(k)) errors.push(unknownField(`/sample_context/${k}`));
      const a = sc['age_days'], s = sc['sex'];
      if (a !== undefined && !(typeof a === 'number' && Number.isInteger(a) && a >= 0 && a <= 73_000)) errors.push(invalid('/sample_context/age_days'));
      if (s !== undefined && !(typeof s === 'string' && SEX.includes(s))) errors.push(invalid('/sample_context/sex'));
      if (typeof a === 'number') ageDays = a;
      if (typeof s === 'string') sex = s as Sex;
    }
  }
  if (errors.length) fail(errors);
  return { analyteId: id as string | undefined, expression: expression as string, sample, ageDays, sex };
}

export function createFormulasService() {
  return {
    /** #36 — read-only; an invalid formula is a 200 with valid:false (only mutations answer 422). Sample values are never logged or echoed. */
    async validateFormula(ctx: Pick<Ctx, 'tenantId' | 'tx'> & { now?: () => string }, body: unknown) {
      const q = parseRequest(body);
      const tx = ctx.tx as Tx, t = ctx.tenantId;
      let code: string | undefined, targetType: string | undefined;
      if (q.analyteId) {
        const [a] = await repo.find(tx, 'analytes', ['id', 'code'], t, { id: q.analyteId });
        if (!a) throw new LimsError('common.not_found');
        code = a.code as string;
        const vs = await repo.find(tx, 'analyte_versions', ['status', 'version_no', 'result_type'], t, { analyte_id: q.analyteId });
        targetType = (vs.find((v) => v.status === 'draft') ?? vs.filter((v) => v.status === 'published').sort((x, y) => Number(y.version_no) - Number(x.version_no))[0])?.result_type;
      }
      const r = await checkFormula(ctx, { expression: q.expression, ...(code ? { code } : {}), ...(targetType ? { targetType } : {}) });
      const out: Record<string, unknown> = {
        valid: r.errors.length === 0, input_analyte_codes: r.inputs.slice(0, 50), dependency_order: r.dependencyOrder.slice(0, 50),
        chain_depth: Math.min(r.chainDepth, 100), errors: r.errors,
      };
      if (r.errors.length === 0 && r.ast && q.sample) {
        // ponytail: @age_years = whole years of age_days / 365.25 (calendar-exact age comes with the real birth date in C5)
        const res = evaluateFormula(r.ast, q.sample, { sex: q.sex, ...(q.ageDays === undefined ? {} : { ageDays: q.ageDays, ageYears: Math.floor(q.ageDays / 365.25) }) });
        if (res.ok) out['sample_result'] = res.value; else out['sample_not_computable_reason'] = res.reason.slice(0, 200);
      }
      return out;
    },
  };
}
