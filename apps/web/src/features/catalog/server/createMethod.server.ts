import 'server-only';
import { METHOD } from './masters';
import { createOf } from './shared';
import type { Method } from './types';

export const createMethod = createOf<Method>('methods', METHOD.create, METHOD.required);
