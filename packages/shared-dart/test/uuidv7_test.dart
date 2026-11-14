// T0A-04 / AC-0A-2.1, 2.2, 2.3 (Dart side; TRD §3.4 "same algorithm").
// ASSUMED API (see .orchestra/notes/T0A-04-tests.md), in lib/src/uuidv7.dart:
//   String uuidv7();  bool isUuidv7(String s);  int uuidv7Timestamp(String id);
//   String Function() createSeededUuidv7({required int seed, required int startMs, int stepMs = 1});
//   String buildUuidv7(int unixMs, List<int> rand /* 10 bytes */);
// Requires `test` in dev_dependencies (impl task).
import 'dart:convert';
import 'dart:io';

import 'package:lims_shared/src/uuidv7.dart';
import 'package:test/test.dart';

final _re = RegExp(
    r'^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$');

List<int> _hex(String h) => [
      for (var i = 0; i < h.length; i += 2) int.parse(h.substring(i, i + 2), radix: 16)
    ];

List<Map<String, dynamic>> _vectors() {
  final f = File('../test-fixtures/uuidv7/vectors.json');
  final j = jsonDecode(f.readAsStringSync()) as Map<String, dynamic>;
  return (j['vectors'] as List).cast<Map<String, dynamic>>();
}

void main() {
  group('AC-0A-2.1', () {
    test('10,000 ids sort in generation order and match Uuidv7 shape', () {
      final ids = List.generate(10000, (_) => uuidv7());
      expect(ids.every(_re.hasMatch), isTrue);
      expect(ids.toSet().length, ids.length);
      expect(([...ids]..sort()), ids);
    });

    test('uuidv7Timestamp is near now; isUuidv7 rejects bad input', () {
      final now = DateTime.now().millisecondsSinceEpoch;
      expect((uuidv7Timestamp(uuidv7()) - now).abs(), lessThan(5000));
      expect(isUuidv7('017f22e2-79b0-7cc3-98c4-dc0c0c07398f'), isTrue);
      for (final bad in [
        '017F22E2-79B0-7CC3-98C4-DC0C0C07398F',
        '017f22e2-79b0-4cc3-98c4-dc0c0c07398f',
        '017f22e2-79b0-7cc3-18c4-dc0c0c07398f',
        '017f22e279b07cc398c4dc0c0c07398f',
        '017f22e2-79b0-7cc3-98c4-dc0c0c07398f\n',
        '',
      ]) {
        expect(isUuidv7(bad), isFalse, reason: bad);
      }
    });
  });

  group('AC-0A-2.2', () {
    test('same seed+startMs => identical 100-id sequences; time-ordered', () {
      final a = createSeededUuidv7(seed: 42, startMs: 1700000000000);
      final b = createSeededUuidv7(seed: 42, startMs: 1700000000000);
      final sa = List.generate(100, (_) => a());
      expect(List.generate(100, (_) => b()), sa);
      expect(sa.every(_re.hasMatch), isTrue);
      expect(([...sa]..sort()), sa);
    });

    test('different seed differs; i-th timestamp == startMs + i*stepMs', () {
      final a = createSeededUuidv7(seed: 42, startMs: 1700000000000);
      final b = createSeededUuidv7(seed: 43, startMs: 1700000000000);
      expect(List.generate(10, (_) => a()), isNot(List.generate(10, (_) => b())));
      final g = createSeededUuidv7(seed: 1, startMs: 1700000000000, stepMs: 5);
      for (var i = 0; i < 20; i++) {
        expect(uuidv7Timestamp(g()), 1700000000000 + i * 5);
      }
    });
  });

  group('AC-0A-2.3 shared fixture', () {
    test('buildUuidv7 reproduces every vector in test-fixtures/uuidv7/vectors.json', () {
      final v = _vectors();
      expect(v.length, greaterThanOrEqualTo(5));
      for (final x in v) {
        expect(buildUuidv7(x['unixMs'] as int, _hex(x['randHex'] as String)),
            x['expected'], reason: x['name'] as String);
      }
    });

    test('RFC 9562 A.6 with junk high bits masked', () {
      expect(
          buildUuidv7(0x017f22e279b0,
              [0xfc, 0xc3, 0xd8, 0xc4, 0xdc, 0x0c, 0x0c, 0x07, 0x39, 0x8f]),
          '017f22e2-79b0-7cc3-98c4-dc0c0c07398f');
    });
  });
}
