import 'server-only';
import { serverFetch } from '@/core/api/server-fetch';
import { bad, list, pick, uuid } from './shared';
import type { ResolvedOrderables } from './types';

/** Read-only POST (query in the body, LD-10): no Idempotency-Key. 422 catalog.test_inactive / catalog.panel_cycle surface as ApiError. */
export async function resolveOrderablesPreview(input: unknown): Promise<ResolvedOrderables> {
  const body = pick(input, { orderable_ids: list(50, uuid) }, ['orderable_ids']);
  if ((body['orderable_ids'] as unknown[]).length < 1) throw bad();
  return serverFetch<ResolvedOrderables>('/v1/catalog/orderables/resolve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}
