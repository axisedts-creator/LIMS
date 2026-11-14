'use client';
// Staff rail (10-DESIGN-SYSTEM §3, T0D-UI-R04, LD-140): rendered inside the kit PageShell <nav aria-label="Main">.
// 248 px, collapsing to 72 px (CSS on [data-collapsed='true']). Collapsed links keep their text as the accessible name
// (visually hidden) and show a role="tooltip" on focus/hover. Entries arrive already permission-filtered by AppShell.
import Link from 'next/link';
import { useId, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { t } from '../i18n/messages';

export type RailItem = { id: string; label: string; path: string; current: boolean; chord?: string };
export type RailGroup = { id: string; label: string; items: RailItem[] };

export function Rail({ groups }: { groups: RailGroup[] }) {
  const [collapsed, setCollapsed] = useState(false);
  const [tip, setTip] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const uid = useId();
  // PageShell (packages/ui) owns the <nav>; the collapsed state is reflected on it so the kit-level CSS can size it.
  useLayoutEffect(() => {
    ref.current?.closest('nav')?.setAttribute('data-collapsed', String(collapsed));
  }, [collapsed]);

  const tipId = (id: string) => `${uid}-tip-${id}`;
  const show = (id: string) => { if (collapsed) setTip(id); };
  // hide synchronously: a tooltip must never outlive its trigger's focus/hover
  const hide = () => flushSync(() => setTip(null));

  return (
    <div ref={ref} className="lims-rail">
      <button
        type="button"
        className="lims-btn lims-rail-toggle"
        aria-expanded={!collapsed}
        aria-label={t(collapsed ? 'core.nav.expand' : 'core.nav.collapse')}
        onClick={() => { setCollapsed((c) => !c); hide(); }}
      >
        <svg aria-hidden="true" focusable="false" viewBox="0 0 16 16" width="16" height="16"><path d={collapsed ? 'M6 3l5 5-5 5' : 'M10 3L5 8l5 5'} fill="none" stroke="currentColor" strokeWidth="2" /></svg>
      </button>
      {groups.map((g) => (
        <div key={g.id} role="group" aria-label={g.label} className="lims-rail-group">
          <span className="lims-rail-heading" aria-hidden="true">{g.label}</span>
          <ul className="lims-sidenav">
            {g.items.map((e) => (
              <li key={e.id} className="lims-rail-item">
                <Link
                  href={e.path}
                  aria-current={e.current ? 'page' : undefined}
                  aria-describedby={tip === e.id ? tipId(e.id) : undefined}
                  data-chord={e.chord}
                  onFocus={() => show(e.id)}
                  onBlur={hide}
                  onMouseEnter={() => show(e.id)}
                  onMouseLeave={hide}
                  onKeyDown={(ev) => { if (ev.key === 'Escape') hide(); }}
                >
                  {/* initial drawn by CSS (attr) so the link text stays exactly the label */}
                  <span className="lims-rail-badge" aria-hidden="true" data-initial={e.label.slice(0, 1)} />
                  <span className="lims-rail-label">{e.label}</span>
                </Link>
                {collapsed && tip === e.id ? <span role="tooltip" id={tipId(e.id)} className="lims-tooltip lims-rail-tip">{e.label}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
