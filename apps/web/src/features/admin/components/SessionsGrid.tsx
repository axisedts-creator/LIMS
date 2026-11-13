'use client';
// Session tables for ME-1, AD-3 and AD-9 with a per-row [Log out] behind a ConfirmDialog. Failures are inline (toasts are success only).
import { useState } from 'react';
import { Button } from '@lims/ui/components/Button';
import { ConfirmDialog } from '@lims/ui/components/ConfirmDialog';
import { useToast } from '@lims/ui/components/Toast';
import { Badge, Grid, Time } from '../Grid';
import { Alert } from '../ui';
import { copyFor, fmt, maskIp, type SessionSummary } from '../lib';
import type { Result } from '../server/api';

type Variant = 'me' | 'user' | 'all';
const COLS: Record<Variant, string[]> = {
  me: ['Device/browser', 'IP', 'Started', 'Last active', 'Expires'],
  user: ['Browser', 'IP', 'Started', 'Last active', 'Expires', 'Two-step'],
  all: ['User', 'Started', 'Last active', 'Expires', 'IP', 'Browser', 'Two-step', 'Support'],
};

export function SessionsGrid({ sessions, variant, onRevoke, buttonLabel = 'Log out' }: {
  sessions: SessionSummary[]; variant: Variant; onRevoke?: ((id: string) => Promise<Result<unknown>>) | undefined; buttonLabel?: string;
}) {
  const toast = useToast();
  const [rows, setRows] = useState(sessions);
  const [target, setTarget] = useState<string | null>(null);
  const [err, setErr] = useState<{ text: string; requestId?: string | undefined } | null>(null);
  const t = (iso: string | undefined) => <Time iso={iso} label={fmt(iso)} />;
  const cells = (s: SessionSummary) => {
    const twoStep = s.aal === 'aal2' ? 'Verified' : '—';
    const c =
      variant === 'all'
        ? [s.display_name ?? '—', t(s.created_at), t(s.last_seen_at), t(s.absolute_expires_at), maskIp(s.client_ip_masked), s.user_agent_family ?? '—', twoStep, s.is_support ? <Badge text="Support" /> : '']
        : [s.user_agent_family ?? '—', maskIp(s.client_ip_masked), t(s.created_at), t(s.last_seen_at), t(s.absolute_expires_at), ...(variant === 'user' ? [twoStep] : [])];
    return onRevoke ? [...c, <Button key="x" size="sm" onPress={() => { setErr(null); setTarget(s.session_id); }}>{buttonLabel}</Button>] : c;
  };
  return (
    <>
      {err && !target ? <Alert text={err.text} requestId={err.requestId} /> : null}
      {rows.length ? (
        <Grid label="Sessions" columns={[...COLS[variant], ...(onRevoke ? ['Actions'] : [])]} rows={rows.map((s) => ({ key: s.session_id, cells: cells(s) }))} />
      ) : (
        <p>No active sessions.</p>
      )}
      <ConfirmDialog
        title="Log out this session?"
        body={<>{err && target ? <Alert text={err.text} requestId={err.requestId} /> : null}<p>The device is signed out immediately.</p></>}
        confirmLabel="Log out"
        tone="danger"
        isOpen={target !== null}
        onCancel={() => setTarget(null)}
        onConfirm={async () => {
          if (!target || !onRevoke) return;
          const r = await onRevoke(target);
          if (!r.ok) { setErr({ text: copyFor(r.code), requestId: r.requestId }); return; }
          setRows((x) => x.filter((s) => s.session_id !== target));
          setTarget(null);
          toast.show({ tone: 'success', title: 'Session logged out.' });
        }}
      />
    </>
  );
}
