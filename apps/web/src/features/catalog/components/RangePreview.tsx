'use client';
// SCR-08 preview panel (#51, AC-05.1–05.6, 05.10): which band would match this patient profile? A read — nothing is written.
import { useState } from 'react';
import { Button } from '@lims/ui/components/Button';
import { DateTimePicker } from '@lims/ui/components/DateTimePicker';
import { Form } from '@lims/ui/components/Form';
import { IntegerField } from '@lims/ui/components/IntegerField';
import { Select } from '@lims/ui/components/Select';
import { previewReferenceRangeAction } from '../server/actions';
import { SEXES, type PreviewResult, type Sex } from '../server/types';
import { FailBanner, type Fail } from './shared';

// ponytail: months/years use average lengths; the API does the exact calendar maths for date-of-birth based matching.
const UNITS = [
  { value: 'years', label: 'Years', days: 365.25 },
  { value: 'months', label: 'Months', days: 30.4375 },
  { value: 'weeks', label: 'Weeks', days: 7 },
  { value: 'days', label: 'Days', days: 1 },
] as const;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function RangePreview({ analyteId, specimenTypes }: { analyteId: string; specimenTypes: readonly { id: string; code: string; name: string }[] }) {
  const [sex, setSex] = useState<Sex>();
  const [age, setAge] = useState<number>();
  const [unit, setUnit] = useState<(typeof UNITS)[number]['value']>('years');
  const [specimen, setSpecimen] = useState<string>();
  const [at, setAt] = useState<string>();
  const [result, setResult] = useState<PreviewResult>();
  const [fail, setFail] = useState<Fail>();
  const [ageError, setAgeError] = useState<string>();

  const submit = async () => {
    const days = Math.floor((age ?? 0) * UNITS.find((u) => u.value === unit)!.days);
    if (days < 0 || days > 73000) return setAgeError('Age must be between 0 and 73000 days');
    setAgeError(undefined);
    const r = await previewReferenceRangeAction({ analyte_id: analyteId, sex: sex!, age_days: days, ...(specimen ? { specimen_type_code: specimen } : {}), ...(at ? { at } : {}) });
    if (r.ok) { setFail(undefined); setResult(r.data); } else { setResult(undefined); setFail(r); }
  };

  const m = result?.reference_range;
  const c = result?.critical_limits;
  return (
    <section className="lims-stack catalog-gap-3" aria-label="Preview">
      <Form onSubmit={submit} errorSummary={false}>
        <Select label="Sex" name="sex" isRequired {...(sex ? { value: sex } : {})} onChange={setSex} options={SEXES.map((s) => ({ value: s, label: cap(s) }))} />
        <IntegerField label="Age" name="age" min={0} max={73000} isRequired {...(age !== undefined ? { value: age } : {})} onChange={(v) => { setAge(v); setAgeError(undefined); }} {...(ageError ? { error: ageError } : {})} />
        <Select label="Unit" name="age_unit" value={unit} onChange={setUnit} options={UNITS} />
        <Select label="Specimen type" name="specimen_type_code" placeholder="Any" {...(specimen ? { value: specimen } : {})} onChange={setSpecimen} options={specimenTypes.map((s) => ({ value: s.code, label: s.name }))} />
        <DateTimePicker label="At" name="at" {...(at ? { value: at as never } : {})} onChange={setAt} />
        <Button type="submit" variant="primary">Preview</Button>
      </Form>
      {fail ? <FailBanner fail={fail} /> : null}
      <div role="status" className="lims-stack catalog-gap-1">
        {result?.no_reference_range ? <p>No reference range</p> : null}
        {m && (m.kind === 'text' || m.kind === 'ordinal') ? (
          <>
            <p>{m.text}</p>
            {m.normal_codes?.length ? <p>{`Normal codes: ${m.normal_codes.join(', ')}`}</p> : null}
          </>
        ) : null}
        {m && m.kind !== 'text' && m.kind !== 'ordinal' ? <p>{`Matches band: ${m.low ?? ''} - ${m.high ?? ''} ${m.unit_code ?? ''} (version ${m.version})`}</p> : null}
        {c ? <p>{`Critical limits: ${c.low ?? ''} - ${c.high ?? ''} ${c.unit_code ?? ''} (version ${c.version})`}</p> : null}
      </div>
    </section>
  );
}
