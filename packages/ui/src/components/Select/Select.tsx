import { useRef } from 'react';
import {
  Button as RacButton,
  Label,
  ListBox,
  ListBoxItem,
  Popover,
  Select as RacSelect,
  SelectValue,
  Text,
  type Key,
} from 'react-aria-components';
import { Icon } from '../Icon/Icon';
import { useFormField } from '../Form/FormContext';
import { msg } from '../_shared/messages';
import type { FieldBase } from '../_shared/TextInputBase';

export interface SelectProps<V extends string> extends FieldBase {
  value?: V;
  onChange?: (v: V) => void;
  options: readonly { value: V; label: string; isDisabled?: boolean }[];
  placeholder?: string;
}

export function Select<V extends string>({ label, name, description, error: ownError, isRequired, isDisabled, isReadOnly, value, onChange, options, placeholder, ...rest }: SelectProps<V>) {
  const trigger = useRef<HTMLButtonElement>(null);
  const current = useRef<string | undefined>(value);
  current.current = value ?? current.current;
  const error = useFormField(name, { validate: () => (isRequired && !current.current ? msg.required(label) : undefined), focus: () => trigger.current?.focus() }, ownError);
  const disabledKeys = options.filter((o) => o.isDisabled).map((o) => o.value);
  return (
    <RacSelect
      className="lims-field"
      name={name}
      validationBehavior="aria"
      isInvalid={!!error}
      disabledKeys={disabledKeys}
      {...(value !== undefined ? { selectedKey: value } : {})}
      {...(placeholder ? { placeholder } : {})}
      {...(isRequired ? { isRequired: true } : {})}
      {...(isDisabled || isReadOnly ? { isDisabled: true } : {})}
      {...(rest['data-testid'] ? { 'data-testid': rest['data-testid'] } : {})}
      onSelectionChange={(k: Key | null) => {
        if (k === null || isReadOnly) return;
        current.current = String(k);
        onChange?.(String(k) as V);
      }}
    >
      <Label className="lims-label">
        {label}
        {isRequired ? <span aria-hidden="true"> *</span> : null}
      </Label>
      <RacButton ref={trigger} className="lims-input lims-select-trigger">
        <SelectValue />
        <Icon name="chevron-down" />
      </RacButton>
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
      {/* [CONV] non-modal like the APG select-only combobox: the trigger stays in the a11y tree; closes on blur, Esc or selection */}
      <Popover className="lims-popover" isNonModal>
        <ListBox className="lims-listbox">
          {options.map((o) => (
            <ListBoxItem key={o.value} id={o.value} textValue={o.label} className="lims-option">
              {o.label}
            </ListBoxItem>
          ))}
        </ListBox>
      </Popover>
    </RacSelect>
  );
}
