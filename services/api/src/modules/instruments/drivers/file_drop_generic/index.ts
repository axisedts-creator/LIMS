// file_drop_generic — exactly one `attachment` record per file (02-TRD §6.2). File bytes are never decoded.
// [CONV] The agent metadata reaches the driver as ctx.options { barcode?, attachment_instrument_code }: DriverContext has
// no other channel (spec gap, see .orchestra/notes/API-T07-tests.md).
import { MAX, malformed } from '../delimited.js';
import type { InstrumentDriver } from '../types.js';

export const fileDropGeneric: InstrumentDriver = Object.freeze<InstrumentDriver>({
  code: 'file_drop_generic',
  version: '0.1.0',
  protocol: 'file_drop',
  status: 'generic',
  capabilities: Object.freeze({ resultUpload: true, hostQuery: false, worklistDownload: false, qc: false, attachments: true, calibration: false }),
  optionsSchema: {
    type: 'object', additionalProperties: false, required: [],
    properties: {
      barcode: { type: 'string', minLength: 1, maxLength: MAX.barcode },
      attachment_instrument_code: { type: 'string', minLength: 1, maxLength: MAX.code },
    },
  },
  parse: (raw, ctx) => {
    if (raw.length === 0) return malformed('empty file');
    const code = ctx.options?.attachment_instrument_code;
    if (typeof code !== 'string' || code.length === 0 || code.length > MAX.code) return malformed('attachment_instrument_code missing or invalid');
    const barcode = ctx.options?.barcode;
    const warnings: string[] = [];
    let sampleBarcode: string | undefined;
    if (typeof barcode === 'string' && barcode.length > 0) {
      if (barcode.length <= MAX.barcode) sampleBarcode = barcode;
      else warnings.push('sample_barcode_too_long'); // never truncated: the attachment arrives unmatched
    }
    return {
      ok: true, messageKind: 'results',
      records: [{
        recordSeq: 1, recordClass: 'patient', ...(sampleBarcode !== undefined && { sampleBarcode }),
        recordKind: 'attachment', instrumentAnalyteCode: code, instrumentFlags: [], warnings: [],
      }],
      warnings,
    };
  },
});
