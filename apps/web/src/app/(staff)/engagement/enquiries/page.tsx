// W11 Enquiries inbox (04-UI-UX §3 W11). N1 listEnquiries, tenant-wide for users with engagement.enquiry.read.
import 'server-only';
import { notFound } from 'next/navigation';
import { getShellSession } from '@/core/session/server';
import { enquiriesQuery, listEnquiries, listEnquiryCategories } from './enquiries.server';
import { EnquiriesView } from './EnquiriesView';

type SP = Record<string, string | string[] | undefined>;

export default async function EnquiriesPage({ searchParams }: { searchParams: Promise<SP> }) {
  const permissions = (await getShellSession())?.actor.permissions ?? [];
  if (!permissions.includes('engagement.enquiry.read')) notFound();
  const q = enquiriesQuery(await searchParams);
  const [res, categories] = await Promise.all([listEnquiries(q), listEnquiryCategories()]);
  const next = res?.page?.next_cursor;
  return (
    <EnquiriesView
      enquiries={(Array.isArray(res?.data) ? res.data : []).slice(0, 50)} categories={categories} permissions={permissions}
      hasPrevious={q.has('cursor')} {...(next ? { nextCursor: next } : {})}
    />
  );
}
