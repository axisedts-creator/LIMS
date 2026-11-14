'use client';
// 04-UI-UX §4.2.7 "Synoptic": definition-driven forms composed from kit fields only (§5, no new component). [Add synoptic] lists PUBLISHED templates for the case kind (K13), the chosen
// definition comes from K14; a saved instance re-renders from ITS template version. show_if is live: a hidden field's value is not sent, focus stays where it is and a polite live
// region says how many fields appeared (§6). Required fields are marked in words; they never block a draft save (only sign-out checks completeness, on the server).
// Labels, options and headings are text, never HTML (REQ-SEC-088). LD-140 (2026-11-13, binding): kit components and token class names only.
import { useEffect, useRef, useState } from 'react';
import { Button } from '@lims/ui/components/Button';
import { Card } from '@lims/ui/components/Card';
import { Checkbox } from '@lims/ui/components/Checkbox';
import { DatePicker, type IsoDate } from '@lims/ui/components/DatePicker';
import { DecimalField } from '@lims/ui/components/DecimalField';
import { IntegerField } from '@lims/ui/components/IntegerField';
import { Select } from '@lims/ui/components/Select';
import { Switch } from '@lims/ui/components/Switch';
import { TextArea } from '@lims/ui/components/TextArea';
import { TextField } from '@lims/ui/components/TextField';
import { VisuallyHidden } from '@lims/ui/components/VisuallyHidden';
import type { Definition, DefField } from '../../server/config.types';
import { getSynopticTemplateAction, listPublishedSynopticAction } from '../../server/actions.report';
import type { DraftSynoptic, SynopticSummary, SynopticValue } from '../../server/report.types';
import type { CaseKind } from '../../server/types';
import type { Fail } from '../common';

export const MAX_SYNOPTIC = 5;
export type SynInstance = DraftSynoptic;
export type Definitions = Readonly<Record<string, Definition>>;

/** show_if: the field is visible while the controlling field equals the value (booleans compare as booleans, everything else as text). */
export const isVisible = (f: DefField, values: Readonly<Record<string, SynopticValue>>) => !f.show_if || values[f.show_if.field_key] === f.show_if.equals;
export const visibleFields = (def: Definition, values: Readonly<Record<string, SynopticValue>>) => def.sections.flatMap((s) => s.fields).filter((f) => isVisible(f, values));

const empty = (v: SynopticValue | undefined) => v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
/** The `values` that go to the API: visible fields only, empty ones left out. */
export function sendableValues(def: Definition | undefined, values: Readonly<Record<string, SynopticValue>>) {
  if (!def) return { ...values };
  return Object.fromEntries(visibleFields(def, values).flatMap((f) => (empty(values[f.key]) ? [] : [[f.key, values[f.key] as SynopticValue]])));
}

/** Display text of one value (option codes -> display), for the preview. */
export function valueText(f: DefField, v: SynopticValue): string {
  const show = (c: string) => f.options?.find((o) => o.code === c)?.display ?? c;
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (Array.isArray(v)) return v.map(show).join(', ');
  return f.type === 'single_select' ? show(String(v)) : f.unit_text ? `${v} ${f.unit_text}` : String(v);
}

interface FieldProps { f: DefField; name: string; value: SynopticValue | undefined; onChange: (v: SynopticValue | undefined) => void; readOnly: boolean }

function FieldView({ f, name, value, onChange, readOnly }: FieldProps) {
  const unit = f.type === 'decimal' && f.unit_text ? ` (${f.unit_text})` : ''; // the kit field prints a suffix without a space; the unit reads better in the label
  const label = `${f.label}${unit}${f.required ? ' (required)' : ''}`;
  const base = { label, name, ...(f.required ? { isRequired: true } : {}), ...(readOnly ? { isReadOnly: true } : {}), ...(f.help_text ? { description: f.help_text } : {}) };
  const str = typeof value === 'string' ? value : undefined;
  switch (f.type) {
    case 'text':
      return <TextField {...base} maxLength={f.max_length ?? 4000} value={str ?? ''} onChange={onChange} />;
    case 'long_text':
      return <TextArea {...base} maxLength={f.max_length ?? 4000} rows={4} value={str ?? ''} onChange={onChange} />;
    case 'integer':
      return <IntegerField {...base} min={f.min === undefined ? -999999999 : Number(f.min)} max={f.max === undefined ? 999999999 : Number(f.max)} {...(typeof value === 'number' ? { value } : {})} onChange={onChange} />;
    case 'decimal':
      return <DecimalField {...base} decimals={f.decimals ?? 2} {...(f.min !== undefined ? { min: f.min } : {})} {...(f.max !== undefined ? { max: f.max } : {})} {...(str !== undefined ? { value: str } : {})} onChange={onChange} />;
    case 'boolean':
      return <Switch label={label} name={name} isSelected={value === true} onChange={onChange} {...(readOnly ? { isDisabled: true } : {})} />;
    case 'single_select':
      // placeholder names the field so an empty focused trigger (e.g. reached from the error summary) still says which field it is
      return <Select {...base} placeholder={`Select ${f.label.toLowerCase()}`} options={(f.options ?? []).map((o) => ({ value: o.code, label: o.display }))} {...(str ? { value: str } : {})} onChange={onChange} />;
    case 'multi_select': {
      const on = Array.isArray(value) ? value : [];
      return (
        <fieldset className="lims-field">
          <legend className="lims-label">{label}</legend>
          {(f.options ?? []).map((o) => (
            <Checkbox key={o.code} label={o.display} name={`${name}/${o.code}`} isSelected={on.includes(o.code)} {...(readOnly ? { isDisabled: true } : {})} onChange={(c) => onChange(c ? [...on, o.code] : on.filter((x) => x !== o.code))} />
          ))}
        </fieldset>
      );
    }
    case 'date':
      // one named group for the date input + calendar button
      return (
        <div role="group" aria-label={label}>
          <DatePicker {...base} {...(str ? { value: str as IsoDate } : {})} onChange={(d) => onChange(d)} />
        </div>
      );
    default:
      return null;
  }
}

function Instance({ index, inst, def, readOnly, onChange, onRemove }: { index: number; inst: SynInstance; def: Definition | undefined; readOnly: boolean; onChange: (values: Record<string, SynopticValue>) => void; onRemove: () => void }) {
  const set = (key: string, v: SynopticValue | undefined) => {
    const next = { ...inst.values };
    if (v === undefined) delete next[key];
    else next[key] = v;
    onChange(next);
  };
  return (
    <Card title={inst.title}>
      {def ? (
        def.sections.map((s) => (
          <section key={s.key}>
            <h3 className="lims-card-title">{s.heading}</h3>
            {s.fields.filter((f) => isVisible(f, inst.values)).map((f) => (
              <FieldView key={f.key} f={f} name={`synoptic/${index}/values/${f.key}`} value={inst.values[f.key]} onChange={(v) => set(f.key, v)} readOnly={readOnly} />
            ))}
          </section>
        ))
      ) : (
        <p className="lims-description">This template could not be loaded. Reload the page to try again.</p>
      )}
      {readOnly ? null : <Button variant="ghost" onPress={onRemove}>Remove</Button>}
    </Card>
  );
}

export function SynopticSection({ kind, instances, defs, readOnly, onChange, onDef, onFail }: {
  kind: CaseKind; instances: readonly SynInstance[]; defs: Definitions; readOnly: boolean;
  onChange: (next: SynInstance[]) => void; onDef: (id: string, def: Definition) => void; onFail: (f: Fail) => void;
}) {
  const [options, setOptions] = useState<SynopticSummary[]>([]);
  const [notice, setNotice] = useState<string>();
  const [live, setLive] = useState('');
  const shown = useRef(0);

  useEffect(() => {
    if (readOnly) return;
    void listPublishedSynopticAction(kind).then((r) => (r.ok ? setOptions(r.data) : setNotice('Synoptic templates could not be loaded. Try again.')));
  }, [kind, readOnly]);

  // §6 live region: how many fields appeared / went away after a show_if change.
  const count = instances.reduce((n, i) => n + (defs[i.template_id] ? visibleFields(defs[i.template_id]!, i.values).length : 0), 0);
  useEffect(() => {
    const d = count - shown.current;
    if (shown.current > 0 && d !== 0) setLive(d > 0 ? `${d} more field${d > 1 ? 's' : ''} shown` : `${-d} field${d < -1 ? 's' : ''} hidden`);
    shown.current = count;
  }, [count]);

  const add = async (id: string) => {
    const s = options.find((o) => o.id === id);
    if (!s || instances.length >= MAX_SYNOPTIC) return;
    const r = await getSynopticTemplateAction(id);
    if (!r.ok) return onFail(r);
    onDef(id, r.data.definition);
    onChange([...instances, { template_id: id, template_key: s.template_key, template_version: s.version_no, title: s.title, values: {} }]);
  };

  return (
    <>
      {notice ? <div role="alert"><p>{notice}</p></div> : null}
      {instances.map((inst, i) => (
        <Instance key={`${inst.template_id}-${i}`} index={i} inst={inst} def={defs[inst.template_id]} readOnly={readOnly} onChange={(values) => onChange(instances.map((x, j) => (j === i ? { ...x, values } : x)))} onRemove={() => onChange(instances.filter((_, j) => j !== i))} />
      ))}
      {readOnly ? null : (
        <Select
          key={instances.length}
          label="Add synoptic"
          name="synoptic_template"
          isDisabled={instances.length >= MAX_SYNOPTIC}
          options={options.map((o) => ({ value: o.id, label: o.title }))}
          onChange={(id) => void add(id)}
        />
      )}
      <div role="status" aria-live="polite"><VisuallyHidden>{live}</VisuallyHidden></div>
    </>
  );
}
