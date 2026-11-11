import 'server-only';
// SCR-18/19 only need the price-list code + current version (target Select, typed confirmation, export version): #59 listPriceLists, #60 getPriceList.
// The target Select / typed code are optional niceties of the screens, so a 403 (no price_list.read) or 404 degrades to "no list" instead of failing the page.
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import { uuid } from './shared';
import type { Page, PriceListLite } from './types';

const degrade = async <T>(f: () => Promise<T>, fallback: T): Promise<T> => {
  try {
    return await f();
  } catch (e) {
    if (e instanceof ApiError && (e.status === 403 || e.status === 404)) return fallback;
    throw e;
  }
};

export const importPriceListsOrEmpty = async (permissions: readonly string[]): Promise<PriceListLite[]> =>
  permissions.includes('catalog.price_list.read') ? degrade(async () => (await serverFetch<Page<PriceListLite>>('/v1/catalog/price-lists?limit=200')).data, []) : [];

export const importPriceListOrUndefined = async (id: string | undefined): Promise<PriceListLite | undefined> =>
  id ? degrade(() => serverFetch<PriceListLite>(`/v1/catalog/price-lists/${uuid(id) as string}`), undefined) : undefined;
