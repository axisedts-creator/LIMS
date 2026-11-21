// QC run detail (C9 04-UI-UX §2.3, route staff.quality.qc_run). Permission and the id shape are checked in runDetailPage before any API call.
import { runDetailPage } from '@/features/quality/server/pages';

export default async function QcRunDetailPage({ params }: { params: Promise<{ qc_run_id?: string }> }) {
  return runDetailPage(await params);
}
