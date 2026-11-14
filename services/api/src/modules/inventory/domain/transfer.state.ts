// C12 stock-transfer state table — 03-APP-FLOW §3.3 T1–T4 (AC-10.4). Dispatched stock in transit must be received, never cancelled.
import { machine } from './machine.js';

export const TRANSFER_STATUSES = ['draft', 'dispatched', 'received', 'cancelled'] as const;
export type TransferStatus = (typeof TRANSFER_STATUSES)[number];

export const { canTransition, assertTransition } = machine<TransferStatus>(
  [[null, 'draft'], ['draft', 'draft'], ['draft', 'dispatched'], ['dispatched', 'received'], ['draft', 'cancelled']],
  'inventory.document_invalid_transition',
);
