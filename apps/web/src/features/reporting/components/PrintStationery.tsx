'use client';
// T0D-PRINTCFG-1 done_when (1), (5) (LD-316, LD-319(1), LD-353 settings template): "Print and stationery" editor on the reporting and the billing settings.
// Per branch (Lab default or one branch) and document kind: paper mode in plain words, notepad style header and footer (8 lines of 120 characters,
// plain text only), blank mm for the pre-printed pad, black and white, font size, and a live A4 preview (previewPrintProfile, synthetic data only).
// Reports need reporting.settings.manage, bills and credit notes billing.settings.manage; without it a tab is read only. [CONV] recipient_type is not
// edited (done_when lists no recipient picker): profiles saved here apply to every recipient.
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { RadioGroup } from '@lims/ui/components/RadioGroup';
import { Select } from '@lims/ui/components/Select';
import { Switch } from '@lims/ui/components/Switch';
import { Tabs } from '@lims/ui/components/Tabs';
import { TextArea } from '@lims/ui/components/TextArea';
import { useToast } from '@lims/ui/components/Toast';
import { getPrintAction, listBranchesAction, listPrintProfilesAction, previewPrintProfileAction, upsertPrintProfileAction } from '../server/actions';
import { PAPER_LABEL, PAPER_MODES, typedTextError, type Branch, type DocumentKind, type PaperMode, type PrintProfile, type PrintProfileFields, type PrintProfileInput } from '../server/types';
import { errorText, hasPerm, newKey } from './format';
import { NumberInput, rangeError } from './NumberInput';
import './print-stationery.css';

const KINDS: { id: DocumentKind; label: string; perm: string }[] = [
  { id: 'report', label: 'Reports', perm: 'reporting.settings.manage' },
  { id: 'invoice', label: 'Bills', perm: 'billing.settings.manage' },
  { id: 'credit_note', label: 'Credit notes', perm: 'billing.settings.manage' },
];
const DEFAULTS: PrintProfileFields = { paper_mode: 'letterhead_image', header_text: '', footer_text: '', reserve_top_mm: 0, reserve_bottom_mm: 0, show_logo: false, show_seller_pan: true, grayscale: false, font_size_pt: 10 };
const LAB = 'lab_default';
const PREVIEW_PAUSE_MS = 600;
const POLL_MS = 1_000;
const POLL_MAX = 30;
const lineCount = (v: string) => (v === '' ? 0 : v.split('\n').length);
const fieldsOf = (p: PrintProfile): PrintProfileFields => {
  const { paper_mode, header_text, footer_text, reserve_top_mm, reserve_bottom_mm, show_logo, show_seller_pan, grayscale, font_size_pt } = p;
  return { paper_mode, header_text: header_text ?? '', footer_text: footer_text ?? '', reserve_top_mm, reserve_bottom_mm, show_logo, show_seller_pan, grayscale, font_size_pt };
};
/** Profile of one key (the lab default when branch is undefined), for every recipient. */
const find = (all: readonly PrintProfile[], kind: DocumentKind, branch?: string) => all.find((p) => p.document_kind === kind && p.branch_id === branch && !p.recipient_type);

type Preview = { state: 'idle' | 'rendering' } | { state: 'ready'; id: string } | { state: 'failed' };

export function PrintStationery({ permissions, initialKind }: { permissions: readonly string[]; initialKind: DocumentKind }) {
  const toast = useToast();
  const headingId = useId();
  const [kind, setKind] = useState<DocumentKind>(initialKind);
  const [branch, setBranch] = useState(LAB);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [profiles, setProfiles] = useState<PrintProfile[] | null>(null);
  const [loadError, setLoadError] = useState<string>();
  const [d, setD] = useState<PrintProfileFields>(DEFAULTS);
  const [saveError, setSaveError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Preview>({ state: 'idle' });
  const canEdit = hasPerm(permissions, KINDS.find((k) => k.id === kind)!.perm);
  const ro = !canEdit;
  const branchId = branch === LAB ? undefined : branch;

  const load = async () => {
    setLoadError(undefined);
    const r = await listPrintProfilesAction().catch(() => null);
    if (r?.ok) setProfiles(r.data);
    else setLoadError(r ? errorText(r.code) : 'The print settings could not be read');
  };
  useEffect(() => { void load(); void listBranchesAction().then(setBranches, () => undefined); }, []);

  // A new tab, branch or a fresh read loads that key's stored profile (a branch without one starts from the lab default).
  const own = profiles ? find(profiles, kind, branchId) : undefined;
  const fallback = profiles ? find(profiles, kind) : undefined;
  useEffect(() => {
    const p = own ?? fallback;
    setD(p ? fieldsOf(p) : DEFAULTS);
    setSaveError(undefined);
  }, [profiles, kind, branch]);

  const set = <K extends keyof PrintProfileFields>(k: K, v: PrintProfileFields[K]) => { setD((x) => ({ ...x, [k]: v })); setSaveError(undefined); };
  const headerError = typedTextError(d.header_text);
  const footerError = typedTextError(d.footer_text);
  const pad = d.paper_mode === 'preprinted_paper';
  const mmError = rangeError('Blank space at the top (mm)', d.reserve_top_mm, 0, 80) ?? rangeError('Blank space at the bottom (mm)', d.reserve_bottom_mm, 0, 60);
  const valid = !headerError && !footerError && !mmError;
  const input: PrintProfileInput = { ...(branchId ? { branch_id: branchId } : {}), document_kind: kind, ...d };

  // Live preview: one request per pause; a changed draft is a new request (new Idempotency-Key). Stale answers are dropped.
  const { branch_id: _b, ...previewInput } = input;
  const previewKey = JSON.stringify(previewInput);
  useEffect(() => {
    if (!canEdit || !profiles || !valid) return;
    let alive = true;
    const t = setTimeout(async () => {
      setPreview({ state: 'rendering' });
      const r = await previewPrintProfileAction(previewInput, newKey()).catch(() => null);
      if (!alive) return;
      if (!r?.ok) { setPreview({ state: 'failed' }); return; }
      let state = r.data.state;
      for (let n = 0; alive && state !== 'ready' && state !== 'failed' && n < POLL_MAX; n++) {
        await new Promise((res) => setTimeout(res, POLL_MS));
        if (!alive) return;
        const g = await getPrintAction(r.data.id).catch(() => null);
        if (g?.ok) state = g.data.state;
      }
      if (alive) setPreview(state === 'ready' ? { state: 'ready', id: r.data.id } : { state: 'failed' });
    }, PREVIEW_PAUSE_MS);
    return () => { alive = false; clearTimeout(t); };
  }, [previewKey, canEdit, !!profiles]);

  const save = async () => {
    if (busy || !canEdit || !profiles || !valid) return;
    setBusy(true);
    setSaveError(undefined);
    try {
      const r = await upsertPrintProfileAction(input);
      if (r.ok) {
        setProfiles((all) => [...(all ?? []).filter((p) => !(p.document_kind === kind && p.branch_id === branchId && !p.recipient_type)), r.data]);
        toast.show({ tone: 'success', title: 'Print settings saved.' });
      } else setSaveError(errorText(r.code));
    } finally { setBusy(false); }
  };

  const counter = (v: string) => <p className="lims-description">{lineCount(v)} of 8 lines</p>;
  const editor = (
    <div className="pcfg-layout">
      <div className="lims-form">
        <BranchPicker branches={branches} value={branch} onChange={setBranch} />
        {profiles && branchId && !own ? <p className="lims-description">This branch uses the lab default until you save its own settings.</p> : null}
        <RadioGroup<PaperMode> label="Paper" name="paper_mode" value={d.paper_mode} isDisabled={ro} onChange={(v) => set('paper_mode', v)} options={PAPER_MODES.map((m) => ({ value: m, label: PAPER_LABEL[m] }))} />
        <TextArea label="Header" name="header_text" rows={4} maxLength={967} showCount={false} isReadOnly={ro} value={d.header_text} onChange={(v) => set('header_text', v)} {...(headerError ? { error: headerError } : {})} />
        {counter(d.header_text)}
        <TextArea label="Footer" name="footer_text" rows={3} maxLength={967} showCount={false} isReadOnly={ro} value={d.footer_text} onChange={(v) => set('footer_text', v)} {...(footerError ? { error: footerError } : {})} />
        {counter(d.footer_text)}
        {pad ? (
          <>
            <NumberInput label="Blank space at the top (mm)" name="reserve_top_mm" min={0} max={80} value={d.reserve_top_mm} isReadOnly={ro} onChange={(v) => set('reserve_top_mm', v as number)} />
            <NumberInput label="Blank space at the bottom (mm)" name="reserve_bottom_mm" min={0} max={60} value={d.reserve_bottom_mm} isReadOnly={ro} onChange={(v) => set('reserve_bottom_mm', v as number)} />
          </>
        ) : null}
        <Switch label="Black and white" isDisabled={ro} isSelected={d.grayscale} onChange={(v) => set('grayscale', v)} />
        <Select<string> label="Font size" name="font_size_pt" isDisabled={ro} value={String(d.font_size_pt)} onChange={(v) => set('font_size_pt', Number(v))} options={[8, 9, 10, 11, 12].map((n) => ({ value: String(n), label: `${n} pt` }))} />
        {saveError ? <div role="alert"><Banner tone="danger" title="Could not save the print settings">{saveError}</Banner></div> : null}
        {canEdit ? <Button variant="primary" isLoading={busy} isDisabled={!profiles} onPress={() => void save()}>Save print settings</Button> : <p className="lims-description">Read only: you do not have the permission to change these settings.</p>}
      </div>
      <section aria-label="Preview" className="lims-card">
        <p role="heading" aria-level={3} className="lims-card-title">Preview</p>
        {preview.state === 'ready' ? <iframe title="A4 preview with sample data" src={`/reporting/prints/${preview.id}/pdf`} className="pcfg-preview-frame" />
          : preview.state === 'failed' ? <p role="alert" className="lims-error">Could not prepare the preview. Your changes are not lost; edit or save as usual.</p>
            : canEdit ? <p className="lims-description">Preparing preview…</p> : <p className="lims-description">The preview needs the permission to change these settings.</p>}
      </section>
    </div>
  );

  return (
    <section aria-labelledby={headingId} className="lims-card">
      {/* T0D-UIGUARD-1-BILLING (LD-436 R7, /billing/settings): card title style with heading semantics, not a raw h2/h3. */}
      <p role="heading" aria-level={2} id={headingId} className="lims-card-title">Print and stationery</p>
      {loadError ? (
        <div role="alert"><Banner tone="danger" title="Could not load the print settings">{loadError} <Button onPress={() => void load()}>Retry</Button></Banner></div>
      ) : null}
      <Tabs aria-label="Document kind" items={KINDS.map(({ id, label }) => ({ id, label }))} selectedId={kind} onChange={(k) => setKind(k as DocumentKind)}>
        {editor}
      </Tabs>
    </section>
  );
}

/** Branch picker on the kit Select. [CONV] the kit names its button "<value> <label>"; the ids are swapped after render so the name reads
 * "Branch <value>" (label first, as for every other field). React re-applies its own value only when the ids change; the swap then runs again. */
function BranchPicker({ branches, value, onChange }: { branches: readonly Branch[]; value: string; onChange: (v: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const btn = box.current?.querySelector('button');
    const ids = btn?.getAttribute('aria-labelledby')?.split(' ') ?? [];
    const first = ids[0] ? document.getElementById(ids[0]) : null;
    if (btn && ids.length > 1 && first && btn.contains(first)) btn.setAttribute('aria-labelledby', [...ids.slice(1), ids[0]].join(' '));
  });
  return (
    <div ref={box}>
      <Select<string> label="Branch" name="branch_id" value={value} onChange={onChange} options={[{ value: LAB, label: 'Lab default' }, ...branches.map((b) => ({ value: b.branch_id, label: b.name }))]} />
    </div>
  );
}
