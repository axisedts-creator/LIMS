import 'server-only';
import { serverFetch } from '@/core/api/server-fetch';
import { opt, qsOf, str, uuid } from './shared';
import type { CommentCode, ListQuery, Page } from './types';

export const listCommentCodes = async (q: ListQuery & { departmentId?: unknown; codePrefix?: unknown } = {}) =>
  serverFetch<Page<CommentCode>>(`/v1/catalog/comment-codes${qsOf(q, { department_id: opt(uuid, q.departmentId), code_prefix: opt(str(1, 16), q.codePrefix) })}`);
