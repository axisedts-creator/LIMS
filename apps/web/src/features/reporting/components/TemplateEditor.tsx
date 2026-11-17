'use client';
// 04-UI-UX §2.6 Template editor: a form over TemplateConfig (02-TRD §6.5; ranges copied from contracts/openapi/reporting.yaml). Save draft (If-Match =
// draft version), Preview with sample data (a print job), Publish (privileged, confirm). Read-only without reporting.template.manage.
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { Checkbox } from '@lims/ui/components/Checkbox';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { Switch } from '@lims/ui/components/Switch';
import { TextField } from '@lims/ui/components/TextField';
import { useToast } from '@lims/ui/components/Toast';
import { getPrintAction, previewTemplateAction, publishTemplateAction, saveTemplateDraftAction } from '../server/actions';
import type { TemplateConfig, TemplateDetail } from '../server/types';
import { Chip, errorText, hasPerm, humanize, newKey } from './format';
import { NumberInput, rangeError } from './NumberInput';
import { NativeSelect } from './ReasonDialog';

const HEADER_FIELDS = ['sample_collected_at', 'name', 'reg_no', 'age_gender', 'barcode_no', 'sample_coll_dt', 'reg_date', 'sample_rcv_dt', 'reported_date', 'report_status', 'referred_by'];
const MAX_DISCLAIMERS = 5;
const POLL_MS = 5_000;
const POLL_MAX = 24;

/** Every numeric field with its contract range; used for the inline errors and the pre-save check. */
const RANGES: { label: string; get: (c: TemplateConfig) => number | ''; min: number; max: number; step?: number }[] = [
  { label: 'Top margin (mm)', get: (c) => c.page.margin_mm.top, min: 5, max: 80 }, { label: 'Bottom margin (mm)', get: (c) => c.page.margin_mm.bottom, min: 5, max: 80 },
  { label: 'Left margin (mm)', get: (c) => c.page.margin_mm.left, min: 5, max: 40 }, { label: 'Right margin (mm)', get: (c) => c.page.margin_mm.right, min: 5, max: 40 },
  { label: 'Plain-paper reserve top (mm)', get: (c) => c.letterhead.plain_reserve_top_mm, min: 0, max: 80 }, { label: 'Plain-paper reserve bottom (mm)', get: (c) => c.letterhead.plain_reserve_bottom_mm, min: 0, max: 80 },
  { label: 'Maximum signatories', get: (c) => c.signatories.max, min: 1, max: 4 }, { label: 'QR size (mm)', get: (c) => c.qr.size_mm, min: 15, max: 35 },
  { label: 'Watermark opacity', get: (c) => c.watermark.opacity, min: 0.05, max: 0.3, step: 0.01 }, { label: 'Base size (pt)', get: (c) => c.fonts.base_pt, min: 7, max: 11 },
];

export function TemplateEditor({ template, permissions }: { template: TemplateDetail; permissions: readonly string[] }) {
  const router = useRouter();
  const toast = useToast();
  const canManage = hasPerm(permissions, 'reporting.template.manage');
  const [cfg, setCfg] = useState<TemplateConfig>(() => structuredClone(template.draft.config));
  const [draftVersion, setDraftVersion] = useState(template.draft.version);
  const [tplVersion, setTplVersion] = useState(template.version);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [publishing, setPublishing] = useState(false);
  const [preview, setPreview] = useState<{ id: string; state: string } | null>(null);
  const [ticks, setTicks] = useState(0);
  const inFlight = useRef(false);
  const set = (fn: (c: TemplateConfig) => void) => { setCfg((c) => { const n = structuredClone(c); fn(n); return n; }); setDirty(true); setError(undefined); };
  const ro = !canManage;
  const num = (r: (typeof RANGES)[number], put: (c: TemplateConfig, v: number) => void) => (
    <NumberInput key={r.label} label={r.label} name={r.label} min={r.min} max={r.max} {...(r.step ? { step: r.step } : {})} value={r.get(cfg)} isReadOnly={ro} onChange={(v) => set((c) => put(c, v as number))} />
  );
  const R = (label: string) => RANGES.find((r) => r.label === label)!;

  useEffect(() => {
    if (!preview || preview.state === 'ready' || preview.state === 'failed' || ticks >= POLL_MAX) return;
    const t = setTimeout(async () => {
      const r = await getPrintAction(preview.id);
      if (r.ok) setPreview({ id: preview.id, state: r.data.state });
      setTicks((n) => n + 1);
    }, POLL_MS);
    return () => clearTimeout(t);
  }, [preview, ticks]);

  const guarded = async (f: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(undefined);
    try { await f(); } finally { inFlight.current = false; setBusy(false); }
  };
  const save = async (): Promise<boolean> => {
    const bad = RANGES.find((r) => rangeError(r.label, r.get(cfg), r.min, r.max, r.step));
    if (bad) { setError(`${bad.label} must be between ${bad.min} and ${bad.max}`); return false; }
    const r = await saveTemplateDraftAction(template.id, draftVersion, cfg, newKey());
    if (!r.ok) { setError(errorText(r.code)); return false; }
    setDraftVersion(r.data.draft.version); setTplVersion(r.data.version); setDirty(false);
    toast.show({ tone: 'success', title: 'Draft saved.' });
    return true;
  };
  const doPreview = () => guarded(async () => {
    const r = await previewTemplateAction(template.id, newKey());
    if (r.ok) { setPreview(r.data); setTicks(0); } else setError(errorText(r.code));
  });
  const publish = () => guarded(async () => {
    if (dirty && !(await save())) { setPublishing(false); return; }
    const r = await publishTemplateAction(template.id, tplVersion, newKey());
    setPublishing(false);
    if (r.ok) { toast.show({ tone: 'success', title: 'Template published.' }); router.refresh(); } else setError(errorText(r.code));
  });

  return (
    <section aria-label="Report template">
      <PageHeader
        title={template.name} helpKey="reporting.template" status={<Chip status={template.is_active ? 'active' : 'cancelled'} label={template.is_active ? 'Active' : 'Inactive'} />}
        breadcrumbs={[{ label: 'Templates', href: '/reporting/templates' }, { label: template.name }]}
      />
      {error ? <p role="alert" className="lims-error">{error}</p> : null}
      {preview ? (
        <p role="status">
          {preview.state === 'ready' ? <>Preview ready. <a className="lims-link" href={`/reporting/prints/${preview.id}/pdf`}>Open the preview PDF</a></> : preview.state === 'failed' ? 'The preview could not be prepared.' : 'Preparing preview…'}
        </p>
      ) : null}

      <div className="lims-card">
        <h2>Page</h2>
        <NativeSelect label="Page size" value={cfg.page.size} onChange={(v) => set((c) => { c.page.size = v; })} options={[{ value: 'A4', label: 'A4' }, { value: 'Letter', label: 'Letter' }]} placeholder="Choose a size" />
        {num(R('Top margin (mm)'), (c, v) => { c.page.margin_mm.top = v; })}{num(R('Bottom margin (mm)'), (c, v) => { c.page.margin_mm.bottom = v; })}
        {num(R('Left margin (mm)'), (c, v) => { c.page.margin_mm.left = v; })}{num(R('Right margin (mm)'), (c, v) => { c.page.margin_mm.right = v; })}
      </div>
      <div className="lims-card">
        <h2>Letterhead</h2>
        <NativeSelect label="Header image" value={cfg.letterhead.header_asset} onChange={(v) => set((c) => { c.letterhead.header_asset = v; })} options={[{ value: 'branding', label: 'Lab branding' }, { value: 'none', label: 'None' }]} placeholder="Choose" />
        <NativeSelect label="Footer image" value={cfg.letterhead.footer_asset} onChange={(v) => set((c) => { c.letterhead.footer_asset = v; })} options={[{ value: 'branding', label: 'Lab branding' }, { value: 'none', label: 'None' }]} placeholder="Choose" />
        {num(R('Plain-paper reserve top (mm)'), (c, v) => { c.letterhead.plain_reserve_top_mm = v; })}{num(R('Plain-paper reserve bottom (mm)'), (c, v) => { c.letterhead.plain_reserve_bottom_mm = v; })}
        <TextField label="Extra contact line" name="contact_strip_extra" maxLength={300} value={cfg.contact_strip_extra ?? ''} isReadOnly={ro} onChange={(v) => set((c) => { if (v) c.contact_strip_extra = v; else delete c.contact_strip_extra; })} />
      </div>
      <div className="lims-card">
        <h2>Header fields</h2>
        <fieldset className="lims-fieldset">
          <legend>Fields shown above the results</legend>
          {HEADER_FIELDS.map((k) => (
            <Checkbox key={k} label={humanize(k)} isDisabled={ro} isSelected={cfg.header_fields.includes(k)} onChange={(on) => set((c) => { c.header_fields = on ? [...c.header_fields, k] : c.header_fields.filter((x) => x !== k); })} />
          ))}
        </fieldset>
      </div>
      <div className="lims-card">
        <h2>Results</h2>
        {([['show_method_line', 'Show the method line'], ['show_units_column', 'Show the units column'], ['group_by_package', 'Group results by package'], ['page_break_before_department', 'Start each department on a new page'], ['show_department_approved_by', 'Show who approved each department']] as const).map(([k, label]) => (
          <Switch key={k} label={label} isDisabled={ro} isSelected={cfg.results[k]} onChange={(v) => set((c) => { c.results[k] = v; })} />
        ))}
      </div>
      <div className="lims-card">
        <h2>Signatories</h2>
        <NativeSelect label="Signatory source" value={cfg.signatories.mode} onChange={(v) => set((c) => { c.signatories.mode = v; })} options={[{ value: 'approvers', label: 'Approvers of the results' }, { value: 'nominated', label: 'Nominated signatories' }]} placeholder="Choose" />
        {num(R('Maximum signatories'), (c, v) => { c.signatories.max = v; })}
        <Switch label="Show signature images" isDisabled={ro} isSelected={cfg.signatories.show_signature_images} onChange={(v) => set((c) => { c.signatories.show_signature_images = v; })} />
        <TextField label="Registration label" name="label_registration" maxLength={20} value={cfg.signatories.label_registration} isReadOnly={ro} onChange={(v) => set((c) => { c.signatories.label_registration = v; })} />
      </div>
      <div className="lims-card">
        <h2>QR code</h2>
        <Switch label="Print a QR code" isDisabled={ro} isSelected={cfg.qr.enabled} onChange={(v) => set((c) => { c.qr.enabled = v; })} />
        {num(R('QR size (mm)'), (c, v) => { c.qr.size_mm = v; })}
        <TextField label="QR caption" name="qr_caption" maxLength={60} value={cfg.qr.caption} isReadOnly={ro} onChange={(v) => set((c) => { c.qr.caption = v; })} />
      </div>
      <div className="lims-card">
        <h2>Watermark</h2>
        <TextField label="Watermark text" name="watermark_text" maxLength={40} value={cfg.watermark.text} isReadOnly={ro} onChange={(v) => set((c) => { c.watermark.text = v; })} />
        {num(R('Watermark opacity'), (c, v) => { c.watermark.opacity = v; })}
      </div>
      <div className="lims-card">
        <h2>Disclaimers</h2>
        {cfg.disclaimers.map((d, i) => (
          <div key={i} className="lims-inline-form">
            <TextField label={`Disclaimer ${i + 1}`} name={`disclaimer_${i}`} maxLength={200} value={d} isReadOnly={ro} onChange={(v) => set((c) => { c.disclaimers[i] = v; })} />
            {ro ? null : <Button size="sm" variant="ghost" onPress={() => set((c) => { c.disclaimers.splice(i, 1); })}>{`Remove line ${i + 1}`}</Button>}
          </div>
        ))}
        {!ro && cfg.disclaimers.length < MAX_DISCLAIMERS ? <Button size="sm" onPress={() => set((c) => { c.disclaimers.push(''); })}>Add a line</Button> : null}
      </div>
      <div className="lims-card">
        <h2>Fonts</h2>
        {num(R('Base size (pt)'), (c, v) => { c.fonts.base_pt = v; })}
      </div>

      {canManage ? (
        <div className="lims-action-bar">
          <Button isDisabled={busy} onPress={() => void doPreview()}>Preview with sample data</Button>
          <Button isLoading={busy} onPress={() => void guarded(async () => { await save(); })}>Save draft</Button>
          <Button variant="primary" isDisabled={busy} onPress={() => setPublishing(true)}>Publish</Button>
        </div>
      ) : null}
      <ConfirmDialog
        title="Publish template" body="Publish this template? New reports will use it. Reports already made keep their layout." confirmLabel="Publish" isOpen={publishing}
        onCancel={() => setPublishing(false)} onConfirm={publish}
      />
    </section>
  );
}
