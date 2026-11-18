'use client';
// /lab/critical-values (C5 04-UI-UX §1 + §3.9, route staff.lab.critical_values, lab.critical_value.read). LD-255 (FOUNDER): lab staff and the administrator reach the list from the menu.
// Columns the CriticalValueDto can fill: detected at, age since detected (live), analyte, direction text, status text. Open rows first, the rest in API order.
// The result value is not a list column (it is shown on the detail, which logs the access). Reg no, patient and notifications count are not in the DTO: gaps in the task notes.
// [CONV] a closed event's age stops at closed_at instead of running on.
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { EmptyRow, PlaceholderRows } from '@lims/ui/components/DataTable';
import { EmptyState } from '@lims/ui/components/EmptyState';
import { PageHeader } from '@lims/ui/components/PageHeader';
import type { CriticalValueRow } from '../server/adminpages.server';

const DIRECTION: Record<CriticalValueRow['direction'], string> = { high: 'Critical high', low: 'Critical low', abnormal: 'Abnormal' };
const STATUS: Record<CriticalValueRow['status'], string> = { open: 'Open', notified: 'Notified', closed: 'Closed' };
const TICK_MS = 30_000;

const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });
function hhmm(ms: number) {
  const m = Math.max(0, Math.floor(ms / 60_000));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

export function CriticalValueList({ items, status, nextCursor }: { items: readonly CriticalValueRow[]; status?: string | undefined; nextCursor?: string | undefined }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, []);
  const rows = [...items.filter((r) => r.status === 'open'), ...items.filter((r) => r.status !== 'open')];
  const more = `/lab/critical-values?${new URLSearchParams({ ...(status ? { status } : {}), ...(nextCursor ? { cursor: nextCursor } : {}) })}`;
  return (
    <section aria-label="Critical values">
      <PageHeader title="Critical values" helpKey="lab.critical_values" />
      {/* T0D-EMPTYTBL-1 (LD-310): headers always drawn; the empty message is a body row. T0D-UILIST-1 (LD-353 rule 5): the table scrolls in its own box. */}
      <div className="lims-data-table"><div className="lims-table-scroll">
      <table className="lims-table" aria-label="Critical values">
          <thead>
            <tr>
              <th scope="col">Detected at</th>
              <th scope="col">Age since detected</th>
              <th scope="col">Analyte</th>
              <th scope="col">Direction</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? <EmptyRow colSpan={5}><EmptyState title="No critical values." /></EmptyRow> : null}
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{when(r.detected_at)}</td>
                <td suppressHydrationWarning>{hhmm((r.closed_at ? Date.parse(r.closed_at) : now) - Date.parse(r.detected_at))}</td>
                <td><Link href={`/lab/critical-values/${encodeURIComponent(r.id)}`}>{r.analyte_code}</Link></td>
                <td>{DIRECTION[r.direction] ?? r.direction}</td>
                <td>{STATUS[r.status] ?? r.status}</td>
              </tr>
            ))}
          </tbody>
          {rows.length === 0 ? <PlaceholderRows colSpan={5} /> : null}
        </table>
      </div></div>
      {nextCursor ? <p><Link href={more}>Next page</Link></p> : null}
    </section>
  );
}
