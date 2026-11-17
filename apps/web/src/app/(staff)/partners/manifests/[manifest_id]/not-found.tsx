import { EmptyState } from '@lims/ui/components/EmptyState';

export default function NotFound() {
  return <EmptyState title="Manifest not found" body="It may have been withdrawn, or it belongs to another receiving centre." />;
}
