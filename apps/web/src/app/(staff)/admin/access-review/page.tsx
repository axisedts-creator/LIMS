// AD-15 Access review (C2 04-UI-UX §6, US-G1). Gate identity.user.read.
// LD-301: listAccessReviews/recordAccessReview are notImplemented in the API (500 common.internal), so the page says so plainly and makes no call.
// Restore the users + listAccessReviews wiring (features/admin/components/AccessReview) once the API exists.
import { NotAvailable } from '@lims/ui/components/NotAvailable';
import { Denied, gate } from '@/features/admin/server/page-kit';

export default async function AccessReviewPage() {
  const perms = await gate('identity.user.read');
  if (!perms) return <Denied />;
  return (
    // T0D-UIGUARD-1-ADMIN (LD-353 rules 5 and 6, LD-439): the kit NotAvailable state keeps the title row and the header row of the review list
    <main className="lims-page">
      <NotAvailable title="Access review" helpKey="admin.access-review" body="Access review is not available yet."
        columns={['User', 'Roles', 'Centres', 'MFA', 'Last login', 'Status']} />
    </main>
  );
}
