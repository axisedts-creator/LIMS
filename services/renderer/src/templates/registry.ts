// Template registry (02-TRD §4 layout, §5.3): report ids -> TemplateModule, RenderTemplateKey values -> DataTemplateModule.
// Loads <templatesRoot>/billing/index.ts (C4), analytics/index.ts (C8) and smart/index.ts (C14) when present; every directory is optional.
// templatesRoot defaults to services/renderer/templates (outside src/, owned by C4/C8/C14). [CONV] index.ts: the renderer runs TypeScript directly.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { DataTemplateModule, SmartSectionRenderer, TemplateModule } from './contract.js';
import { accessSlipTemplate } from './access-slip/index.js';
import { labReportTemplate } from './lab/index.js';
import { narrativeReportTemplate } from './narrative/index.js';

export interface Registry {
  get(id: string): TemplateModule | DataTemplateModule | undefined;
  ids(): string[];
  readonly smart?: SmartSectionRenderer | undefined;
}

const DEFAULT_ROOT = fileURLToPath(new URL('../../templates', import.meta.url));
const DATA_DIRS = ['billing', 'analytics'] as const;   // a directory may only register keys with its own prefix
const KEYS = new Set(['billing.invoice', 'billing.credit_note', 'billing.register', 'analytics.report', 'partners.access_slip']);

const load = async (root: string, dir: string): Promise<Record<string, unknown> | undefined> => {
  const file = join(root, dir, 'index.ts');
  return existsSync(file) ? ((await import(pathToFileURL(file).href)) as Record<string, unknown>) : undefined;
};

export async function loadRegistry(o: { templatesRoot?: string } = {}): Promise<Registry> {
  const root = o.templatesRoot ?? DEFAULT_ROOT;
  const modules = new Map<string, TemplateModule | DataTemplateModule>();
  const add = (id: string, m: TemplateModule | DataTemplateModule) => {
    if (modules.has(id)) throw new Error(`duplicate template id ${id}`);
    modules.set(id, m);
  };
  add(labReportTemplate.templateId, labReportTemplate);
  add(narrativeReportTemplate.templateId, narrativeReportTemplate);
  add(accessSlipTemplate.templateKey, accessSlipTemplate);   // C6-owned (08 A5.1), always present

  for (const dir of DATA_DIRS) {
    const mod = await load(root, dir);
    if (!mod) continue;
    const list = mod['templates'] ?? mod['default'];
    if (!Array.isArray(list)) throw new Error(`templates/${dir}/index.ts must export DataTemplateModule[]`);
    for (const t of list as DataTemplateModule[]) {
      if (typeof t?.templateKey !== 'string' || typeof t.render !== 'function' || !KEYS.has(t.templateKey) || !t.templateKey.startsWith(`${dir}.`))
        throw new Error(`templates/${dir}: invalid DataTemplateModule`);
      add(t.templateKey, t);
    }
  }
  const smart = (await load(root, 'smart'))?.['smartSectionRenderer'] as SmartSectionRenderer | undefined;

  return { get: (id) => modules.get(id), ids: () => [...modules.keys()], smart };
}
