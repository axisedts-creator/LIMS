// SR-06 Wording terms (C14 04-UI-UX SR-06). smartreport.template.manage is checked in wordingPage before any API call.
import { wordingPage } from '@/features/smartreport/server/library-pages';

export default async function WordingPage() {
  return wordingPage();
}
