// 04-UI-UX §3 Culture screen — async server component via the BFF. LD-140 (2026-11-13): the screen is built from @lims/ui only.
// Only the culture id comes from the URL and it is checked as a UUID before any request (REQ-SEC-026/027). Unknown / other-tenant / other-centre ids (404) and
// malformed ids (400) all end in notFound() (S-01, S-02). 403 → full-page "no access" with no patient / specimen fan-out. Patient and specimen come from the
// culture's own ids; either read failing never fails the page ("Patient details unavailable"; Reg no left empty). Other failures reject to error.tsx.
import { notFound } from 'next/navigation';
import { getShellSession } from '@/core/session/server';
import { CultureScreen } from '@/features/micro/components/culture/CultureScreen';
import { MicroForbidden } from '@/features/micro/components/MicroForbidden';
import { getCulture } from '@/features/micro/server/getCulture.server';
import { getPatient } from '@/features/micro/server/getPatient.server';
import { getSpecimen } from '@/features/micro/server/getSpecimen.server';
import { orForbidden, orMissing } from '@/features/micro/server/shared';
import { UUID_RE } from '@/features/micro/server/types';

export default async function CulturePage({ params }: { params: Promise<{ culture_id: string }> }) {
  const { culture_id } = await params;
  if (typeof culture_id !== 'string' || !UUID_RE.test(culture_id)) notFound();
  const session = await getShellSession();
  const culture = await orForbidden(() => orMissing(() => getCulture(culture_id)));
  if (culture === null) return <MicroForbidden />;
  if (!culture) notFound();
  const [patient, specimen] = await Promise.all([getPatient(culture.patient_id), getSpecimen(culture.specimen_id).catch(() => null)]);
  return <CultureScreen culture={culture} patient={patient} specimen={specimen} permissions={session?.actor.permissions ?? []} />;
}
