// C12 purchase-order state table — 03-APP-FLOW §3.1 P1–P9 (AC-05.7). closed/cancelled are terminal.
import { machine } from './machine.js';

export const PO_STATUSES = ['draft', 'approved', 'sent', 'partially_received', 'received', 'closed', 'cancelled'] as const;
export type PoStatus = (typeof PO_STATUSES)[number];

export const { canTransition, assertTransition } = machine<PoStatus>(
  [
    [null, 'draft'], // P1
    ['draft', 'draft'], // P2 replace
    ['draft', 'approved'], // P3
    ['approved', 'sent'], // P4
    ['approved', 'partially_received'], ['approved', 'received'], ['sent', 'partially_received'], ['sent', 'received'], // P5
    ['partially_received', 'partially_received'], ['partially_received', 'received'], // P5
    ['draft', 'cancelled'], // P6
    ['approved', 'cancelled'], ['sent', 'cancelled'], // P7
    ['partially_received', 'closed'], // P8
    ['received', 'closed'], // P9
  ],
  'inventory.po_invalid_transition',
);
