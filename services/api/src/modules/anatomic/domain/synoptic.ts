// C11 synoptic templates — 02-TRD §4.5: definition validator, draft value validator, sign-out completeness, display snapshot. Pure.
// Error paths are RFC 6901 JSON Pointers (`/definition/...` for definitions, `/values/<field_key>` for values).
export type Check = { ok: true } | { ok: false; errors: { path: string; message: string }[] };
type Err = { path: string; message: string };
type Obj = Record<string, unknown>;

const FIELD_TYPES = ['text', 'long_text', 'integer', 'decimal', 'boolean', 'single_select', 'multi_select', 'date'] as const;
type FieldType = (typeof FIELD_TYPES)[number];
const CASE_KINDS = ['histology', 'cytology', 'ihc', 'molecular'];
const KEY = /^[a-z][a-z0-9_]{0,39}$/;
const DECIMAL = /^-?[0-9]{1,12}(\.[0-9]{1,6})?$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);
const has = (o: Obj, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const isStr = (x: unknown, min: number, max: number): x is string => typeof x === 'string' && x.length >= min && x.length <= max;
const esc = (k: string) => k.replace(/~/g, '~0').replace(/\//g, '~1');
const done = (errors: Err[]): Check => (errors.length ? { ok: false, errors } : { ok: true });

/** DecimalString -> bigint scaled by 1e6 (exact compare; no float). Input must match DECIMAL. */
function scaled(s: string): bigint {
  const neg = s.startsWith('-');
  const [i, f = ''] = (neg ? s.slice(1) : s).split('.');
  const n = BigInt(i + f.padEnd(6, '0'));
  return neg ? -n : n;
}

// ───────────────────────── definition ─────────────────────────

interface Seen {
  type: FieldType;
  codes: Set<string> | null; // null = options invalid; equals not checked (no cascading errors)
}

export function validateSynopticDefinition(def: unknown): Check {
  const errors: Err[] = [];
  const err = (path: string, message: string) => errors.push({ path, message });
  if (!isObj(def)) return done([{ path: '/definition', message: 'must be an object' }]);
  const P = '/definition';

  if (def.schema_version !== 1) err(`${P}/schema_version`, 'must be 1');
  if (!isStr(def.title, 1, 200)) err(`${P}/title`, 'string of 1-200 characters');
  if (!Array.isArray(def.applies_to_case_kinds) || def.applies_to_case_kinds.length < 1) {
    err(`${P}/applies_to_case_kinds`, 'at least one case kind');
  } else {
    def.applies_to_case_kinds.forEach((k, i) => {
      if (!CASE_KINDS.includes(k as string)) err(`${P}/applies_to_case_kinds/${i}`, 'unknown case kind');
    });
  }

  if (!Array.isArray(def.sections) || def.sections.length < 1 || def.sections.length > 20) {
    err(`${P}/sections`, '1-20 sections');
    if (!Array.isArray(def.sections)) return done(errors);
  }
  const sectionKeys = new Set<string>();
  const earlier = new Map<string, Seen>(); // valid fields seen so far (also the duplicate-key registry)
  const fieldKeys = new Set<string>();
  let total = 0;

  def.sections.forEach((s: unknown, si: number) => {
    const sp = `${P}/sections/${si}`;
    if (!isObj(s)) return err(sp, 'must be an object');
    if (typeof s.key !== 'string' || !KEY.test(s.key)) err(`${sp}/key`, 'must match ^[a-z][a-z0-9_]{0,39}$');
    else if (sectionKeys.has(s.key)) err(`${sp}/key`, 'duplicate section key');
    else sectionKeys.add(s.key);
    if (!isStr(s.heading, 1, 200)) err(`${sp}/heading`, 'string of 1-200 characters');
    if (!Array.isArray(s.fields) || s.fields.length < 1 || s.fields.length > 60) {
      err(`${sp}/fields`, '1-60 fields per section');
      if (!Array.isArray(s.fields)) return;
    }
    total += s.fields.length;
    s.fields.forEach((f: unknown, fi: number) => {
      const fp = `${sp}/fields/${fi}`;
      if (!isObj(f)) return err(fp, 'must be an object');
      const type = (FIELD_TYPES as readonly unknown[]).includes(f.type) ? (f.type as FieldType) : undefined;

      let keyOk = false;
      if (typeof f.key !== 'string' || !KEY.test(f.key)) err(`${fp}/key`, 'must match ^[a-z][a-z0-9_]{0,39}$');
      else if (fieldKeys.has(f.key)) err(`${fp}/key`, 'duplicate field key');
      else keyOk = true;
      if (!isStr(f.label, 1, 200)) err(`${fp}/label`, 'string of 1-200 characters');
      if (!type) err(`${fp}/type`, 'unknown field type');
      if (typeof f.required !== 'boolean') err(`${fp}/required`, 'must be boolean');
      if (f.help_text !== undefined && !isStr(f.help_text, 0, 500)) err(`${fp}/help_text`, 'string of at most 500 characters');
      if (f.unit_text !== undefined && !isStr(f.unit_text, 0, 20)) err(`${fp}/unit_text`, 'string of at most 20 characters');

      const numeric = type === 'integer' || type === 'decimal';
      for (const b of ['min', 'max'] as const) {
        if (f[b] === undefined) continue;
        if (!numeric) err(`${fp}/${b}`, 'only for integer/decimal fields');
        else if (typeof f[b] !== 'string' || !DECIMAL.test(f[b] as string)) err(`${fp}/${b}`, 'must be a decimal string');
      }
      if (numeric && typeof f.min === 'string' && typeof f.max === 'string' && DECIMAL.test(f.min) && DECIMAL.test(f.max) && scaled(f.min) > scaled(f.max)) {
        err(`${fp}/max`, 'max must be >= min');
      }
      if (f.decimals !== undefined && (type !== 'decimal' || !Number.isInteger(f.decimals) || (f.decimals as number) < 0 || (f.decimals as number) > 6)) {
        err(`${fp}/decimals`, 'integer 0-6, decimal fields only');
      }
      if (f.max_length !== undefined) {
        const cap = type === 'text' ? 500 : type === 'long_text' ? 4000 : 0;
        if (!Number.isInteger(f.max_length) || (f.max_length as number) < 1 || (f.max_length as number) > cap) err(`${fp}/max_length`, `integer 1-${cap || 'n/a'}, text/long_text only`);
      }

      const codes = new Set<string>();
      let optionsOk = true;
      const select = type === 'single_select' || type === 'multi_select';
      if (select) {
        if (!Array.isArray(f.options) || f.options.length < 1 || f.options.length > 100) {
          err(`${fp}/options`, '1-100 options');
          optionsOk = false;
        } else {
          const before = errors.length;
          f.options.forEach((o: unknown, oi: number) => {
            const op = `${fp}/options/${oi}`;
            if (!isObj(o)) return err(op, 'must be an object');
            if (!isStr(o.code, 1, 64)) err(`${op}/code`, 'string of 1-64 characters');
            else if (codes.has(o.code)) err(`${op}/code`, 'duplicate option code');
            else codes.add(o.code);
            if (!isStr(o.display, 1, 200)) err(`${op}/display`, 'string of 1-200 characters');
          });
          optionsOk = errors.length === before;
        }
      } else if (f.options !== undefined && type) err(`${fp}/options`, 'only for select fields');

      if (f.show_if !== undefined) {
        const sp2 = `${fp}/show_if`;
        if (!isObj(f.show_if)) err(sp2, 'must be an object');
        else {
          const trig = typeof f.show_if.field_key === 'string' ? earlier.get(f.show_if.field_key) : undefined;
          if (!trig) err(`${sp2}/field_key`, 'must name an earlier field');
          else if (trig.type === 'boolean') {
            if (typeof f.show_if.equals !== 'boolean') err(`${sp2}/equals`, 'must be a boolean');
          } else if (trig.type === 'single_select' || trig.type === 'multi_select') {
            if (typeof f.show_if.equals !== 'string' || (trig.codes !== null && !trig.codes.has(f.show_if.equals))) err(`${sp2}/equals`, 'must be an option code of the trigger field');
          } else err(`${sp2}/field_key`, 'trigger must be a boolean or select field');
        }
      }

      if (keyOk) {
        fieldKeys.add(f.key as string);
        if (type) earlier.set(f.key as string, { type, codes: optionsOk ? codes : null });
      }
    });
  });
  if (total > 300) err(`${P}/sections`, 'at most 300 fields per template');
  return done(errors);
}

// ───────────────────────── values ─────────────────────────

interface FieldDef extends Obj {
  key: string;
  type: FieldType;
}
const fieldsOf = (def: unknown): FieldDef[] =>
  isObj(def) && Array.isArray(def.sections) ? def.sections.flatMap((s: unknown) => (isObj(s) && Array.isArray(s.fields) ? (s.fields.filter(isObj) as FieldDef[]) : [])) : [];

const optionCodes = (f: FieldDef): Set<string> =>
  new Set(Array.isArray(f.options) ? f.options.filter(isObj).map((o) => o.code as string) : []);

/** Visibility of every field given the values (hidden trigger => hidden). */
function visibility(fields: FieldDef[], values: Obj): Map<string, boolean> {
  const vis = new Map<string, boolean>();
  for (const f of fields) {
    const si = f.show_if;
    if (!isObj(si)) vis.set(f.key, true);
    else {
      const v = has(values, si.field_key as string) ? values[si.field_key as string] : undefined;
      const hit = Array.isArray(v) ? v.includes(si.equals) : v === si.equals;
      vis.set(f.key, vis.get(si.field_key as string) === true && hit);
    }
  }
  return vis;
}

function valueOk(f: FieldDef, v: unknown): boolean {
  const num = (x: bigint) => (f.min === undefined || x >= scaled(f.min as string)) && (f.max === undefined || x <= scaled(f.max as string));
  switch (f.type) {
    case 'text':
    case 'long_text':
      return typeof v === 'string' && v.length <= ((f.max_length as number | undefined) ?? (f.type === 'text' ? 200 : 2000));
    case 'integer':
      return typeof v === 'number' && Number.isSafeInteger(v) && num(BigInt(v) * 1_000_000n);
    case 'decimal':
      return (
        typeof v === 'string' &&
        DECIMAL.test(v) &&
        (f.decimals === undefined || (v.split('.')[1]?.length ?? 0) <= (f.decimals as number)) &&
        num(scaled(v))
      );
    case 'boolean':
      return typeof v === 'boolean';
    case 'single_select':
      return typeof v === 'string' && optionCodes(f).has(v);
    case 'multi_select': {
      const codes = optionCodes(f);
      return Array.isArray(v) && v.every((c) => typeof c === 'string' && codes.has(c)) && new Set(v).size === v.length;
    }
    case 'date': {
      const m = typeof v === 'string' ? ISO_DATE.exec(v) : null;
      if (!m) return false;
      const [y, mo, da] = [Number(m[1]), Number(m[2]), Number(m[3])];
      const d = new Date(Date.UTC(y, mo - 1, da));
      return d.getUTCFullYear() === y && d.getUTCMonth() === mo - 1 && d.getUTCDate() === da;
    }
  }
}

/** Draft-save check: types and limits only — `required` is NOT enforced (AC-08.5); hidden fields must be absent. */
export function validateSynopticValues(def: unknown, values: unknown): Check {
  if (!isObj(values)) return done([{ path: '/values', message: 'must be an object' }]);
  const fields = fieldsOf(def);
  const vis = visibility(fields, values);
  const errors: Err[] = [];
  for (const f of fields) {
    if (!has(values, f.key)) continue;
    if (!vis.get(f.key)) errors.push({ path: `/values/${esc(f.key)}`, message: 'hidden field must be absent' });
    else if (!valueOk(f, values[f.key])) errors.push({ path: `/values/${esc(f.key)}`, message: `invalid ${f.type} value` });
  }
  const known = new Set(fields.map((f) => f.key));
  for (const k of Object.keys(values)) if (!known.has(k)) errors.push({ path: `/values/${esc(k)}`, message: 'unknown field' });
  return done(errors);
}

const empty = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

/** Sign-out completeness (TRD §4.5.3): visible required fields that are absent / "" / [] — definition order. */
export function missingRequiredFields(def: unknown, values: unknown): string[] {
  const vals = isObj(values) ? values : {};
  const vis = visibility(fieldsOf(def), vals);
  return fieldsOf(def)
    .filter((f) => f.required === true && vis.get(f.key) && empty(has(vals, f.key) ? vals[f.key] : undefined))
    .map((f) => `/values/${esc(f.key)}`);
}

// ───────────────────────── display ─────────────────────────

export interface SynopticDisplay {
  template_key: string;
  template_version: number;
  title: string;
  sections: { heading: string; items: { label: string; value: string }[] }[];
}

function show(f: FieldDef, v: unknown): string {
  const unit = typeof f.unit_text === 'string' && f.unit_text ? ` ${f.unit_text}` : '';
  const label = (c: unknown) => {
    const o = Array.isArray(f.options) ? f.options.filter(isObj).find((x) => x.code === c) : undefined;
    return String(o?.display ?? c);
  };
  switch (f.type) {
    case 'boolean':
      return v === true ? 'Yes' : 'No';
    case 'integer':
    case 'decimal':
      return `${String(v)}${unit}`;
    case 'single_select':
      return label(v);
    case 'multi_select':
      return (v as unknown[]).map(label).join('; ');
    case 'date': {
      const m = ISO_DATE.exec(String(v));
      return m ? `${m[3]}/${m[2]}/${m[1]}` : String(v); // DD/MM/YYYY [CONV, 02-CV §13]
    }
    default:
      return String(v);
  }
}

/** Display snapshot of ONE instance (TRD §4.5.4). Hidden and empty fields are omitted; sections left empty are omitted. */
export function renderSynopticDisplay(a: { template_key: string; template_version: number; definition: unknown; values: unknown }): SynopticDisplay {
  const def = isObj(a.definition) ? a.definition : {};
  const vals = isObj(a.values) ? a.values : {};
  const vis = visibility(fieldsOf(def), vals);
  const sections = (Array.isArray(def.sections) ? def.sections : []).filter(isObj).map((s) => ({
    heading: String(s.heading),
    items: (Array.isArray(s.fields) ? (s.fields.filter(isObj) as FieldDef[]) : [])
      .filter((f) => vis.get(f.key) && has(vals, f.key) && !empty(vals[f.key]))
      .map((f) => ({ label: String(f.label), value: show(f, vals[f.key]) })),
  }));
  return { template_key: a.template_key, template_version: a.template_version, title: String(def.title), sections: sections.filter((s) => s.items.length) };
}
