import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { Input, Label, Text, TextArea as RacTextArea, TextField as RacTextField } from 'react-aria-components';
import { useFormField } from '../Form/FormContext';
import { msg } from './messages';

export interface FieldBase {
  label: string;
  name: string;
  description?: string;
  error?: string;
  isRequired?: boolean;
  isDisabled?: boolean;
  isReadOnly?: boolean;
  'data-testid'?: string;
}

interface Props extends FieldBase {
  /** Controlled text; undefined = uncontrolled. */
  text?: string | undefined;
  onText?: (raw: string) => void;
  /** Extra checks after "required"; receives the current DOM text. */
  validate?: (text: string) => string | undefined;
  maxLength?: number;
  multiline?: boolean;
  rows?: number;
  prefix?: string | undefined;
  suffix?: string | undefined;
  inputMode?: 'text' | 'numeric' | 'decimal' | 'tel' | 'email';
  autoComplete?: string | undefined;
  inputProps?: Record<string, unknown>;
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
  footer?: ReactNode;
  /** Rich rendering of the error (e.g. a diagnostics list); `error` stays the plain-text form for the Form summary. */
  errorContent?: ReactNode;
}

export function TextInputBase(p: Props) {
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const error = useFormField(
    p.name,
    {
      validate: () => {
        const v = ref.current?.value ?? p.text ?? '';
        if (p.isRequired && v.trim() === '') return msg.required(p.label);
        if (p.maxLength !== undefined && v.length > p.maxLength) return msg.maxLength(p.label, p.maxLength);
        return v === '' ? undefined : p.validate?.(v);
      },
      focus: () => ref.current?.focus(),
    },
    p.error,
  );
  const control = p.multiline ? (
    <RacTextArea ref={ref} rows={p.rows ?? 3} className={(p.inputProps?.['className'] as string | undefined) ?? 'lims-input'} />
  ) : (
    <Input ref={ref} className="lims-input" {...(p.inputProps ?? {})} {...(p.onKeyDown ? { onKeyDown: p.onKeyDown } : {})} />
  );
  return (
    <RacTextField
      className="lims-field"
      name={p.name}
      validationBehavior="aria"
      isInvalid={!!error}
      {...(p.text !== undefined ? { value: p.text } : {})}
      {...(p.onText ? { onChange: p.onText } : {})}
      {...(p.maxLength !== undefined ? { maxLength: p.maxLength } : {})}
      {...(p.isRequired ? { isRequired: true } : {})}
      {...(p.isDisabled ? { isDisabled: true } : {})}
      {...(p.isReadOnly ? { isReadOnly: true } : {})}
      {...(p.inputMode ? { inputMode: p.inputMode } : {})}
      {...(p.autoComplete ? { autoComplete: p.autoComplete } : {})}
      {...(p['data-testid'] ? { 'data-testid': p['data-testid'] } : {})}
    >
      <Label className="lims-label">
        {p.label}
        {p.isRequired ? <span aria-hidden="true"> *</span> : null}
      </Label>
      <div className="lims-input-group">
        {p.prefix ? <span className="lims-affix">{p.prefix}</span> : null}
        {control}
        {p.suffix ? <span className="lims-affix">{p.suffix}</span> : null}
      </div>
      {p.description ? (
        <Text slot="description" className="lims-description">
          {p.description}
        </Text>
      ) : null}
      {error ? (
        <Text slot="errorMessage" className="lims-error">
          {error === p.error && p.errorContent ? p.errorContent : error}
        </Text>
      ) : null}
      {p.footer}
    </RacTextField>
  );
}
