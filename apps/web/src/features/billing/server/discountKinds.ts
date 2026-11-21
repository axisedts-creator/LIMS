// Shared by discounts.server.ts (server-only) and the slabs client screen. No server-only import here, so a client component may import the value.
export type SlabPartyKind = 'credit_party' | 'partner' | 'doctor' | 'franchise';
export const SLAB_PARTY_KINDS: readonly SlabPartyKind[] = ['credit_party', 'partner', 'doctor', 'franchise'];
