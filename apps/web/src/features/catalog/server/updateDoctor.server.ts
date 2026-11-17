import 'server-only';
import { DOCTOR } from './specs';
import { updateOf } from './shared';
import type { Doctor } from './types';

export const updateDoctor = updateOf<Doctor>('doctors', DOCTOR.patch);
