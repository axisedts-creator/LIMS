import 'server-only';
import { serverFetch } from '@/core/api/server-fetch';
import { listQs } from './shared';
import type { UnitsQuery, ValueSet } from './types';

// T0D-CATUNITS-1 (LD-310): catalog.yaml listValueSets declares ONLY `scope`; the API answers 422 to any other key
// (is_active=all crashed /catalog/units), so only scope is forwarded.
export const listValueSets = async (q: Pick<UnitsQuery, 'scope'> = {}) => serverFetch<{ data: ValueSet[] }>(`/v1/catalog/value-sets${listQs(q.scope === undefined ? {} : { scope: q.scope }, ['global', 'tenant'])}`);
