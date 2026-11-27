// PHLEBO-UI-FULL-1: the preview's pretend centre must feed the real app, or the phone preview shows errors instead.
import 'package:flutter_test/flutter_test.dart';
import 'package:phlebo_app/app/controller.dart';
import 'package:phlebo_app/preview/preview_api.dart';

import 'support/db_fixture.dart';
import 'support/outbox_fixture.dart' show FakeBootId, FakeMonotonicClock;
import 'app_controller_e2e_test.dart' show FakePhone;

void main() {
  test('preview: sign in shows the demo route, a typed demo barcode is collected and uploads', () async {
    final dir = newTempDir();
    final app = AppController(
      phone: FakePhone(dir),
      keyStore: FakeKeyStore(),
      apiBuilder: (_, __, ___) => PreviewApi(DateTime.now),
      clock: FakeMonotonicClock(1000),
      bootId: FakeBootId('b'),
      appVersion: '0.0.0',
      mutationDebounce: const Duration(hours: 1),
    );
    addTearDown(() async {
      await app.dispose();
      deleteQuietly(dir);
    });
    await app.start();
    expect(await app.signIn('demo@example.test', previewRejectedEntry), badLoginText);
    expect(await app.signIn('demo@example.test', 'anything'), isNull);
    await app.syncNow();
    expect(app.syncMessage, isNull);
    expect(app.offline, isFalse);
    expect(app.day.visits, hasLength(5));
    expect(app.day.centres, hasLength(2));
    final view = app.day.next!.view!;
    expect(view.tubes.map((t) => t.barcode), ['DEMO11', 'DEMO12']);

    await app.enqueue(type: 'visit.arrived', visitId: view.visitId, visitLabel: view.label, payload: {'gps': {'status': 'off'}});
    await app.syncNow();
    expect(app.sync.waiting, 0);
    expect(app.day.visit(view.visitId)!.row.status, 'in_progress');
  });
}
