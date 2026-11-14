'use client';
// Line editor shared by S9 (transfer draft), S10 wastage and S10 adjustment. LD-140 (2026-11-13): kit components only.
// A line picks one stock row (item + lot) of the chosen store and a quantity. The first stock row is preselected, so a line is never "no item".
import { Button } from '@lims/ui/components/Button';
import { DecimalField } from '@lims/ui/components/DecimalField';
import { Inline } from '@lims/ui/components/Inline';
import { RadioGroup } from '@lims/ui/components/RadioGroup';
import { Select } from '@lims/ui/components/Select';
import { Stack } from '@lims/ui/components/Stack';
import type { BalanceRow, Direction } from '../server/types';
import { qtyError, stockLabel } from './shared';

export interface LineDraft { id: number; stock?: string | undefined; qty?: string | undefined; direction?: Direction | undefined }

export const stockKey = (b: BalanceRow) => `${b.item_id}|${b.lot_id ?? ''}`;
/** The stock row a line points at: its own choice, else the first row. */
export const resolveStock = (l: LineDraft, rows: readonly BalanceRow[]) => rows.find((b) => stockKey(b) === l.stock) ?? rows[0];
/** Validation messages per line id; empty when every line is sendable. */
export function lineErrors(lines: readonly LineDraft[], rows: readonly BalanceRow[], withDirection: boolean): Record<number, string> {
  const out: Record<number, string> = {};
  for (const l of lines) {
    const e = !resolveStock(l, rows) ? 'There is no stock to pick from in this store' : qtyError('Qty', l.qty) ?? (withDirection && !l.direction ? 'Direction is required' : undefined);
    if (e) out[l.id] = e;
  }
  return out;
}

let next = 1;
/** An adjustment line starts as "In" (stock found); the RadioGroup makes the direction visible and one click changes it. */
export const newLine = (withDirection = false): LineDraft => ({ id: next++, ...(withDirection ? { direction: 'in' as const } : {}) });

export function StockLines({ lines, onChange, rows, withDirection = false, errors = {} }: { lines: readonly LineDraft[]; onChange: (l: LineDraft[]) => void; rows: readonly BalanceRow[]; withDirection?: boolean; errors?: Record<number, string> }) {
  const set = (id: number, patch: Partial<LineDraft>) => onChange(lines.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  const options = rows.map((b) => ({ value: stockKey(b), label: stockLabel(b) }));
  return (
    <Stack>
      {lines.map((l) => {
        const sel = resolveStock(l, rows);
        return (
          <Inline key={l.id} gap={2}>
            <Select label="Item / lot" name={`stock_${l.id}`} options={options} {...(sel ? { value: stockKey(sel) } : {})} onChange={(v) => set(l.id, { stock: v })} />
            <DecimalField label="Qty" name={`qty_${l.id}`} decimals={3} allowNegative {...(l.qty !== undefined ? { value: l.qty } : {})} {...(errors[l.id] ? { error: errors[l.id] as string } : {})} onChange={(v) => set(l.id, { qty: v })} />
            {withDirection ? (
              <RadioGroup label="Direction" name={`direction_${l.id}`} orientation="horizontal" options={[{ value: 'in', label: 'In' }, { value: 'out', label: 'Out' }]} value={l.direction ?? ('' as Direction)} onChange={(v) => set(l.id, { direction: v })} />
            ) : null}
            <Button variant="ghost" size="sm" onPress={() => onChange(lines.filter((x) => x.id !== l.id))}>Remove</Button>
          </Inline>
        );
      })}
      <div>
        <Button onPress={() => onChange([...lines, newLine(withDirection)])}>Add line</Button>
      </div>
    </Stack>
  );
}
