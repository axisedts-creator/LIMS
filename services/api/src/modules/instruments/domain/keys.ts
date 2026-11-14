// Message / result / QC / calibration keys (02-TRD §6.5; 03-IC §3.14/§3.15; 04 N10). Pure.
import { createHash } from 'node:crypto';

export interface ResultKeyInput { instrumentId: string; sampleBarcode: string; instrumentAnalyteCode: string; instrumentResultTime?: string }
export interface QcKeyInput { instrumentId: string; controlIdRaw: string; instrumentAnalyteCode: string; instrumentResultTime?: string; rawSha256: string }
export interface CalibrationKeyInput { instrumentId: string; instrumentAnalyteCode: string; instrumentResultTime?: string; rawSha256: string }

export const resultKey = (k: ResultKeyInput): string =>
  `${k.instrumentId}:${k.sampleBarcode}:${k.instrumentAnalyteCode}:${k.instrumentResultTime ?? 'none'}`;

export const qcKey = (k: QcKeyInput): string =>
  `${k.instrumentId}:qc:${k.controlIdRaw}:${k.instrumentAnalyteCode}:${k.instrumentResultTime ?? k.rawSha256}`;

export const calibrationKey = (k: CalibrationKeyInput): string =>
  `${k.instrumentId}:cal:${k.instrumentAnalyteCode}:${k.instrumentResultTime ?? k.rawSha256}`;

/** Stored/logged instead of the result key, which contains a barcode (02-CV §9.2). */
export const resultKeySha256 = (key: string): string => createHash('sha256').update(key, 'utf8').digest('hex');

export type MessageKeySource =
  | { source: 'hl7v2'; msh10?: string; rawSha256: string; reused?: boolean }
  | { source: 'astm'; rawSha256: string }
  | { source: 'file_drop'; fileSha256: string }
  | { source: 'host_query_repeat'; rawSha256: string; agentMessageId: string };
export type MessageKeyKind = 'msh10' | 'msh10_reused' | 'sha256' | 'sha256_repeat';

export function messageKey(src: MessageKeySource): { key: string; kind: MessageKeyKind } {
  switch (src.source) {
    case 'hl7v2':
      if (!src.msh10) return { key: src.rawSha256, kind: 'sha256' };
      // D-12: control id reused with a different payload.
      return src.reused
        ? { key: `${src.msh10}:${src.rawSha256.slice(0, 16)}`, kind: 'msh10_reused' }
        : { key: src.msh10, kind: 'msh10' };
    case 'astm':
      return { key: src.rawSha256, kind: 'sha256' };
    case 'file_drop':
      return { key: src.fileSha256, kind: 'sha256' }; // the file's hash, not the metadata JSON's (review #22)
    case 'host_query_repeat':
      return { key: `${src.rawSha256}:${src.agentMessageId}`, kind: 'sha256_repeat' };
  }
}
