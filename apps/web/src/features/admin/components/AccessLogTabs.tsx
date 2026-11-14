'use client';
// AD-12 Access log / Sign-in events (US-D3). Access log arrives server-rendered; sign-in events load on first open of their tab
// with the same (already validated) range. IPs are masked in lists (04-UI-UX §3).
import { useEffect, useState } from 'react';
import { listAuthEvents } from '../actions';
import { Grid, Time } from '../Grid';
import { Alert, Tabs } from '../ui';
import { copyFor, fmt, maskIp, shortId } from '../lib';

export interface AccessRow { id: string; membership_id?: string; actor_id: string; action: string; entity_type: string; entity_id?: string; centre_id?: string; occurred_at: string; outcome: string }
interface AuthRow { auth_event_id: string; event_type: string; membership_id?: string; reason_code?: string; client_ip?: string; user_agent?: string; occurred_at: string }
const id = (v: string | undefined) => (v ? <code title={v}>{shortId(v)}</code> : '—');

export function AccessLogTabs({ access, range, eventType, membershipId }: {
  access: { rows: AccessRow[]; error?: { text: string; requestId?: string | undefined } } | null; range: { from: string; to: string } | null; eventType?: string | undefined; membershipId?: string | undefined;
}) {
  const [tab, setTab] = useState('Access log');
  const [events, setEvents] = useState<AuthRow[] | null>(null);
  const [err, setErr] = useState<{ text: string; requestId?: string | undefined } | null>(null);
  useEffect(() => {
    if (tab !== 'Sign-in events' || events || !range) return;
    let live = true;
    void listAuthEvents({ occurred_at_from: range.from, occurred_at_to: range.to, ...(eventType ? { event_type: eventType } : {}), ...(membershipId ? { membership_id: membershipId } : {}) }).then((r) => {
      if (!live) return;
      if (r.ok) setEvents(r.data.data as unknown as AuthRow[]); else setErr({ text: copyFor(r.code), requestId: r.requestId });
    });
    return () => { live = false; };
  }, [tab, events, range, eventType, membershipId]);
  return (
    <Tabs items={['Access log', 'Sign-in events']} selected={tab} onChange={setTab} label="Log type">
      {tab === 'Access log' && access ? (
        access.error ? <Alert text={access.error.text} requestId={access.error.requestId} /> : (
          <Grid label="Access log" columns={['Time', 'User', 'Event', 'Entity type', 'Entity id', 'Outcome', 'Centre']}
            rows={access.rows.map((a) => ({ key: a.id, cells: [<Time key="t" iso={a.occurred_at} label={fmt(a.occurred_at)} />, id(a.membership_id ?? a.actor_id), a.action, a.entity_type, id(a.entity_id), a.outcome === 'denied' ? 'Denied' : 'Allowed', id(a.centre_id)] }))} />
        )
      ) : null}
      {tab === 'Sign-in events' && range ? (
        <>
          {err ? <Alert text={err.text} requestId={err.requestId} /> : null}
          {events ? (
            <Grid label="Sign-in events" columns={['Time', 'User', 'Event', 'Reason', 'IP', 'Browser']}
              rows={events.map((e) => ({ key: e.auth_event_id, cells: [<Time key="t" iso={e.occurred_at} label={fmt(e.occurred_at)} />, id(e.membership_id), e.event_type.replace(/_/g, ' '), e.reason_code ?? '—', maskIp(e.client_ip), e.user_agent ?? '—'] }))} />
          ) : !err ? <p>Loading…</p> : null}
        </>
      ) : null}
    </Tabs>
  );
}
