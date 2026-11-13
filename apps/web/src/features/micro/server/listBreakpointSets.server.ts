import 'server-only';
// listBreakpointSets (GET /v1/micro/breakpoint-sets, newest first). One page (≤ 200) for the list screen.
import { serverFetch } from '@/core/api/server-fetch';
import type { BreakpointSetDto, Page } from './types';

export const listBreakpointSets = async () => serverFetch<Page<BreakpointSetDto>>('/v1/micro/breakpoint-sets?limit=200');
