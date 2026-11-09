import 'server-only';
import { serverFetch } from '@/core/api/server-fetch';
import { bool, oneOf, opt, qsOf } from './shared';
import type { DoctorSummary, ListQuery, Page } from './types';

export const listDoctors = async (q: ListQuery & { isVerified?: unknown; source?: unknown; sort?: unknown } = {}) =>
  serverFetch<Page<DoctorSummary>>(
    `/v1/catalog/doctors${qsOf(q, {
      is_verified: opt(bool, q.isVerified),
      source: opt(oneOf('back_office', 'quick_add', 'import'), q.source),
      sort: opt(oneOf('doctor_code', '-doctor_code', 'created_at', '-created_at'), q.sort),
    })}`,
  );
