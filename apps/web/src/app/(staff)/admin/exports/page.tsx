// AD-13 Exports (C2 04-UI-UX §1, §6). Gate audit.log.export before any API call.
import { actorMembershipId, call } from '@/features/admin/server/api';
import { Denied, LoadError, gate } from '@/features/admin/server/page-kit';
import { rangeFrom, type Page, type SP } from '@/features/admin/lib';
import { ExportsScreen, type AuditExport } from '@/features/admin/components/ExportsScreen';

export default async function ExportsPage({ searchParams }: { searchParams: Promise<SP> }) {
  if (!(await gate('audit.log.export'))) return <Denied />;
  const range = rangeFrom(await searchParams);
  const [r, me] = await Promise.all([call<Page<AuditExport>>('GET', '/v1/identity/audit-exports', { query: { limit: '50' } }), actorMembershipId()]);
  if (!r.ok) return <LoadError fail={r} what="exports" />;
  return <ExportsScreen exports={r.data.data} me={me} defaultRange={{ from: range.from, to: range.to }} />;
}
