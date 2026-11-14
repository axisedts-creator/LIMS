// SR-05 Library review / approve (C14 04-UI-UX SR-05). Read-only; Approve / Return only with smartreport.template.approve (the API enforces it too).
import { libraryReviewPage } from '@/features/smartreport/server/library-pages';

export default async function LibraryReviewPage({ params }: { params: Promise<{ library_version_id: string }> }) {
  return libraryReviewPage((await params).library_version_id);
}
