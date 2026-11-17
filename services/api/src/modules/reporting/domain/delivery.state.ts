// deliveries.status machine (03-IC §3.18; 02-TRD §4.8). Strict chain; `read` only on channels that report it (WhatsApp).
export const DELIVERY_STATUSES = ['queued', 'sent', 'delivered', 'read', 'failed', 'suppressed'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

const ALLOWED: Record<DeliveryStatus, readonly DeliveryStatus[]> = {
  queued: ['sent', 'failed'],
  sent: ['delivered', 'failed'],
  delivered: ['read', 'failed'],
  read: [],
  failed: ['queued'], // retry
  suppressed: [], // terminal at creation
};

const READ_CHANNELS = new Set(['whatsapp']);

export function canTransition(from: DeliveryStatus, to: DeliveryStatus, opts: { channel?: string } = {}): boolean {
  if (!Object.hasOwn(ALLOWED, from) || !ALLOWED[from].includes(to)) return false;
  return to !== 'read' || READ_CHANNELS.has(opts.channel ?? 'whatsapp');
}
