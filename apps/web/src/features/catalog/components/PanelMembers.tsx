'use client';
// SCR-09 panel members: add combobox (searchOrderables), members grid (Order · Kind · Orderable · Name · Status; max 100) and the
// live "Expanded tests" preview (resolveOrderablesPreview). Plain table, not the kit EditableGrid [CONV]: cells are not edited, only
// added/removed; order = row order.
import { useEffect, useState } from 'react';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { Combobox } from '@lims/ui/components/Combobox';
import { VisuallyHidden } from '@lims/ui/components/VisuallyHidden';
import { resolvePreviewAction, searchOrderablesAction } from '../server/catalogActions';
import type { OrderableSummary, PanelMember, ResolvedOrderables } from '../server/types';
import { statusText } from './master-ui';

export const MAX_MEMBERS = 100;
export interface Info { kind: 'test' | 'panel'; code: string; name: string; is_active: boolean }
export const infoOf = (o: OrderableSummary): Info => ({ kind: o.kind, code: o.code, name: o.name, is_active: o.is_active });
export const toPayload = (ms: readonly PanelMember[]): PanelMember[] => ms.map((m, i) => ({ kind: m.kind, orderable_id: m.orderable_id, sort_order: i }));
const kindText = (k: 'test' | 'panel') => (k === 'test' ? 'Test' : 'Panel');

export function MembersEditor({ members, info, onAdd, onRemove, canEdit, keepOne = false, excludeId }: {
  members: readonly PanelMember[];
  info: ReadonlyMap<string, Info>;
  onAdd: (o: OrderableSummary) => void;
  onRemove: (index: number) => void;
  canEdit: boolean;
  /** Existing panels need ≥ 1 member (API); the last row cannot be removed. */
  keepOne?: boolean;
  /** The panel being edited cannot contain itself. */
  excludeId?: string;
}) {
  const [n, setN] = useState(0); // remounts the combobox after each pick so its text is cleared
  const full = members.length >= MAX_MEMBERS;
  const load = async (q: string) => (await searchOrderablesAction(q)).filter((o) => o.id !== excludeId && !members.some((m) => m.orderable_id === o.id));
  return (
    <div>
      {canEdit ? (
        <div>
          <Combobox<OrderableSummary>
            key={n}
            label="Add orderable"
            name="add_orderable"
            isDisabled={full}
            loadOptions={load}
            getKey={(o) => o.id}
            renderOption={(o) => `${o.code} — ${o.name}${o.kind === 'panel' ? ' (panel)' : ''}`}
            renderValue={(o) => o.name}
            onChange={(o) => {
              if (!o) return;
              onAdd(o);
              setN((x) => x + 1);
            }}
          />
          {full ? <p role="note">{`${MAX_MEMBERS} of ${MAX_MEMBERS} members. Remove one to add another.`}</p> : null}
        </div>
      ) : null}
      <table className="lims-table lims-table-compact">
        <caption className="lims-visually-hidden">{`Members (${members.length})`}</caption>
        <thead>
          <tr>
            <th scope="col">Order</th>
            <th scope="col">Kind</th>
            <th scope="col">Orderable</th>
            <th scope="col">Name</th>
            <th scope="col">Status</th>
            {canEdit ? <th scope="col"><VisuallyHidden>Actions</VisuallyHidden></th> : null}
          </tr>
        </thead>
        <tbody>
          {members.map((m, i) => {
            const x = info.get(m.orderable_id);
            return (
              <tr key={m.orderable_id}>
                <td>{i + 1}</td>
                <td>{kindText(m.kind)}</td>
                <td>{x?.code ?? '—'}</td>
                <td>{x?.name ?? '—'}</td>
                <td>{x ? statusText(x.is_active) : '—'}</td>
                {canEdit ? (
                  <td>
                    <Button size="sm" variant="ghost" isDisabled={keepOne && members.length <= 1} onPress={() => onRemove(i)}>
                      Remove<VisuallyHidden> {x?.code ?? `member ${i + 1}`}</VisuallyHidden>
                    </Button>
                  </td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const PREVIEW_ERRORS: Record<string, string> = {
  'catalog.test_inactive': 'A member test is inactive. Remove it or make it active again.',
  'catalog.panel_cycle': 'This would make the panel contain itself (P1 → P2 → P1).',
};

/** AC-07.1 / 07.2: tests listed once, with specimen groups. Live: re-resolves when the member set changes. */
export function ExpandedTests({ ids }: { ids: readonly string[] }) {
  const key = ids.slice(0, 50).join(','); // the API resolves ≤ 50 orderables per call
  const [state, setState] = useState<{ data?: ResolvedOrderables; code?: string }>({});
  useEffect(() => {
    if (!key) return setState({});
    let live = true;
    setState({});
    void resolvePreviewAction(key.split(',')).then((r) => {
      if (live) setState(r.ok ? { data: r.data } : { code: r.code });
    });
    return () => {
      live = false;
    };
  }, [key]);
  const tests = new Map((state.data?.tests ?? []).map((t) => [t.id, t]));
  return (
    <section aria-label="Expanded tests">
      <h2 className="lims-section-title">Expanded tests</h2>
      {state.code ? (
        <div role="alert">
          <Banner tone="danger" title={PREVIEW_ERRORS[state.code] ?? 'The preview could not be loaded.'} />
        </div>
      ) : !state.data ? (
        <p>{key ? 'Loading…' : 'No members.'}</p>
      ) : (
        <>
          <ul>
            {[...tests.values()].map((t) => (
              <li key={t.id}>{`${t.code} — ${t.name}${t.is_active === false ? ' (inactive)' : ''}`}</li>
            ))}
          </ul>
          <ul aria-label="Specimen groups">
            {state.data.specimen_requirements.map((s) => (
              <li key={`${s.specimen_type_code}/${s.container_code ?? ''}`}>{`Specimen ${s.specimen_type_code}${s.container_code ? ` · Container ${s.container_code}` : ''} — ${s.test_ids.length} ${s.test_ids.length === 1 ? 'test' : 'tests'}`}</li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
