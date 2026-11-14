import 'server-only';
import { VALUE_SET } from './masters';
import { createOf } from './shared';
import type { ValueSet } from './types';

export const createValueSet = createOf<ValueSet>('value-sets', VALUE_SET.create, VALUE_SET.required);
