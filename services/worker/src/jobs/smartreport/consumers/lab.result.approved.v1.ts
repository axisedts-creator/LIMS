// lab.result.approved.v1 (03-IC §3.10; 02-TRD §8.2 row 1): supersede when the live summary's hashed approved set lacks "<result_id>:<result_version_no>".
import { consumer } from './supersede.js';

export const handle = consumer((inputs, p) => !inputs.includes(`${p['result_id']}:${p['result_version_no']}`));
