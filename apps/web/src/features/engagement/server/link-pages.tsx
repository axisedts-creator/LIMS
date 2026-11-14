import 'server-only';
// C16.T-L1 page loader for W8. The page file checks engagement.link.read first (notFound() without it); then reads.
import { notFound } from 'next/navigation';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { getShellSession } from '@/core/session/server';
import { AppAccessHost } from '../components/AppAccessHost';
import { UUID_RE } from './queue.server';
import * as api from './link.server';

export async function appAccessPage(patientId: string) {
  if (!UUID_RE.test(patientId)) notFound();
  const patient = await api.getPatient(patientId).catch(() => undefined);
  if (!patient) notFound();
  const [{ links, codes }, consent, session] = await Promise.all([api.listAppLinks(patientId), api.getConsent(), getShellSession()]);
  const labName = session?.actor.tenantCode ?? ''; // same source as the W6 token slip (queue-pages.tsx); never a patient or user name
  return (
    <>
      <PageHeader title="Patient app access" helpKey="engagement.app_access" />
      <AppAccessHost patient={{ id: patient.id, display_name: patient.display_name, patient_code: patient.patient_code }} links={links} codes={codes}
        recordPhoneMasked={patient.phone_masked} consent={consent} labName={labName} />
    </>
  );
}
