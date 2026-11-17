import 'server-only';
import { PANEL } from './specs';
import { updateOf } from './shared';
import type { Panel } from './types';

export const updatePanel = updateOf<Panel>('panels', PANEL.patch);
