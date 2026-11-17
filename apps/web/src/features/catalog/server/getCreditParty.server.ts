import 'server-only';
import { serverFetch } from '@/core/api/server-fetch';
import { uuid } from './shared';
import type { CreditParty } from './types';

export const getCreditParty = async (id: string) => serverFetch<CreditParty>(`/v1/catalog/credit-parties/${uuid(id)}`);
