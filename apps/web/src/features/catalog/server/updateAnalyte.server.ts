import 'server-only';
// #31 updateAnalyte (display fields; sort_order for the Alt+Arrow reorder). If-Match carries the analyte version.
import { serverFetch } from '@/core/api/server-fetch';
import { ifMatch, json, uuid } from './guard';
import type { AnalyteRow } from './types';

export const updateAnalyte = async (analyteId: string, version: number, fields: Partial<Pick<AnalyteRow, 'name' | 'print_name' | 'report_subheading' | 'sort_order' | 'is_active'>>) =>
  serverFetch<AnalyteRow>(`/v1/catalog/analytes/${uuid(analyteId)}`, { method: 'PATCH', headers: json({ 'if-match': ifMatch(version) }), body: JSON.stringify(fields) });
