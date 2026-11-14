// C12 opened-container state table — 03-APP-FLOW §3.5. finished and discarded are terminal.
import { machine } from './machine.js';

export const CONTAINER_STATUSES = ['open', 'finished', 'discarded'] as const;
export type ContainerStatus = (typeof CONTAINER_STATUSES)[number];

export const { canTransition, assertTransition } = machine<ContainerStatus>(
  [[null, 'open'], ['open', 'finished'], ['open', 'discarded']],
  'inventory.document_invalid_transition',
);
