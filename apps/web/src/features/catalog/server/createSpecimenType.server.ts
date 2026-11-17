import 'server-only';
import { SPECIMEN_TYPE } from './masters';
import { createOf } from './shared';
import type { SpecimenType } from './types';

export const createSpecimenType = createOf<SpecimenType>('specimen-types', SPECIMEN_TYPE.create, SPECIMEN_TYPE.required);
