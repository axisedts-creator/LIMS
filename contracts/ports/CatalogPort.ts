// contracts/ports/CatalogPort.ts
import type { RequestContext, Uuidv7, IsoUtc, IsoDate, Money, Code, DecimalString, Priority, Sex } from './common';
export const CATALOG_PORT_VERSION = 1 as const;

export type WorkflowType = 'standard' | 'narrative' | 'microbiology' | 'anatomic' | 'molecular' | 'attachment' | 'outsourced';
export type ResultType = 'numeric' | 'text' | 'ordinal' | 'coded' | 'attachment' | 'narrative';

export interface AnalyteDefinition {
  readonly id: Uuidv7; readonly code: Code; readonly name: string;
  readonly resultType: ResultType;
  readonly unitCode?: Code; readonly decimals?: number;          // display decimals
  readonly methodName?: string;                                  // printed "METHOD : …" (00 §4)
  readonly formula?: { readonly expression: string; readonly inputAnalyteCodes: readonly Code[];
                       readonly inputUnitCodes?: Readonly<Record<Code, Code>> };   // stored in master, not code (01 §2.2); inputUnitCodes added by 08
  readonly ordinalSetCode?: Code;                                // e.g. urine 1+/2+ (04 D14)
  readonly ordinalSetValues?: readonly { readonly code: string; readonly display: string; readonly sortOrder: number }[]; // active values of ordinalSetCode, sortOrder asc; present iff ordinalSetCode is set (08 A13 D-9; codes ^[A-Z0-9_+\-]{1,16}$)
  readonly reportable: boolean; readonly sortOrder: number;
  readonly reportSubheading?: string;                            // e.g. "RBC parameters" (00 §4)
  readonly printName?: string;                                   // added by 08 (CR-C3-001)
}
export interface TestDefinition {
  readonly id: Uuidv7; readonly code: Code; /* short name e.g. CBC (00 A6) */ readonly name: string;
  readonly departmentId: Uuidv7; readonly departmentCode: Code;
  readonly specimenTypeCodes: readonly Code[]; readonly containerCode?: Code;
  readonly workflowType: WorkflowType;
  readonly analytes: readonly AnalyteDefinition[];
  readonly tatTargetSeconds?: { readonly routine?: number; readonly urgent?: number }; // data only (C3 scope)
  readonly isActive: boolean; readonly revision: number;
  // added by 08 (CR-C3-001, R25, CR-C11-009)
  readonly departmentName?: string;                               // R25 (C6 report headings)
  readonly tatTargetSegment?: 'within_lab' | 'total';
  readonly specimenReportLabel?: string;                          // printed "Specimen:" line (00 §4)
  readonly usesExistingMaterial?: boolean;                        // CR-C11-009: C5 creates results without a specimen requirement
}
export interface PanelDefinition {
  readonly id: Uuidv7; readonly code: Code; readonly name: string;
  readonly panelKind: 'clinical' | 'package';                    // package = commercial bundle (00 §4 "HEALTH PACKAGE")
  readonly members: readonly { readonly kind: 'test' | 'panel'; readonly id: Uuidv7 }[];
  readonly sexRestriction?: 'male' | 'female';
  readonly isActive: boolean; readonly revision: number;
}
export interface ResolvedOrderables {
  readonly orderables: readonly { readonly orderableId: Uuidv7; readonly kind: 'test' | 'panel'; readonly testIds: readonly Uuidv7[] }[];
  readonly tests: readonly TestDefinition[];                     // de-duplicated
  readonly specimenRequirements: readonly { readonly specimenTypeCode: Code; readonly containerCode?: Code; readonly testIds: readonly Uuidv7[] }[];
  readonly catalogRevision: number;
}
export interface PriceQuery {
  readonly orderableId: Uuidv7;
  readonly context: { readonly priceListId?: Uuidv7; readonly creditPartyId?: Uuidv7; readonly referrerId?: Uuidv7; readonly centreId?: Uuidv7 };
  readonly priority: Priority;
  readonly at: IsoUtc;
}
export interface PriceQuote {
  readonly orderableId: Uuidv7; readonly priceListId: Uuidv7; readonly priceListVersion: number;
  readonly source: 'explicit' | 'credit_party' | 'referrer' | 'centre' | 'tenant_default';
  readonly unitPrice: Money; readonly urgentSurcharge?: Money;
  readonly tax: { readonly vat: 'exempt' | 'taxable'; readonly otherTaxCode?: Code;   // 04 L15/L25 BLOCKED B7 → configurable
                  readonly vatRateBp?: number; readonly otherTaxRateBp?: number; readonly hsCode?: string };  // added by 08: rates owned by C3 (R18)
}
export interface RangeQuery { readonly analyteId: Uuidv7; readonly sex: Sex; readonly ageDays?: number; readonly specimenTypeCode?: Code; readonly at: IsoUtc;
  readonly birthOn?: IsoDate }                                   // added by 08: exact calendar age when known; ageDays optional (08 A17.1): absent = age unknown
export interface ReferenceRangeMatch {
  readonly referenceRangeId: Uuidv7; readonly version: number;   // result rows snapshot this (04 D14)
  readonly low?: DecimalString; readonly high?: DecimalString; readonly text?: string; // "Biological Ref Range" column (00 §4)
  readonly unitCode?: Code;
  readonly kind?: 'numeric' | 'text' | 'ordinal'; readonly normalCodes?: readonly Code[];   // added by 08 (CR-C3-001)
}
export interface CriticalLimitsMatch { readonly criticalLimitId: Uuidv7; readonly version: number; readonly low?: DecimalString; readonly high?: DecimalString; readonly abnormalCodes?: readonly Code[] }
export interface InstrumentCodeQuery {
  readonly instrumentId: Uuidv7;
  readonly direction: 'inbound' | 'outbound';                    // inbound: instrument code → analyte; outbound: test/analyte → instrument code (host query)
  readonly instrumentCode?: string; readonly analyteId?: Uuidv7; readonly testId?: Uuidv7;
}
export interface InstrumentCodeMapping {
  readonly mappingId: Uuidv7; readonly instrumentId: Uuidv7; readonly instrumentCode: string;
  readonly analyteId: Uuidv7; readonly testId: Uuidv7;
  readonly unitConversion?: { readonly fromUnitRaw: string; readonly toUnitCode: Code; readonly factor: DecimalString };
  readonly flagMap?: Readonly<Record<string, Code>>;
}
// ---- added by 08 (CR-C3-001 + C4-002 + C5-001 + C13-007)
export type CatalogPartyPurpose = 'display' | 'notification' | 'billing';
export interface ReferrerProfile {
  readonly referrerId: Uuidv7; readonly canonicalReferrerId: Uuidv7; readonly code: Code; readonly displayName: string;
  readonly qualification?: string; readonly registrationNo?: string; readonly isVerified: boolean; readonly isActive: boolean;
  readonly contact?: { readonly phoneE164?: string; readonly email?: string } }      // purpose 'notification' + actor user|system only
export interface CreditPartyProfile {
  readonly creditPartyId: Uuidv7; readonly code: Code; readonly name: string;
  readonly kind: 'hospital' | 'company' | 'clinic' | 'partner_lab' | 'insurer' | 'other';
  readonly allowsCredit: boolean; readonly isActive: boolean; readonly priceListId?: Uuidv7;
  readonly pan?: string; readonly billingAddressText?: string;                     // purpose 'billing' only (C4 receipts/periodic invoices)
  readonly contact?: { readonly phoneE164?: string; readonly email?: string } }      // purpose 'notification' only
export interface CommentCodeResolution {
  readonly resolved: readonly { readonly code: Code; readonly commentCodeId: Uuidv7; readonly version: number; readonly departmentId?: Uuidv7; readonly text: string }[];
  readonly unknown: readonly Code[] }

export interface CatalogPortV1 {
  /** @throws common.not_found; catalog.test_inactive (only when opts require active) */
  getTest(ctx: RequestContext, input: { testId: Uuidv7; asOf?: IsoUtc; requireActive?: boolean }): Promise<TestDefinition>;
  /** @throws common.not_found */
  getPanel(ctx: RequestContext, input: { panelId: Uuidv7; asOf?: IsoUtc; requireActive?: boolean }): Promise<PanelDefinition>;
  /** Expands panels recursively to tests; @throws common.not_found, catalog.test_inactive, catalog.panel_cycle */
  resolveOrderables(ctx: RequestContext, input: { orderableIds: readonly Uuidv7[]; asOf?: IsoUtc }): Promise<ResolvedOrderables>;
  /** @throws common.not_found, catalog.no_price, catalog.tax_config_missing */
  priceFor(ctx: RequestContext, input: PriceQuery): Promise<PriceQuote>;
  /** `ageDays` absent (08 A17.1): only rows with no age restriction (age bounds NULL) match.
   *  @throws common.not_found, catalog.no_reference_range */
  referenceRangeFor(ctx: RequestContext, input: RangeQuery): Promise<ReferenceRangeMatch>;
  /** Returns undefined when the analyte has no critical limits configured. `ageDays` absent (08 A17.1): only rows with no age
   *  restriction match. @throws common.not_found */
  criticalLimitsFor(ctx: RequestContext, input: RangeQuery): Promise<CriticalLimitsMatch | undefined>;
  /** @throws catalog.instrument_code_unmapped */
  mapInstrumentCode(ctx: RequestContext, input: InstrumentCodeQuery): Promise<InstrumentCodeMapping>;
  // ---- added by 08
  /** @throws common.not_found; auth.forbidden (purpose 'notification' from device/portal/patient/partner actor) */
  getReferrer(ctx: RequestContext, input: { referrerId: Uuidv7; purpose: 'display' | 'notification' }): Promise<ReferrerProfile>;
  /** @throws common.not_found; auth.forbidden (purpose 'notification'|'billing' from a non user/system actor) */
  getCreditParty(ctx: RequestContext, input: { creditPartyId: Uuidv7; purpose: CatalogPartyPurpose }): Promise<CreditPartyProfile>;
  /** Department-specific active code wins over tenant-wide; unknown/inactive codes → `unknown`; ≤ 50 codes.
   *  `asOf` returns the text version effective then. @throws common.validation_failed */
  resolveCommentCodes(ctx: RequestContext, input: { codes: readonly Code[]; departmentId?: Uuidv7; asOf?: IsoUtc }): Promise<CommentCodeResolution>;
  // ---- added by 08 Addendum A2.2 (CR-C12-010, additive). Signature verbatim from 08 Addendum A4.1 (supersedes the A2.2 text).
  /** Rate of one tax code effective on date `on` (tenant-local ISO date), read from C3's tax-rule data (R18 single source of rates).
   *  No 'exempt' kind (08 A4.1): exemption is a treatment (C3 `tax_rules.vat_treatment`; C12 purchase lines with no tax code), not a
   *  rate — C12 never calls getTaxRate for an exempt line. `effectiveFrom` is null for a rate with no versioned history (the global VAT
   *  row in `g_tax_types`); never derived from `created_at`.
   *  @throws catalog.tax_config_missing (no rate for taxCode effective on `on`) */
  getTaxRate(ctx: RequestContext, input: { taxCode: string; on: string /* ISO date, tenant timezone */ }): Promise<{ taxCode: string; ratePercentBasisPoints: number; kind: 'vat' | 'other'; effectiveFrom: string | null }>;
  // ---- added by 08 Addendum A24.1 (CR-C16-023, additive). Consumer C16 (staff validation of a price_list_id). If C3's price-list
  //      status set differs, C3's set wins and this signature follows it. Request handlers never read `v_pub_*` views (R25/P-21).
  /** @throws common.not_found */
  getPriceListStatus(ctx: RequestContext, input: { priceListId: Uuidv7 }): Promise<{ priceListId: Uuidv7; isActive: boolean; status: 'draft' | 'published' | 'superseded' | 'discarded' }>;   // C3 price_list_versions status set (A24.1: C3's set wins). Derived list-level value (C3 TRD §7.4a [CONV]): 'published' if any version is published, else 'draft' if an open draft exists, else 'discarded'; 'superseded' is never returned; usable list = isActive && status === 'published'
}
export type CatalogPort = CatalogPortV1;
