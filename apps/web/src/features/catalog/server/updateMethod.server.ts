import 'server-only';
import { METHOD } from './masters';
import { updateOf } from './shared';
import type { Method } from './types';

export const updateMethod = updateOf<Method>('methods', METHOD.patch);
