import 'server-only';
import { listOf } from './shared';
import type { SpecimenType } from './types';

export const listSpecimenTypes = listOf<SpecimenType>('specimen-types');
