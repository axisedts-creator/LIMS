import 'server-only';
import { SPECIMEN_TYPE } from './masters';
import { updateOf } from './shared';
import type { SpecimenType } from './types';

export const updateSpecimenType = updateOf<SpecimenType>('specimen-types', SPECIMEN_TYPE.patch);
