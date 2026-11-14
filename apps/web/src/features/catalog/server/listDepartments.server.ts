import 'server-only';
import { listOf } from './shared';
import type { Department } from './types';

export const listDepartments = listOf<Department>('departments');
