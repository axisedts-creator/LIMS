// The CI job c17-db-forensics runs this path (pinned in tools/lint/tests/ci-chunk-jobs.test.mjs).
// The test itself lives with the other tests; this file only runs it.
import '../__tests__/db_forensics_test.dart' as forensics;

void main() => forensics.main();
