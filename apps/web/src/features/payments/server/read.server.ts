import 'server-only';
// P1 listPaymentIntents, P2 getPaymentIntent, P24 listPaymentCodes (BFF reads). Only a uuid ever reaches a path segment.
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import { problem } from '@/core/session/types';
import type { CodedValue, PaymentIntentDetail, PaymentIntentSummary } from '../types';

export interface IntentPage { data: PaymentIntentSummary[]; page?: { limit?: number; next_cursor?: string } }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SETS = ['hold_reasons', 'resolution_reasons', 'cancel_reasons'] as const;
export type CodedSetName = (typeof SETS)[number];

export const listPaymentIntents = (q: URLSearchParams) => serverFetch<IntentPage>(`/v1/payments/intents?${q.toString()}`);

export function getPaymentIntent(id: string) {
  if (!UUID.test(id)) throw new ApiError(404, problem('common.not_found', 'Not found', 404)); // never forward a non-uuid into the path
  return serverFetch<PaymentIntentDetail>(`/v1/payments/intents/${id}`);
}

export async function listPaymentCodes(set: CodedSetName): Promise<CodedValue[]> {
  const r = await serverFetch<{ data?: CodedValue[] }>(`/v1/payments/coded-sets/${set}`);
  return (Array.isArray(r?.data) ? r.data : []).filter((c) => c && c.is_active !== false && typeof c.code === 'string');
}
