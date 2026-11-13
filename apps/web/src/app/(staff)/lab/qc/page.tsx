// /lab/qc (04-UI-UX §1 nav row lab.qc.capture, §3.12; 08 A13 D-14). A session without lab.qc.capture gets notFound() (the nav hides the entry, a direct URL renders nothing).
// Reference reads are best-effort: a refused centres / instruments read gives [] for that prop. The QC list itself is read by the client component.
import { notFound } from 'next/navigation';
import { getShellSession } from '@/core/session/server';
import { QcResultsPage } from '@/features/lab/components/qc/QcResultsPage';
import { listCentres } from '@/features/frontdesk/server/read.server';
import { listInstrumentOptions } from '@/features/lab/server/read.server';

export const metadata = { title: 'QC results' };

export default async function Page() {
  const permissions = (await getShellSession())?.actor.permissions ?? [];
  if (!permissions.includes('lab.qc.capture')) notFound();
  const [centres, instruments] = await Promise.all([listCentres().catch(() => []), listInstrumentOptions().catch(() => [])]);
  return <QcResultsPage permissions={permissions} centres={centres} instruments={instruments} />;
}
