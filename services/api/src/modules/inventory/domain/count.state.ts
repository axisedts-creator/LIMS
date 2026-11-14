// C12 stock-count state table — 03-APP-FLOW §3.4 K1–K4. posted and cancelled are terminal.
import { machine } from './machine.js';

export const COUNT_STATUSES = ['open', 'posted', 'cancelled'] as const;
export type CountStatus = (typeof COUNT_STATUSES)[number];

export const { canTransition, assertTransition } = machine<CountStatus>(
  [[null, 'open'], ['open', 'open'], ['open', 'posted'], ['open', 'cancelled']],
  'inventory.document_invalid_transition',
);
