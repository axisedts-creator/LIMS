import 'server-only';
// #98 listImports.
import { serverFetch } from '@/core/api/server-fetch';
import { oneOf, opt, qsOf } from './shared';
import { IMPORT_KINDS, IMPORT_STATUSES, type Import, type ListQuery, type Page } from './types';

export const listImports = async (q: ListQuery & { kind?: string; status?: string } = {}) =>
  serverFetch<Page<Import>>(`/v1/catalog/imports${qsOf(q, { kind: opt(oneOf(...IMPORT_KINDS), q.kind), status: opt(oneOf(...IMPORT_STATUSES), q.status) })}`);
