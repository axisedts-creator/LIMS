// T-P2 — A10 orders list (04-UI-UX A10; 03-APP-FLOW §11 A10 states; US-EN-07.1). Synthetic data only.
// A10 is NOT a polling screen: only A11 polls (US-EN-07.8). The list refreshes on open and on pull-to-refresh.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lims_shared/lims_shared.dart';
import 'package:lims_ui/lims_ui.dart';

import '../../support/orders_fakes.dart';
import '../../support/rig.dart';

const o1 = '01950c16-0000-7000-8000-000000000b01', o2 = '01950c16-0000-7000-8000-000000000b02', o3 = '01950c16-0000-7000-8000-000000000b03';

void main() {
  late Rig rig;
  late FakeOrdersApi api;

  setUp(() async {
    rig = await Rig.create();
    api = FakeOrdersApi()
      ..onList = (_) => {
            'data': [listed(o1, 'in_lab', reports: 1), listed(o2, 'report_ready', paymentDue: true, reports: 2), listed(o3, 'recollection_needed')],
            'page': {'limit': 50},
          };
  });
  tearDown(() => rig.dispose());

  testWidgets('opening A10 fetches E20 once (no filters) and shows one row per order, each with a LimsStatusChip (tone + word)', (tester) async {
    await openList(tester, rig, api);
    expect(api.listCalls, hasLength(1));
    expect(api.listCalls.single.stage, isNull);
    expect(api.listCalls.single.cursor, isNull);
    expect(find.byType(LimsStatusChip), findsNWidgets(3), reason: 'every status shows tone, icon and word (LD-140)');
    expect(find.text('In the lab'), findsOneWidget);
    expect(find.text('Report ready'), findsOneWidget);
    expect(find.textContaining('Payment due'), findsOneWidget, reason: 'badge only on the order with payment_due');
  });

  testWidgets('chip tones follow 04-UI-UX A10: in_lab info, report_ready success, recollection_needed danger', (tester) async {
    await openList(tester, rig, api);
    final tones = tester.widgetList<LimsStatusChip>(find.byType(LimsStatusChip)).map((c) => c.tone).toList();
    expect(tones, ['info', 'success', 'danger']);
  });

  testWidgets('the screen is a LimsSecureScreen (PHI, REQ-SEC-109) and shows no order ids or raw stage codes', (tester) async {
    await openList(tester, rig, api);
    expect(find.byType(LimsSecureScreen), findsOneWidget);
    expect(find.textContaining(o1), findsNothing);
    expect(find.textContaining('in_lab'), findsNothing);
    expect(find.textContaining('recollection_needed'), findsNothing);
  });

  testWidgets('empty list: "No orders yet"', (tester) async {
    api.onList = (_) => {'data': <Object?>[], 'page': {'limit': 50}};
    await openList(tester, rig, api);
    expect(find.text('No orders yet'), findsOneWidget);
    expect(find.byType(LimsStatusChip), findsNothing);
  });

  testWidgets('error: retry control, no server detail; retry refetches and shows the rows', (tester) async {
    final ok = api.onList;
    api.onList = (call) => call == 1 ? throw LimsException(LimsErrorCodes.commonInternal, safeDetail: 'db password hunter2') : ok(call);
    await openList(tester, rig, api);
    expect(find.textContaining('hunter2'), findsNothing);
    expect(find.byType(LimsStatusChip), findsNothing);
    await tester.tap(find.textContaining(RegExp('retry|try again', caseSensitive: false)));
    await tester.pump(const Duration(milliseconds: 20));
    await tester.pump(const Duration(milliseconds: 20));
    expect(api.listCalls, hasLength(2));
    expect(find.byType(LimsStatusChip), findsNWidgets(3));
  });

  testWidgets('pull to refresh fetches E20 again', (tester) async {
    await openList(tester, rig, api);
    await tester.fling(find.byType(Scrollable).first, const Offset(0, 400), 1000);
    await tester.pump(const Duration(milliseconds: 100));
    await tester.pump(const Duration(seconds: 1));
    await tester.pump(const Duration(seconds: 1));
    expect(api.listCalls.length, greaterThanOrEqualTo(2));
  });

  testWidgets('A10 does not poll: five minutes in the foreground cause no further E20 / E21 request', (tester) async {
    await openList(tester, rig, api);
    await elapse(tester, const Duration(minutes: 5));
    expect(api.listCalls, hasLength(1));
    expect(api.getCalls, isEmpty);
  });
}
