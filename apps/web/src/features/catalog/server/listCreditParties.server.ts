import 'server-only';
import { serverFetch } from '@/core/api/server-fetch';
import { qsOf } from './shared';
import type { CreditParty, ListQuery, Page } from './types';

export const listCreditParties = async (q: ListQuery = {}) => serverFetch<Page<CreditParty>>(`/v1/catalog/credit-parties${qsOf(q)}`);
