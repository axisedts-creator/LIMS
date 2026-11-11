'use client';
// 04-UI-UX §9 not-found copy: shown for a run that is not the viewer's, belongs to another tenant, has expired, or has a malformed id.
import { EmptyState } from '@lims/ui/components/EmptyState';

export default function ReportRunNotFound() {
  return <EmptyState title="This report link is not for your account or has expired." />;
}
