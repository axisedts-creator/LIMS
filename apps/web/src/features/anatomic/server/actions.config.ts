'use server';
// Server actions for the T-23 client components (configuration tabs, template builder). ApiError becomes { ok:false, status, code, detail?, errors? } data; the bearer JWT never
// reaches client code (REQ-SEC-068). Every action is gated again by the API (anatomic.config.manage at aal2). LD-140 (2026-11-13): no UI here.
import 'server-only';
import {
  createAssay, createStain, createSynoptic, createTextTemplate, newSynopticVersion, saveCodedValue, saveSettings, saveTestProfile, transitionSynoptic, updateAssay, updateStain, updateSynoptic,
  updateTextTemplate,
} from './config.server';
import { run } from './shared';
import type { ActionResult } from './types';
import type {
  AssayInput, AssayRecord, CodedInput, CodedRow, CodedSet, Definition, Settings, SettingsInput, StainCreate, StainRecord, StainUpdate, SynopticTemplate, TestProfile, TestProfileInput,
  TextTemplateCreate, TextTemplateRecord, TextTemplateUpdate,
} from './config.types';

export async function saveSettingsAction(version: number, s: SettingsInput): Promise<ActionResult<Settings>> {
  return run(() => saveSettings(version, s));
}
export async function createStainAction(s: StainCreate, key: string): Promise<ActionResult<StainRecord>> {
  return run(() => createStain(s, key));
}
export async function updateStainAction(id: string, version: number, s: StainUpdate): Promise<ActionResult<StainRecord>> {
  return run(() => updateStain(id, version, s));
}
export async function saveTestProfileAction(testId: string, version: number, p: TestProfileInput): Promise<ActionResult<TestProfile>> {
  return run(() => saveTestProfile(testId, version, p));
}
export async function createAssayAction(a: AssayInput, key: string): Promise<ActionResult<AssayRecord>> {
  return run(() => createAssay(a, key));
}
export async function updateAssayAction(id: string, version: number, a: AssayInput): Promise<ActionResult<AssayRecord>> {
  return run(() => updateAssay(id, version, a));
}
export async function saveCodedValueAction(set: CodedSet, code: string, version: number, c: CodedInput): Promise<ActionResult<CodedRow>> {
  return run(() => saveCodedValue(set, code, version, c));
}
export async function createTextTemplateAction(t: TextTemplateCreate, key: string): Promise<ActionResult<TextTemplateRecord>> {
  return run(() => createTextTemplate(t, key));
}
export async function updateTextTemplateAction(id: string, version: number, t: TextTemplateUpdate): Promise<ActionResult<TextTemplateRecord>> {
  return run(() => updateTextTemplate(id, version, t));
}
export async function createSynopticAction(templateKey: string, d: Definition, key: string): Promise<ActionResult<SynopticTemplate>> {
  return run(() => createSynoptic(templateKey, d, key));
}
export async function updateSynopticAction(id: string, version: number, d: Definition): Promise<ActionResult<SynopticTemplate>> {
  return run(() => updateSynoptic(id, version, d));
}
export async function publishSynopticAction(id: string, key: string): Promise<ActionResult<SynopticTemplate>> {
  return run(() => transitionSynoptic(id, 'publish', key));
}
export async function retireSynopticAction(id: string, key: string): Promise<ActionResult<SynopticTemplate>> {
  return run(() => transitionSynoptic(id, 'retire', key));
}
export async function newSynopticVersionAction(id: string, key: string): Promise<ActionResult<SynopticTemplate>> {
  return run(() => newSynopticVersion(id, key));
}
