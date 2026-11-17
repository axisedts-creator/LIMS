// lab.result.amended.v1 (03-IC §3.11; 02-TRD §8.2 row 2): supersede only when the live summary holds result_id at a version < new_version_no
// (absent result -> no change; same or later version = stale event -> no change).
import { consumer } from './supersede.js';

export const handle = consumer((inputs, p) => inputs.some((e) => {
  const i = e.lastIndexOf(':');
  return e.slice(0, i) === p['result_id'] && Number(e.slice(i + 1)) < Number(p['new_version_no']);
}));
