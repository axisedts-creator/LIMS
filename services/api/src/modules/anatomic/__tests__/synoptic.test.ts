// C11 T-03 — synoptic definition validator, value validator, completeness, display renderer (02-TRD §4.5; AC-08.2, AC-08.5). Pure.
// SEAM: ../domain/synoptic.ts exports
//   type Check = { ok: true } | { ok: false; errors: { path: string; message: string }[] }
//   validateSynopticDefinition(def: unknown): Check
//     - collects ALL errors; paths are RFC 6901 JSON Pointers prefixed with `/definition` (TRD §4.5.1 example
//       `/definition/sections/0/fields/3/options`); duplicate key → pointer of the SECOND occurrence's `key`;
//       min>max → `.../max`; unknown/later/ill-typed show_if → `.../show_if/field_key` | `.../show_if/equals`.
//   validateSynopticValues(def, values: unknown): Check        — paths `/values/<field_key>`; `required` NOT checked (AC-08.5);
//     integer = JS integer number; decimal = DecimalString (string); date = ISO `YYYY-MM-DD` string; hidden (show_if false) must be absent.
//   missingRequiredFields(def, values): string[]               — `/values/<field_key>` of visible required fields that are absent/""/[] (sign-out, TRD §4.5.3), definition order.
//   renderSynopticDisplay({ template_key, template_version, definition, values }) → TRD §4.5.4 snapshot for ONE instance.
// Fails now: ../domain/synoptic.js does not exist.
import { describe, expect, it } from 'vitest';
import {
  missingRequiredFields,
  renderSynopticDisplay,
  validateSynopticDefinition,
  validateSynopticValues,
} from '../domain/synoptic.js';

type Json = Record<string, any>;
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

const sel = [
  { code: 'g1', display: 'Grade 1' },
  { code: 'g2', display: 'Grade 2' },
  { code: 'g3', display: 'Grade 3' },
];

/** Valid synthetic definition (no third-party protocol text). */
const GOOD: Json = {
  schema_version: 1,
  title: 'Synthetic Mass Template',
  applies_to_case_kinds: ['histology'],
  sections: [
    {
      key: 'tumour',
      heading: 'Tumour',
      fields: [
        { key: 'site', label: 'Site', type: 'text', required: true },
        { key: 'size_mm', label: 'Size', type: 'decimal', required: true, unit_text: 'mm', min: '0', max: '500', decimals: 1 },
        { key: 'grade', label: 'Grade', type: 'single_select', required: true, options: sel },
        { key: 'necrosis', label: 'Necrosis present', type: 'boolean', required: false },
        {
          key: 'necrosis_pct',
          label: 'Necrosis extent',
          type: 'integer',
          required: false,
          unit_text: '%',
          min: '0',
          max: '100',
          show_if: { field_key: 'necrosis', equals: true },
        },
      ],
    },
    {
      key: 'extra',
      heading: 'Additional',
      fields: [
        { key: 'features', label: 'Features', type: 'multi_select', required: false, options: sel },
        { key: 'notes', label: 'Notes', type: 'long_text', required: false },
        { key: 'resected_on', label: 'Resected on', type: 'date', required: false },
        {
          key: 'high_grade_note',
          label: 'High grade note',
          type: 'text',
          required: true,
          show_if: { field_key: 'grade', equals: 'g3' },
        },
      ],
    },
  ],
};

const paths = (r: { ok: boolean; errors?: { path: string }[] }) => (r.ok ? [] : r.errors!.map((e) => e.path));
const bad = (mut: (d: Json) => void) => {
  const d = clone(GOOD);
  mut(d);
  return validateSynopticDefinition(d);
};
const f = (d: Json, s = 0, i = 0) => d.sections[s].fields[i];

describe('C11 synoptic — definition validator (AC-08.2)', () => {
  it('accepts the valid fixture', () => expect(validateSynopticDefinition(GOOD)).toEqual({ ok: true }));

  it('rejects non-object / wrong schema_version', () => {
    expect(paths(validateSynopticDefinition(null))).toEqual(['/definition']);
    expect(paths(validateSynopticDefinition('x'))).toEqual(['/definition']);
    expect(paths(bad((d) => (d.schema_version = 2)))).toEqual(['/definition/schema_version']);
  });

  it('duplicate field key → pointer of the second occurrence (even across sections)', () => {
    expect(paths(bad((d) => (f(d, 0, 1).key = 'site')))).toEqual(['/definition/sections/0/fields/1/key']);
    expect(paths(bad((d) => (f(d, 1, 0).key = 'site')))).toEqual(['/definition/sections/1/fields/0/key']);
  });

  it('duplicate section key → pointer of the second section key', () => {
    expect(paths(bad((d) => (d.sections[1].key = 'tumour')))).toEqual(['/definition/sections/1/key']);
  });

  it('key pattern ^[a-z][a-z0-9_]{0,39}$ for fields and sections', () => {
    for (const k of ['Site', '1site', 'si-te', '', 'a'.repeat(41)]) {
      expect(paths(bad((d) => (f(d, 0, 0).key = k)))).toEqual(['/definition/sections/0/fields/0/key']);
      expect(paths(bad((d) => (d.sections[0].key = k)))).toEqual(['/definition/sections/0/key']);
    }
    expect(bad((d) => (f(d, 0, 0).key = 'a'.repeat(40)))).toEqual({ ok: true });
  });

  it('single_select / multi_select without options (missing or empty) → .../options (TRD example path)', () => {
    expect(paths(bad((d) => delete f(d, 0, 2).options))).toEqual(['/definition/sections/0/fields/2/options']);
    expect(paths(bad((d) => (f(d, 0, 2).options = [])))).toEqual(['/definition/sections/0/fields/2/options']);
    expect(paths(bad((d) => delete f(d, 1, 0).options))).toEqual(['/definition/sections/1/fields/0/options']);
  });

  it('options: duplicate code, >100, code >64, display >200', () => {
    expect(paths(bad((d) => (f(d, 0, 2).options[2].code = 'g1')))).toEqual(['/definition/sections/0/fields/2/options/2/code']);
    expect(paths(bad((d) => (f(d, 0, 2).options = Array.from({ length: 101 }, (_, i) => ({ code: `c${i}`, display: 'x' })))))).toEqual([
      '/definition/sections/0/fields/2/options',
    ]);
    expect(
      bad((d) => {
        f(d, 0, 2).options = Array.from({ length: 100 }, (_, i) => ({ code: `c${i}`, display: 'x' }));
        f(d, 1, 3).show_if.equals = 'c0'; // keep show_if.equals a valid option code (TRD:303)
      }),
    ).toEqual({ ok: true });
    expect(paths(bad((d) => (f(d, 0, 2).options[0].code = 'c'.repeat(65))))).toEqual(['/definition/sections/0/fields/2/options/0/code']);
    expect(paths(bad((d) => (f(d, 0, 2).options[0].display = 'd'.repeat(201))))).toEqual(['/definition/sections/0/fields/2/options/0/display']);
  });

  it('show_if pointing to an unknown field → .../show_if/field_key', () => {
    expect(paths(bad((d) => (f(d, 0, 4).show_if.field_key = 'nope')))).toEqual(['/definition/sections/0/fields/4/show_if/field_key']);
  });

  it('show_if pointing to itself or a LATER field → .../show_if/field_key', () => {
    expect(paths(bad((d) => (f(d, 0, 4).show_if.field_key = 'necrosis_pct')))).toEqual(['/definition/sections/0/fields/4/show_if/field_key']);
    expect(paths(bad((d) => (f(d, 0, 4).show_if.field_key = 'high_grade_note')))).toEqual(['/definition/sections/0/fields/4/show_if/field_key']);
  });

  it('show_if equals must be a boolean for boolean fields and an option code for selects → .../show_if/equals', () => {
    expect(paths(bad((d) => (f(d, 0, 4).show_if.equals = 'yes')))).toEqual(['/definition/sections/0/fields/4/show_if/equals']);
    expect(paths(bad((d) => (f(d, 1, 3).show_if.equals = 'g9')))).toEqual(['/definition/sections/1/fields/3/show_if/equals']);
    expect(paths(bad((d) => (f(d, 1, 3).show_if.equals = true)))).toEqual(['/definition/sections/1/fields/3/show_if/equals']);
  });

  it('min > max (numerically, not lexically) → .../max; min = max is fine', () => {
    expect(paths(bad((d) => { f(d, 0, 1).min = '10'; f(d, 0, 1).max = '9'; }))).toEqual(['/definition/sections/0/fields/1/max']);
    expect(paths(bad((d) => { f(d, 0, 1).min = '1.5'; f(d, 0, 1).max = '1.25'; }))).toEqual(['/definition/sections/0/fields/1/max']);
    expect(bad((d) => { f(d, 0, 1).min = '5'; f(d, 0, 1).max = '5.0'; })).toEqual({ ok: true });
  });

  it('min/max: not a DecimalString, or on a non-numeric type → .../min', () => {
    expect(paths(bad((d) => (f(d, 0, 1).min = 'abc')))).toEqual(['/definition/sections/0/fields/1/min']);
    expect(paths(bad((d) => (f(d, 0, 0).min = '1')))).toEqual(['/definition/sections/0/fields/0/min']);
  });

  it('decimals: 0–6 and decimal type only → .../decimals', () => {
    expect(paths(bad((d) => (f(d, 0, 1).decimals = 7)))).toEqual(['/definition/sections/0/fields/1/decimals']);
    expect(paths(bad((d) => (f(d, 0, 1).decimals = -1)))).toEqual(['/definition/sections/0/fields/1/decimals']);
    expect(paths(bad((d) => (f(d, 0, 4).decimals = 1)))).toEqual(['/definition/sections/0/fields/4/decimals']);
    expect(bad((d) => (f(d, 0, 1).decimals = 6))).toEqual({ ok: true });
    expect(bad((d) => (f(d, 0, 1).decimals = 0))).toEqual({ ok: true });
  });

  it('max_length: text 1–500, long_text 1–4000 → .../max_length', () => {
    expect(paths(bad((d) => (f(d, 0, 0).max_length = 501)))).toEqual(['/definition/sections/0/fields/0/max_length']);
    expect(paths(bad((d) => (f(d, 0, 0).max_length = 0)))).toEqual(['/definition/sections/0/fields/0/max_length']);
    expect(paths(bad((d) => (f(d, 1, 1).max_length = 4001)))).toEqual(['/definition/sections/1/fields/1/max_length']);
    expect(bad((d) => (f(d, 0, 0).max_length = 500))).toEqual({ ok: true });
    expect(bad((d) => (f(d, 1, 1).max_length = 4000))).toEqual({ ok: true });
  });

  it('string limits: title, label, heading, help_text, unit_text', () => {
    expect(paths(bad((d) => (d.title = '')))).toEqual(['/definition/title']);
    expect(paths(bad((d) => (d.title = 't'.repeat(201))))).toEqual(['/definition/title']);
    expect(bad((d) => (d.title = 't'.repeat(200)))).toEqual({ ok: true });
    expect(paths(bad((d) => (f(d, 0, 0).label = '')))).toEqual(['/definition/sections/0/fields/0/label']);
    expect(paths(bad((d) => (f(d, 0, 0).label = 'l'.repeat(201))))).toEqual(['/definition/sections/0/fields/0/label']);
    expect(paths(bad((d) => (d.sections[0].heading = 'h'.repeat(201))))).toEqual(['/definition/sections/0/heading']);
    expect(paths(bad((d) => (f(d, 0, 0).help_text = 'h'.repeat(501))))).toEqual(['/definition/sections/0/fields/0/help_text']);
    expect(paths(bad((d) => (f(d, 0, 1).unit_text = 'u'.repeat(21))))).toEqual(['/definition/sections/0/fields/1/unit_text']);
  });

  it('applies_to_case_kinds: ≥1 and known kinds', () => {
    expect(paths(bad((d) => (d.applies_to_case_kinds = [])))).toEqual(['/definition/applies_to_case_kinds']);
    expect(paths(bad((d) => (d.applies_to_case_kinds = ['histology', 'radiology'])))).toEqual(['/definition/applies_to_case_kinds/1']);
  });

  it('sections 1–20; fields 1–60 per section', () => {
    expect(paths(bad((d) => (d.sections = [])))).toEqual(['/definition/sections']);
    expect(paths(bad((d) => (d.sections = Array.from({ length: 21 }, (_, i) => ({ key: `s${i}`, heading: 'h', fields: [{ key: `f${i}`, label: 'l', type: 'text', required: false }] })))))).toEqual(['/definition/sections']);
    expect(paths(bad((d) => (d.sections[1].fields = [])))).toEqual(['/definition/sections/1/fields']);
    expect(paths(bad((d) => (d.sections[1].fields = Array.from({ length: 61 }, (_, i) => ({ key: `f${i}`, label: 'l', type: 'text', required: false })))))).toEqual(['/definition/sections/1/fields']);
  });

  it('≤300 fields per template (6 × 51 = 306 → rejected; 5 × 60 = 300 → accepted)', () => {
    const mk = (n: number, per: number) => ({
      ...clone(GOOD),
      sections: Array.from({ length: n }, (_, s) => ({
        key: `s${s}`,
        heading: 'h',
        fields: Array.from({ length: per }, (_, i) => ({ key: `f${s}_${i}`, label: 'l', type: 'text', required: false })),
      })),
    });
    expect(validateSynopticDefinition(mk(6, 51)).ok).toBe(false);
    expect(validateSynopticDefinition(mk(5, 60))).toEqual({ ok: true });
  });

  it('unknown type / non-boolean required → .../type, .../required', () => {
    expect(paths(bad((d) => (f(d, 0, 0).type = 'blob')))).toEqual(['/definition/sections/0/fields/0/type']);
    expect(paths(bad((d) => (f(d, 0, 0).required = 'yes')))).toEqual(['/definition/sections/0/fields/0/required']);
  });

  it('reports ALL errors in one pass, in document order', () => {
    const r = bad((d) => {
      delete f(d, 0, 2).options;
      f(d, 1, 0).key = 'site';
      f(d, 0, 4).show_if.field_key = 'nope';
    });
    expect(paths(r)).toEqual([
      '/definition/sections/0/fields/2/options',
      '/definition/sections/0/fields/4/show_if/field_key',
      '/definition/sections/1/fields/0/key',
    ]);
  });

  it('prototype-pollution style input does not crash or pass', () => {
    const d = JSON.parse('{"__proto__":{"x":1},"schema_version":1,"title":"t","applies_to_case_kinds":["histology"],"sections":[]}');
    expect(validateSynopticDefinition(d).ok).toBe(false);
  });
});

describe('C11 synoptic — value validator (draft save, AC-08.5)', () => {
  const ok = (values: unknown) => validateSynopticValues(GOOD, values);
  const P = (values: unknown) => paths(ok(values));

  it('accepts empty values (draft: required is NOT enforced) and a full valid set', () => {
    expect(ok({})).toEqual({ ok: true });
    expect(
      ok({ site: 'Left lobe', size_mm: '12.5', grade: 'g3', necrosis: true, necrosis_pct: 20, features: ['g1', 'g3'], notes: 'ok', resected_on: '2026-03-05', high_grade_note: 'x' }),
    ).toEqual({ ok: true });
  });

  it('rejects non-object values and unknown keys → /values/<key>', () => {
    expect(P(null)).toEqual(['/values']);
    expect(P([])).toEqual(['/values']);
    expect(P({ zzz: 'a' })).toEqual(['/values/zzz']);
  });

  it('text: string only, ≤ max_length (default 200); long_text default 2000', () => {
    expect(P({ site: 5 })).toEqual(['/values/site']);
    expect(P({ site: 'a'.repeat(201) })).toEqual(['/values/site']);
    expect(P({ site: 'a'.repeat(200) })).toEqual([]);
    expect(P({ notes: 'a'.repeat(2001) })).toEqual(['/values/notes']);
    expect(P({ notes: 'a'.repeat(2000) })).toEqual([]);
  });

  it('integer: integer number within min/max', () => {
    expect(P({ necrosis: true, necrosis_pct: 5.5 })).toEqual(['/values/necrosis_pct']);
    expect(P({ necrosis: true, necrosis_pct: 'abc' })).toEqual(['/values/necrosis_pct']);
    expect(P({ necrosis: true, necrosis_pct: -1 })).toEqual(['/values/necrosis_pct']);
    expect(P({ necrosis: true, necrosis_pct: 101 })).toEqual(['/values/necrosis_pct']);
    expect(P({ necrosis: true, necrosis_pct: 100 })).toEqual([]);
  });

  it('decimal: DecimalString, ≤ decimals places, within min/max', () => {
    expect(P({ size_mm: 'abc' })).toEqual(['/values/size_mm']);
    expect(P({ size_mm: 12 })).toEqual(['/values/size_mm']);
    expect(P({ size_mm: '12.55' })).toEqual(['/values/size_mm']);
    expect(P({ size_mm: '500.1' })).toEqual(['/values/size_mm']);
    expect(P({ size_mm: '-0.1' })).toEqual(['/values/size_mm']);
    expect(P({ size_mm: '500' })).toEqual([]);
    expect(P({ size_mm: '12' })).toEqual([]);
  });

  it('boolean / single_select / multi_select / date types', () => {
    expect(P({ necrosis: 'yes' })).toEqual(['/values/necrosis']);
    expect(P({ grade: 'g9' })).toEqual(['/values/grade']);
    expect(P({ grade: ['g1'] })).toEqual(['/values/grade']);
    expect(P({ features: 'g1' })).toEqual(['/values/features']);
    expect(P({ features: ['g1', 'g9'] })).toEqual(['/values/features']);
    expect(P({ features: ['g1', 'g1'] })).toEqual(['/values/features']);
    expect(P({ resected_on: '05/03/2026' })).toEqual(['/values/resected_on']);
    expect(P({ resected_on: '2026-02-30' })).toEqual(['/values/resected_on']);
    expect(P({ resected_on: '2026-02-28' })).toEqual([]);
  });

  it('null / undefined-ish values are rejected, not silently dropped', () => {
    expect(P({ site: null })).toEqual(['/values/site']);
  });

  it('hidden-field rule: a field whose show_if is false must be ABSENT', () => {
    expect(P({ necrosis_pct: 5 })).toEqual(['/values/necrosis_pct']); // trigger absent → hidden
    expect(P({ necrosis: false, necrosis_pct: 5 })).toEqual(['/values/necrosis_pct']);
    expect(P({ necrosis: true, necrosis_pct: 5 })).toEqual([]);
    expect(P({ grade: 'g1', high_grade_note: 'x' })).toEqual(['/values/high_grade_note']);
    expect(P({ grade: 'g3', high_grade_note: 'x' })).toEqual([]);
  });
});

describe('C11 synoptic — completeness at sign-out (AC-08.5; TRD §4.5.3)', () => {
  it('lists every visible required field that is absent / "" / [] — definition order', () => {
    expect(missingRequiredFields(GOOD, {})).toEqual(['/values/site', '/values/size_mm', '/values/grade']);
    expect(missingRequiredFields(GOOD, { site: '', size_mm: '1', grade: 'g1' })).toEqual(['/values/site']);
  });
  it('required field made visible by show_if is then required', () => {
    expect(missingRequiredFields(GOOD, { site: 's', size_mm: '1', grade: 'g3' })).toEqual(['/values/high_grade_note']);
  });
  it('hidden required fields are not listed; complete → []', () => {
    expect(missingRequiredFields(GOOD, { site: 's', size_mm: '1', grade: 'g1' })).toEqual([]);
  });
  it('boolean false counts as present', () => {
    const d = clone(GOOD);
    f(d, 0, 3).required = true;
    expect(missingRequiredFields(d, { site: 's', size_mm: '1', grade: 'g1', necrosis: false })).toEqual([]);
    expect(missingRequiredFields(d, { site: 's', size_mm: '1', grade: 'g1' })).toEqual(['/values/necrosis']);
  });
});

describe('C11 synoptic — display snapshot golden (TRD §4.5.4)', () => {
  it('renders labels/values per the rules; hidden + empty optional omitted', () => {
    const out = renderSynopticDisplay({
      template_key: 'mass_basic',
      template_version: 2,
      definition: GOOD,
      values: {
        site: 'Left lobe',
        size_mm: '12.5',
        grade: 'g2',
        necrosis: false,
        necrosis_pct: 40, // hidden (necrosis=false) → omitted even if (wrongly) present
        features: ['g1', 'g3'],
        notes: '', // empty optional → omitted
        resected_on: '2026-03-05',
        high_grade_note: 'zzz', // hidden (grade≠g3) → omitted
      },
    });
    expect(out).toEqual({
      template_key: 'mass_basic',
      template_version: 2,
      title: 'Synthetic Mass Template',
      sections: [
        {
          heading: 'Tumour',
          items: [
            { label: 'Site', value: 'Left lobe' },
            { label: 'Size', value: '12.5 mm' },
            { label: 'Grade', value: 'Grade 2' },
            { label: 'Necrosis present', value: 'No' },
          ],
        },
        {
          heading: 'Additional',
          items: [
            { label: 'Features', value: 'Grade 1; Grade 3' },
            { label: 'Resected on', value: '05/03/2026' },
          ],
        },
      ],
    });
  });

  it('boolean true → "Yes"; integer + unit_text → "40 %"', () => {
    const out = renderSynopticDisplay({
      template_key: 'mass_basic',
      template_version: 1,
      definition: GOOD,
      values: { site: 's', size_mm: '1', grade: 'g1', necrosis: true, necrosis_pct: 40 },
    });
    const items = out.sections[0].items;
    expect(items).toContainEqual({ label: 'Necrosis present', value: 'Yes' });
    expect(items).toContainEqual({ label: 'Necrosis extent', value: '40 %' });
  });
});
