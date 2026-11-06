import { TextInputBase, type FieldBase } from '../_shared/TextInputBase';

export interface TextFieldProps extends FieldBase {
  value?: string;
  onChange?: (v: string) => void;
  /** REQUIRED: mirror the spec maxLength. */
  maxLength: number;
  inputMode?: 'text' | 'numeric' | 'tel' | 'email';
  autoComplete?: string;
  prefix?: string;
  suffix?: string;
  /** Default 'nfc' (CV §13). */
  normalize?: 'nfc';
}

export function TextField({ value, onChange, normalize = 'nfc', ...rest }: TextFieldProps) {
  return (
    <TextInputBase
      {...rest}
      text={value}
      {...(onChange ? { onText: (v: string) => onChange(normalize === 'nfc' ? v.normalize('NFC') : v) } : {})}
    />
  );
}
