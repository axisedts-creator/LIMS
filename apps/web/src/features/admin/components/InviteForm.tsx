'use client';
// AD-2 Invite user (US-B1). Client validation mirrors UserInviteRequest; submit posts once with an Idempotency-Key (server action).
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@lims/ui/components/Button';
import { inviteUser } from '../actions';
import { E164_RE, EMAIL_RE, codesOf, isHubLabPermission, type Branch, type Centre, type Role } from '../lib';
import { ErrorSummary, Field, Picker, focusFirstInvalid, useFailure } from '../ui';
import { CentreScope, type Scope } from './CentreScope';

const IDS = { email: 'inv-email', name: 'inv-name', phone: 'inv-phone', roles: 'inv-roles', centres: 'inv-centres' };

export function InviteForm({ roles, centres, branches }: { roles: Role[]; centres: Centre[]; branches: Branch[] }) {
  const router = useRouter();
  const form = useRef<HTMLFormElement>(null);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('+977');
  const [roleIds, setRoleIds] = useState<string[]>([]);
  const [scope, setScope] = useState<Scope>({ all: false, centres: [], branches: [] });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const failure = useFailure();
  const hubLab = codesOf(roleIds, roles).some(isHubLabPermission);
  const phoneValue = phone.trim() === '+977' || phone.trim() === '' ? undefined : phone.trim();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const er: Record<string, string> = {};
    if (!EMAIL_RE.test(email.trim()) || email.length > 254) er['email'] = 'Email: enter a valid email address';
    if (!name.trim() || name.length > 120) er['name'] = 'Full name: enter 1–120 characters';
    if (phoneValue && !E164_RE.test(phoneValue)) er['phone'] = 'Mobile: use the international format, e.g. +9779812345678';
    if (!roleIds.length || roleIds.length > 20) er['roles'] = 'Roles: choose at least one role';
    if (!scope.all && !scope.centres.length) er['centres'] = 'Centres: choose at least one centre, or All centres';
    setErrors(er);
    failure.clear();
    if (Object.keys(er).length) { focusFirstInvalid(form.current); return; }
    setBusy(true);
    const r = await inviteUser({
      email: email.trim(), display_name: name.trim(), ...(phoneValue ? { phone_e164: phoneValue } : {}), role_ids: roleIds, all_centres: scope.all,
      ...(!scope.all ? { centre_ids: scope.centres } : {}), ...(scope.branches.length ? { branch_ids: scope.branches } : {}),
    });
    setBusy(false);
    if (r.ok) router.push('/admin/users');
    else failure.set(r);
  };

  return (
    <form ref={form} onSubmit={submit} noValidate className="lims-form">
      <ErrorSummary errors={errors} ids={IDS} />
      {failure.banner}
      <Field id={IDS.email} label="Email" type="email" value={email} onChange={setEmail} error={errors['email']} required autoComplete="off" />
      <Field id={IDS.name} label="Full name" value={name} onChange={setName} error={errors['name']} required />
      <Field id={IDS.phone} label="Mobile" type="tel" value={phone} onChange={setPhone} error={errors['phone']} inputMode="tel" maxLength={16} />
      <Picker id={IDS.roles} label="Roles" multiple value={roleIds} onChange={setRoleIds} error={errors['roles']}
        options={roles.filter((r) => r.is_active).map((r) => ({ value: r.role_id, label: r.name, tag: r.mfa_required ? 'MFA required' : undefined }))} />
      <CentreScope scope={scope} onChange={setScope} centres={centres} branches={branches} hubLab={hubLab} centresError={errors['centres']} ids={{ centres: IDS.centres }} />
      <p className="lims-description">The user receives an email link valid for a limited time. Roles marked MFA required will have to set up two-step verification.</p>
      <Button type="submit" variant="primary" isLoading={busy}>Send invitation</Button>
      {failure.dialogs}
    </form>
  );
}
