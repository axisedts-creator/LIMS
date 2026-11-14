'use client';
// 04-UI-UX §4.7 field Drawer of the synoptic template builder: Key, Label, Type, Required, Help text, Unit, Min / Max, Decimals, Max length, Options editor, Show if.
// Save field adds or replaces the field in the editor (nothing is sent to the API from here). The drawer stays open and says why when the definition rules would refuse the
// field (AC-08.2 prevented at the source): bad or duplicate key, a select without answers, duplicate answer codes, min above max, a Show-if that does not fit.
// Min / Max / Decimals / Max length only exist for the types the validator allows them for. LD-140 (2026-11-13, binding): kit components only.
import { useState } from 'react';
import { Button } from '@lims/ui/components/Button';
import { IntegerField } from '@lims/ui/components/IntegerField';
import { Select } from '@lims/ui/components/Select';
import { Switch } from '@lims/ui/components/Switch';
import { TextField } from '@lims/ui/components/TextField';
import type { DefField, FieldOption, FieldType } from '../../server/config.types';
import { FormDialog } from '../material/FormDialog';
import { fieldProblems, isNumeric, isSelect, type Sec, triggersFor } from './builder-model';

const TYPES: readonly { value: FieldType; label: string }[] = [
  { value: 'text', label: 'Text' }, { value: 'long_text', label: 'Long text' }, { value: 'integer', label: 'Integer' }, { value: 'decimal', label: 'Decimal' },
  { value: 'boolean', label: 'Yes/No' }, { value: 'single_select', label: 'Single select' }, { value: 'multi_select', label: 'Multi select' }, { value: 'date', label: 'Date' },
];
const NONE = '__none';
const YES_NO = [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }];

interface Props {
  sections: readonly Sec[];
  /** Section index and field index (fields.length = a new field). */
  at: { si: number; fi: number };
  field?: DefField | undefined;
  onSave: (f: DefField) => void;
  onClose: () => void;
}

export function FieldDrawer({ sections, at, field, onSave, onClose }: Props) {
  const [key, setKey] = useState(field?.key ?? '');
  const [label, setLabel] = useState(field?.label ?? '');
  const [type, setType] = useState<FieldType>(field?.type ?? 'text');
  const [required, setRequired] = useState(field?.required ?? false);
  const [help, setHelp] = useState(field?.help_text ?? '');
  const [unit, setUnit] = useState(field?.unit_text ?? '');
  const [min, setMin] = useState(field?.min ?? '');
  const [max, setMax] = useState(field?.max ?? '');
  const [decimals, setDecimals] = useState<number | undefined>(field?.decimals);
  const [maxLength, setMaxLength] = useState<number | undefined>(field?.max_length);
  const [opts, setOpts] = useState<FieldOption[]>(field?.options ?? []);
  const [trig, setTrig] = useState(field?.show_if?.field_key ?? NONE);
  const [equals, setEquals] = useState<string | undefined>(field?.show_if ? String(field.show_if.equals) : undefined);
  const [errs, setErrs] = useState<Record<string, string>>({});

  const triggers = triggersFor(sections, at.si, at.fi);
  const trigField = triggers.find((f) => f.key === trig);
  const equalsOptions = trigField?.type === 'boolean' ? YES_NO : (trigField?.options ?? []).map((o) => ({ value: o.code, label: o.display }));
  const others = sections.flatMap((s) => s.fields).filter((f) => f !== field);

  const setOpt = (i: number, patch: Partial<FieldOption>) => setOpts((o) => o.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  const build = (): DefField => ({
    key, label, type, required,
    ...(help ? { help_text: help } : {}),
    ...(isNumeric(type) && unit ? { unit_text: unit } : {}),
    ...(isNumeric(type) && min ? { min } : {}),
    ...(isNumeric(type) && max ? { max } : {}),
    ...(type === 'decimal' && decimals !== undefined ? { decimals } : {}),
    ...((type === 'text' || type === 'long_text') && maxLength !== undefined ? { max_length: maxLength } : {}),
    ...(isSelect(type) ? { options: opts.map((o) => ({ code: o.code, display: o.display })) } : {}),
    ...(trigField && equals !== undefined ? { show_if: { field_key: trigField.key, equals: trigField.type === 'boolean' ? equals === 'true' : equals } } : {}),
  });

  return (
    <FormDialog
      as="drawer"
      title={field ? 'Edit field' : 'Add field'}
      submitLabel="Save field"
      onClose={onClose}
      onMfa={onClose}
      onSubmit={async () => {
        const f = build();
        const e = fieldProblems(f, others.map((o) => o.key), (k) => triggers.find((t) => t.key === k)?.type, (k) => triggers.find((t) => t.key === k)?.options?.map((o) => o.code));
        if (trig !== NONE && equals === undefined) e['show_if'] = 'Choose the answer that shows this field.';
        if (type === 'text' && maxLength !== undefined && maxLength > 500) e['max_length'] = 'Text fields hold at most 500 characters.';
        setErrs(e);
        if (Object.keys(e).length > 0) return undefined;
        onSave(f);
        onClose();
        return undefined;
      }}
    >
      <TextField label="Key" name="key" isRequired maxLength={64} description="Lower case letters, digits and underscore, 40 at most." value={key} onChange={setKey} {...(field ? { isReadOnly: true } : {})} {...(errs['key'] ? { error: errs['key'] } : {})} />
      <TextField label="Label" name="label" isRequired maxLength={200} value={label} onChange={setLabel} {...(errs['label'] ? { error: errs['label'] } : {})} />
      <Select label="Type" name="type" options={TYPES} value={type} onChange={(t) => { setType(t); setErrs({}); }} />
      <Switch label="Required" name="required" isSelected={required} onChange={setRequired} />
      <TextField label="Help text" name="help_text" maxLength={500} value={help} onChange={setHelp} />
      {isNumeric(type) ? <TextField label="Unit" name="unit_text" maxLength={20} value={unit} onChange={setUnit} /> : null}
      {isNumeric(type) ? <TextField label="Min" name="min" maxLength={20} inputMode="numeric" value={min} onChange={setMin} {...(errs['min'] ? { error: errs['min'] } : {})} /> : null}
      {isNumeric(type) ? <TextField label="Max" name="max" maxLength={20} inputMode="numeric" value={max} onChange={setMax} {...(errs['max'] ? { error: errs['max'] } : {})} /> : null}
      {type === 'decimal' ? <IntegerField label="Decimals" name="decimals" min={0} max={6} {...(decimals !== undefined ? { value: decimals } : {})} onChange={setDecimals} /> : null}
      {type === 'text' || type === 'long_text' ? (
        <IntegerField label="Max length" name="max_length" min={1} max={type === 'text' ? 500 : 4000} {...(maxLength !== undefined ? { value: maxLength } : {})} onChange={setMaxLength} {...(errs['max_length'] ? { error: errs['max_length'] } : {})} />
      ) : null}
      {isSelect(type) ? (
        <fieldset className="lims-field">
          <legend className="lims-label">Answers</legend>
          {opts.map((o, i) => (
            <div key={i} className="lims-inline">
              <TextField label="Option code" name={`option_code_${i}`} maxLength={64} value={o.code} onChange={(v) => setOpt(i, { code: v })} />
              <TextField label="Option display" name={`option_display_${i}`} maxLength={200} value={o.display} onChange={(v) => setOpt(i, { display: v })} />
              <Button variant="ghost" size="sm" onPress={() => setOpts((x) => x.filter((_, j) => j !== i))}>{`Remove answer ${i + 1}`}</Button>
            </div>
          ))}
          {errs['options'] ? <p className="lims-error" role="alert">{errs['options']}</p> : null}
          <Button size="sm" iconStart="plus" onPress={() => setOpts((x) => [...x, { code: '', display: '' }])}>Add option</Button>
        </fieldset>
      ) : null}
      {triggers.length > 0 ? (
        <>
          <Select label="Show if field" name="show_if_field" options={[{ value: NONE, label: 'Always show' }, ...triggers.map((f) => ({ value: f.key, label: f.label }))]} value={trig} onChange={(v) => { setTrig(v); setEquals(undefined); }} />
          {trigField ? <Select label="Equals" name="show_if_equals" options={equalsOptions} {...(equals !== undefined ? { value: equals } : {})} onChange={setEquals} {...(errs['show_if'] ? { error: errs['show_if'] } : {})} /> : null}
        </>
      ) : null}
    </FormDialog>
  );
}
