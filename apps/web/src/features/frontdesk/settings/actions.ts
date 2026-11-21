'use server';
// Server action for the settings form (LD-255). Only ApiError is mapped to { ok:false, status, code, paths? }: a thrown ApiError loses its code
// across the action boundary in production. Only the field names of errors[].path go back, never a server message.
import 'server-only';
import { ApiError } from '@/core/api/server-fetch';
import type { FrontdeskSettings, FrontdeskSettingsBody } from './model';
import { updateFrontdeskSettings } from './server';

export type SaveResult = { ok: true; settings: FrontdeskSettings } | { ok: false; status: number; code: string; paths: string[] };

export async function saveFrontdeskSettingsAction(version: number, body: FrontdeskSettingsBody): Promise<SaveResult> {
  try {
    return { ok: true, settings: await updateFrontdeskSettings(version, body) };
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    const errors = Array.isArray(e.problem['errors']) ? (e.problem['errors'] as { path?: unknown }[]) : [];
    const paths = errors.flatMap((x) => (typeof x.path === 'string' ? [x.path.replace(/^\//, '')] : []));
    return { ok: false, status: e.status, code: e.problem.code, paths };
  }
}
