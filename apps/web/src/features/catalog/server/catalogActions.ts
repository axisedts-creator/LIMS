'use server';
// Server actions for SCR-09…12 (panels, comment codes, doctors, credit parties). ApiError becomes { ok:false, status, code }
// (its message does not survive the action boundary); anything else rethrows. Input is validated again in the *.server.ts functions.
import 'server-only';
import { ApiError } from '@/core/api/server-fetch';
import { createCommentCode } from './createCommentCode.server';
import { createCreditParty } from './createCreditParty.server';
import { createDoctor } from './createDoctor.server';
import { createPanel } from './createPanel.server';
import { getDoctor } from './getDoctor.server';
import { mergeDoctor } from './mergeDoctor.server';
import { replacePanelMembers } from './replacePanelMembers.server';
import { resolveOrderablesPreview } from './resolveOrderablesPreview.server';
import { searchDoctors } from './searchDoctors.server';
import { searchOrderables } from './searchOrderables.server';
import { updateCommentCode } from './updateCommentCode.server';
import { updateCreditParty } from './updateCreditParty.server';
import { updateDoctor } from './updateDoctor.server';
import { updatePanel } from './updatePanel.server';
import { verifyDoctor } from './verifyDoctor.server';
import type { ActionResult, DoctorSummary, OrderableSummary, ResolvedOrderables } from './types';

type Saved = { id: string; version: number };

async function run<T>(f: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await f() };
  } catch (e) {
    if (e instanceof ApiError) return { ok: false, status: e.status, code: e.problem.code };
    throw e;
  }
}
const saved = (r: Saved): Saved => ({ id: r.id, version: r.version });

export const createPanelAction = async (input: unknown, key: string) => run(async () => saved(await createPanel(input, key)));
export const updatePanelAction = async (id: string, version: number, input: unknown) => run(async () => saved(await updatePanel(id, version, input)));
export const replacePanelMembersAction = async (id: string, version: number, input: unknown) => run(async () => saved(await replacePanelMembers(id, version, input)));
export const resolvePreviewAction = async (orderableIds: string[]): Promise<ActionResult<ResolvedOrderables>> => run(() => resolveOrderablesPreview({ orderable_ids: orderableIds }));
/** Combobox source: failures give an empty list (the field just shows no options). Inactive orderables cannot be added (AC-07.5). */
export async function searchOrderablesAction(q: string, kind?: 'test' | 'panel'): Promise<OrderableSummary[]> {
  const r = await run(() => searchOrderables({ q, ...(kind ? { kind } : {}), limit: 20 }));
  return r.ok ? r.data.data.filter((o) => o.is_active) : [];
}

export const createCommentCodeAction = async (input: unknown, key: string) => run(async () => saved(await createCommentCode(input, key)));
export const updateCommentCodeAction = async (id: string, version: number, input: unknown) => run(async () => saved(await updateCommentCode(id, version, input)));

export const createDoctorAction = async (input: unknown, key: string) =>
  run(async () => {
    const d = await createDoctor(input, key);
    return { ...saved(d), possible_duplicate_of: d.possible_duplicate_of ?? [] };
  });
export const updateDoctorAction = async (id: string, version: number, input: unknown) => run(async () => saved(await updateDoctor(id, version, input)));
export async function searchDoctorsAction(q: string): Promise<ActionResult<DoctorSummary[]>> {
  return run(async () => (await searchDoctors({ q, includeUnverified: true, includeInactive: true, limit: 50 })).data);
}
/** `version` omitted (queue rows are summaries): the current version is read first, so the If-Match is the one on the server now. */
export const verifyDoctorAction = async (id: string, version?: number) => run(async () => saved(await verifyDoctor(id, version ?? (await getDoctor(id)).version)));
export const mergeDoctorAction = async (id: string, intoDoctorId: string, key: string, version?: number) =>
  run(async () => saved(await mergeDoctor(id, version ?? (await getDoctor(id)).version, { into_doctor_id: intoDoctorId }, key)));

export const createCreditPartyAction = async (input: unknown, key: string) => run(async () => saved(await createCreditParty(input, key)));
export const updateCreditPartyAction = async (id: string, version: number, input: unknown) => run(async () => saved(await updateCreditParty(id, version, input)));
