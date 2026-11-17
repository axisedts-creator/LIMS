// SR-04 Library editor (C14 04-UI-UX SR-04). Read-only unless the version is a draft; checks in libraryEditorPage run before any API call.
import { libraryEditorPage } from '@/features/smartreport/server/library-pages';

export default async function LibraryEditorPage({ params }: { params: Promise<{ library_version_id: string }> }) {
  return libraryEditorPage((await params).library_version_id);
}
