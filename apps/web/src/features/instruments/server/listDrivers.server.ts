import 'server-only';
// E22 listDrivers (GET /v1/instruments/drivers?protocol=&status=); feeds the SCR-06 Driver select and the Go live check.
import { serverFetch } from '@/core/api/server-fetch';
import { badRequest } from './shared.server';
import { DRIVER_STATUSES, PROTOCOLS, type Driver, type DriverStatus, type Protocol } from './types';

export async function listDrivers(q: { protocol?: Protocol; status?: DriverStatus } = {}): Promise<{ data: Driver[] }> {
  if ((q.protocol !== undefined && !(PROTOCOLS as readonly unknown[]).includes(q.protocol)) || (q.status !== undefined && !(DRIVER_STATUSES as readonly unknown[]).includes(q.status))) throw badRequest();
  const p = new URLSearchParams();
  if (q.protocol) p.set('protocol', q.protocol);
  if (q.status) p.set('status', q.status);
  const qs = p.toString();
  return serverFetch<{ data: Driver[] }>(`/v1/instruments/drivers${qs ? `?${qs}` : ''}`);
}
