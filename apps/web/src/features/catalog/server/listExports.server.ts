import 'server-only';
// #107 listExports.
import { serverFetch } from '@/core/api/server-fetch';
import { oneOf, opt, qsOf } from './shared';
import { EXPORT_KINDS, EXPORT_STATUSES, type ExportRow, type ListQuery, type Page } from './types';

export const listExports = async (q: ListQuery & { kind?: string; status?: string } = {}) =>
  serverFetch<Page<ExportRow>>(`/v1/catalog/exports${qsOf(q, { kind: opt(oneOf(...EXPORT_KINDS), q.kind), status: opt(oneOf(...EXPORT_STATUSES), q.status) })}`);
