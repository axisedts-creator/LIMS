// 04-UI-UX §2.2 Combobox: async options (debounced, aborting stale requests), optional create entry.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ComboBox, Input, Label, ListBox, ListBoxItem, Popover, Text, type Key } from 'react-aria-components';
import { useFormField } from '../Form/FormContext';
import { msg } from '../_shared/messages';
import type { FieldBase } from '../_shared/TextInputBase';

export interface ComboboxProps<T> extends FieldBase {
  value?: T | undefined;
  onChange?: (v: T | undefined) => void;
  loadOptions: (query: string, signal: AbortSignal) => Promise<readonly T[]>;
  getKey: (t: T) => string;
  renderOption: (t: T) => ReactNode;
  renderValue: (t: T) => string;
  /** Default 1. */
  minChars?: number;
  /** Default 150. */
  debounceMs?: number;
  allowCreate?: { label: string; onCreate: (query: string) => void };
}

const CREATE = '\u0000create';

export function Combobox<T>({
  label,
  name,
  description,
  error: ownError,
  isRequired,
  isDisabled,
  isReadOnly,
  value,
  onChange,
  loadOptions,
  getKey,
  renderOption,
  renderValue,
  minChars = 1,
  debounceMs = 150,
  allowCreate,
  ...rest
}: ComboboxProps<T>) {
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(() => (value !== undefined ? renderValue(value) : ''));
  const [query, setQuery] = useState<string | null>(null); // null = nothing to search
  const [items, setItems] = useState<readonly T[]>([]);
  const load = useRef(loadOptions);
  load.current = loadOptions;
  const error = useFormField(name, { validate: () => (isRequired && value === undefined ? msg.required(label) : undefined), focus: () => input.current?.focus() }, ownError);

  const valueKey = value !== undefined ? getKey(value) : null;
  useEffect(() => {
    if (value !== undefined) setText(renderValue(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valueKey]);

  useEffect(() => {
    if (query === null || query.length < minChars) {
      setItems([]);
      return;
    }
    const ctl = new AbortController();
    const t = setTimeout(() => {
      Promise.resolve()
        .then(() => load.current(query, ctl.signal))
        .then(
          (r) => {
            if (!ctl.signal.aborted) setItems(r);
          },
          () => {
            if (!ctl.signal.aborted) setItems([]);
          },
        );
    }, debounceMs);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [query, minChars, debounceMs]);

  const showCreate = !!allowCreate && query !== null && query.trim().length >= minChars;
  const options: { key: string; item?: T }[] = [...items.map((i) => ({ key: getKey(i), item: i })), ...(showCreate ? [{ key: CREATE }] : [])];

  const onInputChange = (q: string) => {
    setText(q);
    if (value !== undefined && q === renderValue(value)) return; // RAC echoes the chosen item's text
    if (q === '' && value !== undefined) onChange?.(undefined);
    setQuery(q);
  };

  const onSelectionChange = (k: Key | null) => {
    if (k === null) return;
    if (k === CREATE) {
      allowCreate?.onCreate(query ?? text);
      return;
    }
    const hit = items.find((i) => getKey(i) === k);
    if (!hit) return;
    setText(renderValue(hit));
    setQuery(null);
    onChange?.(hit);
  };

  return (
    <ComboBox
      className="lims-field"
      name={name}
      inputValue={text}
      onInputChange={onInputChange}
      selectedKey={valueKey}
      onSelectionChange={onSelectionChange}
      items={options}
      allowsEmptyCollection
      allowsCustomValue // Esc must not rewrite the text (that re-opens the list); blur reset below keeps text == value
      menuTrigger="input"
      validationBehavior="aria"
      isInvalid={!!error}
      {...(isRequired ? { isRequired: true } : {})}
      {...(isDisabled ? { isDisabled: true } : {})}
      {...(isReadOnly ? { isReadOnly: true } : {})}
      {...(rest['data-testid'] ? { 'data-testid': rest['data-testid'] } : {})}
    >
      <Label className="lims-label">
        {label}
        {isRequired ? <span aria-hidden="true"> *</span> : null}
      </Label>
      <Input
        ref={input}
        className="lims-input"
        onBlur={() => {
          setText(value !== undefined ? renderValue(value) : '');
          setQuery(null);
        }}
      />
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
      <Popover className="lims-popover" isNonModal>
        <ListBox className="lims-listbox" items={options}>
          {(o) =>
            o.item !== undefined ? (
              <ListBoxItem id={o.key} textValue={renderValue(o.item)} className="lims-option">
                {renderOption(o.item)}
              </ListBoxItem>
            ) : (
              <ListBoxItem id={CREATE} textValue={query ?? ''} className="lims-option lims-option-create">
                {`${allowCreate?.label ?? ''}: “${query ?? ''}”`}
              </ListBoxItem>
            )
          }
        </ListBox>
      </Popover>
    </ComboBox>
  );
}
