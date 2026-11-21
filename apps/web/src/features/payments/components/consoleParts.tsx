'use client';
// T0D-UICONSOLE-1 (LD-353 template 2 CONSOLE): small parts the payment console screens share. Display only: no fetch, no action.
// Same shape as features/lab/components/consoleParts.tsx; copied because a feature never imports another feature's folder (02-CONVENTIONS, REQ-ARCH-076).
import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Timeline } from '@lims/ui/components/Timeline';

const TICK_MS = 30_000;

/** hh:mm, the TAT form used across the product. */
export function hhmm(ms: number) {
  const m = Math.max(0, Math.floor(ms / 60_000));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** The clock the age columns run on (re-renders every 30 s). */
export function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, []);
  return now;
}

/** Oldest age as hh:mm, or a dash when there is none. */
export const oldest = (ages: readonly number[]) => (ages.length ? hhmm(Math.max(...ages)) : '—');

/** Props for one queue row: focusable, carries data-console-item (SplitConsole j / k), click or Enter selects. */
export function itemProps(id: string, selectedId: string | undefined, select: (id: string) => void) {
  return {
    'data-console-item': id,
    tabIndex: 0,
    'aria-selected': selectedId === id,
    className: 'lims-row', // kit.css .lims-row[data-selected] draws the selection
    ...(selectedId === id ? { 'data-selected': 'true' } : {}),
    onClick: () => select(id),
    onKeyDown: (e: KeyboardEvent) => { if (e.key === 'Enter' && e.target === e.currentTarget) { e.preventDefault(); select(id); } },
  };
}

/** Wraps the console so one letter runs the first action of the bar (never while typing or with a modifier). */
export function ShortcutKey({ letter, run, children }: { letter: string | undefined; run: (() => void) | undefined; children: ReactNode }) {
  const onKeyDown = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (!letter || !run || e.key.toLowerCase() !== letter.toLowerCase() || e.ctrlKey || e.metaKey || e.altKey || t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    e.preventDefault();
    run();
  };
  return <div onKeyDown={onKeyDown}>{children}</div>;
}

/** Facts of the record (kit .lims-dl markup). */
export function Facts({ items }: { items: readonly (readonly [string, ReactNode])[] }) {
  return (
    <dl className="lims-dl lims-cols-1">
      {items.map(([term, value]) => <div key={term} className="lims-dl-item"><dt>{term}</dt>{' '}<dd>{value}</dd>{' '}</div>)}
    </dl>
  );
}

/** History block of the detail: a heading and one row per event (label first). T0D-UIGUARD-1-PAYMENTS (LD-436 R7, LD-439): the kit Timeline, no raw h3/ul. */
export function History({ events }: { events: readonly (readonly [string, string])[] }) {
  return <Timeline title="History" labelFirst items={events.map(([label, at]) => ({ label, at }))} />;
}
