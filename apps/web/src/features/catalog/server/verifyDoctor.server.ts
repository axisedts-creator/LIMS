import 'server-only';
import { serverFetch } from '@/core/api/server-fetch';
import { int, uuid } from './shared';
import type { Doctor } from './types';

export async function verifyDoctor(id: string, version: number): Promise<Doctor> {
  uuid(id);
  int(1, Number.MAX_SAFE_INTEGER)(version);
  return serverFetch<Doctor>(`/v1/catalog/doctors/${id}/verify`, { method: 'POST', headers: { 'if-match': `"${version}"` } });
}
