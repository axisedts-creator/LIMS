'use client';
// 04-UI-UX §2.4 Narrative report editor: one RichTextEditor per template section, images (PNG/JPEG, ≤12), Save draft / Sign, amendments.
// Signed content is rendered through the kit SafeHtml only (never raw HTML). Shortcuts §1.1 on staff.reporting.narrative: Ctrl+S, Ctrl+Enter (sign), Alt+I.
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { RichTextEditor, SafeHtml } from '@lims/ui/components/RichTextEditor';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { listCodesAction, saveNarrativeDraftAction, signNarrativeAction, startAmendmentAction, uploadNarrativeImageAction } from '../server/actions';
import type { Narrative, NarrativeTemplate } from '../server/types';
import { Chip, errorText, hasPerm, newKey, whenText } from './format';
import { NativeSelect, ReasonDialog } from './ReasonDialog';
import { useShortcuts } from './useShortcuts';

const TOOLS = ['bold', 'italic', 'underline', 'bullet_list', 'ordered_list', 'table', 'h3', 'h4'] as const;
const MAX_IMAGES = 12;
const hasText = (html: string) => html.replace(/<[^>]*>/g, '').trim() !== '';

export interface NarrativeEditorProps { narrative: Narrative; templates: readonly NarrativeTemplate[]; permissions: readonly string[]; signedByName?: string | undefined; signedByTitle?: string | undefined }

export function NarrativeEditor({ narrative, templates, permissions, signedByName, signedByTitle }: NarrativeEditorProps) {
  const router = useRouter();
  const toast = useToast();
  const cv = narrative.current_version;
  const editable = narrative.status === 'draft' || narrative.status === 'amending';
  const canWrite = hasPerm(permissions, 'reporting.narrative.write');
  const canSign = hasPerm(permissions, 'reporting.narrative.sign');
  const [templateId, setTemplateId] = useState(cv.template_id ?? templates[0]?.id ?? '');
  const [pendingTemplate, setPendingTemplate] = useState<string | null>(null);
  const [sections, setSections] = useState<Record<string, string>>(() => Object.fromEntries(cv.sections.map((s) => [s.key, s.html])));
  const [images, setImages] = useState(cv.images);
  const [version, setVersion] = useState(narrative.version);
  const [dirty, setDirty] = useState(false);
  const [savedAt, setSavedAt] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [dlg, setDlg] = useState<'sign' | 'amend' | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const inFlight = useRef(false);

  const tpl = templates.find((t) => t.id === templateId);
  const known = new Set((tpl?.sections ?? []).map((s) => s.key));
  const rows = [
    ...(tpl?.sections ?? []).map((s) => ({ key: s.key, heading: s.heading, required: s.required })),
    ...cv.sections.filter((s) => !known.has(s.key)).map((s) => ({ key: s.key, heading: s.heading, required: false })),
  ];
  const edit = (key: string, html: string) => { setSections((s) => ({ ...s, [key]: html })); setDirty(true); };

  const payload = () => ({
    ...(templateId ? { template_id: templateId } : {}),
    sections: rows.map((r) => ({ key: r.key, html: sections[r.key] ?? '' })),
    images: images.map((i) => ({ image_id: i.image_id, ...(i.caption ? { caption: i.caption } : {}) })),
  });
  /** Saves the draft; returns the new narrative version, or undefined on failure (error shown). */
  const save = async (): Promise<number | undefined> => {
    const r = await saveNarrativeDraftAction(narrative.id, version, payload(), newKey());
    if (!r.ok) { setError(errorText(r.code)); return undefined; }
    setVersion(r.data.version); setDirty(false); setSavedAt(new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Kathmandu', hour: '2-digit', minute: '2-digit' }));
    return r.data.version;
  };
  const guarded = async (f: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(undefined);
    try { await f(); } finally { inFlight.current = false; setBusy(false); }
  };
  const saveDraft = () => guarded(async () => { await save(); });
  const sign = () => guarded(async () => {
    const v = dirty ? await save() : version;
    if (v === undefined) { setDlg(null); return; }
    const r = await signNarrativeAction(narrative.id, v, newKey());
    setDlg(null);
    if (r.ok) { toast.show({ tone: 'success', title: 'Report signed.' }); router.refresh(); } else setError(errorText(r.code));
  });
  const addImage = (file: File | undefined) => guarded(async () => {
    if (!file) return;
    if (!['image/png', 'image/jpeg'].includes(file.type)) { setError('Only PNG or JPEG images are allowed'); return; }
    const form = new FormData();
    form.set('file', file);
    const r = await uploadNarrativeImageAction(narrative.id, form, newKey());
    if (r.ok) { setImages((l) => [...l, { image_id: r.data.image_id }]); setDirty(true); } else setError(errorText(r.code));
  });
  const changeTemplate = (id: string) => {
    if (id === templateId) return;
    if (Object.values(sections).some(hasText)) setPendingTemplate(id);
    else applyTemplate(id);
  };
  const applyTemplate = (id: string) => {
    const t = templates.find((x) => x.id === id);
    setTemplateId(id);
    setSections(Object.fromEntries((t?.sections ?? []).map((s) => [s.key, s.default_html ?? ''])));
    setDirty(true);
    setPendingTemplate(null);
  };

  useShortcuts('staff.reporting.narrative', editable ? [
    ...(canWrite ? [{ key: 'Ctrl+S', description: 'Save draft', run: () => void saveDraft() }, { key: 'Alt+I', description: 'Add image', run: () => fileInput.current?.click() }] : []),
    ...(canSign ? [{ key: 'Ctrl+Enter', description: 'Sign report', run: () => setDlg('sign') }] : []),
  ] : [], [editable, canWrite, canSign, version, dirty, templateId, images.length]);

  const header = (
    <PageHeader
      title={narrative.test_name} helpKey="reporting.narrative" status={<Chip status={narrative.status} />}
      breadcrumbs={[{ label: 'Reports', href: '/reporting' }, { label: narrative.test_name }]}
    />
  );

  if (!editable) {
    return (
      <section aria-label="Narrative report">
        {header}
        {cv.sections.map((s) => (
          <div key={s.key} className="lims-card"><h2>{s.heading}</h2><SafeHtml html={s.html} /></div>
        ))}
        {cv.signed_at ? <p>{`Signed${signedByName ? ` by ${signedByName}${signedByTitle ? `, ${signedByTitle}` : ''}` : ''} on ${whenText(cv.signed_at)}`}</p> : null}
        {error ? <p role="alert" className="lims-error">{error}</p> : null}
        {canSign && narrative.status === 'signed' ? <Button variant="primary" onPress={() => setDlg('amend')}>Start amendment</Button> : null}
        <ReasonDialog
          title="Start an amendment" confirmLabel="Start amendment" isOpen={dlg === 'amend'} onCancel={() => setDlg(null)} load={() => listCodesAction('narrative_amend_reasons')} textRequired="other"
          body="The signed report stays as it is. You edit a new version and sign it again."
          onConfirm={async (r) => {
            const res = await startAmendmentAction(narrative.id, version, { reason_code: r.reasonCode, ...(r.reasonText ? { reason_text: r.reasonText } : {}) }, newKey());
            if (!res.ok) return errorText(res.code);
            setDlg(null); toast.show({ tone: 'success', title: 'Amendment started.' }); router.refresh();
          }}
        />
      </section>
    );
  }

  return (
    <section aria-label="Narrative report">
      {header}
      {narrative.patient_display_name ? <p className="lims-description">{narrative.patient_display_name}{narrative.registration_no ? ` · ${narrative.registration_no}` : ''}</p> : null}
      {error ? <p role="alert" className="lims-error">{error}</p> : null}
      {templates.length > 0 ? (
        <NativeSelect label="Template" value={templateId} onChange={changeTemplate} options={templates.map((t) => ({ value: t.id, label: t.name }))} placeholder="No template" />
      ) : null}
      {rows.map((r) => (
        <RichTextEditor
          key={`${templateId}:${r.key}`} label={r.heading} name={`section_${r.key}`} maxLength={20000} allowed={TOOLS}
          isReadOnly={!canWrite} isRequired={r.required} {...(r.required ? { description: 'Required' } : {})}
          value={sections[r.key] ?? ''} onChange={(html) => edit(r.key, html)}
        />
      ))}
      <div className="lims-card">
        <h2>Images</h2>
        {images.length > 0 ? (
          <ul className="lims-list">
            {images.map((img, i) => (
              <li key={img.image_id} className="lims-list-row">
                <TextField
                  label={`Caption for image ${i + 1}`} name={`caption_${img.image_id}`} maxLength={200} value={img.caption ?? ''} isReadOnly={!canWrite}
                  onChange={(v) => { setImages((l) => l.map((x) => (x.image_id === img.image_id ? { ...x, caption: v } : x))); setDirty(true); }}
                />
                {canWrite ? <Button size="sm" variant="ghost" onPress={() => { setImages((l) => l.filter((x) => x.image_id !== img.image_id)); setDirty(true); }}>{`Remove image ${i + 1}`}</Button> : null}
              </li>
            ))}
          </ul>
        ) : null}
        {canWrite ? (
          <div className="lims-field">
            <label className="lims-label" htmlFor="narrative-image">Add image</label>
            <input
              ref={fileInput} id="narrative-image" type="file" accept="image/png,image/jpeg" className="lims-input" disabled={images.length >= MAX_IMAGES || busy}
              onChange={(e) => { const f = e.currentTarget.files?.[0]; e.currentTarget.value = ''; void addImage(f); }}
            />
            <p className="lims-description">{`PNG or JPEG, up to ${MAX_IMAGES} images.`}</p>
          </div>
        ) : null}
      </div>
      <div className="lims-action-bar">
        {canWrite ? <Button shortcut="Ctrl+S" isLoading={busy} onPress={() => void saveDraft()}>Save draft</Button> : null}
        {canSign ? <Button variant="primary" shortcut="Ctrl+Enter" isDisabled={busy} onPress={() => setDlg('sign')}>Sign report</Button> : null}
        {savedAt ? <span role="status" className="lims-description">{`Saved ${savedAt}`}</span> : null}
      </div>
      <ConfirmDialog
        title="Sign report" body="Sign and lock this report? After signing, changes need an amendment." confirmLabel="Sign" isOpen={dlg === 'sign'} onCancel={() => setDlg(null)} onConfirm={sign}
      />
      <ConfirmDialog
        title="Replace section text with the template?" body="The text in each section is replaced by the template's default text." confirmLabel="Replace" isOpen={pendingTemplate !== null}
        onCancel={() => setPendingTemplate(null)} onConfirm={() => { if (pendingTemplate) applyTemplate(pendingTemplate); }}
      />
    </section>
  );
}
