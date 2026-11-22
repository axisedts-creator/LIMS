'use client';
// AD-1 table + search box (searchUsers, 2–100 chars, debounce 300 ms). Masked email as served; lock badge independent of status.
// T0D-FIX-10 (LD-455, D-219): Invited rows offer Resend invitation to identity.user.manage holders (same dialog as the detail page),
// and the page says how long an emailed invitation link works (INVITE_LINK_COPY, never the invitation record expires_at).
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@lims/ui/components/Button';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { EmptyState } from '@lims/ui/components/EmptyState';
import { useToast } from '@lims/ui/components/Toast';
import { searchUsers, userAction } from '../actions';
import { Badge, Grid, Time } from '../Grid';
import { Alert, NavButton } from '../ui';
import { INVITE_LINK_COPY, RESEND_DIALOG, STATUS_LABEL, copyFor, fmt, rolesText, type UserSummary } from '../lib';

const COLUMNS = ['Name', 'Email', 'Status', 'Roles', 'Centres', 'MFA', 'Last login'];

export function UsersTable({ rows, moreHref, canManage = false }: { rows: UserSummary[]; moreHref?: string; canManage?: boolean }) {
  const [q, setQ] = useState('');
  const [found, setFound] = useState<UserSummary[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [resend, setResend] = useState<UserSummary | null>(null);
  const seq = useRef(0);
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2 || term.length > 100) { setFound(null); return; }
    const n = ++seq.current;
    const t = setTimeout(async () => {
      const r = await searchUsers(term);
      if (n !== seq.current) return;
      if (r.ok) { setFound(r.data.data as UserSummary[]); setErr(null); } else setErr(copyFor(r.code));
    }, 300);
    return () => clearTimeout(t);
  }, [q]);
  const shown = found ?? rows;
  const anyInvited = shown.some((u) => u.status === 'invited');
  return (
    <>
      <div className="lims-field">
        <label htmlFor="user-search" className="lims-label">Search users</label>
        <input id="user-search" type="search" className="lims-input" value={q} maxLength={100} onChange={(e) => setQ(e.target.value)} />
      </div>
      {err ? <Alert text={err} /> : null}
      {anyInvited ? <p className="lims-description">{INVITE_LINK_COPY}</p> : null}
      {/* T0D-UIGUARD-1-ADMIN (LD-353 rule 5, LD-436 R16): an empty list keeps its header row; Clear filters stays a secondary button */}
        <Grid
          label="Users"
          empty={<><EmptyState title="No users match these filters." /><NavButton href="/admin/users">Clear filters</NavButton></>}
          columns={canManage ? [...COLUMNS, 'Actions'] : COLUMNS}
          rows={shown.map((u) => ({
            key: u.membership_id,
            cells: [
              <Link key="n" href={`/admin/users/${encodeURIComponent(u.membership_id)}`}>{u.display_name}</Link>,
              u.email_masked,
              <>{STATUS_LABEL[u.status] ?? u.status}{u.is_locked ? <> <Badge text="Locked" /></> : null}</>,
              rolesText(u.roles),
              u.all_centres ? 'All centres' : String(u.centre_count),
              u.mfa_enrolled ? 'On' : 'Off',
              <Time key="t" iso={u.last_login_at} label={fmt(u.last_login_at)} />,
              ...(canManage
                ? [u.status === 'invited' ? <Button key="a" size="sm" onPress={() => setResend(u)}>Resend invitation</Button> : null]
                : []),
            ],
          }))}
        />
      {moreHref && !found ? <NavButton href={moreHref}>Load more</NavButton> : null}
      {resend ? <ResendDialog user={resend} onClose={() => setResend(null)} /> : null}
    </>
  );
}

/** Confirm → ONE resendInvitation call (Idempotency-Key set by the server action); a failure stays in the dialog with its reference. */
function ResendDialog({ user, onClose }: { user: UserSummary; onClose: () => void }) {
  const toast = useToast();
  const [err, setErr] = useState<{ text: string; requestId?: string | undefined } | null>(null);
  const busy = useRef(false);
  const run = async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const r = await userAction(user.membership_id, 'resend-invitation', user.version);
      if (r.ok) { onClose(); toast.show({ tone: 'success', title: RESEND_DIALOG.msg }); return; }
      setErr({ text: copyFor(r.code), requestId: r.requestId });
    } finally {
      busy.current = false;
    }
  };
  return (
    <ConfirmDialog
      title={RESEND_DIALOG.title}
      body={<>{err ? <Alert text={err.text} requestId={err.requestId} /> : null}<p>{RESEND_DIALOG.body}</p></>}
      confirmLabel={RESEND_DIALOG.label}
      isOpen
      onCancel={onClose}
      onConfirm={run}
    />
  );
}
