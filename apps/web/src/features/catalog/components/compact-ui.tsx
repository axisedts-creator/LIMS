'use client';
// T0D-TESTMGMT-1 (LD-318, T0D-DENSITY-1): small building blocks for the dense test management forms.
// [CONV] MiniSelect / Check are plain DOM on purpose: the kit Select and Checkbox add react-aria's visually-hidden native controls
// (inline style + a second <select> per field), which the one-screen form budget and the "no inner scroller" rule count against.
// MiniSelect is the APG select-only combobox: a button with role=combobox named by its label only (the value is its content), a listbox popup.
import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Button } from '@lims/ui/components/Button';
import { Card } from '@lims/ui/components/Card';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { DescriptionList } from '@lims/ui/components/DescriptionList';
import './catalog.css';

export interface Opt { value: string; label: string }

export function MiniSelect({ label, value, options, onChange, isRequired, isDisabled, error, placeholder = 'Choose…' }: {
  label: string;
  value: string;
  options: readonly Opt[];
  onChange: (v: string) => void;
  isRequired?: boolean | undefined;
  isDisabled?: boolean | undefined;
  error?: string | undefined;
  placeholder?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const button = useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.value === value);
  const show = () => { setActive(Math.max(0, options.findIndex((o) => o.value === value))); setOpen(true); };
  const pick = (o: Opt | undefined) => { if (o) onChange(o.value); setOpen(false); button.current?.focus(); };
  const onKey = (e: KeyboardEvent) => {
    const k = e.key;
    if (!open) {
      if (k === 'ArrowDown' || k === 'ArrowUp' || k === 'Enter' || k === ' ') { e.preventDefault(); show(); }
      return;
    }
    if (k === 'ArrowDown') setActive((a) => Math.min(options.length - 1, a + 1));
    else if (k === 'ArrowUp') setActive((a) => Math.max(0, a - 1));
    else if (k === 'Home') setActive(0);
    else if (k === 'End') setActive(options.length - 1);
    else if (k === 'Enter' || k === ' ') pick(options[active]);
    else if (k === 'Escape') setOpen(false);
    else if (k === 'Tab') { setOpen(false); return; }
    else return;
    e.preventDefault();
  };
  return (
    <div className="lims-field catalog-mini-select" onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false); }}>
      <span id={`${id}-l`} className="lims-label">{label}{isRequired ? <span aria-hidden="true"> *</span> : null}</span>
      {/* LD-442 (T0D-UIX-2): APG select-only combobox on a focusable div (no raw button); disabled = aria-disabled, out of tab order, inert. */}
      <div
        ref={button}
        tabIndex={isDisabled ? -1 : 0}
        role="combobox"
        className="lims-input lims-select-trigger"
        aria-labelledby={`${id}-l`}
        aria-haspopup="listbox"
        aria-expanded={open}
        {...(open ? { 'aria-controls': `${id}-lb`, 'aria-activedescendant': `${id}-o${active}` } : {})}
        {...(isRequired ? { 'aria-required': true } : {})}
        {...(error ? { 'aria-invalid': true, 'aria-describedby': `${id}-e` } : {})}
        {...(isDisabled ? { 'aria-disabled': true } : {})}
        onClick={() => { if (!isDisabled) (open ? setOpen(false) : show()); }}
        onKeyDown={(e) => { if (!isDisabled) onKey(e); }}
      >
        {current?.label ?? placeholder}
      </div>
      {open ? (
        <div id={`${id}-lb`} role="listbox" aria-labelledby={`${id}-l`} className="lims-listbox catalog-mini-listbox">
          {options.map((o, i) => (
            <div
              key={o.value}
              id={`${id}-o${i}`}
              role="option"
              aria-selected={o.value === value}
              className={`lims-option${i === active ? ' catalog-option-active' : ''}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(o)}
            >
              {o.label}
            </div>
          ))}
        </div>
      ) : null}
      {error ? <span id={`${id}-e`} className="lims-error">{error}</span> : null}
    </div>
  );
}

/** Native checkbox with its label (light; no hidden duplicate control). */
export function Check({ label, checked, onChange, isDisabled }: { label: string; checked: boolean; onChange: (v: boolean) => void; isDisabled?: boolean | undefined }) {
  return (
    <label className="catalog-check">
      <input type="checkbox" checked={checked} disabled={isDisabled} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

/** One form section: heading + a grid of `columns` equal columns (data-columns drives the CSS and the one-screen budget). */
export function GridSection({ title, columns, note, children }: { title: string; columns: 3 | 4 | 5 | 6; note?: string; children: ReactNode }) {
  // T0D-UIGUARD-1-CATALOG (LD-436 R7): a kit Card region with its title row (no raw h2); data-columns stays on the section for the form budget.
  return (
    <Card title={title} region data-columns={columns}>
      {note ? <p className="lims-description">{note}</p> : null}
      <div className="catalog-grid" data-columns={columns}>{children}</div>
    </Card>
  );
}

export interface PreviewRow { name: string; value: string; unit: string; range: string }
const PREVIEW_HEADER = [
  { term: 'Patient', value: 'SAMPLE PATIENT (synthetic)' },
  { term: 'Age / Sex', value: '35 Y / Female' },
  { term: 'Sample', value: 'SAMPLE-0001' },
  { term: 'Date', value: '01/01/2026' },
] as const;
const PREVIEW_COLS: readonly ColumnDef<PreviewRow>[] = [
  { id: 'name', header: 'Test Name', cell: (r) => r.name, isRowHeader: true },
  { id: 'value', header: 'Value', cell: (r) => r.value },
  { id: 'unit', header: 'Unit', cell: (r) => r.unit },
  { id: 'range', header: 'Reference Range', cell: (r) => r.range },
];

/** Report preview built from SAMPLE data only (never a real patient): patient header block + Test Name · Value · Unit · Reference Range. */
export function ReportPreview({ title, rows }: { title?: string | undefined; rows: readonly PreviewRow[] }) {
  const all: readonly PreviewRow[] = title ? [{ name: title, value: '', unit: '', range: '' }, ...rows] : rows;
  return (
    <Card title="Report preview" region>
      {/* LD-442 (T0D-UIX-2): kit DescriptionList for the header pairs, kit DataTable for the rows; the test title is the first row. */}
      <DescriptionList columns={2} items={PREVIEW_HEADER} />
      <DataTable
        caption="Report preview"
        density="regular"
        columns={PREVIEW_COLS}
        rows={all}
        getRowId={(r) => String(all.indexOf(r))}
        emptyState={{ title: 'No parameters yet.' }}
      />
    </Card>
  );
}

/** Whole number in [min, max] from a text box; '' = not given (undefined); NaN = invalid. */
export function intOf(text: string, min: number, max: number): number | undefined {
  const t = text.trim();
  if (!t) return undefined;
  if (!/^-?\d{1,9}$/.test(t)) return NaN;
  const n = Number(t);
  return n < min || n > max ? NaN : n;
}

// T0D-TESTMGMT-1 item (6), LD-318 (ElabAssist Test Profile): two list picker for panel / package members. Listboxes "Available tests" and
// "Selected tests"; Add, Add all, Remove, Remove all; click picks an option, Enter (or double click) on an option moves it. Order = selected order.
export interface PickItem { id: string; label: string }

function ListBox({ label, items, picked, onPick, onMove }: { label: string; items: readonly PickItem[]; picked: string | undefined; onPick: (id: string) => void; onMove: (id: string) => void }) {
  return (
    <div className="lims-stack catalog-gap-1">
      <span className="catalog-grid-title" aria-hidden="true">{label}</span>
      {items.length === 0 ? <p className="lims-description">None</p> : null}
      <div role="listbox" aria-label={label} className="catalog-plain-list catalog-pick-list">
        {items.map((it) => (
          <div
            key={it.id}
            role="option"
            tabIndex={0}
            aria-selected={it.id === picked}
            className={it.id === picked ? 'catalog-row-chosen' : undefined}
            onClick={() => onPick(it.id)}
            onDoubleClick={() => onMove(it.id)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onMove(it.id); } else if (e.key === ' ') { e.preventDefault(); onPick(it.id); } }}
          >
            {it.label}
          </div>
        ))}
      </div>
    </div>
  );
}

export function TwoListPicker({ available, selected, onChange, isDisabled }: {
  available: readonly PickItem[];
  selected: readonly PickItem[];
  onChange: (selectedIds: string[]) => void;
  isDisabled: boolean;
}) {
  const [left, setLeft] = useState<string>();
  const [right, setRight] = useState<string>();
  const ids = selected.map((s) => s.id);
  const add = (id: string | undefined) => { if (!isDisabled && id && !ids.includes(id)) { onChange([...ids, id]); setLeft(undefined); } };
  const remove = (id: string | undefined) => { if (!isDisabled && id) { onChange(ids.filter((x) => x !== id)); setRight(undefined); } };
  return (
    <div className="catalog-two-list">
      <ListBox label="Available tests" items={available} picked={left} onPick={setLeft} onMove={add} />
      <div className="lims-stack catalog-gap-1">
        <Button size="sm" isDisabled={isDisabled || !left} onPress={() => add(left)}>Add</Button>
        <Button size="sm" isDisabled={isDisabled || available.length === 0} onPress={() => onChange([...ids, ...available.map((a) => a.id)])}>Add all</Button>
        <Button size="sm" isDisabled={isDisabled || !right} onPress={() => remove(right)}>Remove</Button>
        <Button size="sm" isDisabled={isDisabled || selected.length === 0} onPress={() => onChange([])}>Remove all</Button>
      </div>
      <ListBox label="Selected tests" items={selected} picked={right} onPick={setRight} onMove={remove} />
    </div>
  );
}
