'use client';
// AD-1 table + search box (searchUsers, 2–100 chars, debounce 300 ms). Masked email as served; lock badge independent of status.
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { searchUsers } from '../actions';
import { Badge, Grid, Time } from '../Grid';
import { Alert, NavButton } from '../ui';
import { STATUS_LABEL, copyFor, fmt, rolesText, type UserSummary } from '../lib';

export function UsersTable({ rows, moreHref }: { rows: UserSummary[]; moreHref?: string }) {
  const [q, setQ] = useState('');
  const [found, setFound] = useState<UserSummary[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
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
  return (
    <>
      <div className="lims-field">
        <label htmlFor="user-search" className="lims-label">Search users</label>
        <input id="user-search" type="search" className="lims-input" value={q} maxLength={100} onChange={(e) => setQ(e.target.value)} />
      </div>
      {err ? <Alert text={err} /> : null}
      {shown.length === 0 ? (
        <div className="lims-state">
          <p>No users match these filters.</p>
          <NavButton href="/admin/users">Clear filters</NavButton>
        </div>
      ) : (
        <Grid
          label="Users"
          columns={['Name', 'Email', 'Status', 'Roles', 'Centres', 'MFA', 'Last login']}
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
            ],
          }))}
        />
      )}
      {moreHref && !found ? <NavButton href={moreHref}>Load more</NavButton> : null}
    </>
  );
}
