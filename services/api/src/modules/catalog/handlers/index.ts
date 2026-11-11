// One handler per catalog.yaml operationId (02-CV §2.2; the core fails boot if one is missing).
// T-01: every entry is a stub. Each later task swaps its entries for real ./<operationId>.ts handlers and removes
// them from __tests__/probes/pending.json (CR-C3-008; the list must be empty at M6).
import type { Handler } from '../../../core/module.js';
import { analyteVersionsHandlers } from './analyteVersions.handlers.js';
import { creditPartiesHandlers } from './creditParties.handlers.js';
import { exportsHandlers } from './exports.handlers.js';
import { formulasHandlers } from './formulas.handlers.js';
import { healthHandlers } from './health.handlers.js';
import { importsHandlers } from './imports.handlers.js';
import { instrumentMapsHandlers } from './instrumentMaps.handlers.js';
import { mastersHandlers } from './masters.handlers.js';
import { panelsHandlers } from './panels.handlers.js';
import { pricingHandlers } from './pricing.handlers.js';
import { rangePreviewHandlers } from './rangePreview.handlers.js';
import { rangesHandlers } from './ranges.handlers.js';
import { referrersHandlers } from './referrers.handlers.js';
import { testsHandlers } from './tests.handlers.js';

export const handlers: Readonly<Record<string, Handler>> = Object.freeze({
  ...healthHandlers, // T-30: #1 (revision), #4 (health report)
  ...mastersHandlers, // T-04: #5–#16; T-05: #17–#22 (units, value sets); T-13: #57–#59 (comment codes)
  ...testsHandlers, // T-06: #2, #23–#27; T-14: #28
  ...analyteVersionsHandlers, // T-07: #29–#35
  ...formulasHandlers, // T-11: #36
  ...rangesHandlers, // T-08: #37–#50 (reference-range + critical-limit sets)
  ...rangePreviewHandlers, // T-10: #51
  ...panelsHandlers, // T-12: #52–#56, #3
  ...referrersHandlers, // T-15: #60–#66 (doctors)
  ...creditPartiesHandlers, // T-16: #67–#70 (credit parties)
  ...pricingHandlers, // T-17: #71–#81 (price lists); T-19: #82 (quotePrices); T-18: #83–#91 (surcharge / tax)
  ...instrumentMapsHandlers, // T-27: #92–#95 (instrument code maps)
  ...importsHandlers,
  ...exportsHandlers, // T-36: #104–#107 (export API)
});
