// Template contract (02-TRD §5.3, C6-owned). ReportDocument mirrors services/api/src/modules/reporting/domain/document.ts
// (02-TRD §3.2); the renderer is a separate package and cannot import the api, so the shape is restated here.
type Uuidv7 = string;
type IsoUtc = string;

export type AssetRef = { source: 'branding' | 'signature' | 'narrative_image' | 'instrument_attachment' | 'module_image'; id: string; sha256: string;
  mimeType?: 'image/png' | 'image/jpeg' | 'application/pdf' };
/** Returns only data: URIs (REQ-SEC-086). */
export interface AssetResolver { dataUri(ref: AssetRef): string }

/** LD-27: `council` + `registrationNo` (<= 20 chars); the footer prints "<council> No. <registrationNo>". */
export interface Signatory { membershipId: Uuidv7; displayName: string; displayTitle?: string; registrationNo?: string; council?: 'NMC' | 'NHPC';
  signatureAssetRef?: AssetRef; role: 'approver' | 'nominated' | 'narrative_signer' }
export interface AnalyteLine {
  analyteId: Uuidv7; resultId: Uuidv7; versionNo: number; name: string; valueText: string; flagLabel?: string; valueBold: boolean;
  refRangeText?: string; unitText?: string; methodLine?: string; comment?: string; images: { ref: AssetRef }[];
}
export interface Block { packageName?: string; panelName: string; subgroups: { subheading?: string; lines: AnalyteLine[] }[]; specimenLine?: string; comments: string[] }
export type NarrativeSection = { kind: 'narrative'; narrativeVersionId: Uuidv7; testName: string; templateKind: string; sections: { heading: string; html: string }[];
  images: { ref: AssetRef; caption?: string }[]; signedBy: Signatory };
export type Section =
  | { kind: 'department'; departmentId: Uuidv7; departmentName: string; approvedBy: string[]; blocks: Block[] }
  | NarrativeSection
  | { kind: 'micro'; orderItemId: Uuidv7; testName: string; phase: 'preliminary' | 'final'; content: unknown }
  | { kind: 'anatomic'; orderItemId: Uuidv7; testName: string; content: unknown }
  | { kind: 'outsourced_index'; items: { testName: string; externalLabName: string }[] };
export interface AmendmentNote { analyteOrSection: string; previousVersionNo: number; reasonCode: string; reasonText?: string; amendedAt: IsoUtc }
export interface ReportDocument {
  schemaVersion: 1;
  family: 'laboratory' | 'narrative';
  reportKind: 'final' | 'partial' | 'preliminary' | 'amended' | 'addendum';
  statusLabel: string;
  lab: { displayName: string; legalName: string; addressText?: string; contactStrip: string[]; logoAssetRef?: AssetRef; headerAssetRef?: AssetRef; footerAssetRef?: AssetRef };
  header: {
    patientName: string; ageGender: string; regNo: string; barcodeNos: string[];
    sampleCollectedAt?: IsoUtc; sampleReceivedAt?: IsoUtc; registeredAt: IsoUtc; reportedAt: IsoUtc;
    referredBy: string; collectedAtCentre: { code: string; name: string; addressText?: string };
  };
  calendarDisplay: 'AD' | 'BS' | 'AD_BS' | 'BS_AD'; timezone: string;
  sections: Section[];
  amendmentNotes: AmendmentNote[];
  signatories: Signatory[];
  disclaimers: string[];
  qr: { verifyUrl: string };
  outsourcedAttachments: unknown[];
  instrumentPdfAttachments: unknown[];
  smart?: { summaryId: Uuidv7; templateLibraryVersion: string; payload: unknown };
}

/** [CONV] key names of the 11 header fields (02-TRD §6.5 lists the field set, not the keys); same list as api domain/templates.ts. */
export const HEADER_FIELD_KEYS = ['sample_collected_at', 'name', 'reg_no', 'age_gender', 'barcode_no', 'sample_coll_dt', 'reg_date', 'sample_rcv_dt',
  'reported_date', 'report_status', 'referred_by'] as const;
export type HeaderFieldKey = (typeof HEADER_FIELD_KEYS)[number];

/** 02-TRD §6.5 (validated by api domain/templates.ts before it is stored). */
export interface TemplateConfig {
  page: { size: 'A4' | 'Letter'; margin_mm: { top: number; bottom: number; left: number; right: number } };
  letterhead: { header_asset: 'branding' | 'none'; footer_asset: 'branding' | 'none'; plain_reserve_top_mm: number; plain_reserve_bottom_mm: number };
  header_fields?: HeaderFieldKey[];
  results: { show_method_line?: boolean; show_units_column: boolean; group_by_package?: boolean; page_break_before_department: boolean; show_department_approved_by: boolean };
  signatories: { mode: 'approvers' | 'nominated'; max?: number; show_signature_images: boolean; label_registration?: string };
  qr: { enabled: boolean; size_mm: number; caption?: string };
  watermark?: { text: string; opacity: number };
  disclaimers: string[];
  contact_strip_extra?: string;
  fonts: { base_pt?: number };
  narrative: { show_images_grid_columns: number };
}

/** 03-IC §4.16 (restated: the renderer cannot import the api). */
export type RenderTemplateKey = 'billing.invoice' | 'billing.credit_note' | 'billing.register' | 'analytics.report' | 'partners.access_slip';
/** RenderPort data templates (review fix #13): templates/billing (C4), templates/analytics (C8), ./access-slip (C6) export `DataTemplateModule[]`. */
export interface DataTemplateModule {
  readonly templateKey: RenderTemplateKey;
  render(input: { data: Readonly<Record<string, unknown>>; assets: AssetResolver; qr?: (text: string) => string }): string;   // full HTML document
}

/** Implemented by C14 in templates/smart/index.ts. Optional: absent -> no smart section. */
export interface SmartSectionRenderer {
  readonly libraryVersion: string;
  renderSections(input: { summary: unknown; calendarDisplay: string; timezone: string }): string;
}

export interface RenderInput {
  document: ReportDocument; config: TemplateConfig; variant: 'letterhead' | 'plain'; assets: AssetResolver; smart?: SmartSectionRenderer;
  /** LD-26 (A33-3): tenant.training_mode, read by the caller through the C2 settings read port; templates have no other route to it. */
  trainingMode?: boolean;
}
export interface TemplateModule {
  readonly templateId: 'lab-report' | 'narrative-report';
  render(input: RenderInput): string;   // full HTML document
}
