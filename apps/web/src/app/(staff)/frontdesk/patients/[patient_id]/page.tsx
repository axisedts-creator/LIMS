// 04-UI-UX §5 (route /frontdesk/patients/{patient_id}). The document title is static: patient name and phone never go into titles or URLs (REQ-SEC-098).
import { notFound } from 'next/navigation';
import { ApiError } from '@/core/api/server-fetch';
import { getShellSession } from '@/core/session/server';
import { PatientView } from '@/features/frontdesk/components/PatientView';
import { getPatient, listPatientOrders } from '@/features/frontdesk/server/read.server';
import type { OrderSummary, Patient } from '@/features/frontdesk/server/types';

export const metadata = { title: 'Patient' };

export default async function PatientPage({ params }: { params: Promise<{ patient_id: string }> }) {
  const [session, { patient_id }] = await Promise.all([getShellSession(), params]);
  const perms = session?.actor.permissions ?? [];
  let patient: Patient;
  try {
    patient = await getPatient(patient_id);
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 400)) notFound();
    throw e;
  }
  const orders: OrderSummary[] = perms.includes('frontdesk.order.read') ? (await listPatientOrders(patient_id)).data : [];
  return <PatientView patient={patient} orders={orders} permissions={perms} />;
}
