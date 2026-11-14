'use client';
// C13.T19 PM-2 Manifest editor (draft) (04-UI-UX PM-2; US-04.1/04.2/04.4/04.5). Header fields, lines list (cards on phones), line form in a Drawer, submit / discard with ConfirmDialogs.
// Shortcuts: Alt+A add sample, Alt+S submit (desktop). Unsaved drawer -> beforeunload prompt + in-app ConfirmDialog.
// LD-140 (2026-11-13): @lims/ui components only; exactly one primary button on the page ("Submit manifest").
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge } from '@lims/ui/components/Badge';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { DatePicker } from '@lims/ui/components/DatePicker';
import { Drawer } from '@lims/ui/components/Drawer';
import { EmptyState } from '@lims/ui/components/EmptyState';
import { Menu } from '@lims/ui/components/Menu';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Stack } from '@lims/ui/components/Stack';
import { TextArea } from '@lims/ui/components/TextArea';
import { Chip, ListScreen, type ListColumn } from '../common/ui';
import { codesText, sexAge } from '../common/format';
import type { Manifest, ManifestLine } from '../common/types';
import { MANIFEST_STATE } from './ManifestList';
import { blankLine, draftOf, lineInput, LineForm, type LineDraft } from './LineForm';
import { discardManifestAction, removeLineAction, saveLineAction, submitManifestAction, updateManifestAction, type FieldIssue } from './actions';

const D102 = 'Shown to the receiving lab staff; not part of the lab order or the report';
const FALLBACK_CONSENT = 'Read the lab consent statement to the patient before you continue.'; // [CONV] PartnerContext carries no consent_statement (spec gap, see impl note)

export interface ManifestEditorProps { manifest: Manifest; labName: string; consentStatement?: string | undefined }

export function ManifestEditor({ manifest, labName, consentStatement }: ManifestEditorProps) {
  const router = useRouter();
  const lines = manifest.lines;
  const [notes, setNotes] = useState(manifest.notes ?? '');
  const [collectedOn, setCollectedOn] = useState(manifest.collected_on ?? '');
  const [drawer, setDrawer] = useState<{ line: ManifestLine | null } | null>(null);
  const [dirty, setDirty] = useState(false);
  const [issues, setIssues] = useState<FieldIssue[]>([]);
  const [banner, setBanner] = useState<{ tone: 'danger' | 'warning'; title: string; items?: string[]; reload?: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'submit' | 'discard' | 'dirty' | { remove: ManifestLine } | null>(null);
  const key = useRef<{ add: string; submit: string }>({ add: '', submit: '' });
  const fresh = () => crypto.randomUUID();

  // Alt+A add sample, Alt+S submit (04-UI-UX PM-2 footer actions).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      const k = e.key.toLowerCase();
      if (k === 'a') { e.preventDefault(); openDrawer(null); }
      if (k === 's' && lines.length > 0) { e.preventDefault(); setConfirm('submit'); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  useEffect(() => {
    if (!dirty) return;
    const guard = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [dirty]);

  const openDrawer = (line: ManifestLine | null) => { key.current.add = fresh(); setIssues([]); setDirty(false); setDrawer({ line }); };
  const closeDrawer = () => { if (dirty) setConfirm('dirty'); else setDrawer(null); };
  const conflict = (code: string) => code === 'common.version_conflict';
  const fail = (code: string, issues2?: FieldIssue[]) => {
    if (conflict(code)) setBanner({ tone: 'warning', title: 'This manifest was changed somewhere else.', reload: true });
    else if (issues2?.length) setBanner({ tone: 'danger', title: 'Please fix the following.', items: issues2.map((i) => i.message) });
    else setBanner({ tone: 'danger', title: 'Could not save. Try again in a moment.' });
  };

  const saveHeader = async () => {
    setBusy('header');
    const r = await updateManifestAction(manifest.id, manifest.version ?? 0, { notes, collected_on: collectedOn });
    setBusy(null);
    if (r.ok) { setBanner(null); router.refresh(); } else fail(r.code, r.issues);
  };

  const saveLine = async (d: LineDraft) => {
    setBusy('line');
    setIssues([]);
    const line = drawer?.line ?? null;
    const r = await saveLineAction(manifest.id, line?.id ?? null, line ? (line.version ?? 0) : (manifest.version ?? 0), lineInput(d), key.current.add);
    setBusy(null);
    if (r.ok) { setDrawer(null); setDirty(false); setBanner(null); router.refresh(); return; }
    if (conflict(r.code)) { setDrawer(null); fail(r.code); return; }
    setIssues(r.issues ?? [{ message: 'Could not save this sample. Try again in a moment.' }]);
  };

  const remove = async (l: ManifestLine) => {
    const r = await removeLineAction(manifest.id, l.id, l.version ?? 0);
    setConfirm(null);
    if (r.ok) router.refresh(); else fail(r.code, r.issues);
  };

  const submit = async () => {
    const r = await submitManifestAction(manifest.id, manifest.version ?? 0, key.current.submit || (key.current.submit = fresh()));
    setConfirm(null);
    if (r.ok) { key.current.submit = ''; router.refresh(); } else { key.current.submit = ''; fail(r.code, r.issues); }
  };

  const discard = async () => {
    const r = await discardManifestAction(manifest.id, manifest.version ?? 0);
    setConfirm(null);
    if (r.ok) router.push('/manifests'); else fail(r.code, r.issues);
  };

  const columns: ListColumn<ManifestLine>[] = [
    { id: 'line_no', header: '#', isRowHeader: true, align: 'end', cell: (l) => l.line_no },
    { id: 'ref', header: 'Sample ref', cell: (l) => l.partner_sample_ref ?? '—' },
    { id: 'patient', header: 'Patient', cell: (l) => <>{l.patient.full_name} <small>{sexAge(l.patient)}</small></> },
    { id: 'tests', header: 'Tests', cell: (l) => codesText(l.orderables.map((o) => o.code)) },
    { id: 'priority', header: 'Priority', cell: (l) => (l.priority === 'urgent' ? <Badge tone="warning">Urgent</Badge> : '—'), card: (l) => (l.priority === 'urgent' ? 'Urgent sample' : null) },
    { id: 'doctor', header: 'Doctor', hideBelow: 'md', cell: (l) => l.referrer?.display_name ?? '—' },
  ];

  const n = lines.length;
  return (
    <>
      <PageHeader title={`Manifest ${manifest.manifest_no}`} helpKey="partners.manifest_editor" status={<Chip table={MANIFEST_STATE} code="draft" size="md" />} />
      {banner ? (
        <Banner tone={banner.tone} title={banner.title} {...(banner.reload ? { action: { label: 'Reload', onPress: () => router.refresh() } } : {})}>
          {banner.items ? <ul>{banner.items.map((m, i) => <li key={i}>{m}</li>)}</ul> : null}
        </Banner>
      ) : null}
      <Stack gap={4}>
        <DatePicker label="Collection date" name="collected_on" description={D102} max={new Date().toISOString().slice(0, 10) as never} value={(collectedOn || undefined) as never} onChange={(v) => setCollectedOn(v ?? '')} />
        <TextArea label="Notes for the lab" name="notes" maxLength={500} rows={2} description={D102} value={notes} onChange={setNotes} />
        <div><Button isLoading={busy === 'header'} onPress={() => void saveHeader()}>Save details</Button></div>
        <section aria-label="Samples">
          <h2>Samples</h2>
          {n === 0 ? (
            <EmptyState title="No samples yet." body="Use Add sample to enter the first one." />
          ) : (
            <ListScreen
              caption="Samples in this manifest"
              columns={columns}
              rows={lines}
              getRowId={(l) => l.id}
              empty={{ title: 'No samples yet.' }}
              rowActions={() => [{ id: 'edit', label: 'Edit' }, { id: 'remove', label: 'Remove', isDanger: true }]}
              onRowActionMenu={(l, a) => (a === 'edit' ? openDrawer(l) : setConfirm({ remove: l }))}
              cardActions={(l) => (
                <>
                  <Button size="sm" onPress={() => openDrawer(l)}>Edit</Button>
                  <Button size="sm" variant="danger" onPress={() => setConfirm({ remove: l })}>Remove</Button>
                </>
              )}
            />
          )}
        </section>
        <div className="partner-card-actions">
          <Button variant="secondary" shortcut="Alt+A" onPress={() => openDrawer(null)}>Add sample</Button>
          <Button variant="primary" shortcut="Alt+S" isDisabled={n === 0} onPress={() => setConfirm('submit')}>Submit manifest</Button>
          <Menu trigger={<Button variant="ghost">More actions</Button>} items={[{ id: 'discard', label: 'Discard draft', isDanger: true }]} onAction={() => setConfirm('discard')} />
        </div>
      </Stack>

      {drawer ? (
        <Drawer title={drawer.line ? 'Edit sample' : 'Add sample'} isOpen onClose={closeDrawer} width="lg">
          <LineForm
            initial={drawer.line ? draftOf(drawer.line) : blankLine()}
            consentStatement={consentStatement ?? FALLBACK_CONSENT}
            issues={issues}
            isSaving={busy === 'line'}
            onDirty={() => setDirty(true)}
            onSave={(d) => void saveLine(d)}
            onCancel={closeDrawer}
          />
        </Drawer>
      ) : null}
      <ConfirmDialog
        title="Submit manifest" confirmLabel="Submit" isOpen={confirm === 'submit'} onCancel={() => setConfirm(null)} onConfirm={submit}
        body={`Submit ${n} ${n === 1 ? 'sample' : 'samples'} to ${labName}? You can't edit them after submitting.`}
      />
      <ConfirmDialog title="Discard draft" confirmLabel="Discard draft" tone="danger" isOpen={confirm === 'discard'} onCancel={() => setConfirm(null)} onConfirm={discard} body="This draft and its samples will be deleted." />
      <ConfirmDialog
        title="Discard unsaved changes?" confirmLabel="Discard changes" tone="danger" isOpen={confirm === 'dirty'} onCancel={() => setConfirm(null)}
        onConfirm={() => { setConfirm(null); setDirty(false); setDrawer(null); }} body="The sample you are editing has not been saved."
      />
      <ConfirmDialog
        title="Remove sample" confirmLabel="Remove" tone="danger" isOpen={typeof confirm === 'object' && confirm !== null} onCancel={() => setConfirm(null)}
        onConfirm={() => (typeof confirm === 'object' && confirm !== null ? remove(confirm.remove) : undefined)} body="Remove this sample from the manifest?"
      />
    </>
  );
}
