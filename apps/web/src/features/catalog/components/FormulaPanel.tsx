'use client';
// SCR-07 formula field (F-05, AC-04.8): debounced server validation (#36, read-only), Inputs/Order summary, "Try it" sample evaluation.
import { useEffect, useState } from 'react';
import { Button } from '@lims/ui/components/Button';
import { DecimalField } from '@lims/ui/components/DecimalField';
import { FormulaEditor } from '@lims/ui/components/FormulaEditor';
import { IntegerField } from '@lims/ui/components/IntegerField';
import { Select } from '@lims/ui/components/Select';
import { validateFormulaAction } from '../server/actions';
import { SEXES, type FormulaValidation } from '../server/types';
import './catalog.css';

const DEBOUNCE_MS = 400;
/** '/expression/4' → 4 (character offset); anything else → 0. */
const positionOf = (path?: string) => {
  const n = Number(path?.split('/').pop());
  return Number.isInteger(n) && n >= 0 ? n : 0;
};

export function FormulaPanel({ analyteId, value, onChange, error, isReadOnly }: {
  analyteId?: string | undefined;
  value: string;
  onChange: (v: string) => void;
  /** Server error from a mutation (e.g. a cycle path), shown under the field. */
  error?: string | undefined;
  isReadOnly?: boolean;
}) {
  const [text, setText] = useState(value);
  const [res, setRes] = useState<FormulaValidation>();
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [age, setAge] = useState<number>();
  const [sex, setSex] = useState<string>();
  const [tried, setTried] = useState<{ result?: string; reason?: string }>();

  useEffect(() => setText(value), [value]);

  useEffect(() => {
    if (text.trim() === '') {
      setRes(undefined);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      validateFormulaAction({ ...(analyteId ? { analyte_id: analyteId } : {}), expression: text })
        .then((r) => live && setRes(r.ok ? r.data : undefined))
        .catch(() => undefined); // validation is advisory; the mutation re-checks
    }, DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [text, analyteId]);

  const codes = res?.valid ? res.input_analyte_codes : [];
  const diagnostics = res && !res.valid ? res.errors.map((e) => ({ message: e.message, position: positionOf(e.path) })) : [];

  const tryIt = async () => {
    const sample_inputs = Object.fromEntries(codes.filter((c) => inputs[c]).map((c) => [c, inputs[c]!]));
    const r = await validateFormulaAction({
      ...(analyteId ? { analyte_id: analyteId } : {}),
      expression: text,
      sample_inputs,
      ...(age !== undefined && sex ? { sample_context: { age_days: age, sex } } : {}),
    }).catch(() => undefined);
    if (!r?.ok) return setTried({ reason: 'The sample could not be evaluated.' });
    setTried({ ...(r.data.sample_result !== undefined ? { result: r.data.sample_result } : {}), ...(r.data.sample_not_computable_reason ? { reason: r.data.sample_not_computable_reason } : {}) });
  };

  return (
    <div className="lims-stack catalog-gap-3">
      <div aria-live="polite">
        <FormulaEditor
          label="Formula"
          name="formula_expression"
          maxLength={500}
          value={text}
          diagnostics={diagnostics}
          {...(error ? { error } : {})}
          {...(isReadOnly ? { isReadOnly: true } : {})}
          onChange={(v) => {
            setText(v);
            setTried(undefined);
            onChange(v);
          }}
        />
        {res?.valid ? (
          <>
            <p>{`Inputs: ${res.input_analyte_codes.join(', ')}`}</p>
            <p>{`Order: ${res.dependency_order.join(' → ')}`}</p>
          </>
        ) : null}
      </div>
      {codes.length > 0 ? (
        // Enter here must not submit the surrounding analyte form; it runs the sample instead.
        <div
          className="lims-stack catalog-gap-2"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
              e.preventDefault();
              void tryIt();
            }
          }}
        >
          {codes.map((c) => (
            <DecimalField key={c} label={c} name={`try_${c}`} decimals={6} allowNegative {...(inputs[c] !== undefined ? { value: inputs[c] } : {})} onChange={(v) => setInputs((s) => ({ ...s, [c]: v ?? '' }))} />
          ))}
          <IntegerField label="Sample age (days)" name="try_age_days" min={0} max={73000} {...(age !== undefined ? { value: age } : {})} onChange={setAge} />
          <Select label="Sample sex" name="try_sex" options={SEXES.map((s) => ({ value: s, label: s.charAt(0).toUpperCase() + s.slice(1) }))} {...(sex ? { value: sex as (typeof SEXES)[number] } : {})} onChange={setSex} />
          <div><Button onPress={() => void tryIt()}>Try it</Button></div>
          {tried?.result !== undefined ? <p>{`Result: ${tried.result}`}</p> : null}
          {tried?.reason ? <p>{tried.reason}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
