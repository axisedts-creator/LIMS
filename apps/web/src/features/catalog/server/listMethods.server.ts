import 'server-only';
import { listOf } from './shared';
import type { Method } from './types';

export const listMethods = listOf<Method>('methods');
