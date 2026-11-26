'use client';
// PL-2 Provision tenant (AC-E1.1, AC-E1.2): single page with sections; one Idempotency-Key per form; result checklist.
import { useRef, useState, type FormEvent } from 'react';
import { Button } from '@lims/ui/components/Button';
import { provisionTenantAction, uploadTenantLogoAction } from './actions';
import { ACCEPT_MAX, EMAIL_RE, LOGO_MAX_BYTES, LOGO_TYPES, PAN_RE, TENANT_CODE_RE, UNIT_CODE_RE, errorText } from './shared';
import { Alert, SelectInput, TextInput, newKey, useSingleFlight } from './ui';

const EMPTY = {
  code: '', legal_name: '', display_name: '', pan: '', calendar_display: 'AD_BS',
  branch_code: '', branch_name: '', branch_address: '', centre_code: '', centre_name: '', centre_kind: 'own', centre_address: '',
  admin_email: '', admin_name: '',
  tos_version: '', dpa_version: '', accepted_by_name: '', accepted_by_title: '', accepted_at: '',
};
// datetime-local wants local wall time without zone: YYYY-MM-DDTHH:mm
const localNow = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
type Values = typeof EMPTY;
type Errors = Partial<Record<keyof Values | 'form' | 'logo', string>>;
// CR TENANT-LOGO-1: the lab's own logo, optional. Same limits as the API (which re-checks, re-encodes and scans the image).
const LOGO_ERROR = 'Logo must be a PNG or JPEG image of at most 2 MB.';
const logoOk = (f: File | undefined) => !f || ((LOGO_TYPES as readonly string[]).includes(f.type) && f.size > 0 && f.size <= LOGO_MAX_BYTES);

function validate(v: Values, logo?: File): Errors {
  const e: Errors = {};
  if (!logoOk(logo)) e.logo = LOGO_ERROR;
  if (!TENANT_CODE_RE.test(v.code)) e.code = 'Tenant code: 3–32 characters, lowercase letters, digits or _, starting with a letter.';
  if (!v.legal_name.trim()) e.legal_name = 'Enter the legal name.';
  if (!v.display_name.trim()) e.display_name = 'Enter the display name.';
  if (v.pan && !PAN_RE.test(v.pan)) e.pan = 'PAN must be 9 digits.';
  if (!UNIT_CODE_RE.test(v.branch_code)) e.branch_code = 'Branch code: 1–16 letters, digits or -.';
  if (!v.branch_name.trim()) e.branch_name = 'Enter the branch name.';
  if (!UNIT_CODE_RE.test(v.centre_code)) e.centre_code = 'Centre code: 1–16 letters, digits or -.';
  if (!v.centre_name.trim()) e.centre_name = 'Enter the centre name.';
  if (!EMAIL_RE.test(v.admin_email)) e.admin_email = 'Enter a valid email address.';
  if (!v.admin_name.trim()) e.admin_name = 'Enter the administrator name.';
  // LD-29 / LD-275: limits equal the service validator accInput (maxLength on the inputs)
  if (!v.tos_version.trim()) e.tos_version = 'Enter the ToS version.';
  if (!v.dpa_version.trim()) e.dpa_version = 'Enter the DPA version.';
  if (!v.accepted_by_name.trim()) e.accepted_by_name = 'Enter the name of the person who accepted.';
  if (!v.accepted_by_title.trim()) e.accepted_by_title = 'Enter the title of the person who accepted.';
  if (Number.isNaN(new Date(v.accepted_at).getTime())) e.accepted_at = 'Enter the date and time of acceptance.';
  return e;
}

const CHECKLIST = ['Tenant', 'First branch', 'First centre', 'Roles', 'Settings', 'Feature flags', 'IRD annex records', 'First administrator'];

export function ProvisionForm() {
  const [v, setV] = useState(() => ({ ...EMPTY, accepted_at: localNow() }));
  const [errors, setErrors] = useState<Errors>({});
  const [done, setDone] = useState<{ tenantId: string; code: string }>();
  const [logo, setLogo] = useState<File>();
  // 'saved' | an error text; undefined = no logo chosen or upload not finished
  const [logoState, setLogoState] = useState<string>();
  const key = useRef(newKey());
  const { run, pending } = useSingleFlight();
  const set = (k: keyof Values) => (x: string) => setV((p) => ({ ...p, [k]: x }));

  // The tenant exists before its logo can be stored under it, so the logo goes up as a second request for that tenant id only.
  // A failed upload never undoes the tenant: the result panel says so and offers the upload again.
  const sendLogo = async (tenantId: string, file: File) => {
    const form = new FormData();
    form.set('file', file);
    const r = await uploadTenantLogoAction(tenantId, form, newKey());
    setLogoState(r.ok ? 'saved' : `Logo not saved. ${r.code === 'common.payload_too_large' || r.code === 'common.unsupported_media_type' ? LOGO_ERROR : errorText(r)}`);
  };

  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    void run(async () => {
      const e = validate(v, logo);
      setErrors(e);
      if (Object.keys(e).length) return;
      // one acceptor and one instant (UTC) for both documents; the operator types the versions
      const acceptor = { accepted_by_name: v.accepted_by_name.trim(), accepted_by_title: v.accepted_by_title.trim(), accepted_at: new Date(v.accepted_at).toISOString() };
      const r = await provisionTenantAction({
        code: v.code, legal_name: v.legal_name.trim(), display_name: v.display_name.trim(),
        ...(v.pan ? { pan: v.pan } : {}), calendar_display: v.calendar_display,
        first_branch: { code: v.branch_code, name: v.branch_name.trim(), ...(v.branch_address.trim() ? { address_text: v.branch_address.trim() } : {}) },
        first_centre: { code: v.centre_code, name: v.centre_name.trim(), kind: v.centre_kind, ...(v.centre_address.trim() ? { address_text: v.centre_address.trim() } : {}) },
        first_admin: { email: v.admin_email.trim(), display_name: v.admin_name.trim() },
        contract_acceptance: { tos: { ...acceptor, version: v.tos_version.trim() }, dpa: { ...acceptor, version: v.dpa_version.trim() } },
      }, key.current);
      if (r.ok) {
        if (logo) await sendLogo(r.data.tenant_id, logo);
        setDone({ tenantId: r.data.tenant_id, code: r.data.code });
        return;
      }
      if (r.code === 'identity.code_duplicate') setErrors({ code: errorText(r) });
      else setErrors({ form: `${errorText(r)}${r.requestId ? ` Reference: ${r.requestId}` : ''}` });
      // a refused request is final; the corrected form is a new operation (a same-key retry with a new body would be refused)
      if (r.status < 500) key.current = newKey();
    });
  };

  if (done) {
    return (
      <section aria-labelledby="pl2-done">
        <h2 id="pl2-done">Tenant {done.code} provisioned</h2>
        <ul className="lims-checklist">
          {CHECKLIST.map((c) => <li key={c}><span aria-hidden="true">✓ </span>{c} created</li>)}
        </ul>
        <p role="status">Invitation sent</p>
        {logo && logoState === 'saved' ? <p role="status">Logo saved</p> : null}
        {logo && logoState && logoState !== 'saved' ? (
          <>
            <Alert>{logoState}</Alert>
            <Button type="button" isLoading={pending} onPress={() => void run(() => sendLogo(done.tenantId, logo))}>Upload logo again</Button>
          </>
        ) : null}
        <a href={`/platform/tenants/${done.tenantId}`}>Open tenant</a>
      </section>
    );
  }

  return (
    <form onSubmit={submit} noValidate aria-label="Provision tenant">
      <fieldset>
        <legend><h2>Tenant</h2></legend>
        <TextInput label="Tenant code" value={v.code} onChange={set('code')} maxLength={32} error={errors.code} required hint="Lowercase letters, digits and _; cannot be changed later." />
        <TextInput label="Legal name" value={v.legal_name} onChange={set('legal_name')} maxLength={200} error={errors.legal_name} required />
        <TextInput label="Display name" value={v.display_name} onChange={set('display_name')} maxLength={120} error={errors.display_name} required />
        <TextInput label="PAN (optional)" value={v.pan} onChange={set('pan')} maxLength={9} error={errors.pan} />
        <p className="lims-field">Timezone: <span>Asia/Kathmandu</span></p>
        <SelectInput label="Calendar display" value={v.calendar_display} onChange={set('calendar_display')}
          options={[{ value: 'AD_BS', label: 'AD (BS)' }, { value: 'BS_AD', label: 'BS (AD)' }, { value: 'AD', label: 'AD only' }, { value: 'BS', label: 'BS only' }]} />
        <div className="lims-field">
          <label className="lims-label" htmlFor="pl2-logo">Lab logo (optional)</label>
          <input id="pl2-logo" type="file" accept="image/png,image/jpeg,.png,.jpg,.jpeg" aria-describedby="pl2-logo-h"
            aria-invalid={errors.logo ? true : undefined}
            onChange={(e) => { const f = e.target.files?.[0]; setLogo(f); setErrors(({ logo: _old, ...rest }) => (logoOk(f) ? rest : { ...rest, logo: LOGO_ERROR })); }} />
          <p id="pl2-logo-h" className="lims-description">PNG or JPEG, up to 2 MB. Shown to this lab&apos;s staff in place of the default logo. The lab can change it later in Settings.</p>
          <Alert>{errors.logo}</Alert>
        </div>
      </fieldset>
      <fieldset>
        <legend><h2>First branch</h2></legend>
        <TextInput label="Branch code" value={v.branch_code} onChange={set('branch_code')} maxLength={16} error={errors.branch_code} required />
        <TextInput label="Branch name" value={v.branch_name} onChange={set('branch_name')} maxLength={120} error={errors.branch_name} required />
        <TextInput label="Branch address" value={v.branch_address} onChange={set('branch_address')} maxLength={300} />
      </fieldset>
      <fieldset>
        <legend><h2>First centre</h2></legend>
        <TextInput label="Centre code" value={v.centre_code} onChange={set('centre_code')} maxLength={16} error={errors.centre_code} required />
        <TextInput label="Centre name" value={v.centre_name} onChange={set('centre_name')} maxLength={120} error={errors.centre_name} required />
        <SelectInput label="Centre type" value={v.centre_kind} onChange={set('centre_kind')}
          options={[{ value: 'own', label: 'Own' }, { value: 'franchise', label: 'Franchise' }, { value: 'home_collection', label: 'Home collection' }]} />
        <TextInput label="Centre address" value={v.centre_address} onChange={set('centre_address')} maxLength={300} />
      </fieldset>
      <fieldset>
        <legend><h2>First administrator</h2></legend>
        <TextInput label="Administrator email" type="email" value={v.admin_email} onChange={set('admin_email')} maxLength={254} error={errors.admin_email} required />
        <TextInput label="Administrator full name" value={v.admin_name} onChange={set('admin_name')} maxLength={120} error={errors.admin_name} required />
      </fieldset>
      <fieldset>
        <legend><h2>Contract acceptance</h2></legend>
        <TextInput label="ToS version" value={v.tos_version} onChange={set('tos_version')} maxLength={ACCEPT_MAX.version} error={errors.tos_version} required />
        <TextInput label="DPA version" value={v.dpa_version} onChange={set('dpa_version')} maxLength={ACCEPT_MAX.version} error={errors.dpa_version} required />
        <TextInput label="Accepted by (name)" value={v.accepted_by_name} onChange={set('accepted_by_name')} maxLength={ACCEPT_MAX.name} error={errors.accepted_by_name} required />
        <TextInput label="Accepted by (title)" value={v.accepted_by_title} onChange={set('accepted_by_title')} maxLength={ACCEPT_MAX.title} error={errors.accepted_by_title} required />
        <TextInput label="Accepted at" type="datetime-local" value={v.accepted_at} onChange={set('accepted_at')} error={errors.accepted_at} required hint="Your local time; sent as UTC. One acceptor and time for both documents." />
      </fieldset>
      <Alert>{errors.form}</Alert>
      <Button type="submit" variant="primary" isLoading={pending}>Provision tenant</Button>
    </form>
  );
}
