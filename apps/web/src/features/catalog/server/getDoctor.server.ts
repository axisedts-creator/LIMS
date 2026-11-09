import 'server-only';
import { serverFetch } from '@/core/api/server-fetch';
import { uuid } from './shared';
import type { Doctor } from './types';

/** Contact fields are only ever what the API sent (it omits them without catalog.referrer.manage). */
export const getDoctor = async (id: string) => serverFetch<Doctor>(`/v1/catalog/doctors/${uuid(id)}`);
