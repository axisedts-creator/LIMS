import 'server-only';
// getPatient (C4 GET /v1/frontdesk/patients/{patient_id}) for the culture identity card. PHI minimisation: only name, age text and sex leave this function
// (no phone, patient code or visit date). ANY failure (invalid id, 403, 404, 5xx, network) -> null, one request, no retry: the page shows
// "Patient details unavailable" and keeps working (04-UI-UX §3). Nothing is logged (REQ-SEC-098).
import { serverFetch } from '@/core/api/server-fetch';
import { uuid } from './shared';
import type { PatientLite } from './types';

interface PatientRead { full_name?: unknown; age_display?: unknown; sex?: unknown }

export async function getPatient(patientId: string): Promise<PatientLite | null> {
  try {
    const p = await serverFetch<PatientRead>(`/v1/frontdesk/patients/${uuid(patientId)}`);
    if (typeof p.full_name !== 'string' || p.full_name === '') return null;
    return {
      name: p.full_name,
      ...(typeof p.age_display === 'string' && p.age_display ? { age_display: p.age_display } : {}),
      ...(typeof p.sex === 'string' && p.sex ? { sex: p.sex } : {}),
    };
  } catch {
    return null;
  }
}
