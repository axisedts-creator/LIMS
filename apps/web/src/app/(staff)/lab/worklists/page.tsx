// C5 04-UI-UX §1 / §3.4 (route /lab/worklists, lab.worklist.read). LD-255 (FOUNDER): the administrator and lab staff reach the department worklists from the menu.
// Permission first (the API is never called without it); a 403 from the API is the permission-denied page, any other failure throws to error.tsx.
import { ApiError } from '@/core/api/server-fetch';
import { PermissionDenied } from '@/core/errors/PermissionDenied';
import { t } from '@/core/i18n/messages';
import { NotAvailable, isPending } from '@/core/shell/NotAvailable';
import { getShellSession } from '@/core/session/server';
import { DepartmentIndex } from '@/features/lab/components/worklists/DepartmentIndex';
import { listActiveDepartments } from '@/features/lab/server/adminpages.server';

export const metadata = { title: 'Worklists' };

export default async function WorklistsIndexPage() {
  const session = await getShellSession();
  if (!(session?.actor.permissions ?? []).includes('lab.worklist.read')) return <PermissionDenied />;
  try {
    return <DepartmentIndex departments={await listActiveDepartments()} />;
  } catch (e) {
    if (e instanceof ApiError && e.status === 403) return <PermissionDenied />;
    // T0D-UILIST-1 (LD-353 rule 6): 501 operation_pending keeps the title and the header row
    if (isPending(e)) return <NotAvailable title={t('lab.nav.worklists')} columns={['Department', 'Code']} />;
    throw e;
  }
}
