'use client';
// One row of the AST grid (04-UI-UX §3.3): antibiotic, method, raw value, suggestion + "Use", category, source, report. LD-140 (2026-11-13): kit components only.
// Memoised: an edit in one row must not re-render the other rows (a panel can have 60 antibiotics). The comparator looks at the values the row shows; the handlers are stable.
import { memo } from 'react';
import { Button } from '@lims/ui/components/Button';
import { Checkbox } from '@lims/ui/components/Checkbox';
import { Icon } from '@lims/ui/components/Icon';
import { Inline } from '@lims/ui/components/Inline';
import { Select } from '@lims/ui/components/Select';
import { TextField } from '@lims/ui/components/TextField';
import { VisuallyHidden } from '@lims/ui/components/VisuallyHidden';
import { Chip, type Tone } from '../common';
import type { AstMethod, AstResultDto, AstSuggestion } from '../../server/types';
import { RAW_VALUE_MESSAGE } from './rawValue';

/** A controlled Select value that is not an option: shows the placeholder (the kit Select cannot be given null). */
export const NONE = '__none__';
const METHOD_LABEL: Record<AstMethod, string> = { mic: 'MIC', zone_diameter: 'Zone', other: 'Other' };
export const methodLabel = (m: AstMethod) => METHOD_LABEL[m];
const UNIT: Partial<Record<AstMethod, string>> = { mic: 'µg/mL', zone_diameter: 'mm' };
const SOURCE: Record<string, { label: string; tone: Tone }> = { manual: { label: 'Manual', tone: 'neutral' }, instrument: { label: 'Instrument', tone: 'info' }, suggested: { label: 'Suggested', tone: 'success' } };

export interface RowError { target: 'raw' | 'category' | 'row'; text: string; code: string }
export interface Suggestion extends AstSuggestion { raw: string }
export interface Vm {
  row: AstResultDto; code: string; raw: string; category: string | undefined; report: boolean; rawEdited: boolean; catEdited: boolean; repEdited: boolean; dirty: boolean; valid: boolean;
}
export interface RowHandlers {
  raw: (code: string, raw: string) => void;
  category: (code: string, category: string) => void;
  report: (code: string, on: boolean) => void;
  add: (code: string, on: boolean) => void;
  use: (code: string, s: Suggestion) => void;
}
export interface AstRowProps {
  vm: Vm;
  options: readonly { value: string; label: string }[];
  error: RowError | undefined;
  suggestion: Suggestion | undefined;
  touched: boolean;
  askAdd: boolean;
  add: boolean;
  readOnly: boolean;
  on: RowHandlers;
}

const same = (a: AstRowProps, b: AstRowProps) =>
  a.vm.code === b.vm.code && a.vm.raw === b.vm.raw && a.vm.category === b.vm.category && a.vm.report === b.vm.report && a.vm.valid === b.vm.valid &&
  a.vm.row.antibiotic_display === b.vm.row.antibiotic_display && a.vm.row.method === b.vm.row.method && a.vm.row.source === b.vm.row.source && a.vm.row.interpretation_source === b.vm.row.interpretation_source &&
  a.options === b.options && a.error === b.error && a.suggestion === b.suggestion && a.touched === b.touched && a.askAdd === b.askAdd && a.add === b.add && a.readOnly === b.readOnly && a.on === b.on;

export const AstRow = memo(function AstRow({ vm: v, options, error: err, suggestion: s, touched, askAdd, add, readOnly, on }: AstRowProps) {
  const name = v.row.antibiotic_display;
  const src = v.row.source === 'instrument' || v.row.interpretation_source === 'instrument' ? 'instrument' : v.row.interpretation_source === 'breakpoint_suggestion' ? 'suggested' : 'manual';
  const rawErr = !v.valid && touched ? RAW_VALUE_MESSAGE : err?.target === 'raw' ? err.text : undefined;
  const unit = UNIT[v.row.method];
  return (
    <tr role="row">
      <td role="gridcell">
        {name}
        {err?.target === 'row' ? (
          <span className="lims-ast-note lims-error">
            <Icon name="danger" />
            {err.text}
          </span>
        ) : null}
        {askAdd && !readOnly ? <Checkbox label="Add to isolate" name={`add_${v.code}`} isSelected={add} onChange={(x) => on.add(v.code, x)} /> : null}
      </td>
      <td role="gridcell">{METHOD_LABEL[v.row.method]}</td>
      <td role="gridcell" data-ast-raw={v.code}>
        {/* the trailing space keeps the label apart from the unit suffix in the row's plain text */}
        <TextField
          label={`${name} raw value `}
          name={`raw_${v.code}`}
          maxLength={32}
          value={v.raw}
          {...(unit ? { suffix: unit } : {})}
          {...(rawErr ? { error: rawErr } : {})}
          {...(readOnly ? { isReadOnly: true } : {})}
          onChange={(raw) => on.raw(v.code, raw)}
        />
      </td>
      <td role="gridcell">
        {s ? (
          <Inline gap={1}>
            <span>{`Suggested: ${s.category_code} (${s.standard} ${s.standard_version})`}</span>
            {!readOnly ? (
              <Button size="sm" variant="ghost" onPress={() => on.use(v.code, s)}>
                Use
                <VisuallyHidden>{` suggested category ${s.category_code} for ${name}`}</VisuallyHidden>
              </Button>
            ) : null}
          </Inline>
        ) : null}
      </td>
      <td role="gridcell">
        {/* the leading space keeps the unit suffix of the previous cell apart from this label in the row's plain text */}
        <Select<string>
          label={` ${name} category`}
          name={`category_${v.code}`}
          placeholder="Choose"
          options={options}
          value={v.category ?? NONE}
          {...(err?.target === 'category' ? { error: err.text } : {})}
          {...(readOnly ? { isReadOnly: true } : {})}
          onChange={(c) => on.category(v.code, c)}
        />
      </td>
      <td role="gridcell">
        <Chip tone={SOURCE[src]!.tone} label={SOURCE[src]!.label} />
      </td>
      <td role="gridcell">
        <Checkbox label={`${name} report`} name={`report_${v.code}`} isSelected={v.report} {...(readOnly ? { isDisabled: true } : {})} onChange={(x) => on.report(v.code, x)} />
      </td>
    </tr>
  );
}, same);
