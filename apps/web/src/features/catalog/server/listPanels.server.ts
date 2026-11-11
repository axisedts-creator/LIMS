import 'server-only';
import { serverFetch } from '@/core/api/server-fetch';
import { opt, oneOf, qsOf } from './shared';
import type { ListQuery, Page, Panel } from './types';

export const listPanels = async (q: ListQuery & { panelKind?: unknown } = {}) =>
  serverFetch<Page<Panel>>(`/v1/catalog/panels${qsOf(q, { panel_kind: opt(oneOf('clinical', 'package'), q.panelKind) })}`);
