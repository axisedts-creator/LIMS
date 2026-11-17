import 'server-only';
// #99 getImport. Non-UUID ids never leave the server.
import { serverFetch } from '@/core/api/server-fetch';
import { uuid } from './shared';
import type { Import } from './types';

export const getImport = async (id: string) => serverFetch<Import>(`/v1/catalog/imports/${uuid(id) as string}`);
