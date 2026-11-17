// Worker ctx.files.scan for re-scan jobs (08 A17 P-19): scan(await ctx.storage.read(bucket, path)). The worker accepts no uploads
// and has no download helper; only the scanner is shared with the API.
export { createFiles, type ScanResult } from '../../../../api/src/core/uploads/scan.js';
