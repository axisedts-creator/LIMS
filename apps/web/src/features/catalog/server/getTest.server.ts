import 'server-only';
// #25 getTestDetail. Other-tenant ids come back 404 from the API; non-UUIDs never leave the server.
import { serverFetch } from '@/core/api/server-fetch';
import { uuid } from './guard';
import type { TestDto } from './types';

export const getTest = async (testId: string) => serverFetch<TestDto & Record<string, unknown>>(`/v1/catalog/tests/${uuid(testId)}`);
