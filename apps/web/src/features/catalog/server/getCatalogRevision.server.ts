import 'server-only';
// getCatalogRevision (GET /v1/catalog/revision) — SCR-01 "Catalog revision" tile.
import { serverFetch } from '@/core/api/server-fetch';

export const getCatalogRevision = () => serverFetch<{ catalog_revision: number; global_release_seen: number }>('/v1/catalog/revision');
