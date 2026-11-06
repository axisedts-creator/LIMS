import { TextInputBase, type FieldBase } from '../_shared/TextInputBase';

export interface CodeFieldProps extends FieldBase {
  value?: string;
  onChange?: (v: string) => void;
  /** REQUIRED: mirror the spec maxLength. */
  maxLength: number;
  /** Regex source from the spec (e.g. `^[A-Z0-9][A-Z0-9_]{0,31}$`). */
  pattern: string;
  /** Plain-language form of the pattern; always shown and linked as the description. */
  patternHint: string;
}

/** Upper-casing code input (C3 codes). Create-only codes pass isReadOnly on edit. */
export function CodeField({ value, onChange, pattern, patternHint, description, ...rest }: CodeFieldProps) {
  const re = new RegExp(pattern);
  return (
    <TextInputBase
      {...rest}
      description={description ? `${description} ${patternHint}` : patternHint}
      text={value}
      autoComplete="off"
      inputProps={{ spellCheck: false, className: 'lims-input lims-mono' }}
      validate={(v) => (re.test(v.toUpperCase()) ? undefined : patternHint)}
      {...(onChange ? { onText: (v: string) => onChange(v.normalize('NFC').toUpperCase()) } : {})}
    />
  );
}
