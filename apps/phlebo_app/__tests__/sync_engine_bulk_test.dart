// Quality gate: 500 queued mutations, 5 of them refused by the server, drain in ONE sync cycle.
// A refused mutation is answered per mutation (C17 02-TRD §6.3 step 4): it must not hold back the other 495 or a later visit.
// Synthetic data only.
import 'package:flutter_test/flutter_test.dart';
import 'package:phlebo_app/core/sync/sync_engine.dart';

import 'support/outbox_fixture.dart';
import 'support/sync_fixture.dart';
import 'support/tls_fixture.dart';

void main() {
  late TestPki pki;
  late SyncFx fx;

  setUpAll(() async => pki = await TestPki.create());
  setUp(() async => fx = await SyncFx.create(pki));
  tearDown(() async => fx.dispose());

  test('500 mutations, 5 rejected by the server: 495 applied, 5 rejected, queue empty, nothing resent', () async {
    fx.server.outcomeOverride['specimen.collected'] = ('rejected', 'homecollection.barcode_mismatch');
    final rejectedIds = <String>{};
    for (var i = 0; i < 500; i++) {
      fx.ofx.tick(const Duration(seconds: 1));
      if (i % 100 == 50) {
        rejectedIds.add((await enqueueType(fx.ofx, 'specimen.collected')).clientMutationId);
      } else {
        await enqueueType(fx.ofx, 'visit.arrived', visit: i.isEven ? visitA : visitB);
      }
    }
    expect(rejectedIds, hasLength(5));

    final r = await fx.sync();
    expect(r.status, SyncStatus.ok);
    expect(r.batchesPushed, 5);
    expect(fx.server.batchSizes, [100, 100, 100, 100, 100]);
    expect(fx.server.appliedCount, 495);
    expect(fx.server.errors, isEmpty);

    final rows = await fx.ofx.rows('SELECT client_mutation_id, state, outcome_code FROM mutation_log');
    expect(rows.where((x) => x['state'] == 'applied'), hasLength(495));
    final rejected = rows.where((x) => x['state'] == 'rejected').toList();
    expect({for (final x in rejected) x['client_mutation_id']}, rejectedIds);
    expect({for (final x in rejected) x['outcome_code']}, {'homecollection.barcode_mismatch'});
    expect(await fx.batchRows(), 0);

    // a second cycle has nothing to push: a rejected row is terminal, never resent
    final pushesBefore = fx.server.batchSizes.length;
    expect((await fx.sync()).status, SyncStatus.ok);
    expect(fx.server.batchSizes.length, pushesBefore);

    // and work captured after the rejections still goes through
    fx.server.outcomeOverride.clear();
    await enqueueType(fx.ofx, 'visit.arrived');
    expect((await fx.sync()).batchesPushed, 1);
    expect(fx.server.appliedCount, 496);
  }, timeout: const Timeout(Duration(minutes: 3)));
}
