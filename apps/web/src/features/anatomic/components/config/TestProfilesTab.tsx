'use client';
// 04-UI-UX §4.7 Test profiles tab (K6/K7; AC-14.1): table Test · Case kind · Add-on · Requires gross · Default stain · Default synoptic templates · Active. The tests are the catalog's
// anatomic and molecular tests (catalog.test.read, loaded by the server page); a test without a profile is listed as "Not configured". Drawer: Case kind, Is add-on, Requires gross,
// Default stain, Default synoptic templates (up to 5 PUBLISHED template keys), Active. Save: PUT /test-profiles/{test_id} with If-Match = the profile version ("0" creates).
// LD-140 (2026-11-13, binding): kit components only; [Save] is the drawer's primary button.
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { Checkbox } from '@lims/ui/components/Checkbox';
import { DataTable } from '@lims/ui/components/DataTable';
import { EmptyState } from '@lims/ui/components/EmptyState';
import { Select } from '@lims/ui/components/Select';
import { Switch } from '@lims/ui/components/Switch';
import { useToast } from '@lims/ui/components/Toast';
import { saveTestProfileAction } from '../../server/actions.config';
import type { CatalogTest, StainRecord, TemplateSummary, TestProfile } from '../../server/config.types';
import type { CaseKind } from '../../server/types';
import { ActiveChip, cfgText, MfaDialog } from './config-shared';
import { FormDialog } from '../material/FormDialog';
import { KIND_LABEL } from '../common';

const KINDS = (['histology', 'cytology', 'ihc', 'molecular'] as const).map((k) => ({ value: k, label: KIND_LABEL[k] }));
const NONE = '__none';
const MAX_KEYS = 5;
interface Row { test_id: string; name: string; profile?: TestProfile }

export function TestProfilesTab({ profiles, tests, stains, templates }: { profiles: readonly TestProfile[]; tests: readonly CatalogTest[]; stains: readonly StainRecord[]; templates: readonly TemplateSummary[] }) {
  const [editing, setEditing] = useState<Row>();
  const [mfa, setMfa] = useState(false);
  const byTest = new Map(profiles.map((p) => [p.test_id, p]));
  const rows: Row[] = [
    ...profiles.map((p) => ({ test_id: p.test_id, name: p.test_name, profile: p })),
    ...tests.filter((t) => !byTest.has(t.id)).map((t) => ({ test_id: t.id, name: t.name })),
  ];
  const yes = (b: boolean) => (b ? 'Yes' : 'No');
  return (
    <>
      {rows.length === 0 ? (
        <EmptyState title="No anatomic or molecular tests yet." body="Add tests with workflow type anatomic or molecular in the test catalog." />
      ) : (
        <DataTable
          caption="Test profiles"
          density="compact"
          rows={rows}
          getRowId={(r) => r.test_id}
          emptyState={{ title: 'No tests' }}
          columns={[
            { id: 'test', header: 'Test', isRowHeader: true, cell: (r) => r.name },
            { id: 'kind', header: 'Case kind', cell: (r) => (r.profile ? KIND_LABEL[r.profile.case_kind] : 'Not configured') },
            { id: 'addon', header: 'Add-on', hideBelow: 'md', cell: (r) => (r.profile ? yes(r.profile.is_addon) : '—') },
            { id: 'gross', header: 'Requires gross', hideBelow: 'md', cell: (r) => (r.profile ? yes(r.profile.requires_gross) : '—') },
            { id: 'stain', header: 'Default stain', hideBelow: 'lg', cell: (r) => r.profile?.default_stain_code ?? '—' },
            { id: 'tpl', header: 'Default synoptic templates', hideBelow: 'lg', cell: (r) => (r.profile?.default_synoptic_template_keys.length ? r.profile.default_synoptic_template_keys.join(', ') : '—') },
            { id: 'active', header: 'Active', cell: (r) => (r.profile ? <ActiveChip active={r.profile.is_active} /> : '—') },
            { id: 'edit', header: 'Actions', cell: (r) => <Button size="sm" variant="ghost" onPress={() => setEditing(r)}>{r.profile ? `Edit ${r.name}` : `Set up ${r.name}`}</Button> },
          ]}
        />
      )}
      {editing ? <ProfileDrawer row={editing} stains={stains} templates={templates} onClose={() => setEditing(undefined)} onMfa={() => { setEditing(undefined); setMfa(true); }} /> : null}
      <MfaDialog isOpen={mfa} onClose={() => setMfa(false)} />
    </>
  );
}

function ProfileDrawer({ row, stains, templates, onClose, onMfa }: { row: Row; stains: readonly StainRecord[]; templates: readonly TemplateSummary[]; onClose: () => void; onMfa: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const p = row.profile;
  const [kind, setKind] = useState<CaseKind | undefined>(p?.case_kind);
  const [addon, setAddon] = useState(p?.is_addon ?? false);
  const [gross, setGross] = useState(p?.requires_gross ?? true);
  const [stain, setStain] = useState(p?.default_stain_code ?? NONE);
  const [keys, setKeys] = useState<readonly string[]>(p?.default_synoptic_template_keys ?? []);
  const [active, setActive] = useState(p?.is_active ?? true);
  const [kindError, setKindError] = useState<string>();
  // Published keys, plus keys the profile already holds (kept until the user unticks them).
  const choices = [...new Set([...templates.map((t) => t.template_key), ...(p?.default_synoptic_template_keys ?? [])])].sort();
  const stainOptions = [{ value: NONE, label: 'No default stain' }, ...stains.filter((s) => s.is_active || s.code === p?.default_stain_code).map((s) => ({ value: s.code, label: s.display }))];
  return (
    <FormDialog
      as="drawer"
      title={`Test profile: ${row.name}`}
      submitLabel="Save"
      describe={cfgText}
      onClose={onClose}
      onMfa={onMfa}
      onSubmit={async () => {
        if (!kind) {
          setKindError('Choose a case kind.');
          return undefined;
        }
        setKindError(undefined);
        const r = await saveTestProfileAction(row.test_id, p?.version ?? 0, {
          case_kind: kind, is_addon: addon, requires_gross: gross, is_active: active, ...(stain !== NONE ? { default_stain_code: stain } : {}), default_synoptic_template_keys: [...keys],
        });
        if (!r.ok) return r;
        toast.show({ tone: 'success', title: 'Saved' });
        onClose();
        router.refresh();
        return undefined;
      }}
    >
      <Select label="Case kind" name="case_kind" isRequired options={KINDS} {...(kind ? { value: kind } : {})} onChange={setKind} {...(kindError ? { error: kindError } : {})} />
      <Switch label="Is add-on" name="is_addon" isSelected={addon} onChange={setAddon} />
      <Switch label="Requires gross" name="requires_gross" isSelected={gross} onChange={setGross} />
      <Select label="Default stain" name="default_stain_code" options={stainOptions} value={stain} onChange={setStain} />
      <fieldset className="lims-field">
        <legend className="lims-label">Default synoptic templates</legend>
        <p className="lims-description">Up to {MAX_KEYS} published templates.</p>
        {choices.length === 0 ? <p className="lims-description">No published templates yet.</p> : null}
        {choices.map((k) => (
          <Checkbox key={k} label={k} isSelected={keys.includes(k)} isDisabled={!keys.includes(k) && keys.length >= MAX_KEYS} onChange={(on) => setKeys(on ? [...keys, k] : keys.filter((x) => x !== k))} />
        ))}
      </fieldset>
      <Switch label="Active" name="is_active" isSelected={active} onChange={setActive} />
    </FormDialog>
  );
}
