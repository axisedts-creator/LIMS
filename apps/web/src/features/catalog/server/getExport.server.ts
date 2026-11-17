import 'server-only';
// #105 getExport.
import { serverFetch } from '@/core/api/server-fetch';
import { uuid } from './shared';
import type { ExportRow } from './types';

export const getExport = async (id: string) => serverFetch<ExportRow>(`/v1/catalog/exports/${uuid(id) as string}`);
