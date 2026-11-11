// SR-03 Library versions (C14 04-UI-UX SR-03). Permission smartreport.template.manage is checked in libraryListPage before any API call.
import { libraryListPage } from '@/features/smartreport/server/library-pages';

export default async function LibraryPage() {
  return libraryListPage();
}
