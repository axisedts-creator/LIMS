import 'server-only';
import { serverFetch } from '@/core/api/server-fetch';
import { listQs } from './shared';
import type { UnitsQuery, ValueSet } from './types';

export const listValueSets = async (q: UnitsQuery = {}) => serverFetch<{ data: ValueSet[] }>(`/v1/catalog/value-sets${listQs(q, ['global', 'tenant'])}`);
