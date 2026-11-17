import 'server-only';
import { DEPARTMENT } from './masters';
import { updateOf } from './shared';
import type { Department } from './types';

export const updateDepartment = updateOf<Department>('departments', DEPARTMENT.patch);
