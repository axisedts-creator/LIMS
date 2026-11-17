import 'server-only';
import { VALUE_SET } from './masters';
import { updateOf } from './shared';
import type { ValueSet } from './types';

export const updateValueSet = updateOf<ValueSet>('value-sets', VALUE_SET.patch);
