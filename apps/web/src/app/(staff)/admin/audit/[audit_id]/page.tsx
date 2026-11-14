// AD-11 Audit entry (C2 04-UI-UX §6, US-D2): key/values + DiffTable; values are text nodes only (REQ-SEC-088). Viewing is recorded by the API.
import { notFound } from 'next/navigation';
import { DiffTable, type DiffRow } from '@lims/ui/components/DiffTable';
import { call } from '@/features/admin/server/api';
import { Denied, Frame, LoadError, gate } from '@/features/admin/server/page-kit';
import { SEG_RE, fmt } from '@/features/admin/lib';

interface Entry {
  audit_id: string; occurred_at: string; table: string; action: string; row_id?: string; actor?: { display_name?: string; type?: string }; centre_id?: string; request_id?: string;
  changed_columns: string[]; support_session_id?: string; old_values?: string; new_values?: string; client_ip?: string; user_agent?: string;
}
const parse = (s: string | undefined): Record<string, unknown> | null => {
  if (!s) return {};
  try { const v = JSON.parse(s) as unknown; return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null; } catch { return null; }
};
const show = (v: unknown) => (v === undefined ? '—' : typeof v === 'string' ? v : JSON.stringify(v));

/** Before/after rows per key; malformed JSON falls back to one raw-text row (never throws). */
function diffRows(oldText: string | undefined, newText: string | undefined): DiffRow[] {
  const a = parse(oldText), b = parse(newText);
  if (!a || !b) return [{ label: 'Raw values', before: oldText ?? '', after: newText ?? '', changed: oldText !== newText }];
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].map((k) => ({ label: k, before: show(a[k]), after: show(b[k]), changed: JSON.stringify(a[k]) !== JSON.stringify(b[k]) }));
}

export default async function AuditEntryPage({ params }: { params: Promise<{ audit_id: string }> }) {
  if (!(await gate('audit.log.read'))) return <Denied />;
  const { audit_id: id } = await params;
  if (!SEG_RE.test(id)) notFound();
  const r = await call<Entry>('GET', `/v1/identity/audit-entries/${encodeURIComponent(id)}`);
  if (!r.ok && r.status === 404) notFound();
  if (!r.ok) return <LoadError fail={r} what="this audit entry" />;
  const e = r.data;
  const kv: Array<[string, string]> = [
    ['Time', `${fmt(e.occurred_at)} (${e.occurred_at} UTC)`], ['User', e.actor?.display_name ?? e.actor?.type ?? '—'], ['Action', e.action], ['Table', e.table],
    ['Record id', e.row_id ?? '—'], ['Request id', e.request_id ?? '—'], ['IP', e.client_ip ?? '—'], ['User agent', e.user_agent ?? '—'],
    ['Centre', e.centre_id ?? '—'], ['Support session', e.support_session_id ?? '—'],
  ];
  return (
    <Frame title="Audit entry">
      <p className="lims-description">Your viewing of this entry is recorded.</p>
      <dl className="lims-dl">{kv.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
      <p className="lims-label">Changes</p>
      <DiffTable rows={diffRows(e.old_values, e.new_values)} />
    </Frame>
  );
}
