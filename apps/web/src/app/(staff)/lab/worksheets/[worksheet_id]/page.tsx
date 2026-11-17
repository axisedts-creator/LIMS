// SCR worksheet print view (03-APP-FLOW §3.6).
import { notFound } from 'next/navigation';
import { WorksheetPrintPage } from '@/features/lab/components/worksheets/WorksheetPrintPage';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function Page({ params }: { params: Promise<{ worksheet_id: string }> }) {
  const { worksheet_id } = await params;
  if (!UUID.test(worksheet_id)) notFound();
  return <WorksheetPrintPage worksheetId={worksheet_id} />;
}
