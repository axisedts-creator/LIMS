'use client';
// 04-UI-UX §4.7 synoptic template editor /anatomic/config/templates/{template_id|new}: builder (left) + live preview (right). Header (Template key while new, Title, case kinds),
// sections (heading, reorder, [Add field]) with a field table each; a field is added or edited in a Drawer. [Save draft] (the page's one primary button) sends the whole
// definition: new -> POST {template_key, definition} + Idempotency-Key; existing -> PUT {definition} with If-Match = the template version. The API validator (T-03) is the authority:
// the builder only refuses to send what it would refuse (AC-08.2 at the source) and shows the API's own errors[] on the section / field their path names (422 anatomic.template_invalid).
// A published or retired template is read-only with a banner (AC-08.3: use New version from the list). Section keys are derived from headings (builder-model.sectionKey), stored keys
// never change. Template text is rendered as text, never HTML (REQ-SEC-088).
// LD-140 (2026-11-13, binding): kit components and token class names only; one primary button; every status shows tone, icon and word.
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { Card } from '@lims/ui/components/Card';
import { Checkbox } from '@lims/ui/components/Checkbox';
import { DataTable } from '@lims/ui/components/DataTable';
import { Grid } from '@lims/ui/components/Grid';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Stack } from '@lims/ui/components/Stack';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { createSynopticAction, updateSynopticAction } from '../../server/actions.config';
import type { DefField, SynopticTemplate } from '../../server/config.types';
import type { CaseKind } from '../../server/types';
import { FailNotice, KIND_LABEL } from '../common';
import { CASE_KINDS, checkDefinition, KEY_RE, orderValid, repairShowIf, sectionKeys, toDefinition, toSecs, type Problem, type Sec } from './builder-model';
import { cfgText, MfaDialog, newKey, TemplateStatusChip, type Fail } from './config-shared';
import { FieldDrawer } from './FieldDrawer';
import { TemplatePreview } from './TemplatePreview';

const TYPE_LABEL: Record<string, string> = { text: 'Text', long_text: 'Long text', integer: 'Integer', decimal: 'Decimal', boolean: 'Yes/No', single_select: 'Single select', multi_select: 'Multi select', date: 'Date' };
const INVALID: Fail = { ok: false, status: 422, code: 'anatomic.template_invalid' };
const showIfText = (f: DefField) => (f.show_if ? `${f.show_if.field_key} = ${typeof f.show_if.equals === 'boolean' ? (f.show_if.equals ? 'Yes' : 'No') : f.show_if.equals}` : '—');
const swap = <T,>(a: readonly T[], i: number, j: number) => { const n = [...a]; [n[i], n[j]] = [n[j]!, n[i]!]; return n; };

export function TemplateEditor({ template }: { template?: SynopticTemplate }) {
  const router = useRouter();
  const toast = useToast();
  const isNew = template === undefined;
  const readOnly = template !== undefined && template.status !== 'draft';
  const uid = useRef(0);
  const nextUid = () => ++uid.current;
  const version = useRef(template?.version ?? 0);
  const busy = useRef(false);
  const saved = useRef<string | undefined>(template ? JSON.stringify(template.definition) : undefined); // the last stored definition (dirty check)

  const [tkey, setTkey] = useState('');
  const [title, setTitle] = useState(template?.definition.title ?? '');
  const [kinds, setKinds] = useState<readonly CaseKind[]>(template?.definition.applies_to_case_kinds ?? []);
  const [sections, setSections] = useState<readonly Sec[]>(() => (template ? toSecs(template.definition, nextUid) : []));
  const [problems, setProblems] = useState<readonly Problem[]>([]);
  const [fail, setFail] = useState<Fail>();
  const [mfa, setMfa] = useState(false);
  const [saving, setSaving] = useState(false);
  const [drawer, setDrawer] = useState<{ si: number; fi: number }>();
  const [repaired, setRepaired] = useState<readonly string[]>([]);

  const def = toDefinition({ title, kinds, sections });
  const msgs = (path: string) => problems.filter((p) => p.path === path).map((p) => p.message).join(' ');
  const under = (prefix: string) => problems.filter((p) => p.path.startsWith(`${prefix}/`)).map((p) => p.message);

  const edit = (next: readonly Sec[]) => { setSections(next); setProblems([]); };
  const canMove = (i: number, d: -1 | 1) => i + d >= 0 && i + d < sections.length && orderValid(swap(sections, i, i + d));
  const saveField = (f: DefField) => {
    const d = drawer!;
    const next = sections.map((s, si) => (si !== d.si ? s : { ...s, fields: d.fi < s.fields.length ? s.fields.map((x, j) => (j === d.fi ? f : x)) : [...s.fields, f] }));
    const r = repairShowIf(next);
    setRepaired(r.repaired);
    edit(r.sections);
  };

  const save = async () => {
    if (busy.current) return; // one request per press
    busy.current = true;
    try {
      const found: Problem[] = checkDefinition(def);
      if (isNew && !KEY_RE.test(tkey)) found.push({ path: '/template_key', message: 'Use lower case letters, digits and underscore, starting with a letter (40 at most).' });
      if (found.length > 0) {
        setProblems(found);
        setFail(INVALID);
        return;
      }
      const json = JSON.stringify(def);
      if (!isNew && json === saved.current) return toast.show({ tone: 'info', title: 'No changes to save' }); // a second press on an unchanged draft sends nothing
      setSaving(true);
      setFail(undefined);
      const r = isNew ? await createSynopticAction(tkey, def, newKey()) : await updateSynopticAction(template.id, version.current, def);
      if (!r.ok) {
        if (r.code === 'auth.mfa_required') return setMfa(true);
        setProblems((r.errors ?? []).map((e) => ({ path: e.path ?? '', message: e.message })));
        return setFail(r);
      }
      setProblems([]);
      toast.show({ tone: 'success', title: 'Draft saved' });
      if (isNew) router.replace(`/anatomic/config/templates/${r.data.id}`);
      else {
        saved.current = json;
        version.current = r.data.version;
        router.refresh();
      }
    } finally {
      busy.current = false;
      setSaving(false);
    }
  };

  const keys = sectionKeys(sections);
  const fieldTable = (s: Sec, si: number) => (
    <DataTable
      caption={`Fields of section ${si + 1}`}
      density="compact"
      rows={s.fields.map((f, fi) => ({ f, fi }))}
      getRowId={(r) => `${si}-${r.fi}`}
      emptyState={{ title: 'No fields yet' }}
      columns={[
        { id: 'key', header: 'Key', isRowHeader: true, cell: (r) => <span className="lims-mono">{r.f.key}</span> },
        {
          id: 'label', header: 'Label',
          cell: (r) => (
            <>
              {r.f.label}
              {under(`/definition/sections/${si}/fields/${r.fi}`).map((m, i) => <span key={i} className="lims-error"> {m}</span>)}
            </>
          ),
        },
        { id: 'type', header: 'Type', cell: (r) => TYPE_LABEL[r.f.type] ?? r.f.type },
        { id: 'required', header: 'Required', cell: (r) => (r.f.required ? 'Yes' : 'No') },
        { id: 'show', header: 'Show if', hideBelow: 'lg', cell: (r) => showIfText(r.f) },
        ...(readOnly ? [] : [{ id: 'edit', header: 'Actions', cell: (r: { f: DefField; fi: number }) => <Button size="sm" variant="ghost" onPress={() => setDrawer({ si, fi: r.fi })}>{`Edit field ${r.f.key}`}</Button> }]),
      ]}
    />
  );

  return (
    <>
      <PageHeader
        title={template ? def.title || template.template_key : 'New synoptic template'}
        helpKey="anatomic.config.template"
        breadcrumbs={[{ label: 'Pathology cases', href: '/anatomic' }, { label: 'Pathology setup', href: '/anatomic/config?tab=templates' }, { label: template ? template.template_key : 'New template' }]}
        {...(template ? { status: <TemplateStatusChip status={template.status} /> } : {})}
        actions={readOnly ? null : <Button variant="primary" isLoading={saving} onPress={() => void save()}>Save draft</Button>}
      />
      {readOnly ? <Banner tone="info" title="Published templates can't be changed. Create a new version." /> : null}
      {repaired.length > 0 ? <Banner tone="warning" title={`The Show if condition was removed from: ${repaired.join(', ')}.`} /> : null}
      <FailNotice fail={fail} describe={cfgText} />
      <p className="lims-description">Write your own checklists. Do not copy protocol text you do not have rights to.</p>
      <Grid columns={2}>
        <Stack>
          {template ? (
            <p>
              <span className="lims-mono">{template.template_key}</span> · Version {template.version_no}
            </p>
          ) : (
            <TextField label="Template key" name="template_key" isRequired maxLength={64} description="Lower case letters, digits and underscore, 40 at most." value={tkey} onChange={setTkey} {...(msgs('/template_key') ? { error: msgs('/template_key') } : {})} />
          )}
          {readOnly ? (
            <>
              <p>{def.title}</p>
              <p>{def.applies_to_case_kinds.map((k) => KIND_LABEL[k]).join(', ')}</p>
            </>
          ) : (
            <>
              <TextField label="Title" name="title" isRequired maxLength={200} value={title} onChange={(v) => { setTitle(v); setProblems([]); }} {...(msgs('/definition/title') ? { error: msgs('/definition/title') } : {})} />
              <fieldset className="lims-field">
                <legend className="lims-label">Applies to case kinds</legend>
                {CASE_KINDS.map((k) => (
                  <Checkbox key={k} label={KIND_LABEL[k]} name={`kind_${k}`} isSelected={kinds.includes(k)} onChange={(on) => { setKinds(on ? [...kinds, k] : kinds.filter((x) => x !== k)); setProblems([]); }} />
                ))}
                {msgs('/definition/applies_to_case_kinds') ? <p className="lims-error">{msgs('/definition/applies_to_case_kinds')}</p> : null}
              </fieldset>
            </>
          )}
          {sections.map((s, i) => (
            <div key={s.uid} data-section-index={i} data-section-key={keys[i]}>
              <Card>
                {readOnly ? (
                  <h3>{s.heading}</h3>
                ) : (
                  <>
                    <TextField label="Section heading" name={`section_heading_${s.uid}`} maxLength={200} value={s.heading} onChange={(v) => edit(sections.map((x) => (x === s ? { ...x, heading: v } : x)))} {...(msgs(`/definition/sections/${i}/heading`) ? { error: msgs(`/definition/sections/${i}/heading`) } : {})} />
                    <Button size="sm" variant="ghost" isDisabled={!canMove(i, -1)} onPress={() => edit(swap(sections, i, i - 1))}>Move section up</Button>
                    <Button size="sm" variant="ghost" isDisabled={!canMove(i, 1)} onPress={() => edit(swap(sections, i, i + 1))}>Move section down</Button>
                    <Button size="sm" iconStart="plus" onPress={() => setDrawer({ si: i, fi: s.fields.length })}>Add field</Button>
                    {msgs(`/definition/sections/${i}/fields`) ? <p className="lims-error">{msgs(`/definition/sections/${i}/fields`)}</p> : null}
                  </>
                )}
                {s.fields.length > 0 ? fieldTable(s, i) : null}
              </Card>
            </div>
          ))}
          {readOnly ? null : (
            <div>
              <Button iconStart="plus" onPress={() => edit([...sections, { uid: nextUid(), heading: '', fields: [] }])}>Add section</Button>
              {msgs('/definition/sections') ? <p className="lims-error">{msgs('/definition/sections')}</p> : null}
            </div>
          )}
        </Stack>
        <TemplatePreview definition={def} />
      </Grid>
      {drawer && !readOnly ? <FieldDrawer sections={sections} at={drawer} field={sections[drawer.si]?.fields[drawer.fi]} onSave={saveField} onClose={() => setDrawer(undefined)} /> : null}
      <MfaDialog isOpen={mfa} onClose={() => setMfa(false)} />
    </>
  );
}
