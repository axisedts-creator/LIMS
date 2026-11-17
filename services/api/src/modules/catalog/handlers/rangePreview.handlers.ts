// #51 previewReferenceRange (02-TRD §5.2 row 51, §7.3 steps 1–7, 08 A17.1; PRD AC-05.1–05.6, 05.8, 05.10, 05.11; 07-SECURITY S-4, S-5, REQ-SEC-080).
// Read-only POST: the core pipeline owns auth and the catalog.test.read floor; this handler validates its own strict body (defence in depth), loads the analyte's
// sets / versions / bands (explicit tenant_id predicate on every statement) and delegates the matching to the pure domain/rangeMatch. It writes nothing and emits nothing.
// Unknown analyte, another tenant's analyte and an unknown specimen_type_code are all 404 common.not_found (no existence oracle). `age_days` absent = age unknown (A17.1).
import { LimsError, type FieldError } from '../../../core/errors.js';
import type { Handler, HandlerContext, HandlerRequest } from '../../../core/module.js';
import { resolveCriticalLimits, resolveReferenceRange, selectSet } from '../domain/rangeMatch.js';
import * as repo from '../repo/tests.repo.js';
import { fail, invalid, isObj, unknown as unknownField, UUID, type Ctx, type Tx } from '../service/masters.service.js';

const KEYS = ['analyte_id', 'sex', 'age_days', 'birth_on', 'specimen_type_code', 'at'];
const SEX = ['male', 'female', 'other', 'unknown'];
const SPECIMEN = /^[A-Z0-9][A-Z0-9_]{0,31}$/, ISO_DATE = /^\d{4}-\d{2}-\d{2}$/, ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SET_COLS = ['id', 'version_no', 'status', 'unit_code', 'method_id', 'effective_from', 'effective_to'];
const VER_COLS = ['status', 'unit_code', 'method_id', 'effective_from', 'effective_to'];
const BAND_COLS = ['id', 'set_id', 'sex', 'age_low_value', 'age_low_unit', 'age_high_value', 'age_high_unit', 'specimen_type_id', 'low', 'high', 'sort_order'];
const REF_COLS = [...BAND_COLS, 'kind', 'normal_codes', 'display_text'], CRIT_COLS = [...BAND_COLS, 'abnormal_codes'];

const validDate = (s: string) => ISO_DATE.test(s) && new Date(`${s}T00:00:00.000Z`).toJSON()?.startsWith(s) === true;   // toJSON() = null for an impossible date
const validInstant = (s: string) => ISO_UTC.test(s) && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString() === s;

function parse(body: unknown) {
  if (!isObj(body)) return fail([invalid('')]);
  const errors: FieldError[] = [];
  for (const k of Object.keys(body)) if (body[k] !== undefined && !KEYS.includes(k)) errors.push(unknownField(`/${k}`));
  const { analyte_id: id, sex, age_days: age, birth_on: birth, specimen_type_code: spec, at } = body;
  if (typeof id !== 'string' || !UUID.test(id)) errors.push(invalid('/analyte_id'));
  if (typeof sex !== 'string' || !SEX.includes(sex)) errors.push(invalid('/sex'));
  if (age !== undefined && !(typeof age === 'number' && Number.isInteger(age) && age >= 0 && age <= 73_000)) errors.push(invalid('/age_days'));
  if (birth !== undefined && !(typeof birth === 'string' && validDate(birth))) errors.push(invalid('/birth_on'));
  if (spec !== undefined && !(typeof spec === 'string' && SPECIMEN.test(spec))) errors.push(invalid('/specimen_type_code'));
  if (at !== undefined && !(typeof at === 'string' && validInstant(at))) errors.push(invalid('/at'));
  if (errors.length) fail(errors);
  return { analyteId: id as string, sex: sex as string, ageDays: age as number | undefined, birthOn: birth as string | undefined, specimenCode: spec as string | undefined, at: at as string | undefined };
}

const dto = (o: Record<string, unknown>, names: Record<string, string>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [names[k] ?? k, v]));
const REF_NAMES = { referenceRangeId: 'reference_range_id', unitCode: 'unit_code', normalCodes: 'normal_codes' };
const CRIT_NAMES = { criticalLimitId: 'critical_limit_id', abnormalCodes: 'abnormal_codes' };

export const rangePreviewHandlers: Readonly<Record<string, Handler>> = Object.freeze({
  previewReferenceRange: (async (req: HandlerRequest, hctx: HandlerContext) => {
    const c = hctx as unknown as Partial<Ctx>;
    if (typeof c.tenantId !== 'string' || !c.tx) throw new LimsError('auth.unauthenticated');
    const tx = c.tx as Tx, t = c.tenantId;
    const q = parse(req.body);
    const at = q.at ?? c.now?.() ?? new Date().toISOString();

    const [analyte] = await repo.find(tx, 'analytes', ['id'], t, { id: q.analyteId });
    if (!analyte) throw new LimsError('common.not_found');
    let specimenTypeId: string | undefined;
    if (q.specimenCode !== undefined) {
      const [s] = await repo.find(tx, 'specimen_types', ['id'], t, { code: q.specimenCode });
      if (!s) throw new LimsError('common.not_found');
      specimenTypeId = s.id as string;
    }
    const query = { sex: q.sex, at, ...(q.ageDays === undefined ? {} : { ageDays: q.ageDays }), ...(q.birthOn === undefined ? {} : { birthOn: q.birthOn }), ...(specimenTypeId === undefined ? {} : { specimenTypeId }) };
    const versions = await repo.find(tx, 'analyte_versions', VER_COLS, t, { analyte_id: q.analyteId }, { order: 'version_no DESC', limit: 200 });

    // Only the set effective at `at` can answer (step 1), so only its bands are read.
    const pick = async (table: 'reference_range_sets' | 'critical_limit_sets', bandTable: 'reference_ranges' | 'critical_limits', cols: string[]) => {
      const set = selectSet(await repo.find(tx, table, SET_COLS, t, { analyte_id: q.analyteId }, { order: 'version_no DESC', limit: 200 }), at);
      return set ? [{ ...set, bands: await repo.find(tx, bandTable, cols, t, {}, { anyOf: { col: 'set_id', values: [set.id] }, order: 'sort_order, id' }) }] : [];
    };
    const ref = resolveReferenceRange({ sets: await pick('reference_range_sets', 'reference_ranges', REF_COLS), versions, query });
    const crit = resolveCriticalLimits({ sets: await pick('critical_limit_sets', 'critical_limits', CRIT_COLS), versions, query });
    return {
      status: 200,
      body: { no_reference_range: !ref, ...(ref ? { reference_range: dto(ref, REF_NAMES) } : {}), ...(crit ? { critical_limits: dto(crit, CRIT_NAMES) } : {}) },
    };
  }) as Handler,
});
