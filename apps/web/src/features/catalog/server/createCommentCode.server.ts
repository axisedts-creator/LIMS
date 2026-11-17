import 'server-only';
import { COMMENT_CODE } from './specs';
import { createOf } from './shared';
import type { CommentCode } from './types';

export const createCommentCode = createOf<CommentCode>('comment-codes', COMMENT_CODE.create, COMMENT_CODE.required);
