// astm_generic_e1394 — 02-TRD §6.2. Field defaults follow common LIS2-A2 usage and are UNVERIFIED (CLSI text not opened).
// Host query is off (capabilities.hostQuery = false, 04 N14); no reply builder is shipped until a driver is verified.
import { OPTIONS_SCHEMA, isDelim, parseDelimited, type Profile, type Ref } from '../delimited.js';
import type { InstrumentDriver } from '../types.js';

const ref = (seg: string, field: number, comp: number): Ref => ({ seg, field, comp });

const ASTM: Profile = {
  header: 'H',
  emit: 'R',
  querySeg: 'Q',
  resets: { P: ['O', 'R'], O: ['R'] },
  // H|\^&  -> field '|', repeat '\', component '^', escape '&'
  delims: (h) => {
    const [field, repeat, component, escape] = [h[1], h[2], h[3], h[4]];
    if (!isDelim(field) || !isDelim(repeat) || !isDelim(component) || !isDelim(escape)) return undefined;
    if (new Set([field, repeat, component, escape]).size !== 4) return undefined;
    return { field, repeat, component };
  },
  index: (_seg, n) => n - 1, // record type is field 1
  kind: (_get, hasResults, hasQuery) => (hasResults ? 'results' : hasQuery ? 'host_query' : 'other'),
  defaults: {
    sample: [ref('O', 3, 1), ref('O', 4, 1)],
    testCode: ref('R', 3, 4),
    value: ref('R', 4, 0),
    unit: ref('R', 5, 0),
    flags: ref('R', 7, 0),
    status: ref('R', 9, 1),
    time: [ref('R', 13, 1), ref('H', 14, 1)],
    messageTime: ref('H', 14, 1),
  },
};

export const astmGenericE1394: InstrumentDriver = Object.freeze<InstrumentDriver>({
  code: 'astm_generic_e1394',
  version: '0.1.0',
  protocol: 'astm',
  status: 'generic',
  capabilities: Object.freeze({ resultUpload: true, hostQuery: false, worklistDownload: false, qc: true, attachments: false, calibration: false }),
  optionsSchema: OPTIONS_SCHEMA,
  parse: (raw, ctx) => parseDelimited(ASTM, raw, ctx),
});
