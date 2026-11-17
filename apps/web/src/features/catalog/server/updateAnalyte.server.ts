import 'server-only';
// #31 updateAnalyte (display fields; sort_order for the Alt+Arrow reorder; is_active false = remove). If-Match carries the analyte version.
// T0D-TESTMGMT-1 (LD-318): every AnalyteUpdate field incl. the parity fields and `unset`; validated, unknown fields dropped.
import { serverFetch } from '@/core/api/server-fetch';
import { ANALYTE_FIELDS } from './createAnalyte.server';
import { ifMatch, json, uuid } from './guard';
import { bool, list, oneOf, pick } from './shared';
import type { AnalyteRow } from './types';

const SPEC = { ...ANALYTE_FIELDS, is_active: bool, unset: list(4, oneOf('trend_name', 'specimen_type_id', 'font', 'result_display_type')) };
export const updateAnalyte = async (analyteId: string, version: number, fields: Record<string, unknown>) =>
  serverFetch<AnalyteRow>(`/v1/catalog/analytes/${uuid(analyteId)}`, { method: 'PATCH', headers: json({ 'if-match': ifMatch(version) }), body: JSON.stringify(pick(fields, SPEC)) });
