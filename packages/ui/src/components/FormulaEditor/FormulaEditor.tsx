import { useEffect, useState } from 'react';
import { TextInputBase, type FieldBase } from '../_shared/TextInputBase';

export interface FormulaDiagnostic {
  message: string;
  /** 0-based character offset in the formula. */
  position: number;
}

export interface FormulaEditorProps extends FieldBase {
  value?: string;
  onChange?: (v: string) => void;
  /** REQUIRED: mirror the spec maxLength. */
  maxLength: number;
  /** Parser output (from @lims/shared-ts formula); shown as text, never colour only. */
  diagnostics?: readonly FormulaDiagnostic[];
  rows?: number;
}

const at = (d: FormulaDiagnostic) => `${d.message} (position ${d.position})`;

/** Monospace multi-line formula input (C3). Autocomplete/parser wiring is the consumer's (not built here). */
export function FormulaEditor({ value, onChange, diagnostics = [], error, rows = 4, ...rest }: FormulaEditorProps) {
  // Local draft so typing is not lost while the parent debounces/parses; a new `value` prop wins.
  const [draft, setDraft] = useState(value ?? '');
  useEffect(() => setDraft(value ?? ''), [value]);
  const diagText = diagnostics.map(at).join('; ');
  return (
    <TextInputBase
      {...rest}
      multiline
      rows={rows}
      inputProps={{ className: 'lims-input lims-mono' }}
      text={draft}
      {...(error || diagText ? { error: error ?? diagText } : {})}
      {...(!error && diagnostics.length
        ? {
            errorContent: diagnostics.map((d, i) => (
              <span key={i} className="lims-diagnostic">
                <span>{d.message}</span> <span>(position {d.position})</span>
              </span>
            )),
          }
        : {})}
      onText={(v: string) => {
        const n = v.normalize('NFC');
        setDraft(n);
        onChange?.(n);
      }}
    />
  );
}
