import { useRef } from 'react';
import { Label, Radio, RadioGroup as RacRadioGroup, Text } from 'react-aria-components';
import { useFormField } from '../Form/FormContext';
import { msg } from '../_shared/messages';
import type { FieldBase } from '../_shared/TextInputBase';

export interface RadioGroupProps<V extends string> extends FieldBase {
  value?: V;
  onChange?: (v: V) => void;
  options: readonly { value: V; label: string; isDisabled?: boolean }[]; // LD-83 / CR-C8-NEW: per-option disable (additive)
  orientation?: 'horizontal' | 'vertical';
}

export function RadioGroup<V extends string>({ label, name, description, error: ownError, isRequired, isDisabled, isReadOnly, value, onChange, options, orientation = 'vertical', ...rest }: RadioGroupProps<V>) {
  const root = useRef<HTMLDivElement>(null);
  const current = useRef<string | undefined>(value);
  current.current = value ?? current.current;
  const error = useFormField(
    name,
    { validate: () => (isRequired && !current.current ? msg.required(label) : undefined), focus: () => root.current?.querySelector<HTMLInputElement>('input')?.focus() },
    ownError,
  );
  return (
    <RacRadioGroup
      ref={root}
      className="lims-field lims-radio-group"
      name={name}
      orientation={orientation}
      validationBehavior="aria"
      isInvalid={!!error}
      {...(value !== undefined ? { value } : {})}
      {...(isRequired ? { isRequired: true } : {})}
      {...(isDisabled ? { isDisabled: true } : {})}
      {...(isReadOnly ? { isReadOnly: true } : {})}
      {...(rest['data-testid'] ? { 'data-testid': rest['data-testid'] } : {})}
      onChange={(v) => {
        current.current = v;
        onChange?.(v as V);
      }}
    >
      <Label className="lims-label">
        {label}
        {isRequired ? <span aria-hidden="true"> *</span> : null}
      </Label>
      <div className={`lims-radio-options lims-${orientation}`}>
        {options.map((o) => (
          <Radio key={o.value} value={o.value} className="lims-radio" {...(o.isDisabled ? { isDisabled: true } : {})}>
            <span className="lims-radio-dot" aria-hidden="true" />
            {o.label}
          </Radio>
        ))}
      </div>
      {description ? (
        <Text slot="description" className="lims-description">
          {description}
        </Text>
      ) : null}
      {error ? (
        <Text slot="errorMessage" className="lims-error">
          {error}
        </Text>
      ) : null}
    </RacRadioGroup>
  );
}
