import 'server-only';
import { serverFetch } from '@/core/api/server-fetch';
import { listQs } from './shared';
import type { Unit, UnitsQuery } from './types';

export const listUnits = async (q: UnitsQuery = {}) => serverFetch<{ data: Unit[] }>(`/v1/catalog/units${listQs(q, ['global', 'tenant'])}`);
