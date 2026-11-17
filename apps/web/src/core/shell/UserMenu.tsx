'use client';
// T0D-DENSITY-1 (LD-310, founder 2026-11-17 04:49 / 05:03 NPT): the actor's name in the top bar opens a menu with the screen density
// (Compact, the default, or Regular). The choice is kept per user (core/prefs/density: membership id key, compact on any error). Server and first client render are compact, the stored choice is applied after mount (no hydration mismatch).
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { t } from '../i18n/messages';
import { readDensity, writeDensity, type Density } from '../prefs/density';

export type { Density };

const DENSITIES: readonly Density[] = ['compact', 'regular'];

/** density state of the staff shell: compact first, then the stored choice of this user */
export function useDensity(memberId: string | undefined): [Density, (d: Density) => void] {
  const [density, setDensity] = useState<Density>('compact');
  useEffect(() => setDensity(readDensity(memberId)), [memberId]);
  return [density, (d) => { setDensity(d); writeDensity(memberId, d); }];
}

type Props = { name: string; density: Density; onChange: (d: Density) => void };

export function UserMenu({ name, density, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const items = useRef<(HTMLDivElement | null)[]>([]);

  const close = () => { setOpen(false); button.current?.focus(); };
  const choose = (d: Density) => { onChange(d); close(); };

  useEffect(() => {
    if (!open) return;
    items.current[Math.max(0, DENSITIES.indexOf(density))]?.focus();
    const onDown = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- focus the checked item only when the menu opens
  }, [open]);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = items.current.indexOf(document.activeElement as HTMLDivElement);
    const n = DENSITIES.length;
    const move = (to: number) => { e.preventDefault(); items.current[(to + n) % n]?.focus(); };
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowDown') move(i + 1);
    else if (e.key === 'ArrowUp') move(i - 1);
    else if (e.key === 'Home') move(0);
    else if (e.key === 'End') move(n - 1);
    else if ((e.key === 'Enter' || e.key === ' ') && i >= 0) { e.preventDefault(); choose(DENSITIES[i]!); }
    else if (e.key === 'Tab') setOpen(false);
  };

  return (
    <div className="lims-user-menu" ref={wrap}>
      <button ref={button} type="button" className="lims-btn lims-btn-ghost lims-topbar-actor" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {name}
      </button>
      {open ? (
        <div role="menu" aria-label={t('core.shell.user_menu')} className="lims-popover lims-menu lims-user-menu-list" onKeyDown={onKey}>
          <div role="presentation" className="lims-user-menu-heading">{t('core.shell.density')}</div>
          {DENSITIES.map((d, i) => (
            <div
              key={d}
              ref={(el) => { items.current[i] = el; }}
              role="menuitemradio"
              aria-checked={density === d}
              tabIndex={-1}
              className="lims-menuitem"
              onClick={() => choose(d)}
            >
              {t(`core.shell.density_${d}`)}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
