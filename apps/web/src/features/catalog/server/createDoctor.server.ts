import 'server-only';
import { DOCTOR } from './specs';
import { createOf, dropBlank } from './shared';
import type { DoctorCreated } from './types';

const create = createOf<DoctorCreated>('doctors', DOCTOR.create, DOCTOR.required);
/** Blank doctor_code = auto `DR{seq:5}`. A 201 may carry possible_duplicate_of — that is not an error (AC-11.2). */
export const createDoctor = async (input: unknown, idempotencyKey?: string) => create(dropBlank(input, 'doctor_code'), idempotencyKey);
