// T0D-17 API: ctx.files.scan against a fake clamd (INSTREAM over TCP). Fails now: ../index.js missing.
import { scanSuite } from './suite.js';

scanSuite('api uploads', () => import('../index.js') as any);
