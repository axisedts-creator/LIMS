// PHLEBO-UI-FULL-1: the live position read from a booking's tracking block. Synthetic data only.
import 'package:flutter_test/flutter_test.dart';
import 'package:patient_app/features/mhn/live_collector_map.dart';

void main() {
  test('a well-formed position is read; its age is said in plain words', () {
    final p = LivePosition.of({
      'coordinates': {'latitude': 27.7, 'longitude': 85.3, 'accuracy_m': 12, 'captured_at': '2026-11-26T04:16:00.000Z'},
    })!;
    expect((p.latitude, p.longitude), (27.7, 85.3));
    expect(p.age(DateTime.utc(2026, 11, 26, 4, 16, 30)), 'just now');
    expect(p.age(DateTime.utc(2026, 11, 26, 4, 21)), '5 min ago');
  });

  test('no tracking, no coordinates, text instead of numbers or out-of-range values give no position', () {
    for (final bad in <Map<String, Object?>?>[
      null,
      {},
      {'coordinates': null},
      {'coordinates': 'here'},
      {'coordinates': {'latitude': '27.7', 'longitude': '85.3'}},
      {'coordinates': {'latitude': 27.7}},
      {'coordinates': {'latitude': 127.7, 'longitude': 85.3}},
      {'coordinates': {'latitude': 27.7, 'longitude': 285.3}},
    ]) {
      expect(LivePosition.of(bad), isNull, reason: '$bad');
    }
  });

  test('a position with no usable time still shows, as "recently"', () {
    final p = LivePosition.of({'coordinates': {'latitude': 27, 'longitude': 85, 'captured_at': 'not a time'}})!;
    expect(p.age(DateTime.utc(2026)), 'recently');
  });
}
