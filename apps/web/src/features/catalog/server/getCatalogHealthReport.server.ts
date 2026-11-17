import 'server-only';
// getCatalogHealthReport (GET /v1/catalog/health-report) — SCR-01 "Needs attention".
import { serverFetch } from '@/core/api/server-fetch';
import type { CatalogHealthReport } from './types';

export const getCatalogHealthReport = () => serverFetch<CatalogHealthReport>('/v1/catalog/health-report');
