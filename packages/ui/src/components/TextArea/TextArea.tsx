import { useState } from 'react';
import { TextInputBase, type FieldBase } from '../_shared/TextInputBase';

export interface TextAreaProps extends FieldBase {
  value?: string;
  onChange?: (v: string) => void;
  maxLength: number;
  /** Default 3. */
  rows?: number;
  /** Default true. */
  showCount?: boolean;
}

export function TextArea({ value, onChange, rows = 3, showCount = true, ...rest }: TextAreaProps) {
  const [own, setOwn] = useState('');
  const text = value ?? own;
  return (
    <TextInputBase
      {...rest}
      multiline
      rows={rows}
      text={text}
      onText={(v) => {
        const n = v.normalize('NFC');
        setOwn(n);
        onChange?.(n);
      }}
      footer={
        showCount ? (
          <span className="lims-count" aria-hidden="true">
            {text.length} / {rest.maxLength}
          </span>
        ) : null
      }
    />
  );
}
