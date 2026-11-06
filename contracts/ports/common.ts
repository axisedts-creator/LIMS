// contracts/ports/common.ts  (C0)
export type Uuid = string & { readonly __brand: 'Uuid' };           // any RFC 9562 version (GoTrue subs)
export type Uuidv7 = string & { readonly __brand: 'Uuidv7' };       // ids this system generates (04 D9)
export type IsoUtc = string & { readonly __brand: 'IsoUtc' };       // 2026-11-05T04:15:00.000Z
export type IsoDate = string & { readonly __brand: 'IsoDate' };     // 1983-04-12 (A.D.)
export type DecimalString = string & { readonly __brand: 'DecimalString' }; // "13.40"
export type Code = string;                                          // coded-set code, ≤64 chars

export interface Money { readonly amountPaisa: number; readonly currency: 'NPR' } // safe integer paisa

export type ActorType = 'user' | 'system' | 'device' | 'portal' | 'patient' | 'partner';
export interface Actor {
  readonly type: ActorType;
  readonly id: Uuid;                 // user sub, system actor id, device/agent id, portal link id
  readonly membershipId?: Uuidv7;
  readonly supportSessionId?: Uuidv7;
}

/** Opaque DB transaction handle from the core; ports MUST use it for every query. */
export interface DbTx { readonly __brand: 'DbTx' }

export interface RequestContext {
  readonly tenantId: Uuidv7;
  readonly actor: Actor;
  readonly requestId: Uuidv7;
  readonly tx: DbTx;
  readonly now: () => IsoUtc;        // injected clock
  readonly ports: PortRegistry;      // other ports (a port impl may call other ports)
}

export interface PortRegistry {
  readonly CatalogPort: import('./CatalogPort').CatalogPort;
  readonly FrontdeskPort: import('./FrontdeskPort').FrontdeskPort;
  readonly BillingPort: import('./BillingPort').BillingPort;
  readonly LabPort: import('./LabPort').LabPort;
  readonly ReportingPort: import('./ReportingPort').ReportingPort;
  readonly IdentityPort: import('./IdentityPort').IdentityPort;
  readonly NotificationPort: import('./NotificationPort').NotificationPort;
  readonly PaymentProviderPort: import('./PaymentProviderPort').PaymentProviderPort;
  readonly SmartReportPort: import('./SmartReportPort').SmartReportPort;
  readonly QualityPort: import('./QualityPort').QualityPort;
  readonly BillingCommandPort: import('./BillingCommandPort').BillingCommandPort;   // added by 08 (§4.15; consumer allowlist: frontdesk only)
  readonly RenderPort: import('./RenderPort').RenderPort;                           // added by 08 (§4.16)
  readonly EngagementPort: import('./EngagementPort').EngagementPort;               // added by 08 (§4.17)
}
// Reserved, DEFER (B4): LegacyPatientImportPort, LegacyResultImportPort, LegacyDocumentImportPort, legacy-common.ts (08 §4.14).

export interface Page<T> { readonly items: readonly T[]; readonly nextCursor?: string }

/** Generated from contracts/errors.yaml by tools/codegen (C0). */
export type ErrorCode = import('./generated/error-codes').ErrorCode;
export class LimsError extends Error {
  constructor(readonly code: ErrorCode, readonly safeDetail?: string, readonly fieldErrors?: readonly FieldError[]) {
    super(code);
  }
}
export interface FieldError { readonly path: string; readonly code: ErrorCode; readonly message: string }

export type Priority = 'routine' | 'urgent';
export type Sex = 'male' | 'female' | 'other' | 'unknown';
export type SpecimenStatus = 'ordered' | 'collected' | 'in_transit' | 'received' | 'aliquoted' | 'in_process'
  | 'resulted' | 'verified' | 'approved' | 'reported' | 'rejected' | 'recollection_ordered' | 'stored' | 'discarded';
export type ResultStatus = 'pending' | 'resulted' | 'verified' | 'approved' | 'cancelled';
