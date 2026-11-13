'use client';
// AD-8 Lab settings (US-C2..C5): one form per tab, each save PATCHes only that tab's fields with If-Match of the latest version.
// Ranges/patterns per 04-UI-UX §6 AD-8 (tighter than the API's), server pointers land on the field (AC-C2), flags via setTenantFeatureFlag.
import { useRef, useState, type ReactNode } from 'react';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { Switch } from '@lims/ui/components/Switch';
import { useToast } from '@lims/ui/components/Toast';
import { setFeatureFlag, updateSettings, uploadBrandingAsset } from '../actions';
import { Grid } from '../Grid';
import { Alert, Field, Radios, Tabs, focusFirstInvalid, useFailure } from '../ui';
import { EMAIL_RE, SAVED_COPY, copyFor, fmt } from '../lib';

type Settings = Record<string, unknown> & { version: number };
export interface Flag { code: string; description?: string; scope: string; settable_by: string; is_enabled: boolean; blocker_ref?: string; version?: number }
export interface Annex { record_id: string; annex_code: string; status: string; reference_no?: string; submitted_on?: string; completed_on?: string }

type Kind = 'text' | 'int' | 'email' | 'radio' | 'switch' | 'select' | 'lines' | 'npr';
interface Spec { key: string; label: string; kind: Kind; options?: Array<[string, string]>; min?: number; max?: number; maxLength?: number; pattern?: RegExp; patternMsg?: string; required?: boolean; hint?: string; disabled?: boolean; dflt?: string | boolean; items?: number }

const PREFIX4 = { pattern: /^[A-Z0-9]{0,4}$/, patternMsg: 'Use up to 4 capital letters or digits', maxLength: 4 };
const pat = (key: string, label: string): Spec => ({ key, label, kind: 'text', maxLength: 40, hint: 'Example: ' });
const TABS: Record<string, Spec[]> = {
  General: [
    { key: 'display_name', label: 'Display name', kind: 'text', required: true, maxLength: 120 },
    { key: 'address_lines', label: 'Address (one line each, up to 4)', kind: 'lines', items: 4, maxLength: 120 },
    { key: 'phones', label: 'Phones (one per line, up to 3)', kind: 'lines', items: 3, maxLength: 40 },
    { key: 'contact_email', label: 'Contact email', kind: 'email', maxLength: 254 },
    { key: 'website', label: 'Website', kind: 'text', maxLength: 200, pattern: /^https:\/\/\S+$/, patternMsg: 'Use an https:// address', hint: 'https://…' },
    { key: 'receipt_footer_note', label: 'Receipt footer note', kind: 'text', maxLength: 200 },
    { key: 'accent_color', label: 'Accent colour', kind: 'text', maxLength: 7, pattern: /^#[0-9A-Fa-f]{6}$/, patternMsg: 'Use #RRGGBB, e.g. #1F6FEB', hint: '#RRGGBB' },
  ],
  'Date & time': [{ key: 'calendar_display', label: 'Calendar display', kind: 'radio', options: [['AD', 'A.D.'], ['BS', 'B.S.'], ['AD_BS', 'A.D. + B.S.'], ['BS_AD', 'B.S. + A.D.']], dflt: 'AD' }],
  'Sign-in & sessions': [
    { key: 'idle_timeout_minutes', label: 'Idle timeout (minutes)', kind: 'int', min: 15, max: 30 },
    { key: 'absolute_session_hours', label: 'Maximum session length (hours)', kind: 'int', min: 1, max: 12 },
    { key: 'password_min_length', label: 'Minimum password length', kind: 'int', min: 12, max: 64 },
    { key: 'support_access_mode', label: 'Support access', kind: 'radio', options: [['notify', 'Notify me'], ['approval_required', 'Require my approval']], dflt: 'notify' },
  ],
  Numbering: [
    { key: 'numbering_prefix', label: 'Prefix', kind: 'text', maxLength: 8, pattern: /^[A-Z0-9]{0,8}$/, patternMsg: 'Use up to 8 capital letters or digits' },
    pat('patient_code_pattern', 'Patient code pattern'), pat('registration_no_pattern', 'Registration no. pattern'), pat('barcode_pattern', 'Barcode pattern'),
    pat('invoice_no_pattern', 'Invoice no. pattern'), pat('credit_note_no_pattern', 'Credit note no. pattern'), pat('receipt_no_pattern', 'Receipt no. pattern'),
    { key: 'barcode_prefix', label: 'Barcode prefix', kind: 'text', ...PREFIX4 },
    pat('accession_no_pattern', 'Accession no. pattern'),
    { key: 'accession_prefix_histology', label: 'Accession prefix — Histology', kind: 'text', ...PREFIX4, dflt: 'S' },
    { key: 'accession_prefix_cytology', label: 'Accession prefix — Cytology', kind: 'text', ...PREFIX4, dflt: 'C' },
    { key: 'accession_prefix_ihc', label: 'Accession prefix — IHC', kind: 'text', ...PREFIX4, dflt: 'I' },
    { key: 'accession_prefix_molecular', label: 'Accession prefix — Molecular', kind: 'text', ...PREFIX4, dflt: 'M' },
  ],
  'Letterhead & branding': [{ key: 'letterhead_default', label: 'Default for reports and receipts', kind: 'radio', options: [['with', 'With letterhead'], ['without', 'Without']], dflt: 'with' }],
  'Reports & delivery': [
    { key: 'release_requires_payment', label: 'Hold reports until paid', kind: 'switch', dflt: true },
    { key: 'partial_release_allowed', label: 'Allow partial release', kind: 'switch', dflt: false },
    { key: 'report_link_ttl_days', label: 'Report link validity (days)', kind: 'int', min: 30, max: 90 },
    { key: 'sms_enabled', label: 'SMS', kind: 'switch', dflt: false },
    { key: 'whatsapp_enabled', label: 'WhatsApp', kind: 'switch', dflt: false },
    { key: 'email_enabled', label: 'Email', kind: 'switch', dflt: false },
    { key: 'sms_sender_id', label: 'SMS sender ID', kind: 'text', maxLength: 11, pattern: /^[A-Za-z0-9]{1,11}$/, patternMsg: 'Use 1–11 letters or digits', hint: 'Provider rules may be stricter.' },
  ],
  'Data retention': [
    { key: 'retention_clinical_years', label: 'Clinical records (years)', kind: 'int', min: 5, max: 100 },
    { key: 'retention_audit_years', label: 'Audit logs (years)', kind: 'int', min: 5, max: 100 },
    { key: 'retention_raw_instrument_years', label: 'Raw analyser messages (years)', kind: 'int', min: 1, max: 100 },
  ],
  'Billing & IRD': [
    { key: 'cbms_realtime_required', label: 'CBMS real-time push required', kind: 'switch', dflt: false, hint: 'Only taxpayers designated by IRD notice.' },
    { key: 'abbreviated_invoice_limit_paisa', label: 'Abbreviated invoice limit (NPR) — UNVERIFIED — confirm with your auditor', kind: 'npr' },
  ],
  'Lab operations': [
    { key: 'auto_verification_enabled', label: 'Auto-verification', kind: 'switch', dflt: false, disabled: true, hint: 'Available in Phase 2' },
    { key: 'westgard_mode', label: 'Westgard mode', kind: 'select', options: [['classic', 'Classic'], ['modern', 'Modern']], dflt: 'classic', hint: 'Default pending QC module design.' },
  ],
};
const TAB_NAMES = ['General', 'Date & time', 'Sign-in & sessions', 'Numbering', 'Letterhead & branding', 'Reports & delivery', 'Data retention', 'Features', 'Billing & IRD', 'Lab operations'];
const ASSETS: Array<[string, string]> = [['logo', 'Logo'], ['letterhead_header', 'Letterhead header'], ['letterhead_footer', 'Letterhead footer']];
const ASSET_MAX = 2 * 1024 * 1024;

/** Synthetic example of a numbering pattern (04-UI-UX AD-8 "live example"). */
export function example(p: string, prefix: string) {
  return p
    .replace(/\{branch\}/g, 'KTM').replace(/\{centre\}/g, 'C01').replace(/\{yy\}/g, '26').replace(/\{fyl\}/g, '2083-84').replace(/\{fy\}/g, '8384')
    .replace(/\{prefix\}/g, prefix).replace(/\{seq:(\d{1,2})\}/g, (_, n: string) => '1'.padStart(Number(n), '0'));
}

type Vals = Record<string, string | boolean>;
const toVal = (s: Spec, v: unknown): string | boolean => {
  if (s.kind === 'switch') return typeof v === 'boolean' ? v : Boolean(s.dflt);
  if (s.kind === 'lines') return Array.isArray(v) ? v.join('\n') : '';
  if (s.kind === 'npr') return typeof v === 'number' ? String(v / 100) : '';
  return v === undefined || v === null ? String(s.dflt ?? '') : String(v);
};

export function SettingsScreen({ settings: initial, flags, annexes }: { settings: Settings; flags: Flag[] | null; annexes: Annex[] | null }) {
  const [settings, setSettings] = useState(initial);
  const [tab, setTab] = useState('General');
  return (
    <main className="lims-page">
      <header className="lims-page-header"><h1>Lab settings</h1></header>
      <Tabs items={TAB_NAMES} selected={tab} onChange={setTab} label="Settings sections">
        {tab === 'Features' ? <FlagsTab flags={flags} /> : <TabForm key={tab} tab={tab} settings={settings} onSaved={setSettings} annexes={annexes} />}
      </Tabs>
    </main>
  );
}

function TabForm({ tab, settings, onSaved, annexes }: { tab: string; settings: Settings; onSaved: (s: Settings) => void; annexes: Annex[] | null }) {
  const toast = useToast();
  const specs = TABS[tab] ?? [];
  const root = useRef<HTMLDivElement>(null);
  const [vals, setVals] = useState<Vals>(() => Object.fromEntries(specs.map((s) => [s.key, toVal(s, settings[s.key])])));
  const [assets, setAssets] = useState<Record<string, { id: string; pending: boolean }>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const failure = useFailure();
  const set = (k: string) => (v: string | boolean) => setVals((x) => ({ ...x, [k]: v }));
  const allErrors = { ...failure.fieldErrors, ...errors };

  const validate = () => {
    const e: Record<string, string> = {};
    for (const s of specs) {
      const v = vals[s.key];
      if (typeof v !== 'string' || s.disabled) continue;
      const t = v.trim();
      if (s.required && !t) e[s.key] = `${s.label} is required`;
      else if (s.kind === 'int' && (!/^\d+$/.test(t) || Number(t) < s.min! || Number(t) > s.max!)) e[s.key] = `Enter a whole number from ${s.min} to ${s.max}`;
      else if (s.kind === 'npr' && t && !/^\d+(\.\d{1,2})?$/.test(t)) e[s.key] = 'Enter an amount in NPR, e.g. 10000';
      else if (s.kind === 'email' && t && !EMAIL_RE.test(t)) e[s.key] = 'Enter a valid email address';
      else if (s.kind === 'lines' && (t.split('\n').filter((l) => l.trim()).length > s.items! || t.split('\n').some((l) => l.trim().length > s.maxLength!))) e[s.key] = `Up to ${s.items} lines of ${s.maxLength} characters`;
      else if (s.kind !== 'lines' && s.maxLength !== undefined && t.length > s.maxLength) e[s.key] = `Use ${s.maxLength} characters or fewer`;
      else if (t && s.pattern && !s.pattern.test(t)) e[s.key] = s.patternMsg ?? 'Invalid value';
    }
    return e;
  };

  const save = async () => {
    if (busy) return;
    const e = validate();
    setErrors(e);
    failure.clear();
    if (Object.keys(e).length) { focusFirstInvalid(root.current); return; }
    const patch: Record<string, unknown> = {};
    const unset: string[] = [];
    for (const s of specs) {
      if (s.disabled) continue;
      const v = vals[s.key]!;
      if (typeof v === 'boolean') { patch[s.key] = v; continue; }
      const t = v.trim();
      if (!t) { if (settings[s.key] !== undefined && settings[s.key] !== '') unset.push(s.key); continue; }
      patch[s.key] = s.kind === 'int' ? Number(t) : s.kind === 'npr' ? Math.round(Number(t) * 100) : s.kind === 'lines' ? t.split('\n').map((l) => l.trim()).filter(Boolean) : t;
    }
    for (const [kind, a] of Object.entries(assets)) patch[`${kind}_asset_id`] = a.id;
    if (unset.length) patch['unset'] = unset;
    setBusy(true);
    const r = await updateSettings(settings.version, patch);
    setBusy(false);
    if (!r.ok) { failure.set(r); if (r.pointers.length) focusFirstInvalid(root.current); return; }
    onSaved(r.data);
    toast.show({ tone: 'success', title: SAVED_COPY });
  };

  const upload = async (kind: string, f: File | undefined) => {
    setErrors((x) => { const { [kind]: _drop, ...rest } = x; return rest; });
    if (!f) return;
    if (!['image/png', 'image/jpeg'].includes(f.type)) { setErrors((x) => ({ ...x, [kind]: 'Use a PNG or JPEG image.' })); return; }
    if (f.size > ASSET_MAX) { setErrors((x) => ({ ...x, [kind]: 'The image must be 2 MB or smaller.' })); return; }
    const form = new FormData();
    form.set('file', f, f.name);
    form.set('kind', kind);
    const r = await uploadBrandingAsset(form);
    if (!r.ok) { setErrors((x) => ({ ...x, [kind]: copyFor(r.code) })); return; }
    setAssets((x) => ({ ...x, [kind]: { id: r.data.asset_id, pending: r.data.scan_state === 'pending' } }));
  };

  const field = (s: Spec): ReactNode => {
    const v = vals[s.key]!;
    const err = allErrors[s.key];
    if (s.kind === 'switch') return (
      <div key={s.key} className="lims-field">
        <Switch label={s.label} isSelected={v as boolean} onChange={set(s.key)} isDisabled={!!s.disabled} />
        {s.hint ? <p className="lims-description">{s.hint}</p> : null}
      </div>
    );
    if (s.kind === 'radio') return <Radios key={s.key} legend={s.label} name={s.key} value={v as string} onChange={set(s.key)} options={s.options!.map(([value, label]) => ({ value, label }))} />;
    if (s.kind === 'select') return (
      <div key={s.key} className="lims-field">
        <label htmlFor={`set-${s.key}`} className="lims-label">{s.label}</label>
        <select id={`set-${s.key}`} className="lims-input" value={v as string} onChange={(e) => set(s.key)(e.target.value)} aria-describedby={`set-${s.key}-hint`}>
          {s.options!.map(([o, l]) => <option key={o} value={o}>{l}</option>)}
        </select>
        <p id={`set-${s.key}-hint`} className="lims-description">{s.hint}</p>
      </div>
    );
    const hint = s.hint === 'Example: ' ? `Example: ${(v as string) ? example(v as string, String(vals['numbering_prefix'] ?? settings['numbering_prefix'] ?? '')) : '—'}` : s.hint;
    return <Field key={s.key} id={`set-${s.key}`} label={s.label} value={v as string} onChange={set(s.key)} error={err} hint={hint} multiline={s.kind === 'lines'}
      {...(s.maxLength !== undefined && s.kind !== 'lines' ? { maxLength: s.maxLength } : {})} {...(s.kind === 'int' ? { inputMode: 'numeric' as const } : {})} />;
  };

  const pending = settings['pending_numbering'] as { invoice_no_pattern?: string; credit_note_no_pattern?: string; effective_fy_bs?: string } | undefined;
  return (
    <div ref={root}>
      {failure.banner}
      {tab === 'General' ? (
        <>
          <Field label="Legal name" value={String(settings['legal_name_snapshot'] ?? '')} readOnly hint="Changed by the LIMS provider." />
          {settings['ird_pan'] ? <Field label="PAN" value={String(settings['ird_pan'])} readOnly /> : null}
        </>
      ) : null}
      {tab === 'Date & time' ? (
        <>
          <p>Timezone: Asia/Kathmandu</p>
          <p className="lims-description">Bills and statutory registers always show both B.S. and A.D.</p>
        </>
      ) : null}
      {tab === 'Numbering' ? (
        <>
          <p className="lims-description">Tokens: {'{branch} {centre} {yy} {fy} {fyl} {seq:N} {prefix}'}. Examples use synthetic values.</p>
          {pending ? (
            <Banner tone="info" title={`Takes effect from FY ${pending.effective_fy_bs ?? ''}`}>
              {pending.invoice_no_pattern ? <p>Invoice no. pattern: <code>{pending.invoice_no_pattern}</code></p> : null}
              {pending.credit_note_no_pattern ? <p>Credit note no. pattern: <code>{pending.credit_note_no_pattern}</code></p> : null}
            </Banner>
          ) : null}
        </>
      ) : null}
      {tab === 'Data retention' ? <Banner tone="warning" title="Legal retention periods are not yet confirmed (B15). These are minimum defaults." /> : null}
      {tab === 'Billing & IRD' ? <Banner tone="warning" title="IRD submission requirements are pending clarification (B6). This tracker records status only." /> : null}
      {specs.map(field)}
      {tab === 'Letterhead & branding' ? (
        <>
          {ASSETS.map(([kind, label]) => (
            <div key={kind} className="lims-field">
              <label htmlFor={`asset-${kind}`} className="lims-label">{label}</label>
              <input id={`asset-${kind}`} type="file" accept="image/png,image/jpeg" aria-describedby={`asset-${kind}-hint`} onChange={(e) => { void upload(kind, e.target.files?.[0]); e.target.value = ''; }} />
              <p id={`asset-${kind}-hint`} className="lims-description">PNG or JPEG, up to 2 MB and 4000 px. Saved with this tab.</p>
              {assets[kind]?.pending ? <p>Security scan in progress — the image is used once the scan has passed</p> : assets[kind] ? <p>Uploaded. Save to use it.</p> : null}
              {errors[kind] ? <Alert text={errors[kind]} /> : null}
            </div>
          ))}
          <p>Report layout, watermark and signature placement are set in Report templates.</p>
        </>
      ) : null}
      {tab === 'Billing & IRD' ? (
        annexes ? (
          <Grid label="IRD annexes" columns={['Annex', 'Status', 'Reference no.', 'Date']}
            rows={annexes.map((a) => ({ key: a.record_id, cells: [a.annex_code.replace('annex_', 'Annex '), a.status.replace(/_/g, ' '), a.reference_no ?? '—', fmt(a.completed_on ?? a.submitted_on)] }))} />
        ) : <Alert text="The IRD annex status could not be loaded." />
      ) : null}
      <Button variant="primary" onPress={() => void save()} isLoading={busy}>Save</Button>
      {failure.dialogs}
    </div>
  );
}

function FlagsTab({ flags: initial }: { flags: Flag[] | null }) {
  const toast = useToast();
  const [flags, setFlags] = useState(initial ?? []);
  const [err, setErr] = useState<{ text: string; requestId?: string | undefined } | null>(null);
  if (!initial) return <Alert text="Feature flags could not be loaded." />;
  const toggle = async (f: Flag, on: boolean) => {
    setErr(null);
    setFlags((xs) => xs.map((x) => (x.code === f.code ? { ...x, is_enabled: on } : x)));
    const r = await setFeatureFlag(f.code, f.version, on);
    if (r.ok) { setFlags((xs) => xs.map((x) => (x.code === f.code ? { ...x, ...r.data } : x))); toast.show({ tone: 'success', title: SAVED_COPY }); return; }
    setFlags((xs) => xs.map((x) => (x.code === f.code ? { ...x, is_enabled: f.is_enabled } : x)));
    setErr({ text: copyFor(r.code), requestId: r.requestId });
  };
  return (
    <>
      {err ? <Alert text={err.text} requestId={err.requestId} /> : null}
      <Grid label="Feature flags" columns={['Name', 'Description', 'Status', 'Blocker ref']}
        rows={flags.map((f) => ({
          key: f.code,
          cells: [
            <code key="c">{f.code}</code>,
            f.code === 'referral_incentive_report' ? 'Shows the referral-incentive report (reporting only). Leave off until your management confirms the compliance position (B13).' : (f.description ?? ''),
            <span key="s" {...(f.settable_by === 'platform' ? { title: 'Managed by the LIMS provider' } : {})}>
              <Switch label={f.description ?? f.code} isSelected={f.is_enabled} isDisabled={f.settable_by !== 'tenant'} onChange={(on) => void toggle(f, on)} />
              {f.settable_by === 'platform' ? <span className="lims-description"> Managed by the LIMS provider</span> : null}
            </span>,
            f.blocker_ref ?? '—',
          ],
        }))} />
    </>
  );
}
