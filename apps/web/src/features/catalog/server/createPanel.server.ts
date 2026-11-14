import 'server-only';
import { PANEL } from './specs';
import { createOf } from './shared';
import type { Panel } from './types';

export const createPanel = createOf<Panel>('panels', PANEL.create, PANEL.required);
