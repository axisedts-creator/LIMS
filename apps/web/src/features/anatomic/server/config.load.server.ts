import 'server-only';
// What the /anatomic/config page loads for one tab (03-APP-FLOW §4.6): only the active tab's data. `tab` and `set` come from the URL and are narrowed to the known values first,
// so nothing user-controlled reaches an API path (REQ-SEC-026/027). LD-140 (2026-11-13): no UI in this file.
import {
  getSettings, listActiveStains, listAllAssays, listAllStains, listAllTextTemplates, listCodedValues, listProfileTests, listRoutineStains, listSynoptic, listTestProfiles,
} from './config.server';
import type { AssayRecord, CatalogTest, CodedRow, CodedSet, ConfigTab, Settings, StainRecord, TemplateSummary, TestProfile, TextTemplateRecord } from './config.types';
import { CODED_SETS, CONFIG_TABS } from './config.types';

export type TabData =
  | { tab: 'settings'; settings: Settings; stains: StainRecord[] }
  | { tab: 'stains'; stains: StainRecord[] }
  | { tab: 'test-profiles'; profiles: TestProfile[]; tests: CatalogTest[]; stains: StainRecord[]; templates: TemplateSummary[] }
  | { tab: 'assays'; assays: AssayRecord[] }
  | { tab: 'coded-lists'; set: CodedSet; rows: CodedRow[] }
  | { tab: 'templates'; templates: TemplateSummary[] }
  | { tab: 'text-templates'; items: TextTemplateRecord[] };

const first = (v: string | string[] | undefined) => (typeof v === 'string' ? v : undefined);
export const pickTab = (v: string | string[] | undefined): ConfigTab => CONFIG_TABS.find((t) => t === first(v)) ?? 'settings';
export const pickSet = (v: string | string[] | undefined): CodedSet => CODED_SETS.find((s) => s === first(v)) ?? 'diagnoses';

export async function loadTab(tab: ConfigTab, set: CodedSet): Promise<TabData> {
  switch (tab) {
    case 'settings': {
      const settings = await getSettings(); // a 403 here is the no-access state
      return { tab, settings, stains: await listRoutineStains() };
    }
    case 'stains':
      return { tab, stains: await listAllStains() };
    case 'test-profiles': {
      const profiles = await listTestProfiles();
      const [tests, stains, templates] = await Promise.all([listProfileTests(), listActiveStains(), listSynoptic('published')]);
      return { tab, profiles, tests, stains, templates };
    }
    case 'assays':
      return { tab, assays: await listAllAssays() };
    case 'coded-lists':
      return { tab, set, rows: await listCodedValues(set) };
    case 'templates':
      return { tab, templates: await listSynoptic() };
    case 'text-templates':
      return { tab, items: await listAllTextTemplates() };
  }
}
