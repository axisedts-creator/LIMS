// HC-T27 M10 Handover (04-UI-UX §3.10, US-12-1/3 device side, TRD §6.3 handover.recorded). ASSUMED API: support/hc27_fixture.dart.
// handover.recorded: visit_id absent (sink visitId null), payload {handover_id: Uuidv7, to_centre_id, specimen_ids[1..50]}, no PHI.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lims_ui/lims_ui.dart';
import 'package:phlebo_app/features/handover/domain/handover_models.dart';
import 'package:phlebo_app/features/handover/ui/handover_screen.dart';

import 'support/hc27_fixture.dart';

void main() {
  late RecordingSink sink;
  late List<String> done;

  Future<void> open(
    WidgetTester t, {
    List<HandoverTube>? tubes,
    Map<String, String> results = const {},
    List<HandoverCentre>? useCentres,
  }) async {
    sink = RecordingSink();
    done = [];
    await pumpScreen(
      t,
      HandoverScreen(
        centres: useCentres ?? centres,
        tubes: tubes ?? threeTubes(),
        itemResults: results,
        sink: sink,
        newId: () => handoverId,
        onDone: done.add,
      ),
    );
  }

  Finder box(String specimenId) => find.byKey(ValueKey('handover.tube.$specimenId'));

  testWidgets('copy, centre choice and the list of collected tubes, all selected by default', (t) async {
    await open(t);
    expect(find.text('Give the tubes to the centre staff. They will scan them to confirm.'), findsOneWidget);
    expect(find.text('Synthetic Centre A2'), findsOneWidget);
    expect(find.text('Synthetic Centre B1'), findsOneWidget);
    for (final id in [specA, specB, specC]) {
      expect(t.widget<Checkbox>(find.descendant(of: box(id), matching: find.byType(Checkbox))).value, isTrue, reason: id);
    }
    expect(find.textContaining('Serum'), findsWidgets);
    expect(find.textContaining('0042'), findsOneWidget);
  });

  testWidgets('US-12-1: choose centre, "Hand over 3 tubes" = ONE handover.recorded (no visit id, no PHI)', (t) async {
    await open(t);
    await tapText(t, 'Synthetic Centre A2');
    expect(isEnabled(t, 'Hand over 3 tubes'), isTrue);
    await tapButton(t, 'Hand over 3 tubes');
    expect(sink.types, ['handover.recorded']);
    final c = sink.only('handover.recorded');
    expect(c.visitId, isNull, reason: 'handover.recorded has no visit_id');
    expect(c.payload, {
      'handover_id': handoverId,
      'to_centre_id': centreA,
      'specimen_ids': [specA, specB, specC],
    });
    expect(done, [handoverId]);
    final blob = '${c.payload} ${c.visitLabel}';
    for (final s in [patientName, patientPhone, patientAddress, 'HC00000042']) {
      expect(blob.contains(s), isFalse, reason: 'PHI/barcode "$s" in the handover mutation');
    }
  });

  testWidgets('button count follows the selection; unchecked tubes are left out of specimen_ids', (t) async {
    await open(t);
    await tapText(t, 'Synthetic Centre B1');
    await t.tap(box(specB));
    await t.pumpAndSettle();
    expect(find.text('Hand over 2 tubes'), findsOneWidget);
    await tapButton(t, 'Hand over 2 tubes');
    expect(sink.only('handover.recorded').payload['specimen_ids'], [specA, specC]);
    expect(sink.only('handover.recorded').payload['to_centre_id'], centreB);
  });

  testWidgets('nothing is written until a centre is chosen and at least one tube is selected', (t) async {
    await open(t);
    expect(isEnabled(t, 'Hand over 3 tubes'), isFalse, reason: 'no centre yet');
    await tapText(t, 'Synthetic Centre A2');
    for (final id in [specA, specB, specC]) {
      await t.tap(box(id));
      await t.pumpAndSettle();
    }
    expect(find.byWidgetPredicate((w) => w is LimsButton && !w.secondary && w.onPressed != null), findsNothing,
        reason: 'zero tubes selected: no enabled primary button');
    expect(sink.calls, isEmpty);
  });

  testWidgets('more than 50 tubes cannot be sent in one handover (specimen_ids is 1..50)', (t) async {
    final many = [for (var i = 0; i < 51; i++) tube('01a1a98a-ac40-7000-8000-0000000a${i.toString().padLeft(4, '0')}', 'Serum', 'HC${10000000 + i}')];
    await open(t, tubes: many);
    await tapText(t, 'Synthetic Centre A2');
    expect(find.text('Hand over 51 tubes'), findsNothing);
    expect(find.byWidgetPredicate((w) => w is LimsButton && !w.secondary && w.onPressed != null), findsNothing);
    expect(sink.calls, isEmpty);
  });

  testWidgets('UI acks only after the mutation is persisted; a double tap enqueues once', (t) async {
    await open(t);
    sink.gate = Completer<void>();
    await tapText(t, 'Synthetic Centre A2');
    await t.tap(button('Hand over 3 tubes'));
    await t.pump();
    await t.tap(button('Hand over 3 tubes'), warnIfMissed: false);
    await t.pump();
    expect(sink.calls.length, 1, reason: 'second tap while the save is pending');
    expect(done, isEmpty, reason: 'not acknowledged before COMMIT');
    sink.gate!.complete();
    await t.pumpAndSettle();
    expect(done, [handoverId]);
    expect(sink.calls.length, 1);
  });

  testWidgets('a failed save shows "Couldn\'t save…" and does not move on', (t) async {
    await open(t);
    sink.failWith = StateError('disk full');
    await tapText(t, 'Synthetic Centre A2');
    await tapButton(t, 'Hand over 3 tubes');
    expect(find.textContaining("Couldn't save"), findsOneWidget);
    expect(done, isEmpty);
  });

  testWidgets('US-12-3: after sync each tube shows Included / Not collected by you / Already handed over', (t) async {
    await open(t, results: {
      specA: 'included',
      specB: 'skipped_not_collected',
      specC: 'skipped_already_handed_over',
    });
    expect(find.text('Included'), findsOneWidget);
    expect(find.text('Not collected by you'), findsOneWidget);
    expect(find.text('Already handed over'), findsOneWidget);
  });

  testWidgets('no collected tubes waiting: empty state, nothing to hand over', (t) async {
    await open(t, tubes: const []);
    expect(find.byType(LimsEmptyState), findsOneWidget);
    expect(find.byWidgetPredicate((w) => w is LimsButton && !w.secondary && w.onPressed != null), findsNothing);
  });

  testWidgets('LD-140: LimsSecureScreen + LimsScaffold, one primary button, 2.0 text scale does not overflow', (t) async {
    await open(t);
    expect(find.byType(LimsSecureScreen), findsOneWidget);
    expect(find.byType(LimsScaffold), findsOneWidget);
    expectOnePrimary(t);
    await pumpScreen(
      t,
      HandoverScreen(centres: centres, tubes: threeTubes(), itemResults: const {}, sink: sink, newId: () => handoverId, onDone: done.add),
      textScale: 2.0,
    );
    expect(t.takeException(), isNull);
  });
}
