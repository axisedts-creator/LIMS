'use client';
// T0D-TESTMGMT-1 item (6), LD-318 (ElabAssist Test Profile): two list picker for panel / package members. Listboxes "Available tests" and
// "Selected tests"; Add, Add all, Remove, Remove all; click picks an option, Enter (or double click) on an option moves it. Order = selected order.
import { useState } from 'react';
import { Button } from '@lims/ui/components/Button';
import './catalog.css';

export interface PickItem { id: string; label: string }

function ListBox({ label, items, picked, onPick, onMove }: { label: string; items: readonly PickItem[]; picked: string | undefined; onPick: (id: string) => void; onMove: (id: string) => void }) {
  return (
    <div className="lims-stack catalog-gap-1">
      <h3 className="catalog-grid-title">{label}</h3>
      {items.length === 0 ? <p className="lims-description">None</p> : null}
      <ul role="listbox" aria-label={label} className="catalog-plain-list catalog-pick-list">
        {items.map((it) => (
          <li
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
          </li>
        ))}
      </ul>
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
