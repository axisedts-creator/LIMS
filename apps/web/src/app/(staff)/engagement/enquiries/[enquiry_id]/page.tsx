// W11 thread (N2). A malformed id or an unknown / other-tenant enquiry is a 404.
import 'server-only';
import { notFound } from 'next/navigation';
import { ApiError } from '@/core/api/server-fetch';
import { getShellSession } from '@/core/session/server';
import { UUID_RE, getEnquiry } from '../enquiries.server';
import { EnquiryThread } from '../EnquiryThread';

export default async function EnquiryThreadPage({ params }: { params: Promise<{ enquiry_id: string }> }) {
  const permissions = (await getShellSession())?.actor.permissions ?? [];
  if (!permissions.includes('engagement.enquiry.read')) notFound();
  const { enquiry_id } = await params;
  if (!UUID_RE.test(enquiry_id)) notFound();
  try {
    return <EnquiryThread enquiry={await getEnquiry(enquiry_id)} permissions={permissions} />;
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 400)) notFound();
    throw e;
  }
}
