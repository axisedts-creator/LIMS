'use client';
// T0D-UICONSOLE-1 (LD-353 template 2 CONSOLE): small parts the lab console screens share. Display only: no fetch, no action.
import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { DescriptionList } from '@lims/ui/components/DescriptionList';

const TICK_MS = 30_000;

export const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });

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

/** Oldest open age as hh:mm, or a dash when nothing is open. */
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

/** The single bar action: a link to the record screen; the letter O opens it (shown in its label). */
export function OpenBar({ href, label }: { href: string; label: string }) {
  return <Link href={href}>{label} (O)</Link>;
}

/** Wraps the console so the O key opens the selected record (never while typing). */
export function OpenKey({ href, children }: { href: string | undefined; children: ReactNode }) {
  const router = useRouter();
  const onKeyDown = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (!href || e.key.toLowerCase() !== 'o' || e.ctrlKey || e.metaKey || e.altKey || t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    e.preventDefault();
    router.push(href);
  };
  return <div onKeyDown={onKeyDown}>{children}</div>;
}

/** Facts of the record. T0D-UIX-3 (LD-442): the kit DescriptionList replaces the raw dl. */
export function Facts({ items }: { items: readonly (readonly [string, ReactNode])[] }) {
  return <DescriptionList items={items.map(([term, value]) => ({ term, value }))} />;
}

/** T0D-UIX-3 (LD-442): the kit Button and IconButton forward no aria-* / data-* / title, so a ref callback sets them on the element
 * (onRow: on its table row). Pass it inline so it runs on every render; undefined removes the attribute.
 * ponytail: DOM attributes outside React; give the kit Button pass-through props when the kit owner adds them. */
export const domAttrs = (attrs: Record<string, string | undefined>, onRow = false) => (el: HTMLElement | null) => {
  const t = onRow ? el?.closest('tr') : el;
  if (!t) return;
  for (const [k, v] of Object.entries(attrs)) if (v === undefined) t.removeAttribute(k); else t.setAttribute(k, v);
};

/** History block of the detail: a heading and one li per event (label first). */
export function History({ events }: { events: readonly (readonly [string, string])[] }) {
  return (
    <div>
      {/* T0D-UIGUARD-1-LAB (LD-436 rule 7): same heading and list semantics without raw h3/ul */}
      <p role="heading" aria-level={3} className="lims-card-title">History</p>
      <div role="list">{events.map(([label, at]) => <div role="listitem" key={label}>{label}: {when(at)}</div>)}</div>
    </div>
  );
}
