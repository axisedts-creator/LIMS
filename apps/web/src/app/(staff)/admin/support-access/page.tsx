// AD-14 Support access (C2 04-UI-UX §6). Gate audit.log.read (list); approve/deny/end need identity.settings.manage (API x-permission).
import { call } from '@/features/admin/server/api';
import { Denied, LoadError, gate } from '@/features/admin/server/page-kit';
import type { Page } from '@/features/admin/lib';
import { SupportAccess, type SupportSession } from '@/features/admin/components/SupportAccess';

export default async function SupportAccessPage() {
  const perms = await gate('audit.log.read');
  if (!perms) return <Denied />;
  const r = await call<Page<SupportSession>>('GET', '/v1/identity/support-sessions', { query: { limit: '50' } });
  if (!r.ok) return <LoadError fail={r} what="support access" />;
  return <SupportAccess sessions={r.data.data} canDecide={perms.has('identity.settings.manage')} />;
}
