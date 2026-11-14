import 'server-only';
// getCulture (GET /v1/micro/cultures/{culture_id}) for the T-20 culture page. The id is validated as a UUID before it reaches the path (REQ-SEC-026/027).
import { serverFetch } from '@/core/api/server-fetch';
import { uuid } from './shared';
import type { CultureDetailDto } from './types';

export const getCulture = async (id: string) => serverFetch<CultureDetailDto>(`/v1/micro/cultures/${uuid(id)}`);
