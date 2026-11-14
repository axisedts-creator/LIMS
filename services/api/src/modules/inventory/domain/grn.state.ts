// C12 goods-receipt state table — 03-APP-FLOW §3.2 G1–G4. posted and cancelled are terminal.
import { machine } from './machine.js';

export const GRN_STATUSES = ['draft', 'posted', 'cancelled'] as const;
export type GrnStatus = (typeof GRN_STATUSES)[number];

export const { canTransition, assertTransition } = machine<GrnStatus>(
  [[null, 'draft'], ['draft', 'draft'], ['draft', 'posted'], ['draft', 'cancelled']],
  'inventory.document_invalid_transition',
);
