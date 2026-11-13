'use client';
// AD-5 Role editor (US-B2): PermissionMatrix; privileged codes force "MFA required" (AC-B2.1); platform.* and non-assignable codes are
// disabled (07-SECURITY A-4, AC-B2.2); hub-lab warning (D-13/D-63, warning only). Code is immutable after create.
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { Button } from '@lims/ui/components/Button';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { PermissionMatrix } from '@lims/ui/components/PermissionMatrix';
import { Switch } from '@lims/ui/components/Switch';
import { useToast } from '@lims/ui/components/Toast';
import { createRole, deactivateRole, updateRole } from '../actions';
import { Alert, Field, useFailure } from '../ui';
import { HUB_ROLE_COPY, ROLE_CODE_RE, copyFor, isHubLabPermission, type Permission, type Role } from '../lib';

const assignable = (p: Permission) => p.assignable && !p.code.startsWith('platform.');

export function RoleEditor({ role: initial, catalog, canEdit }: { role?: Role; catalog: Permission[]; canEdit: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [role, setRole] = useState(initial);
  const [name, setName] = useState(initial?.name ?? '');
  const [code, setCode] = useState(initial?.code ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [codes, setCodes] = useState<string[]>(initial?.permission_codes ?? []);
  const [mfa, setMfa] = useState(initial?.mfa_required ?? false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [confirmErr, setConfirmErr] = useState<string | null>(null);
  const failure = useFailure();
  const privileged = new Set(catalog.filter((p) => p.privileged).map((p) => p.code));
  const forced = codes.some((c) => privileged.has(c));
  const mfaOn = mfa || forced;
  const hub = codes.some(isHubLabPermission);
  const modules = [...new Set(catalog.map((p) => p.module))].map((m) => ({ id: m, label: m }));
  const blockedReason = role?.is_default ? 'Default roles cannot be deactivated.' : role && role.member_count > 0 ? 'Remove all members from this role first.' : undefined;

  const save = async () => {
    if (busy) return;
    const e: Record<string, string> = {};
    if (!name.trim() || name.length > 80) e['name'] = 'Enter 1–80 characters';
    if (!role && !ROLE_CODE_RE.test(code)) e['code'] = 'Use 2–40 lower-case letters, digits or _, starting with a letter';
    if (description.length > 500) e['description'] = 'Use 500 characters or fewer';
    if (!codes.length) e['permissions'] = 'Choose at least one permission';
    setErrors(e);
    failure.clear();
    if (Object.keys(e).length) return;
    const body = { name: name.trim(), ...(description.trim() ? { description: description.trim() } : {}), permission_codes: codes, mfa_required: mfaOn };
    setBusy(true);
    const r = role ? await updateRole(role.role_id, role.version, body) : await createRole({ code, ...body });
    setBusy(false);
    if (!r.ok) { failure.set(r); return; }
    if (!role) { router.push(`/admin/roles/${encodeURIComponent((r.data as { role_id: string }).role_id)}`); return; }
    setRole((x) => (x ? { ...x, ...(r.data as Partial<Role>) } : x));
    toast.show({ tone: 'success', title: 'Role saved. Members are logged out and sign in with the new permissions.' });
  };

  return (
    <main className="lims-page">
      <header className="lims-page-header"><h1>{role ? role.name : 'New role'}</h1></header>
      {failure.banner}
      {role ? <p>Changing a role logs out everyone who has it.</p> : null}
      <Field label="Name" value={name} onChange={setName} maxLength={80} readOnly={!canEdit} error={errors['name']} required />
      <Field label="Code" value={code} onChange={setCode} readOnly={!!role || !canEdit} error={errors['code']} hint={role ? 'The code cannot change after the role is created.' : 'e.g. night_tech'} required={!role} />
      <Field label="Description" multiline value={description} onChange={setDescription} readOnly={!canEdit} error={errors['description']} />
      <Switch label="MFA required" isSelected={mfaOn} onChange={setMfa} isDisabled={forced || !canEdit} />
      {forced ? <p className="lims-description">Includes privileged permissions</p> : null}
      {hub ? <Banner tone="warning" title={HUB_ROLE_COPY} /> : null}
      {errors['permissions'] ? <Alert text={errors['permissions']} /> : null}
      <PermissionMatrix
        label="Permissions"
        modules={modules}
        permissions={catalog.map((p) => ({
          code: p.code, moduleId: p.module, resource: p.code.split('.')[1] ?? p.code, isPrivileged: p.privileged, isAssignable: assignable(p),
          ...(assignable(p) ? {} : { unassignableReason: 'Managed by the LIMS provider' }),
        }))}
        value={codes}
        onChange={setCodes}
        isReadOnly={!canEdit}
      />
      {canEdit ? (
        <footer className="lims-form-footer">
          <Button variant="primary" onPress={() => void save()} isLoading={busy}>Save</Button>
          {role ? (
            <span {...(blockedReason ? { title: blockedReason } : {})}>
              <Button variant="danger" isDisabled={!!blockedReason || !role.is_active} onPress={() => { setConfirmErr(null); setConfirm(true); }}>Deactivate role</Button>
            </span>
          ) : null}
          {blockedReason ? <p className="lims-description">{blockedReason}</p> : null}
        </footer>
      ) : null}
      {role ? (
        <ConfirmDialog
          title="Deactivate this role?"
          body={<>{confirmErr ? <Alert text={confirmErr} /> : null}<p>The role can no longer be assigned. It stays visible in history.</p></>}
          confirmLabel="Deactivate"
          tone="danger"
          isOpen={confirm}
          onCancel={() => setConfirm(false)}
          onConfirm={async () => {
            const r = await deactivateRole(role.role_id, role.version);
            if (!r.ok) { setConfirmErr(copyFor(r.code)); return; }
            setConfirm(false);
            setRole((x) => (x ? { ...x, ...(r.data as Partial<Role>), is_active: false } : x));
            toast.show({ tone: 'success', title: 'Role deactivated.' });
          }}
        />
      ) : null}
      {failure.dialogs}
    </main>
  );
}
