// SR-02 Summary review (C14 04-UI-UX SR-02). Permission smartreport.summary.read is checked in summaryPage before any API call.
import { summaryPage } from '@/features/smartreport/server/summary-pages';

export default async function SummaryPage({ params }: { params: Promise<{ summary_id: string }> }) {
  return summaryPage((await params).summary_id);
}
