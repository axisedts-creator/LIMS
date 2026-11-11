import 'server-only';
import { UNIT } from './masters';
import { createOf } from './shared';
import type { Unit } from './types';

export const createUnit = createOf<Unit>('units', UNIT.create, UNIT.required);
