// Pure model of the synoptic template builder (04-UI-UX §4.7, TRD §4.5.1). The API validator (T-03) stays the authority; this file only avoids SENDING what it would refuse
// (AC-08.2 prevented at the source) and builds the definition from the editor state. No React, no I/O. LD-140 (2026-11-13): no UI here.
import type { CaseKind } from '../../server/types';
import type { Definition, DefField, DefSection, FieldType } from '../../server/config.types';

export const KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;
export const DECIMAL_RE = /^-?[0-9]{1,12}(\.[0-9]{1,6})?$/;
export const CASE_KINDS: readonly CaseKind[] = ['histology', 'cytology', 'ihc', 'molecular'];
export const SELECTS: readonly FieldType[] = ['single_select', 'multi_select'];
export const isSelect = (t: FieldType) => SELECTS.includes(t);
export const isNumeric = (t: FieldType) => t === 'integer' || t === 'decimal';
const isTrigger = (t: FieldType) => t === 'boolean' || isSelect(t);

/** Editor state of one section. `key` is set for stored sections (it never changes); new sections get it from the heading when the definition is built. */
export interface Sec { uid: number; key?: string; heading: string; fields: DefField[] }

/** Section key from a heading: lower case, runs of non [a-z0-9] -> "_", trimmed of "_", "s_" prefix when it does not start with a letter, cut to 40, unique with a numeric suffix. */
export function sectionKey(heading: string, used: ReadonlySet<string>): string {
  let base = heading.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!/^[a-z]/.test(base)) base = `s_${base}`;
  base = base.slice(0, 40);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `_${n}`;
    const k = `${base.slice(0, 40 - suffix.length)}${suffix}`;
    if (!used.has(k)) return k;
  }
}

/** Keys of every section in order: stored keys are kept, new ones are derived (never colliding with a stored key). */
export function sectionKeys(sections: readonly Sec[]): string[] {
  const used = new Set(sections.flatMap((s) => (s.key ? [s.key] : [])));
  return sections.map((s) => {
    if (s.key) return s.key;
    const k = sectionKey(s.heading, used);
    used.add(k);
    return k;
  });
}

export interface Draft { title: string; kinds: readonly CaseKind[]; sections: readonly Sec[] }

export function toDefinition(d: Draft): Definition {
  const keys = sectionKeys(d.sections);
  return {
    schema_version: 1,
    title: d.title,
    applies_to_case_kinds: CASE_KINDS.filter((k) => d.kinds.includes(k)),
    sections: d.sections.map((s, i): DefSection => ({ key: keys[i]!, heading: s.heading, fields: s.fields })),
  };
}

export const toSecs = (def: Definition, nextUid: () => number): Sec[] => def.sections.map((s) => ({ uid: nextUid(), key: s.key, heading: s.heading, fields: s.fields }));

export interface Problem { path: string; message: string }

/** Client-side mirror of the definition rules (same paths as the API: /definition/...). */
export function checkDefinition(def: Definition): Problem[] {
  const out: Problem[] = [];
  const err = (path: string, message: string) => out.push({ path, message });
  if (def.title.length < 1 || def.title.length > 200) err('/definition/title', 'Enter a title of 1 to 200 characters.');
  if (def.applies_to_case_kinds.length < 1) err('/definition/applies_to_case_kinds', 'Choose at least one case kind.');
  if (def.sections.length < 1) err('/definition/sections', 'Add at least one section.');
  if (def.sections.length > 20) err('/definition/sections', 'A template has at most 20 sections.');
  const seen = new Map<string, DefField>();
  let total = 0;
  def.sections.forEach((s, si) => {
    const sp = `/definition/sections/${si}`;
    if (s.heading.length < 1 || s.heading.length > 200) err(`${sp}/heading`, 'Enter a heading of 1 to 200 characters.');
    if (s.fields.length < 1) err(`${sp}/fields`, 'Add at least one field to this section.');
    if (s.fields.length > 60) err(`${sp}/fields`, 'A section has at most 60 fields.');
    total += s.fields.length;
    s.fields.forEach((f, fi) => {
      const p = `${sp}/fields/${fi}`;
      const bad = fieldProblems(f, [...seen.keys()], (k) => seen.get(k)?.type, (k) => seen.get(k)?.options?.map((o) => o.code));
      for (const [k, m] of Object.entries(bad)) err(`${p}/${k}`, m);
      seen.set(f.key, f);
    });
  });
  if (total > 300) err('/definition/sections', 'A template has at most 300 fields.');
  return out;
}

/** Problems of ONE field given the keys used by OTHER fields and the type of the earlier ones. Keys of the result are field property names. */
export function fieldProblems(f: DefField, usedKeys: readonly string[], typeOf: (k: string) => FieldType | undefined, earlierOptions?: (k: string) => readonly string[] | undefined): Record<string, string> {
  const e: Record<string, string> = {};
  if (!KEY_RE.test(f.key)) e['key'] = 'Use lower case letters, digits and underscore, starting with a letter (40 at most).';
  else if (usedKeys.includes(f.key)) e['key'] = 'This key is already used by another field.';
  if (f.label.length < 1 || f.label.length > 200) e['label'] = 'Enter a label of 1 to 200 characters.';
  if (isSelect(f.type)) {
    const o = f.options ?? [];
    if (o.length < 1) e['options'] = 'Add at least one answer.';
    else if (o.length > 100) e['options'] = 'A field has at most 100 answers.';
    else if (o.some((x) => x.code.length < 1 || x.code.length > 64 || x.display.length < 1 || x.display.length > 200)) e['options'] = 'Every answer needs a code (64 at most) and text (200 at most).';
    else if (new Set(o.map((x) => x.code)).size !== o.length) e['options'] = 'Duplicate answer codes: use each code once.';
  }
  if (isNumeric(f.type)) {
    for (const b of ['min', 'max'] as const) if (f[b] !== undefined && !DECIMAL_RE.test(f[b]!)) e[b] = 'Enter a number, for example 12 or 0.5.';
    if (!e['min'] && !e['max'] && f.min !== undefined && f.max !== undefined && Number(f.min) > Number(f.max)) e['max'] = 'Max must not be lower than min.';
  }
  if (f.show_if) {
    const t = typeOf(f.show_if.field_key);
    if (!t || !isTrigger(t)) e['show_if'] = 'Choose an earlier yes/no or select field.';
    else if (t === 'boolean' ? typeof f.show_if.equals !== 'boolean' : typeof f.show_if.equals !== 'string' || (earlierOptions?.(f.show_if.field_key) && !earlierOptions(f.show_if.field_key)!.includes(f.show_if.equals))) e['show_if'] = 'Choose the answer that shows this field.';
  }
  return e;
}

export const flat = (sections: readonly Sec[]) => sections.flatMap((s) => s.fields);

/** Fields that may be a Show-if trigger for the field at (si, fi) (fi = fields.length for a new field): earlier boolean / select fields only. */
export function triggersFor(sections: readonly Sec[], si: number, fi: number): DefField[] {
  const before = sections.flatMap((s, i) => (i < si ? s.fields : i === si ? s.fields.slice(0, fi) : []));
  return before.filter((f) => isTrigger(f.type));
}

/** Every show_if names a boolean / select field that comes EARLIER in the flattened order. */
export function orderValid(sections: readonly Sec[]): boolean {
  const seen = new Map<string, FieldType>();
  for (const f of flat(sections)) {
    if (f.show_if) {
      const t = seen.get(f.show_if.field_key);
      if (!t || !isTrigger(t)) return false;
    }
    seen.set(f.key, f.type);
  }
  return true;
}

/** After a field changed: dependents whose trigger no longer fits (type changed, answer code gone) lose their show_if. Returns the new sections and the labels that lost it. */
export function repairShowIf(sections: readonly Sec[]): { sections: Sec[]; repaired: string[] } {
  const info = new Map<string, DefField>();
  const repaired: string[] = [];
  const next = sections.map((s) => ({
    ...s,
    fields: s.fields.map((f) => {
      let out = f;
      if (f.show_if) {
        const t = info.get(f.show_if.field_key);
        const ok = t && (t.type === 'boolean' ? typeof f.show_if.equals === 'boolean' : isSelect(t.type) && typeof f.show_if.equals === 'string' && (t.options ?? []).some((o) => o.code === f.show_if!.equals));
        if (!ok) {
          const { show_if: _drop, ...rest } = f;
          void _drop;
          out = rest;
          repaired.push(f.label);
        }
      }
      info.set(out.key, out);
      return out;
    }),
  }));
  return { sections: next, repaired };
}

/** The visible fields of the preview for the given answers: a hidden trigger hides its dependents. */
export function visibleKeys(fields: readonly DefField[], answers: Readonly<Record<string, boolean | string | readonly string[] | undefined>>): Set<string> {
  const vis = new Set<string>();
  for (const f of fields) {
    if (!f.show_if) vis.add(f.key);
    else {
      const a = answers[f.show_if.field_key];
      const hit = Array.isArray(a) ? a.includes(f.show_if.equals as string) : a === f.show_if.equals;
      if (vis.has(f.show_if.field_key) && hit) vis.add(f.key);
    }
  }
  return vis;
}
