import 'server-only';
// #100 listImportIssues.
import { serverFetch } from '@/core/api/server-fetch';
import { oneOf, opt, qsOf, uuid } from './shared';
import type { ImportIssue, ListQuery, Page } from './types';

export const listImportIssues = async (id: string, q: ListQuery & { severity?: string } = {}) =>
  serverFetch<Page<ImportIssue>>(`/v1/catalog/imports/${uuid(id) as string}/issues${qsOf(q, { severity: opt(oneOf('error', 'warning'), q.severity) })}`);
