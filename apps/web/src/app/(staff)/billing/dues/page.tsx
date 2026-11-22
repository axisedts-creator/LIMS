// 04-UI-UX §8.4 Dues.
import { ApiError } from '@/core/api/server-fetch';
import { t } from '@/core/i18n/messages';
import { LoadError } from '@/core/shell/LoadError';
import { DuesList } from '@/features/billing/components/DuesList';
import { listCentres } from '@/features/billing/server/accounts.server';
import { listDues } from '@/features/billing/server/read.server';

export default async function DuesPage() {
  // LD-446 (CR DEPLOY-AXIS-012 7a): pass the centre list so every row shows the centre name; an unreadable list leaves dashes.
  // T0D-FIX-11 (LD-455 rule 3): a failed dues read is the kit inline error with the reference under the page title, never "No outstanding dues."
  try {
    const [{ data }, centres] = await Promise.all([listDues({ limit: 100 }), listCentres()]);
    return <DuesList dues={data} centres={centres.flatMap((c) => (c.centre_id ?? c.id ? [{ id: (c.centre_id ?? c.id) as string, name: c.name }] : []))} />;
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    return <LoadError title={t('nav.billing.dues')} {...(e.problem.request_id ? { requestId: e.problem.request_id } : {})} />;
  }
}
