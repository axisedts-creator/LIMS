import 'server-only';
import { DEPARTMENT } from './masters';
import { createOf } from './shared';
import type { Department } from './types';

export const createDepartment = createOf<Department>('departments', DEPARTMENT.create, DEPARTMENT.required);
