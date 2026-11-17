import 'server-only';
import { COMMENT_CODE } from './specs';
import { updateOf } from './shared';
import type { CommentCode } from './types';

export const updateCommentCode = updateOf<CommentCode>('comment-codes', COMMENT_CODE.patch);
