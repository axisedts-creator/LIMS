import 'server-only';
// #24 createTest (POST /v1/catalog/tests, TestCreate, Idempotency-Key). T0D-CATTESTS-1 (LD-310). Only TestCreate fields are forwarded.
import { bool, createOf, list, oneOf, pick, str, upperCode, uuid } from './shared';
import type { TestDto } from './types';

export const WORKFLOW_TYPES = ['standard', 'narrative', 'microbiology', 'anatomic', 'molecular', 'attachment', 'outsourced'] as const;
const specimenRequirement = (v: unknown) => pick(v, { specimen_type_id: uuid, is_preferred: bool }, ['specimen_type_id']);

export const createTest = createOf<TestDto>(
  'tests',
  { code: upperCode(), name: str(1, 200), department_id: uuid, workflow_type: oneOf(...WORKFLOW_TYPES), specimen_requirements: list(10, specimenRequirement) },
  ['code', 'name', 'department_id', 'workflow_type', 'specimen_requirements'],
);
