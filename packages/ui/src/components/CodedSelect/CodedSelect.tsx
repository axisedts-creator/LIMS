import { Select } from '../Select/Select';
import type { FieldBase } from '../_shared/TextInputBase';

export interface CodedSelectProps extends FieldBase {
  /** x-coded-set name. */
  codedSet: string;
  value?: string;
  onChange?: (code: string) => void;
  /** Loaded by the feature via BFF; inactive codes hidden unless currently selected. */
  options: readonly { code: string; display: string; isActive: boolean }[];
  placeholder?: string;
}

// codedSet names the set for callers/tests; options arrive already loaded.
export function CodedSelect({ codedSet: _codedSet, options, ...rest }: CodedSelectProps) {
  const shown = options.filter((o) => o.isActive || o.code === rest.value).map((o) => ({ value: o.code, label: o.display }));
  return <Select {...rest} options={shown} />;
}
