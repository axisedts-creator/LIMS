import 'server-only';
// getBreakpointSet (GET /v1/micro/breakpoint-sets/{set_id}). Non-UUID ids never leave the server.
import { serverFetch } from '@/core/api/server-fetch';
import { uuid } from './shared';
import type { BreakpointSetDto } from './types';

export const getBreakpointSet = async (id: string) => serverFetch<BreakpointSetDto>(`/v1/micro/breakpoint-sets/${uuid(id)}`);
