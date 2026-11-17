'use client';
// T0D-TESTMGMT-1 done_when (6) (LD-318): profile / package two-list picker on /catalog/panels/<id>. "Available tests" | "In this
// profile" (or package) with Add, Add all, Remove, Remove all; Enter on an option moves it, click selects. Nothing is written until Save,
// which PUTs the whole member list in order (sort_order 1..n, If-Match). The API needs at least one member, so an empty list is refused here.
import { useState, type KeyboardEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { useToast } from '@lims/ui/components/Toast';
import { replacePanelMembersAction } from '../server/catalogActions';
import type { PanelMember } from '../server/types';
import { ErrorList } from './tm-ui';
import './catalog.css';

type Item = { id: string; code: string; name: string };
const MEMBER_ERRORS: Record<string, string> = {
  'catalog.panel_cycle': 'This would make the panel contain itself.',
  'catalog.test_inactive': 'A member is inactive. Remove it or make it active again, then save.',
  'common.version_conflict': 'Someone else changed this panel. Reload to see their changes.',
};

export function PanelPicker({ panel, tests, names, manage }: {
  panel: { id: string; version: number; panel_kind: 'clinical' | 'package'; members: readonly PanelMember[] };
  tests: readonly Item[];
  /** Names of members that are not in `tests` (nested panels, inactive tests). */
  names: ReadonlyMap<string, Item>;
  manage: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const where = panel.panel_kind === 'package' ? 'In this package' : 'In this profile';
  const byId = new Map<string, Item>([...names, ...tests.map((t) => [t.id, t] as const)]);
  const [chosen, setChosen] = useState<PanelMember[]>(() => [...panel.members].sort((a, b) => a.sort_order - b.sort_order));
  const [selA, setSelA] = useState<string>();
  const [selC, setSelC] = useState<string>();
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const inside = new Set(chosen.map((m) => m.orderable_id));
  const avail = tests.filter((t) => !inside.has(t.id) && t.id !== panel.id);
  const label = (id: string) => { const i = byId.get(id); return i ? `${i.code} ${i.name}` : id; };

  const add = (ids: string[]) => { setChosen((c) => [...c, ...ids.map((id, i) => ({ kind: 'test' as const, orderable_id: id, sort_order: c.length + i + 1 }))]); setSelA(undefined); setErrors([]); };
  const remove = (ids: string[]) => { setChosen((c) => c.filter((m) => !ids.includes(m.orderable_id))); setSelC(undefined); };
  const save = async () => {
    if (busy) return;
    if (chosen.length === 0) return setErrors(['A profile or package needs at least one test.']);
    setBusy(true); setErrors([]);
    try {
      const r = await replacePanelMembersAction(panel.id, panel.version, { members: chosen.map((m, i) => ({ kind: m.kind, orderable_id: m.orderable_id, sort_order: i + 1 })) });
      if (!r.ok) return setErrors([MEMBER_ERRORS[r.code] ?? 'Could not save the members. Try again.']);
      toast.show({ tone: 'success', title: 'Members saved.' });
      router.refresh();
    } finally { setBusy(false); }
  };
  const key = (move: () => void) => (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Enter' && manage) { e.preventDefault(); move(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); ((e.currentTarget[e.key === 'ArrowDown' ? 'nextElementSibling' : 'previousElementSibling']) as HTMLElement | null)?.focus(); }
  };

  return (
    <section aria-label="Members" className="lims-stack catalog-gap-2">
      <h2 className="lims-section-title">Members</h2>
      <div className="tm-picker">
        <ul role="listbox" aria-label="Available tests" className="catalog-plain-list tm-list tm-pick-list">
          {avail.map((t) => (
            <li key={t.id} role="option" tabIndex={0} aria-selected={t.id === selA} className="tm-option" onClick={() => setSelA(t.id)} onFocus={() => setSelA(t.id)} onKeyDown={key(() => add([t.id]))}>{t.code} {t.name}</li>
          ))}
        </ul>
        {manage ? (
          <div className="lims-stack catalog-gap-1">
            <Button size="sm" isDisabled={!selA} onPress={() => selA && add([selA])}>Add</Button>
            <Button size="sm" isDisabled={avail.length === 0} onPress={() => add(avail.map((t) => t.id))}>Add all</Button>
            <Button size="sm" isDisabled={!selC} onPress={() => selC && remove([selC])}>Remove</Button>
            <Button size="sm" isDisabled={chosen.length === 0} onPress={() => remove(chosen.map((m) => m.orderable_id))}>Remove all</Button>
          </div>
        ) : null}
        <ul role="listbox" aria-label={where} className="catalog-plain-list tm-list tm-pick-list">
          {chosen.map((m) => (
            <li key={m.orderable_id} role="option" tabIndex={0} aria-selected={m.orderable_id === selC} className="tm-option" onClick={() => setSelC(m.orderable_id)} onFocus={() => setSelC(m.orderable_id)} onKeyDown={key(() => remove([m.orderable_id]))}>{label(m.orderable_id)}</li>
          ))}
        </ul>
      </div>
      <ErrorList errors={errors} />
      {manage ? <div><Button variant="primary" isDisabled={busy} onPress={() => void save()}>Save</Button></div> : null}
    </section>
  );
}
