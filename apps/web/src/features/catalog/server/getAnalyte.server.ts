import 'server-only';
// #30 getAnalyte (+ versions[] newest first).
import { serverFetch } from '@/core/api/server-fetch';
import { uuid } from './guard';
import type { AnalyteRow, AnalyteVersion } from './types';

export const getAnalyte = async (analyteId: string) => serverFetch<AnalyteRow & { versions: AnalyteVersion[] }>(`/v1/catalog/analytes/${uuid(analyteId)}`);
