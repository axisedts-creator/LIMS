'use client';
// 04-UI-UX §2.9 Critical alerts panel (review fix #16): collapsible card above the worklist tabs, R18 listCriticalAlerts polled every 30 s.
// Never shows a value, an analyte or a patient name. A load failure is inline (Retry) and never fails the worklist.
import { useEffect, useRef, useState } from 'react';
import { Button } from '@lims/ui/components/Button';
import { Card } from '@lims/ui/components/Card';
import { ErrorState } from '@lims/ui/components/ErrorState';
import { listCriticalAlertsAction } from '../server/actions';
import type { CriticalAlert } from '../server/types';
import { When } from './format';

const POLL_MS = 30_000;
const WHO: Record<string, string> = { referrer: 'Doctor', staff: 'Staff', centre: 'Centre', patient: 'Patient' };
const STATE: Record<string, string> = { queued: 'Queued', sent: 'Sent', delivered: 'Delivered', read: 'Delivered', failed: 'Failed' };
export const recipientText = (kind: string, status: string) =>
  `${WHO[kind] ?? kind} — ${STATE[status] ?? (status === 'suppressed' && kind === 'staff' ? 'Not sent (call)' : 'Not sent')}`; // Phase 1: staff rows are suppressed → "call"

export function CriticalAlertsPanel({ alerts, hasMore = false, centreId }: { alerts: CriticalAlert[] | null; hasMore?: boolean; centreId?: string | undefined }) {
  const [rows, setRows] = useState<CriticalAlert[] | null>(alerts);
  const [more, setMore] = useState(hasMore);
  const [open, setOpen] = useState(true);
  const centre = useRef(centreId);
  centre.current = centreId;

  useEffect(() => { setRows(alerts); setMore(hasMore); }, [alerts, hasMore]);
  const load = async () => {
    const r = await listCriticalAlertsAction(centre.current);
    if (r.ok) { setRows(r.data.data); setMore(!!r.data.page.next_cursor); return true; }
    return false;
  };
  useEffect(() => {
    // LD-240: no request while the tab is hidden.
    const t = setInterval(() => { if (document.visibilityState !== 'hidden') void load().catch(() => undefined); }, POLL_MS);
    return () => clearInterval(t);
  }, [centreId]);

  // LD-353 rule 6 (T0D-UILIST-1): a failed read is one slim ErrorState banner under the title, not a card that pushes the worklist down
  if (rows === null) return <ErrorState title="Critical alerts could not be loaded" body="The worklist below still works." onRetry={() => void load().catch(() => undefined)} />;
  const count = more ? '50+' : String(rows.length);
  return (
    // T0D-UIGUARD-1-REPORTING (LD-436 Card title row, LD-439 a): Card title with the count as its caption; rows are a role=list of divs (no raw h2 / ul).
    <section aria-label="Critical alerts">
      <Card title="Critical alerts" caption={count}>
        <Button size="sm" variant="ghost" onPress={() => setOpen(!open)}>{open ? 'Hide' : 'Show'}</Button>
        {open ? (
          rows.length === 0 ? (
            // LD-353 rule 6: the page's one EmptyState belongs to the worklist table; an empty side panel is one plain line
            <p className="lims-description">No critical alerts in the last 24 hours.</p>
          ) : (
            <div role="list" aria-label="Critical alerts">
              {rows.map((a) => (
                <div role="listitem" key={a.critical_event_id} className="lims-list-row">
                  <code className="lims-mono">{a.registration_no ?? '—'}</code>
                  <When value={a.alerted_at} />
                  <span className="lims-chip-list">
                    {a.recipients.map((r, i) => <span key={i} className="lims-chip lims-chip-sm lims-tone-neutral">{recipientText(r.recipient_kind, r.status)}</span>)}
                  </span>
                  {a.report_id ? <a className="lims-link" href={`/reporting/reports/${a.report_id}`}>Open report</a> : null}
                </div>
              ))}
            </div>
          )
        ) : null}
      </Card>
    </section>
  );
}
