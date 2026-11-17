// Mindray sketches — 02-TRD §6.3, BLOCKED B2. Illustrative only: status sketch_blocked, parse = hl7v2_generic_oru,
// buildHostQueryReply is a placeholder that always throws. Nothing else about Mindray segment contents is assumed.
import { LimsError } from '../../../core/errors.js';
import { hl7v2GenericOru } from './hl7v2_generic_oru/index.js';
import type { InstrumentDriver } from './types.js';

const sketch = (code: string): InstrumentDriver => Object.freeze<InstrumentDriver>({
  code,
  version: '0.0.1',
  protocol: 'hl7v2',
  status: 'sketch_blocked',
  capabilities: Object.freeze({ resultUpload: true, hostQuery: true, worklistDownload: false, qc: false, attachments: false, calibration: false }),
  optionsSchema: hl7v2GenericOru.optionsSchema,
  parse: hl7v2GenericOru.parse,
  buildHostQueryReply: () => { throw new LimsError('instruments.driver_not_available'); },
});

export const mindrayBc5380Sketch = sketch('mindray_bc5380_sketch'); // agent profile HostQueryMessageTypes ["ORM^O01"]
export const mindrayBs200Sketch = sketch('mindray_bs200_sketch');   // agent profile HostQueryMessageTypes ["QRY^Q02"]
