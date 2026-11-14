// AD-15 Access review (C2 04-UI-UX §6, US-G1). Gate identity.user.read; lists every ACTIVE membership (pages followed).
import { call } from '@/features/admin/server/api';
import { Denied, LoadError, gate } from '@/features/admin/server/page-kit';
import type { Page, UserSummary } from '@/features/admin/lib';
import { AccessReview, type Review } from '@/features/admin/components/AccessReview';

const MAX_PAGES = 20; // ponytail: 20 × 200 memberships; page the table if a lab ever exceeds that

export default async function AccessReviewPage() {
  const perms = await gate('identity.user.read');
  if (!perms) return <Denied />;
  const users: UserSummary[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const r = await call<Page<UserSummary>>('GET', '/v1/identity/users', { query: { status: 'active', limit: '200', ...(cursor ? { cursor } : {}) } });
    if (!r.ok) return <LoadError fail={r} what="users" />;
    users.push(...r.data.data);
    cursor = r.data.page?.next_cursor;
    if (!cursor) break;
  }
  const reviews = await call<{ data: Review[] }>('GET', '/v1/identity/access-reviews');
  if (!reviews.ok) return <LoadError fail={reviews} what="access reviews" />;
  const last = [...reviews.data.data].sort((a, b) => Date.parse(b.reviewed_at) - Date.parse(a.reviewed_at))[0] ?? null;
  return <AccessReview users={users} last={last} canRecord={perms.has('identity.user.manage')} now={Date.now()} />;
}
