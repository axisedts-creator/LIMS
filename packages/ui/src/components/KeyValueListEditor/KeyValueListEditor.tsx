import { useId } from 'react';
import { Button } from '../Button/Button';
import { VisuallyHidden } from '../VisuallyHidden/VisuallyHidden';
import type { FieldBase } from '../_shared/TextInputBase';

export interface KeyValueRow {
  key: string;
  value: string;
}

export interface KeyValueListEditorProps extends FieldBase {
  value: readonly KeyValueRow[];
  onChange: (rows: KeyValueRow[]) => void;
  maxRows: number;
  keyMaxLength: number;
  valueMaxLength: number;
  /** Column captions; default "Key" / "Value". */
  keyLabel?: string;
  valueLabel?: string;
}

/** Ordered key/value rows with Add / Remove (C7 flag maps). */
export function KeyValueListEditor({
  label, name, description, error, isRequired, isDisabled, isReadOnly, value, onChange, maxRows, keyMaxLength, valueMaxLength,
  keyLabel = 'Key', valueLabel = 'Value', ...rest
}: KeyValueListEditorProps) {
  const id = useId();
  const locked = !!(isDisabled || isReadOnly);
  const set = (i: number, patch: Partial<KeyValueRow>) => onChange(value.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  const describedBy = [description ? `${id}-d` : '', error ? `${id}-e` : ''].filter(Boolean).join(' ') || undefined;
  return (
    <fieldset className="lims-field lims-kv" aria-describedby={describedBy} {...rest}>
      <legend className="lims-label">
        {label}
        {isRequired ? <span aria-hidden="true"> *</span> : null}
      </legend>
      {value.map((r, i) => (
        <div key={i} className="lims-kv-row">
          <input
            className="lims-input"
            aria-label={`${keyLabel} ${i + 1}`}
            name={`${name}[${i}].key`}
            maxLength={keyMaxLength}
            value={r.key}
            disabled={isDisabled}
            readOnly={isReadOnly}
            aria-invalid={error ? true : undefined}
            onChange={(e) => set(i, { key: e.target.value.normalize('NFC') })}
          />
          <input
            className="lims-input"
            aria-label={`${valueLabel} ${i + 1}`}
            name={`${name}[${i}].value`}
            maxLength={valueMaxLength}
            value={r.value}
            disabled={isDisabled}
            readOnly={isReadOnly}
            aria-invalid={error ? true : undefined}
            onChange={(e) => set(i, { value: e.target.value.normalize('NFC') })}
          />
          {!locked ? (
            <Button variant="ghost" size="sm" onPress={() => onChange(value.filter((_, k) => k !== i))}>
              Remove<VisuallyHidden>{` row ${i + 1}${r.key ? ` (${r.key})` : ''}`}</VisuallyHidden>
            </Button>
          ) : null}
        </div>
      ))}
      {!locked ? (
        <Button size="sm" iconStart="plus" isDisabled={value.length >= maxRows} onPress={() => onChange([...value, { key: '', value: '' }])}>
          Add row
        </Button>
      ) : null}
      {description ? (
        <span id={`${id}-d`} className="lims-description">
          {description}
        </span>
      ) : null}
      {error ? (
        <span id={`${id}-e`} className="lims-error">
          {error}
        </span>
      ) : null}
    </fieldset>
  );
}
