'use client';
// RM-T05 apply / re-apply a role pack with a diff before save (11-ROLE-MATRIX s8; LD-141, LD-150, LD-140: kit + PermissionMatrix only).
// The diff mirrors the server (RM-T02 applyRolePack): missing pack roles are created; an existing role is never rewritten (R6, tenant
// edits win), so pack permissions it lacks are listed as "not added" and nothing is ever shown as removed.
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge } from '@lims/ui/components/Badge';
import { Button } from '@lims/ui/components/Button';
import { PermissionMatrix } from '@lims/ui/components/PermissionMatrix';
import { RadioGroup } from '@lims/ui/components/RadioGroup';
import { useFailure } from '../ui';
import type { Permission, Role } from '../lib';
import { applyRolePack, type ApplyRolePackResult } from './actions';

export interface PackRole { code: string; name: string; mfa_required: boolean; permission_codes: string[] }
export interface RolePack { pack_code: string; name: string; roles: PackRole[] }

export function RolePackApply({ packs, roles, catalog }: { packs: RolePack[]; roles: Role[]; catalog: Permission[] }) {
  const router = useRouter();
  const failure = useFailure();
  const [code, setCode] = useState<string>();
  const [open, setOpen] = useState<string>();
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [result, setResult] = useState<ApplyRolePackResult>();
  const pack = packs.find((p) => p.pack_code === code);
  const byCode = new Map(roles.map((r) => [r.code, r]));
  const rows = (pack?.roles ?? []).map((r) => {
    const have = byCode.get(r.code);
    return { r, isNew: !have, missing: have ? r.permission_codes.filter((c) => !have.permission_codes.includes(c)) : [] };
  });
  const toCreate = rows.filter((x) => x.isNew).length;
  const openRole = pack?.roles.find((r) => r.code === open);

  const apply = async () => {
    if (!pack || pending.current || result) return; // one apply per pick: a late second click must not re-send
    pending.current = true;
    setBusy(true);
    failure.clear();
    const r = await applyRolePack(pack.pack_code);
    setBusy(false);
    if (!r.ok) { pending.current = false; failure.set(r); return; } // stays latched after success until a new pick

    setResult(r.data);
    router.refresh();
  };

  return (
    <>
      {failure.banner}
      {result ? (
        <div role="status" className="lims-banner lims-tone-success" data-tone="success">
          <p className="lims-banner-title">Pack applied: {result.created.length} created, {result.updated.length} updated, {result.unchanged.length} unchanged.</p>
        </div>
      ) : null}
      <RadioGroup
        label="Role pack"
        name="pack_code"
        {...(code ? { value: code } : {})}
        onChange={(v) => { pending.current = false; setCode(v);setOpen(undefined); setResult(undefined); failure.clear(); }}
        options={packs.map((p) => ({ value: p.pack_code, label: p.name }))}
      />
      {pack ? (
        <section aria-labelledby="rm-pack-diff" className="lims-card">
          <h2 id="rm-pack-diff">Diff against current roles</h2>
          {toCreate === 0 ? <p>No changes: every role in this pack already exists. Nothing to apply.</p> : null}
          <ul>
            {rows.map(({ r, isNew, missing }) => (
              <li key={r.code}>
                <Button variant="ghost" size="sm" onPress={() => setOpen(r.code === open ? undefined : r.code)}>
                  <code>{r.code}</code> {r.name}
                </Button>{' '}
                {r.mfa_required ? <Badge tone="warning">MFA required</Badge> : null}{' '}
                {isNew
                  ? <span>New role: will be created with {r.permission_codes.length} permissions.</span>
                  : missing.length
                    ? <span>Exists: kept as your lab edited it. Pack permissions not added: {missing.join(', ')}.</span>
                    : <span>Unchanged.</span>}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {openRole ? (
        <PermissionMatrix
          label={`Pack permissions of ${openRole.name}`}
          modules={[...new Set(catalog.map((p) => p.module))].map((m) => ({ id: m, label: m }))}
          permissions={catalog.map((p) => ({ code: p.code, moduleId: p.module, resource: p.code.split('.')[1] ?? p.code, isPrivileged: p.privileged }))}
          value={openRole.permission_codes}
          onChange={() => undefined}
          isReadOnly
        />
      ) : null}
      <footer className="lims-form-footer">
        <Button variant="primary" onPress={() => void apply()} isDisabled={!pack || toCreate === 0 || !!result}isLoading={busy}>Apply</Button>
      </footer>
      {failure.dialogs}
    </>
  );
}
