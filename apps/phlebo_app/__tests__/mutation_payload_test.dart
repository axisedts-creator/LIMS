// Payload shape check at enqueue (lib/features/outbox/data/mutation_payload.dart). Mirror of the server's
// validateMutationPayload: a payload the server would refuse (400 for the whole batch) must never enter the outbox.
// Synthetic data only.
import 'package:flutter_test/flutter_test.dart';
import 'package:phlebo_app/features/outbox/data/mutation_payload.dart';
import 'package:phlebo_app/features/outbox/data/outbox_repository.dart';

import 'support/outbox_fixture.dart';

const _u = '0195f3a0-0000-4000-8000-000000000001';
const _u7 = '0195f3a0-0000-7000-8000-000000000001';
const _off = {'status': 'off'};

Map<String, Object?> _collected([Map<String, Object?> over = const {}]) => {
      'specimen_id': _u, 'scanned_barcode': 'E2600000042', 'scan_method': 'camera', 'specimen_type_code': 'EDTA_WB', 'gps': _off, ...over,
    };

void main() {
  final valid = <String, Map<String, Object?>>{
    'visit.arrived': {'gps': {'status': 'ok', 'latitude': '27.700000', 'longitude': '85.300000', 'accuracy_m': 12}},
    'visit.identity_checked': {'name_check': 'matches', 'second_identifier': 'phone', 'second_check': 'mismatch'},
    'visit.consent_recorded': {'consent_text_version': 'v1', 'given': true},
    'specimen.collected': _collected(),
    'specimen.not_collected': {'specimen_id': _u, 'reason_code': 'patient_refused', 'reason_text': 'synthetic note'},
    'payment.captured': {'order_id': _u, 'payment_method_code': 'cash', 'amount': {'amount_paisa': 150000, 'currency': 'NPR'}},
    'visit.completed': {'outcome': 'partial'},
    'visit.failed': {'reason_code': 'other', 'gps': _off},
    'handover.recorded': {'handover_id': _u7, 'to_centre_id': _u, 'specimen_ids': [_u]},
  };

  test('every mutation type of the repository has a schema and a valid example passes', () {
    expect(valid.keys.toSet(), mutationTypes);
    valid.forEach((type, p) => expect(mutationPayloadIsValid(type, p), isTrue, reason: type));
  });

  test('unknown type, non-map payload and a missing required key are refused', () {
    expect(mutationPayloadIsValid('visit.deleted', const {}), isFalse);
    expect(mutationPayloadIsValid('visit.completed', 'collected'), isFalse);
    expect(mutationPayloadIsValid('visit.completed', null), isFalse);
    for (final e in valid.entries) {
      for (final k in e.value.keys) {
        if (k == 'reason_text') continue; // optional
        expect(mutationPayloadIsValid(e.key, {...e.value}..remove(k)), isFalse, reason: '${e.key} without $k');
      }
    }
  });

  test('closed objects: an extra key is refused at every level', () {
    valid.forEach((type, p) => expect(mutationPayloadIsValid(type, {...p, 'extra': 1}), isFalse, reason: type));
    expect(mutationPayloadIsValid('visit.arrived', {'gps': {'status': 'off', 'extra': 1}}), isFalse);
    expect(mutationPayloadIsValid('payment.captured', {...valid['payment.captured']!, 'amount': {'amount_paisa': 1, 'currency': 'NPR', 'x': 1}}), isFalse);
  });

  test('specimen.collected: hostile or sloppy barcode input never passes', () {
    for (final bad in <Object?>[
      '', 'e2600000042', 'E26 00000042', 'E2600000042\n', 'A' * 21, "E26'; DROP TABLE x;--", 'https://example.invalid/x', 'ई२६', 42, null,
    ]) {
      expect(mutationPayloadIsValid('specimen.collected', _collected({'scanned_barcode': bad})), isFalse, reason: '$bad');
    }
    expect(mutationPayloadIsValid('specimen.collected', _collected({'scan_method': 'nfc'})), isFalse);
    expect(mutationPayloadIsValid('specimen.collected', _collected({'specimen_id': _u.toUpperCase()})), isFalse);
    expect(mutationPayloadIsValid('specimen.collected', _collected({'specimen_type_code': '-EDTA'})), isFalse);
  });

  test('gps: coordinates only with status ok, decimal strings, in range', () {
    bool gps(Map<String, Object?> g) => mutationPayloadIsValid('visit.arrived', {'gps': g});
    expect(gps({'status': 'denied'}), isTrue);
    expect(gps({'status': 'off', 'latitude': '27.7'}), isFalse);
    expect(gps({'status': 'ok'}), isFalse);
    expect(gps({'status': 'ok', 'latitude': '27.7'}), isFalse);
    expect(gps({'status': 'ok', 'latitude': 27.7, 'longitude': 85.3}), isFalse); // numbers, not DecimalString
    expect(gps({'status': 'ok', 'latitude': '90.1', 'longitude': '85.3'}), isFalse);
    expect(gps({'status': 'ok', 'latitude': '-90', 'longitude': '180'}), isTrue);
    expect(gps({'status': 'ok', 'latitude': '27.7', 'longitude': '180.5'}), isFalse);
    expect(gps({'status': 'ok', 'latitude': '1e2', 'longitude': '85.3'}), isFalse);
    expect(gps({'status': 'ok', 'latitude': '27.7', 'longitude': '85.3', 'accuracy_m': 10001}), isFalse);
    expect(gps({'status': 'ok', 'latitude': '27.7', 'longitude': '85.3', 'accuracy_m': 1.5}), isFalse);
    expect(gps({'status': 'moon'}), isFalse);
  });

  test('money, text and list bounds', () {
    Map<String, Object?> pay(Object? amount, [Object? ref]) => {'order_id': _u, 'payment_method_code': 'cash', 'amount': amount, if (ref != null) 'reference': ref};
    expect(mutationPayloadIsValid('payment.captured', pay({'amount_paisa': 0, 'currency': 'NPR'})), isFalse);
    expect(mutationPayloadIsValid('payment.captured', pay({'amount_paisa': -5, 'currency': 'NPR'})), isFalse);
    expect(mutationPayloadIsValid('payment.captured', pay({'amount_paisa': 50000001, 'currency': 'NPR'})), isFalse);
    expect(mutationPayloadIsValid('payment.captured', pay({'amount_paisa': 1.5, 'currency': 'NPR'})), isFalse);
    expect(mutationPayloadIsValid('payment.captured', pay({'amount_paisa': '100', 'currency': 'NPR'})), isFalse);
    expect(mutationPayloadIsValid('payment.captured', pay({'amount_paisa': 100, 'currency': 'USD'})), isFalse);
    expect(mutationPayloadIsValid('payment.captured', pay({'amount_paisa': 100, 'currency': 'NPR'}, 'R' * 100)), isTrue);
    expect(mutationPayloadIsValid('payment.captured', pay({'amount_paisa': 100, 'currency': 'NPR'}, 'R' * 101)), isFalse);
    expect(mutationPayloadIsValid('payment.captured', pay({'amount_paisa': 100, 'currency': 'NPR'}, '')), isFalse);
    expect(mutationPayloadIsValid('visit.failed', {'reason_code': 'other', 'gps': _off, 'reason_text': 'x' * 201}), isFalse);
    expect(mutationPayloadIsValid('visit.failed', {'reason_code': 'Other Reason', 'gps': _off}), isFalse);
    Map<String, Object?> hand(Object? ids, [String id = _u7]) => {'handover_id': id, 'to_centre_id': _u, 'specimen_ids': ids};
    expect(mutationPayloadIsValid('handover.recorded', hand(<String>[])), isFalse);
    expect(mutationPayloadIsValid('handover.recorded', hand(List.filled(50, _u))), isTrue);
    expect(mutationPayloadIsValid('handover.recorded', hand(List.filled(51, _u))), isFalse);
    expect(mutationPayloadIsValid('handover.recorded', hand([_u, 'nope'])), isFalse);
    expect(mutationPayloadIsValid('handover.recorded', hand([_u], _u)), isFalse); // handover_id must be UUIDv7
  });

  test('enqueue refuses a payload the server would refuse: nothing written, no value echoed', () async {
    final fx = await OutboxFx.create();
    addTearDown(fx.dispose);
    Object? err;
    try {
      await fx.repo.enqueue(type: 'specimen.collected', visitId: _u, payload: _collected({'scanned_barcode': 'e26-bad barcode'}));
    } catch (e) {
      err = e;
    }
    expect(err, isArgumentError);
    expect('$err', isNot(contains('e26-bad')));
    expect((await fx.rows('SELECT count(*) AS n FROM mutation_log')).single['n'], 0);
    expect((await fx.rows("SELECT value FROM device_state WHERE key='next_device_seq'")).single['value'], '1');
    // a valid one right after is saved with seq 1: the refusal burned nothing
    expect((await fx.repo.enqueue(type: 'specimen.collected', visitId: _u, payload: _collected())).deviceSeq, 1);
  });
}
