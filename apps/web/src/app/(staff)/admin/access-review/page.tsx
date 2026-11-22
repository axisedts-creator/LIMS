// AD-15 Access review (C2 04-UI-UX §6, US-G1). Gate identity.user.read; the Record action needs identity.user.manage (the API enforces both).
// T0D-BUILD-3 (LD-447): listAccessReviews + recordAccessReview are built, so the LD-301 placeholder state is retired. Lists every ACTIVE membership
// (pages followed) for the prefilled count and the reviewer names.
import { call } from '@/features/admin/server/api';
import { Denied, FailedPage, gate } from '@/features/admin/server/page-kit';
import type { Page, Review, UserSummary } from '@/features/admin/lib';
import { AccessReview } from '@/features/admin/components/AccessReview';

const MAX_PAGES = 20; // ponytail: 20 × 200 memberships; page the table if a lab ever exceeds that

export default async function AccessReviewPage() {
  const perms = await gate('identity.user.read');
  if (!perms) return <Denied />;
  const users: UserSummary[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const r = await call<Page<UserSummary>>('GET', '/v1/identity/users', { query: { status: 'active', limit: '200', ...(cursor ? { cursor } : {}) } });
    if (!r.ok) return <FailedPage title="Access review" helpKey="admin.access-review" fail={r} what="users" />;
    users.push(...r.data.data.filter((u) => u.status === 'active'));
    cursor = r.data.page?.next_cursor;
    if (!cursor) break;
  }
  const reviews = await call<{ data: Review[] }>('GET', '/v1/identity/access-reviews');
  if (!reviews.ok) return <FailedPage title="Access review" helpKey="admin.access-review" fail={reviews} what="access reviews" />;
  return <AccessReview users={users} reviews={reviews.data.data} canRecord={perms.has('identity.user.manage')} now={Date.now()} />;
}
