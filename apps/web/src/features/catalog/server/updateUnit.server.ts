import 'server-only';
import { UNIT } from './masters';
import { updateOf } from './shared';
import type { Unit } from './types';

export const updateUnit = updateOf<Unit>('units', UNIT.patch);
