'use client';
// 04-UI-UX §5 "AST panels" (AC-14.2). Editing a panel saves a new version (POST …/{id}/versions, code kept); the antibiotic list is ordered (1..60) and reordered
// with "Move up" / "Move down" buttons ([CONV] text Buttons, not IconButtons: the kit icon set has no chevron-up — CR candidate). [CONV] Antibiotic, organism and site are code TextFields (checked against ^[a-z0-9_]{2,64}$; the API checks they exist)
// instead of Comboboxes over the dictionaries — open point for a later pass.
import { useState } from 'react';
import { Button } from '@lims/ui/components/Button';
import { Checkbox } from '@lims/ui/components/Checkbox';
import { DataTable, type ColumnDef } from '@lims/ui/components/DataTable';
import { Drawer } from '@lims/ui/components/Drawer';
import { Form } from '@lims/ui/components/Form';
import { RadioGroup } from '@lims/ui/components/RadioGroup';
import { Select } from '@lims/ui/components/Select';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { VisuallyHidden } from '@lims/ui/components/VisuallyHidden';
import { createAstPanelAction, listAstPanelsAction, versionAstPanelAction } from '../../server/actions';
import { MICRO_CODE_RE, type AstMethod, type AstPanelDto, type AstPanelInput } from '../../server/types';
import { Chip, FailNotice, newKey, type Fail } from '../common';
import { useLoad } from './useLoad';

const CODE_HELP = 'Use 2 to 64 lowercase letters, digits or _.';
const METHODS: readonly { value: AstMethod; label: string }[] = [{ value: 'mic', label: 'MIC' }, { value: 'zone_diameter', label: 'Zone diameter' }, { value: 'other', label: 'Other' }];
const METHOD_LABEL = Object.fromEntries(METHODS.map((m) => [m.value, m.label])) as Record<string, string>;
type Scope = 'organism' | 'group' | 'any';
interface Item { code: string; method: AstMethod | 'default'; reported: boolean }
const scopeOf = (p: AstPanelDto | undefined): Scope => (p?.organism_code ? 'organism' : p?.organism_group_code ? 'group' : 'any');

export function PanelsTab({ canManage }: { canManage: boolean }) {
  const [editing, setEditing] = useState<AstPanelDto | 'new'>();
  const { rows, loaded, fail, reload } = useLoad(() => listAstPanelsAction(), 'panels');
  const columns: ColumnDef<AstPanelDto>[] = [
    { id: 'code', header: 'Code', isRowHeader: true, cell: (p) => p.code },
    { id: 'version', header: 'Version', align: 'end', cell: (p) => String(p.version_no) },
    { id: 'display', header: 'Display', cell: (p) => p.display },
    { id: 'applies', header: 'Organism / group', cell: (p) => p.organism_code ?? p.organism_group_code ?? 'Any' },
    { id: 'site', header: 'Site', cell: (p) => p.specimen_site_code ?? '—' },
    { id: 'method', header: 'Method', cell: (p) => METHOD_LABEL[p.default_method] ?? p.default_method },
    { id: 'count', header: 'Antibiotics', align: 'end', cell: (p) => String(p.antibiotics?.length ?? p.antibiotic_count ?? 0) },
    { id: 'active', header: 'Active', cell: (p) => <Chip tone={p.is_active ? 'success' : 'neutral'} label={p.is_active ? 'Active' : 'Inactive'} /> },
    ...(canManage ? [{ id: 'edit', header: 'Actions', cell: (p: AstPanelDto) => <Button size="sm" variant="ghost" onPress={() => setEditing(p)}>Edit<VisuallyHidden> {p.code}</VisuallyHidden></Button> }] : []),
  ];
  return (
    <section aria-labelledby="micro-panels">
      <h2 id="micro-panels">AST panels</h2>
      <FailNotice fail={fail} />
      {canManage ? <div><Button onPress={() => setEditing('new')}>Add panel</Button></div> : null}
      <DataTable<AstPanelDto> caption="AST panels" columns={columns} rows={rows} getRowId={(p) => p.id} isLoading={!loaded} emptyState={{ title: 'No AST panels.' }} />
      {editing ? <PanelDrawer key={editing === 'new' ? 'new' : editing.id} base={editing === 'new' ? undefined : editing} onClose={() => setEditing(undefined)} onSaved={reload} /> : null}
    </section>
  );
}

function PanelDrawer({ base, onClose, onSaved }: { base: AstPanelDto | undefined; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [code, setCode] = useState(base?.code ?? '');
  const [display, setDisplay] = useState(base?.display ?? '');
  const [scope, setScope] = useState<Scope>(scopeOf(base));
  const [organism, setOrganism] = useState(base?.organism_code ?? base?.organism_group_code ?? '');
  const [site, setSite] = useState(base?.specimen_site_code ?? '');
  const [method, setMethod] = useState<AstMethod>(base?.default_method ?? 'zone_diameter');
  const [items, setItems] = useState<Item[]>((base?.antibiotics ?? []).map((a) => ({ code: a.antibiotic_code, method: a.method ?? 'default', reported: a.is_reported_default })));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [fail, setFail] = useState<Fail>();
  const [key] = useState(newKey);

  const patch = (i: number, p: Partial<Item>) => setItems((cur) => cur.map((it, n) => (n === i ? { ...it, ...p } : it)));
  const move = (i: number, d: -1 | 1) => setItems((cur) => {
    const j = i + d;
    if (j < 0 || j >= cur.length) return cur;
    const next = [...cur];
    [next[i], next[j]] = [next[j]!, next[i]!];
    return next;
  });

  const submit = async () => {
    const e: Record<string, string> = {};
    if (!base && !MICRO_CODE_RE.test(code)) e['code'] = CODE_HELP;
    if (scope !== 'any' && !MICRO_CODE_RE.test(organism)) e['organism'] = CODE_HELP;
    if (site && !MICRO_CODE_RE.test(site)) e['site'] = CODE_HELP;
    if (items.length < 1 || items.length > 60) e['items'] = 'Add 1 to 60 antibiotics.';
    else if (items.some((it) => !MICRO_CODE_RE.test(it.code))) e['items'] = `Every antibiotic needs a code. ${CODE_HELP}`;
    setErrors(e);
    if (Object.keys(e).length > 0) return;
    setFail(undefined);
    const input: AstPanelInput = {
      ...(base ? {} : { code }), display, default_method: method,
      ...(scope === 'organism' ? { organism_code: organism } : scope === 'group' ? { organism_group_code: organism } : {}),
      ...(site ? { specimen_site_code: site } : {}),
      antibiotics: items.map((it) => ({ antibiotic_code: it.code, ...(it.method !== 'default' ? { method: it.method } : {}), is_reported_default: it.reported })),
    };
    const r = base ? await versionAstPanelAction(base.id, base.version ?? 1, input, key) : await createAstPanelAction(input, key); // [CONV] fallback as in ProtocolsTab
    if (r.ok) {
      toast.show({ tone: 'success', title: base ? 'New version saved' : 'Panel saved' });
      onSaved();
      onClose();
    } else setFail(r);
  };

  return (
    <Drawer title={base ? 'Edit panel' : 'Add panel'} isOpen onClose={onClose} width="lg">
      <FailNotice fail={fail} />
      <Form onSubmit={submit}>
        <TextField label="Code" name="code" isRequired maxLength={64} isReadOnly={!!base} value={code} {...(errors['code'] ? { error: errors['code'] } : {})} onChange={setCode} />
        <TextField label="Display" name="display" isRequired maxLength={120} value={display} onChange={setDisplay} />
        <RadioGroup<Scope> label="Applies to" name="scope" orientation="horizontal" value={scope} onChange={setScope} options={[{ value: 'organism', label: 'Organism' }, { value: 'group', label: 'Organism group' }, { value: 'any', label: 'Any' }]} />
        {scope !== 'any' ? <TextField label={scope === 'organism' ? 'Organism code' : 'Organism group code'} name="organism" isRequired maxLength={64} value={organism} {...(errors['organism'] ? { error: errors['organism'] } : {})} onChange={setOrganism} /> : null}
        <TextField label="Site code" name="specimen_site_code" maxLength={64} value={site} {...(errors['site'] ? { error: errors['site'] } : {})} onChange={setSite} />
        <Select<AstMethod> label="Default method" name="default_method" value={method} onChange={setMethod} options={METHODS} />
        <h3>Antibiotics</h3>
        {errors['items'] ? <p className="lims-error">{errors['items']}</p> : null}
        {items.map((it, i) => (
          <div key={i} className="lims-inline">
            <TextField label="Antibiotic code" name={`antibiotic_${i}`} maxLength={64} value={it.code} onChange={(v) => patch(i, { code: v })} />
            <Select<AstMethod | 'default'> label="Method" name={`method_${i}`} value={it.method} onChange={(v) => patch(i, { method: v })} options={[{ value: 'default', label: 'Panel default' }, ...METHODS]} />
            <Checkbox label="Report by default" isSelected={it.reported} onChange={(v) => patch(i, { reported: v })} />
            <Button size="sm" variant="ghost" isDisabled={i === 0} onPress={() => move(i, -1)}>Move up</Button>
            <Button size="sm" variant="ghost" isDisabled={i === items.length - 1} onPress={() => move(i, 1)}>Move down</Button>
            <Button size="sm" variant="ghost" onPress={() => setItems((cur) => cur.filter((_, n) => n !== i))}>Remove</Button>
          </div>
        ))}
        <div><Button isDisabled={items.length >= 60} onPress={() => setItems((cur) => [...cur, { code: '', method: 'default', reported: true }])}>Add antibiotic</Button></div>
        <Button type="submit" variant="primary">Save</Button>
      </Form>
    </Drawer>
  );
}
