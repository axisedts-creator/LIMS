import 'server-only';
import { serverFetch } from '@/core/api/server-fetch';
import { uuid } from './shared';
import type { Panel } from './types';

export const getPanelDetail = async (id: string) => serverFetch<Panel>(`/v1/catalog/panels/${uuid(id)}`);
