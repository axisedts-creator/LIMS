'use server';
// T0D-FINCTRL-1 (LD-321, LD-310) server actions for the discount masters. Errors become { ok:false, status, code, errors? }: the field errors of a
// 400 (JSON Pointer path + message, e.g. an overlapping slab on /amount_from_paisa) travel back so the screen shows them on the field.
import 'server-only';
import { ApiError } from '@/core/api/server-fetch';
import {
  createDiscountAuthority, createDiscountReason, createPartyDiscountSlab, deactivateDiscountAuthority, deactivatePartyDiscountSlab, setUserDiscountLimit, updateDiscountReason,
  updatePartyDiscountSlab, type Ceiling, type CreateSlabInput, type SlabInput,
} from './discounts.server';

export type FieldError = { path: string; message: string };
export type DiscountActionResult = { ok: true } | { ok: false; status: number; code: string; errors?: FieldError[] };

interface Job { (): Promise<unknown> }
async function run(f: Job): Promise<DiscountActionResult> {
  try {
    await f();
    return { ok: true };
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    const raw = (e.problem as { errors?: unknown }).errors;
    const errors = Array.isArray(raw)
      ? raw.filter((x): x is FieldError => !!x && typeof x.path === 'string' && typeof x.message === 'string').map((x) => ({ path: x.path, message: x.message.slice(0, 500) }))
      : [];
    return { ok: false, status: e.status, code: e.problem.code, ...(errors.length ? { errors } : {}) };
  }
}

export async function createDiscountReasonAction(r: { code: string; name: string }, key: string) { return run(() => createDiscountReason(r, key)); }
export async function updateDiscountReasonAction(id: string, version: number, patch: { name?: string; is_active?: boolean }) { return run(() => updateDiscountReason(id, version, patch)); }
export async function createDiscountSlabAction(s: CreateSlabInput, key: string) { return run(() => createPartyDiscountSlab(s, key)); }
export async function updateDiscountSlabAction(id: string, version: number, s: SlabInput) { return run(() => updatePartyDiscountSlab(id, version, s)); }
export async function deactivateDiscountSlabAction(id: string, version: number) { return run(() => deactivatePartyDiscountSlab(id, version)); }
export async function setDiscountLimitAction(userId: string, c: Ceiling & { is_active?: boolean }, version?: number) { return run(() => setUserDiscountLimit(userId, c, version)); }
export async function createDiscountAuthorityAction(a: Ceiling & { user_id: string }, key: string) { return run(() => createDiscountAuthority(a, key)); }
export async function deactivateDiscountAuthorityAction(id: string, version: number) { return run(() => deactivateDiscountAuthority(id, version)); }
