import 'server-only';
// #26 updateTest (If-Match).
import { serverFetch } from '@/core/api/server-fetch';
import { ifMatch, json, uuid } from './guard';
import type { TestDto } from './types';

export const updateTest = async (testId: string, version: number, fields: Partial<Pick<TestDto, 'name' | 'department_id' | 'workflow_type' | 'report_order' | 'is_orderable' | 'is_active'>>) =>
  serverFetch<TestDto>(`/v1/catalog/tests/${uuid(testId)}`, { method: 'PATCH', headers: json({ 'if-match': ifMatch(version) }), body: JSON.stringify(fields) });
