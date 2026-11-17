// AD-15 Access review (C2 04-UI-UX §6, US-G1). Gate identity.user.read.
// LD-301: listAccessReviews/recordAccessReview are notImplemented in the API (500 common.internal), so the page says so plainly and makes no call.
// Restore the users + listAccessReviews wiring (features/admin/components/AccessReview) once the API exists.
import { Denied, Frame, gate } from '@/features/admin/server/page-kit';

export default async function AccessReviewPage() {
  const perms = await gate('identity.user.read');
  if (!perms) return <Denied />;
  return (
    <Frame title="Access review">
      <p>Access review is not available yet.</p>
    </Frame>
  );
}
