'use client';
// PL-3 Tenant detail (AC-E1.3, AC-E2): Overview + lifecycle T2..T5, Settings, Feature flags, IRD annexes, Administrators, Support sessions.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { Dialog } from '@lims/ui/components/Dialog';
import { EmptyState } from '@lims/ui/components/EmptyState';
import { ErrorState } from '@lims/ui/components/ErrorState';
import { StatusChip } from '@lims/ui/components/StatusChip';
import { Tabs } from '@lims/ui/components/Tabs';
import { Timeline } from '@lims/ui/components/Timeline';
import { useToast } from '@lims/ui/components/Toast';
import {
  getTenantSettingsAction, inviteTenantAdminAction, listAnnexesAction, listTenantSupportSessionsAction, patchTenantSettingsAction,
  tenantLifecycleAction,
} from './actions';
import { IrdTracker } from './IrdTracker';
import {
  EMAIL_RE, TENANT_NEXT, errorText, scopeLabel, supportStatusLabel, tenantStatusLabel,
  type AnnexRecord, type Fail,type LifecycleAction, type Result, type Settings, type SupportSession, type TenantDetail as Detail,
} from './shared';
import { Alert, CheckboxInput, SelectInput, TextAreaInput, TextInput, fmtDateTime, newKey, useProblemDialogs, useSingleFlight } from './ui';

const TABS = [
  { id: 'overview', label: 'Overview' }, { id: 'settings', label: 'Settings' }, { id: 'flags', label: 'Feature flags' },
  { id: 'ird', label: 'IRD annexes' }, { id: 'admins', label: 'Administrators' }, { id: 'support', label: 'Support sessions' },
] as const;
const TONE = { active: 'success', suspended: 'warning', provisioning: 'info', offboarded: 'neutral' } as const;
const failText = (f: Fail) => `${errorText(f)}${f.requestId ? ` Reference: ${f.requestId}` : ''}`;

export function TenantDetailView({ tenant, canManage }: { tenant: Detail; canManage: boolean }) {
  const [tab, setTab] = useState<string>('overview');
  return (
    <>
      <h1>{tenant.display_name} <StatusChip kind="generic" status={tenant.status} tone={TONE[tenant.status] ?? 'neutral'} label={tenantStatusLabel(tenant.status)} /></h1>
      <p className="lims-muted">{tenant.code} · {tenant.legal_name}</p>
      <Tabs items={TABS} selectedId={tab} onChange={setTab} aria-label="Tenant sections">
        {tab === 'overview' ? <Overview tenant={tenant} canManage={canManage} /> : null}
        {tab === 'settings' ? <SettingsTab tenantId={tenant.tenant_id} canManage={canManage} /> : null}
        {tab === 'flags' ? <FlagsTab /> : null}
        {tab === 'ird' ? <IrdTab tenant={tenant} canManage={canManage} /> : null}
        {tab === 'admins' ? <AdminsTab tenantId={tenant.tenant_id} canManage={canManage} /> : null}
        {tab === 'support' ? <SupportTab tenantId={tenant.tenant_id} /> : null}
      </Tabs>
    </>
  );
}

/** Loads a tab's data through a server action once on mount. */
function useLoad<T>(load: () => Promise<Result<T>>) {
  const [state, setState] = useState<Result<T>>();
  const ref = useRef(load);
  useEffect(() => {
    let live = true;
    void ref.current().then((r) => { if (live) setState(r); });
    return () => { live = false; };
  }, []);
  return [state, setState] as const;
}

// ------------------------------------------------------------------ Overview + lifecycle
const BUTTON: Record<LifecycleAction, string> = { activate: 'Activate', suspend: 'Suspend', reactivate: 'Reactivate', terminate: 'Terminate' };

function Overview({ tenant, canManage }: { tenant: Detail; canManage: boolean }) {
  const router = useRouter();
  const { run, pending } = useSingleFlight();
  const { handle, dialogs } = useProblemDialogs();
  const [dialog, setDialog] = useState<LifecycleAction | null>(null);
  const [reason, setReason] = useState('');
  const [code, setCode] = useState('');
  const [dialogError, setDialogError] = useState<string>();
  const [error, setError] = useState<string>();
  const [notReady, setNotReady] = useState(false);

  const act = (action: LifecycleAction) => run(async () => {
    const extra: { reason_text?: string; confirm_code?: string } = {};
    if (action === 'suspend' || action === 'terminate') {
      if (!reason.trim()) return setDialogError('Enter a reason (up to 500 characters).');
      extra.reason_text = reason.trim();
    }
    if (action === 'terminate') {
      if (code !== tenant.code) return setDialogError(`Type the tenant code "${tenant.code}" exactly to confirm.`);
      extra.confirm_code = code;
    }
    setDialogError(undefined);
    const r = await tenantLifecycleAction(tenant.tenant_id, action, tenant.version, extra);
    if (r.ok) { setDialog(null); setError(undefined); setNotReady(false); router.refresh(); return; }
    if (r.code === 'identity.tenant_not_ready') { setDialog(null); setNotReady(true); return; }
    const inline = handle(r);
    if (inline === undefined) { setDialog(null); return; }
    if (dialog) setDialogError(inline); else setError(inline);
  });

  const openDialog = (d: LifecycleAction) => { setReason(''); setCode(''); setDialogError(undefined); setDialog(d); };
  const history = [...tenant.status_history].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));

  return (
    <div className="lims-stack">
      {notReady ? (
        <Banner tone="warning" title="Tenant not ready to activate">
          Activation needs an accepted tenant administrator, at least one active branch and at least one active centre.
        </Banner>
      ) : null}
      <dl className="lims-kv">
        <div><dt>Users</dt> <dd>{tenant.counts.users}</dd></div>
        <div><dt>Branches</dt> <dd>{tenant.counts.branches}</dd></div>
        <div><dt>Centres</dt> <dd>{tenant.counts.centres}</dd></div>
        <div><dt>IRD annex readiness</dt> <dd>{tenant.annex_readiness === 'complete' ? 'Complete' : tenant.annex_readiness === 'incomplete' ? 'Incomplete' : tenant.annex_readiness}</dd></div>
        <div><dt>Timezone</dt> <dd>{tenant.timezone}</dd></div>
        <div><dt>Created</dt> <dd>{fmtDateTime(tenant.created_at)}</dd></div>
        {tenant.status_reason ? <div><dt>Status reason</dt> <dd>{tenant.status_reason}</dd></div> : null}
      </dl>
      <h2>Status history</h2>
      <Timeline items={history.map((h) => ({ at: h.occurred_at, label: tenantStatusLabel(h.to_status) }))} />
      {canManage && TENANT_NEXT[tenant.status].length ? (
        <div className="lims-actions">
          {TENANT_NEXT[tenant.status].map((a) => (
            <Button key={a} variant={a === 'terminate' || a === 'suspend' ? 'danger' : 'primary'} isDisabled={pending}
              onPress={() => openDialog(a)}>{BUTTON[a]}</Button>
          ))}
        </div>
      ) : null}
      <Alert>{error}</Alert>
      {/* Every lifecycle action confirms first, so a fast 409/403 never races the confirm step. */}
      <Dialog title={dialog ? `${BUTTON[dialog]} tenant` : ''} isOpen={dialog !== null} onClose={() => setDialog(null)}
        footer={dialog ? <Button variant={dialog === 'terminate' || dialog === 'suspend' ? 'danger' : 'primary'} isLoading={pending} onPress={() => void act(dialog)}>{BUTTON[dialog]}</Button> : null}>
        {dialog === 'suspend' ? <p>All staff sessions of this tenant are signed out. Support sessions in read-only scope stay possible.</p> : null}
        {dialog === 'terminate' ? <p>Termination is final: the tenant is offboarded and cannot be reactivated.</p> : null}
        {dialog === 'suspend' || dialog === 'terminate' ? <TextAreaInput label="Reason" value={reason} onChange={setReason} maxLength={500} required /> : null}
        {dialog === 'terminate' ? <TextInput label="Type the tenant code to confirm" value={code} onChange={setCode} maxLength={32} required hint={`Tenant code: ${tenant.code}`} /> : null}
        <Alert>{dialogError}</Alert>
      </Dialog>
      {dialogs}
    </div>
  );
}

// ------------------------------------------------------------------ Settings
type Kind = 'int' | 'text' | 'bool' | 'enum';
const FIELDS: readonly { key: string; label: string; kind: Kind; max?: number; options?: readonly string[] }[] = [
  { key: 'display_name', label: 'Display name', kind: 'text', max: 120 },
  { key: 'ird_pan', label: 'IRD PAN', kind: 'text', max: 9 },
  { key: 'calendar_display', label: 'Calendar display', kind: 'enum', options: ['AD_BS', 'BS_AD', 'AD', 'BS'] },
  { key: 'idle_timeout_minutes', label: 'Idle timeout (minutes)', kind: 'int' },
  { key: 'absolute_session_hours', label: 'Absolute session length (hours)', kind: 'int' },
  { key: 'password_min_length', label: 'Minimum password length', kind: 'int' },
  { key: 'support_access_mode', label: 'Support access mode', kind: 'enum', options: ['notify', 'approval_required'] },
  { key: 'report_link_ttl_days', label: 'Report link validity (days)', kind: 'int' },
  { key: 'letterhead_default', label: 'Default letterhead', kind: 'enum', options: ['with', 'without'] },
  { key: 'numbering_prefix', label: 'Numbering prefix', kind: 'text', max: 8 },
  { key: 'release_requires_payment', label: 'Release requires payment', kind: 'bool' },
  { key: 'partial_release_allowed', label: 'Partial release allowed', kind: 'bool' },
  { key: 'sms_enabled', label: 'SMS enabled', kind: 'bool' },
  { key: 'email_enabled', label: 'Email enabled', kind: 'bool' },
  { key: 'whatsapp_enabled', label: 'WhatsApp enabled', kind: 'bool' },
];
const asText = (v: unknown) => (v === undefined || v === null ? '' : String(v));

function SettingsTab({ tenantId, canManage }: { tenantId: string; canManage: boolean }) {
  const toast = useToast();
  const [loaded, setLoaded] = useLoad(() => getTenantSettingsAction(tenantId));
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();
  const { run, pending } = useSingleFlight();
  const { handle, dialogs } = useProblemDialogs();
  if (!loaded) return <p role="status">Loading settings…</p>;
  if (!loaded.ok) return <ErrorState title="Could not load settings" {...(loaded.requestId ? { requestId: loaded.requestId } : {})} />;
  const settings: Settings = loaded.data;
  const shown = FIELDS.filter((f) => f.key in settings);
  const valueOf = (k: string) => edits[k] ?? asText(settings[k]);

  const save = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const patch: Record<string, unknown> = {};
      for (const f of shown) {
        const v = valueOf(f.key);
        if (v === asText(settings[f.key])) continue;
        if (f.kind === 'int') {
          if (!/^\d{1,9}$/.test(v)) return setError(`${f.label}: enter a whole number.`);
          patch[f.key] = Number(v);
        } else if (f.kind === 'bool') patch[f.key] = v === 'true';
        else patch[f.key] = v;
      }
      if (!Object.keys(patch).length) return setError('Nothing to save.');
      setError(undefined);
      const r = await patchTenantSettingsAction(tenantId, settings.version, patch);
      if (!r.ok) return setError(handle(r));
      setEdits({});
      setLoaded(r);
      toast.show({ tone: 'success', title: 'Settings saved' });
    });
  };

  return (
    <form onSubmit={save} noValidate aria-label="Tenant settings">
      {shown.map((f) => {
        const v = valueOf(f.key);
        const set = (x: string) => setEdits((p) => ({ ...p, [f.key]: x }));
        if (f.kind === 'bool') return <CheckboxInput key={f.key} label={f.label} checked={v === 'true'} onChange={(c) => canManage && set(String(c))} />;
        if (f.kind === 'enum') return <SelectInput key={f.key} label={f.label} value={v} onChange={set} disabled={!canManage} options={(f.options ?? []).map((o) => ({ value: o, label: o }))} />;
        return <TextInput key={f.key} label={f.label} value={v} onChange={set} readOnly={!canManage} {...(f.max ? { maxLength: f.max } : {})} />;
      })}
      <Alert>{error}</Alert>
      {canManage ? <Button type="submit" variant="primary" isLoading={pending}>Save settings</Button> : null}
      {dialogs}
    </form>
  );
}

// ------------------------------------------------------------------ Feature flags
// LD-114: no platform read of a tenant's flags in this release (CR-C2-T26 items 1-5 not approved), so the tab is an empty state and makes no request.
function FlagsTab() {
  return <EmptyState title="Feature flags cannot be listed on the platform console yet." />;
}

// ------------------------------------------------------------------ IRD annexes (PL-4 filtered)
function IrdTab({ tenant, canManage }: { tenant: Detail; canManage: boolean }) {
  const [loaded] = useLoad(() => listAnnexesAction(tenant.tenant_id));
  if (!loaded) return <p role="status">Loading IRD annexes…</p>;
  if (!loaded.ok) return <ErrorState title="Could not load the IRD annexes" {...(loaded.requestId ? { requestId: loaded.requestId } : {})} />;
  const records: AnnexRecord[] = loaded.data.data;
  return <IrdTracker tenants={[{ tenant_id: tenant.tenant_id, code: tenant.code }]} records={records} canManage={canManage} />;
}

// ------------------------------------------------------------------ Administrators
function AdminsTab({ tenantId, canManage }: { tenantId: string; canManage: boolean }) {
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string>();
  const key = useRef(newKey());
  const { run, pending } = useSingleFlight();
  if (!canManage) return <p>Inviting administrators needs the tenant manage permission.</p>;
  const invite = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      if (!EMAIL_RE.test(email.trim())) return setError('Enter a valid email address.');
      if (!name.trim()) return setError('Enter the full name.');
      setError(undefined);
      const r = await inviteTenantAdminAction(tenantId, email.trim(), name.trim(), key.current);
      key.current = newKey();
      if (!r.ok) return setError(failText(r));
      setEmail(''); setName('');
      toast.show({ tone: 'success', title: 'Invitation sent', description: 'The administrator receives an email to set a password.' });
    });
  };
  return (
    <form onSubmit={invite} noValidate aria-label="Invite tenant administrator">
      <h2>Invite an additional tenant administrator</h2>
      <TextInput label="Email" type="email" value={email} onChange={setEmail} maxLength={254} required />
      <TextInput label="Full name" value={name} onChange={setName} maxLength={120} required />
      <Alert>{error}</Alert>
      <Button type="submit" variant="primary" isLoading={pending}>Invite administrator</Button>
    </form>
  );
}

// ------------------------------------------------------------------ Support sessions of this tenant
function SupportTab({ tenantId }: { tenantId: string }) {
  const [loaded] = useLoad(() => listTenantSupportSessionsAction(tenantId));
  if (!loaded) return <p role="status">Loading support sessions…</p>;
  if (!loaded.ok) return <ErrorState title="Could not load support sessions" {...(loaded.requestId ? { requestId: loaded.requestId } : {})} />;
  const rows: SupportSession[] = loaded.data.data;
  if (!rows.length) return <p>No support sessions for this tenant.</p>;
  return (
    <ul className="lims-list">
      {rows.map((s) => (
        <li key={s.support_session_id}>
          {fmtDateTime(s.requested_at)} · {s.platform_staff_display_name} · {scopeLabel(s.scope)} · {supportStatusLabel(s.status)} · {s.ticket_ref}
        </li>
      ))}
    </ul>
  );
}
