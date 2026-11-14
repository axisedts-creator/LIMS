'use client';
// Top-bar centre/lab switcher (10-DESIGN-SYSTEM §3, T0D-UI-R04, LD-140): the active centre is always visible.
// Listing/persisting the active centre has no contract yet (.orchestra/cr/T0D-UI-R04.md): without onSelect the
// control is read-only, so the shell never pretends to switch centre.
import { t } from '../i18n/messages';

export type Centre = { id: string; name: string };

export function CentreSwitcher({ centres, activeId, onSelect }: { centres: readonly Centre[]; activeId: string | null; onSelect?: (id: string) => void }) {
  if (centres.length === 0) return null;
  const known = centres.some((c) => c.id === activeId);
  return (
    <select
      className="lims-input lims-centre-switcher"
      aria-label={t('core.shell.centre')}
      value={known ? activeId! : ''}
      disabled={!onSelect}
      onChange={(e) => { if (e.target.value && e.target.value !== activeId) onSelect?.(e.target.value); }}
    >
      {known ? null : <option value="">{t('core.shell.centre_none')}</option>}
      {centres.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
    </select>
  );
}
