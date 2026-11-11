import 'server-only';
import { serverFetch } from '@/core/api/server-fetch';
import { int, oneOf, opt, str } from './shared';
import type { OrderableSummary, Page } from './types';

export async function searchOrderables(q: { q: string; kind?: unknown; panelKind?: unknown; limit?: number }) {
  const p = new URLSearchParams({ q: String(str(1, 64)(q.q)) });
  const kind = opt(oneOf('test', 'panel'), q.kind);
  const panelKind = opt(oneOf('clinical', 'package'), q.panelKind);
  const limit = opt(int(1, 50), q.limit);
  if (kind !== undefined) p.set('kind', String(kind));
  if (panelKind !== undefined) p.set('panel_kind', String(panelKind));
  if (limit !== undefined) p.set('limit', String(limit));
  return serverFetch<Page<OrderableSummary>>(`/v1/catalog/orderables?${p}`);
}
