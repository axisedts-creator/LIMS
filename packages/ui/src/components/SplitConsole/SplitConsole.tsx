'use client';
// T0D-UIKIT-1, LD-353 template 2 (CONSOLE): queue list left (40 percent), detail right with its own scrolling body and a sticky action bar.
// j / k move focus through the queue items (any focusable element marked data-console-item); typing in a field is never hijacked.
import type { KeyboardEvent, ReactNode } from 'react';
import { useRef } from 'react';

export interface SplitConsoleProps {
  list: ReactNode;
  detail: ReactNode;
  /** Sticky action bar at the bottom of the detail (Approve, Reject, ...). */
  actions?: ReactNode;
  listLabel: string;
  detailLabel: string;
  'data-testid'?: string;
}

const isTyping = (el: EventTarget | null) => {
  const e = el as HTMLElement | null;
  return !!e && (e.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.tagName));
};

export function SplitConsole({ list, detail, actions, listLabel, detailLabel, ...rest }: SplitConsoleProps) {
  const listRef = useRef<HTMLElement>(null);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.key !== 'j' && e.key !== 'k') || e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
    const items = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-console-item]') ?? [])];
    if (!items.length) return;
    e.preventDefault();
    const at = items.indexOf((e.target as HTMLElement).closest<HTMLElement>('[data-console-item]')!);
    const next = at < 0 ? (e.key === 'j' ? 0 : items.length - 1) : Math.min(items.length - 1, Math.max(0, at + (e.key === 'j' ? 1 : -1)));
    items[next]!.focus();
  };
  return (
    <div className="lims-console" onKeyDown={onKeyDown} {...rest}>
      <section ref={listRef} className="lims-console-list" aria-label={listLabel}>
        {list}
      </section>
      <section className="lims-console-detail" aria-label={detailLabel}>
        <div className="lims-console-body">{detail}</div>
        {actions ? <div className="lims-console-actions">{actions}</div> : null}
      </section>
    </div>
  );
}
