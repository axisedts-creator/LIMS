'use server';
// Server actions for the SCR-02…05 editors. ApiError becomes { ok:false, code } (its message does not survive the action
// boundary); anything else rethrows. `kind` is checked against the table below, so a tampered value reaches nothing.
import 'server-only';
import { ApiError } from '@/core/api/server-fetch';
import { createContainer } from './createContainer.server';
import { createDepartment } from './createDepartment.server';
import { createMethod } from './createMethod.server';
import { createSpecimenType } from './createSpecimenType.server';
import { createUnit } from './createUnit.server';
import { createValueSet } from './createValueSet.server';
import { bad } from './shared';
import type { ActionResult } from './types';
import { updateContainer } from './updateContainer.server';
import { updateDepartment } from './updateDepartment.server';
import { updateMethod } from './updateMethod.server';
import { updateSpecimenType } from './updateSpecimenType.server';
import { updateUnit } from './updateUnit.server';
import { updateValueSet } from './updateValueSet.server';

type Saved = { id: string; version: number };
const OPS: Record<string, { create: (i: unknown, k?: string) => Promise<Saved>; update: (id: string, v: number, i: unknown) => Promise<Saved> }> = {
  department: { create: createDepartment, update: updateDepartment },
  specimen_type: { create: createSpecimenType, update: updateSpecimenType },
  container: { create: createContainer, update: updateContainer },
  method: { create: createMethod, update: updateMethod },
  unit: { create: createUnit, update: updateUnit },
  value_set: { create: createValueSet, update: updateValueSet },
};
export type MasterKind = 'department' | 'specimen_type' | 'container' | 'method' | 'unit' | 'value_set';

const op = (kind: string) => {
  const o = Object.hasOwn(OPS, kind) ? OPS[kind] : undefined;
  if (!o) throw bad();
  return o;
};

async function run(f: () => Promise<Saved>): Promise<ActionResult<Saved>> {
  try {
    const r = await f();
    return { ok: true, data: { id: r.id, version: r.version } };
  } catch (e) {
    if (e instanceof ApiError) return { ok: false, status: e.status, code: e.problem.code };
    throw e;
  }
}

export async function createMasterAction(kind: MasterKind, input: unknown, idempotencyKey: string): Promise<ActionResult<Saved>> {
  return run(() => op(kind).create(input, idempotencyKey));
}

export async function updateMasterAction(kind: MasterKind, id: string, version: number, input: unknown): Promise<ActionResult<Saved>> {
  return run(() => op(kind).update(id, version, input));
}
