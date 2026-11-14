// T0D-17 worker storage adapter: same contract as the API's (suite shared by relative import; both services are C0-0D paths).
import { storageSuite } from '../../../../../api/src/core/storage/__tests__/suite.js';

storageSuite('worker storage', () => import('../index.js') as any);
