// 04-UI-UX §3.14 (route /lab/specimens/{specimen_id}). A bad id or a session without lab.specimen.read → notFound() before any request (REQ-SEC-028, S-15);
// 404 → notFound() (same answer as a missing id, P-01); any other failure throws → error.tsx (an empty detail would look like "no such specimen").
// Reasons / recollection default are read only for a holder of lab.specimen.reject and are best-effort, as the receive page.
import { notFound } from 'next/navigation';
import { ApiError } from '@/core/api/server-fetch';
import { getShellSession } from '@/core/session/server';
import { SpecimenDetail } from '@/features/lab/components/specimens/SpecimenDetail';
import { getRecollectionDefault, getSpecimen, listRejectionReasons } from '@/features/lab/server/read.server';
import { UUID_RE } from '@/features/lab/server/types';

export const metadata = { title: 'Specimen' };

export default async function SpecimenPage({ params }: { params: Promise<{ specimen_id: string }> }) {
  const [{ specimen_id }, session] = await Promise.all([params, getShellSession()]);
  const permissions = session?.actor.permissions ?? [];
  if (!UUID_RE.test(specimen_id) || !permissions.includes('lab.specimen.read')) notFound();
  const canReject = permissions.includes('lab.specimen.reject');
  const [specimen, rejectionReasons, recollectionDefault] = await Promise.all([
    getSpecimen(specimen_id).catch((e: unknown) => { if (e instanceof ApiError && e.status === 404) notFound(); throw e; }),
    canReject ? listRejectionReasons().catch(() => []) : [],
    canReject ? getRecollectionDefault().catch(() => false) : false,
  ]);
  return <SpecimenDetail specimen={specimen} rejectionReasons={rejectionReasons} recollectionDefault={recollectionDefault} permissions={permissions} />;
}
