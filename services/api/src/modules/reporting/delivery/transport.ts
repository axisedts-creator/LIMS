// Messaging transport contract (02-TRD §5.4). Providers are reached only through this interface, only from worker task code.
// ProviderKind 'recording' is the only adapter allowed outside production (REQ-SEC-136).
export type ProviderKind = 'recording' | 'whatsapp_cloud_api' | 'sms_sparrow' | 'sms_aakash' | 'email_smtp_relay';

export interface OutboundMessage {
  readonly deliveryId: string;
  readonly channel: 'whatsapp' | 'sms' | 'email';
  readonly to: string;                       // E.164 phone or e-mail; in memory only
  readonly body: string;                     // rendered from the tenant text; never logged
  readonly subject?: string;                 // e-mail
  readonly providerTemplate?: { name: string; language: string; variables: readonly string[]; urlSuffix?: string };   // WhatsApp
  readonly senderId?: string;
  readonly unicode: boolean;
}
export interface SendOutcome { readonly providerMessageId?: string; readonly acceptedAt: string }
/** Resolved secret of channel_accounts.secret_ref; opaque to the send task. */
export type ResolvedSecret = unknown;

export class TransportError extends Error {
  readonly retryable: boolean;
  readonly failureCode: string;
  constructor(retryable: boolean, failureCode: string) {
    super(failureCode);
    this.retryable = retryable;
    this.failureCode = failureCode;
  }
}

/** One provider status event as the adapter parsed it from a callback (C6-T29, CR-C6-001). */
export interface CallbackEvent {
  readonly providerMessageId: string;
  readonly statusRaw: string;
  readonly mappedStatus: 'sent' | 'delivered' | 'read' | 'failed';
  readonly occurredAt?: string;
}

export interface Transport {
  readonly providerKind: ProviderKind;
  send(msg: OutboundMessage, creds: ResolvedSecret): Promise<SendOutcome>;   // throws TransportError
  /** Verifies the provider signature over the RAW body bytes (req.rawBody) and parses the events. Throws on a bad signature or an unparsable body. */
  parseCallback?(rawBody: Uint8Array, headers: Readonly<Record<string, string | undefined>>): readonly CallbackEvent[];
}
