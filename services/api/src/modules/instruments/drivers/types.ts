// C7 driver interface — verbatim from 02-TRD §6.1. Drivers are pure: bytes + context in, ParseResult out.
// [CONV] Same brands as contracts/ports/common.ts, declared locally: importing that file drags uncompilable port imports into tsc.
type IsoUtc = string & { readonly __brand: 'IsoUtc' };
type Uuidv7 = string & { readonly __brand: 'Uuidv7' };

export type DriverStatus = 'generic' | 'verified' | 'sketch_blocked';
export type DriverProtocol = 'astm' | 'hl7v2' | 'file_drop';
export type RecordKind = 'quantitative' | 'qualitative' | 'ordinal' | 'text' | 'organism_id' | 'ast' | 'attachment'; // 03-IC §3.14

export interface DriverCapabilities {
  readonly resultUpload: true; readonly hostQuery: boolean; readonly worklistDownload: boolean;
  readonly qc: boolean; readonly attachments: boolean;
  readonly calibration: boolean;               // = g_drivers.cap_calibration; true only for a verified driver whose manual classifies calibrators (B2)
}
export interface DriverContext {
  readonly receivedAt: IsoUtc;
  readonly capturedAt: IsoUtc;
  readonly instrumentTimezone: string;
  readonly qcSampleIdPatterns: readonly RegExp[];
  readonly options: Readonly<Record<string, unknown>>;   // instrument.parser_options, already validated by optionsSchema
}
export interface ParsedRecord {
  readonly recordSeq: number;
  readonly recordClass: 'patient' | 'qc' | 'calibrator' | 'host_query' | 'other';
  readonly sampleBarcode?: string;             // ≤ 40
  readonly controlIdRaw?: string; readonly controlLotRaw?: string; readonly controlLevel?: string;
  readonly recordKind?: RecordKind;
  readonly instrumentAnalyteCode?: string;     // ≤ 64
  readonly valueRaw?: string; readonly unitRaw?: string;
  readonly instrumentFlags: readonly string[]; // each ≤ 16, ≤ 20 entries
  readonly instrumentResultTimeLocal?: string; // 'YYYY-MM-DDTHH:MM:SS' as sent, no zone
  readonly isRerun?: boolean;
  readonly organism?: { organismCodeRaw: string; isolateSeq?: number };
  readonly ast?: { antibioticCodeRaw: string; isolateSeq?: number; method: 'mic' | 'zone_diameter' | 'other';
                   rawValue: string; interpretationRaw?: string; standard?: 'CLSI' | 'EUCAST' | 'ECOFF' | 'unknown'; standardVersion?: string };
  readonly calibratorIdRaw?: string; readonly calibratorLotRaw?: string;
  /** CR-C7-015 / LD-139 (08-ADDENDUM-TRUTH-H80E §3, §10): picture carried inline in the message; only read when recordKind = 'attachment'. */
  readonly inlineAttachment?: { readonly mimeType: 'image/jpeg' | 'image/png'; readonly base64: string };
  readonly warnings: readonly string[];
}
export type ParseOk = { readonly ok: true; readonly messageKind: 'results' | 'host_query' | 'other';
  readonly messageControlId?: string; readonly messageTimeLocal?: string;
  readonly records: readonly ParsedRecord[]; readonly warnings: readonly string[] };
export type ParseResult =
  | ParseOk
  | { readonly ok: false; readonly errorCode: 'instruments.message_malformed'; readonly reason: string /* no PHI */ };

export interface HostQueryAnswer {
  readonly barcode: string; readonly status: 'found' | 'not_found' | 'not_receivable' | 'no_mapped_tests';
  readonly priority?: 'routine' | 'urgent'; readonly sex?: 'male' | 'female' | 'other' | 'unknown'; readonly ageDays?: number;
  readonly tests: readonly { readonly testId: Uuidv7; readonly analyteId: Uuidv7; readonly instrumentCode: string }[];
}
export interface InstrumentDriver {
  readonly code: string; readonly version: string;
  readonly protocol: DriverProtocol; readonly status: DriverStatus;
  readonly capabilities: DriverCapabilities;
  readonly manualRef?: { readonly title: string; readonly documentId: string; readonly revision: string; readonly softwareVersion?: string };
  readonly optionsSchema: object;
  parse(raw: Uint8Array, ctx: DriverContext): ParseResult;
  extractHostQueryBarcodes?(parsed: ParseOk): readonly string[];
  buildHostQueryReply?(input: { query: ParseOk; answers: readonly HostQueryAnswer[]; ctx: DriverContext }): readonly Uint8Array[];
}
