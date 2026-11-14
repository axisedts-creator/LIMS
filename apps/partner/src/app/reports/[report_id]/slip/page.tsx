// PR-2 Patient access slip — /reports/{report_id}/slip (04-UI-UX PR-2; 03-APP-FLOW §5.5; 08 A2.1, A5.3, A19 D-105). Guarded like every data page: only an active partner session renders it.
import { requirePartnerSession } from '@/core/auth-guard';
import { notFound } from 'next/navigation';
import { SlipPanel } from './SlipPanel';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function SlipPage({ params }: { params: Promise<{ report_id: string }> }) {
  const { report_id: reportId } = await params;
  if (!UUID.test(reportId)) notFound();
  await requirePartnerSession();
  return <SlipPanel reportId={reportId} />;
}
