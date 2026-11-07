// 04-UI-UX §2.5 FilterBar. date_range values are [from, to] A.D. IsoDates ([CONV]: the value map only holds string | string[]).
import { useId } from 'react';
import { Label, ListBox, ListBoxItem, type Selection } from 'react-aria-components';
import { Button } from '../Button/Button';
import { DateRangePicker } from '../DateRangePicker/DateRangePicker';
import { Select } from '../Select/Select';
import { TextField } from '../TextField/TextField';
import type { IsoDate } from '../_shared/dates';

export type FilterDef = { id: string; label: string } & (
  | { kind: 'select'; options: readonly { value: string; label: string }[]; multiple?: boolean }
  | { kind: 'date_range' }
  | { kind: 'text'; maxLength: number }
  | { kind: 'coded'; codedSet: string; options: readonly { code: string; display: string }[] }
);
export type FilterValue = Readonly<Record<string, string | readonly string[] | undefined>>;

export interface FilterBarProps {
  filters: readonly FilterDef[];
  value: FilterValue;
  onChange: (v: FilterValue) => void;
  onReset: () => void;
  'data-testid'?: string;
}

function MultiSelect({ label, options, value, onChange }: { label: string; options: readonly { value: string; label: string }[]; value: readonly string[]; onChange: (v: string[]) => void }) {
  const id = useId();
  return (
    <div className="lims-field">
      <Label id={id} className="lims-label">
        {label}
      </Label>
      <ListBox
        aria-labelledby={id}
        className="lims-listbox lims-chip-list"
        orientation="horizontal"
        selectionMode="multiple"
        selectedKeys={new Set(value)}
        onSelectionChange={(s: Selection) => onChange(s === 'all' ? options.map((o) => o.value) : [...s].map(String))}
      >
        {options.map((o) => (
          <ListBoxItem key={o.value} id={o.value} textValue={o.label} className="lims-option lims-chip">
            {o.label}
          </ListBoxItem>
        ))}
      </ListBox>
    </div>
  );
}

export function FilterBar({ filters, value, onChange, onReset, ...rest }: FilterBarProps) {
  const set = (id: string, v: string | readonly string[] | undefined) => onChange({ ...value, [id]: v });
  const str = (id: string) => (typeof value[id] === 'string' ? (value[id] as string) : undefined);
  const arr = (id: string) => (Array.isArray(value[id]) ? (value[id] as readonly string[]) : []);
  return (
    <div role="search" className="lims-filter-bar" {...rest}>
      {filters.map((f) => {
        const key = `f-${f.id}`;
        if (f.kind === 'text') return <TextField key={key} label={f.label} name={f.id} maxLength={f.maxLength} value={str(f.id) ?? ''} onChange={(v) => set(f.id, v === '' ? undefined : v)} />;
        if (f.kind === 'date_range') {
          const [from, to] = arr(f.id) as readonly IsoDate[];
          return (
            <DateRangePicker
              key={key}
              label={f.label}
              name={f.id}
              {...(from && to ? { value: { from, to } } : {})}
              onChange={(r) => set(f.id, r ? [r.from, r.to] : undefined)}
            />
          );
        }
        if (f.kind === 'coded') {
          const v = str(f.id);
          return <Select key={key} label={f.label} name={f.id} options={f.options.map((o) => ({ value: o.code, label: o.display }))} {...(v ? { value: v } : {})} onChange={(c) => set(f.id, c)} />;
        }
        if (f.multiple) return <MultiSelect key={key} label={f.label} options={f.options} value={arr(f.id)} onChange={(v) => set(f.id, v.length ? v : undefined)} />;
        const v = str(f.id);
        return <Select key={key} label={f.label} name={f.id} options={f.options} {...(v ? { value: v } : {})} onChange={(x) => set(f.id, x)} />;
      })}
      <Button variant="ghost" onPress={onReset}>
        Reset filters
      </Button>
    </div>
  );
}
