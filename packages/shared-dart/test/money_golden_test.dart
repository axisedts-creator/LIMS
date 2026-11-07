// T0A-07 / AC-0A-4.1, 4.2, 4.3 (Dart side; TRD §3.3 "mirrored in lims_shared", §3.4 money.dart `int` paisa).
// ASSUMED API (see .orchestra/notes/T0A-07-tests.md), in lib/src/money.dart:
//   class Money { final int amountPaisa; final String currency; }  // currency == 'NPR'
//   int paisa(int n); Money money(int amountPaisa); Money add(List<Money> m); Money sub(Money a, Money b);
//   Money mulQty(Money m, int qty); Money percentOf(Money m, int basisPoints);
//   List<Money> allocate(Money total, List<int> weights); int compare(Money a, Money b); bool isZero(Money m);
//   String format(Money m, {String grouping = 'lakh', String symbol = 'Rs.'});
// Fixture schema is documented in packages/shared-ts/test/money.test.mjs. Error type unspecified: any throw.
import 'dart:convert';
import 'dart:io';

import 'package:lims_shared/src/money.dart' as m;
import 'package:test/test.dart';

const maxSafe = 9007199254740991;
final maxSafeN = BigInt.from(maxSafe);

List<Map<String, dynamic>> _cases() {
  final f = File('../test-fixtures/money/golden.json');
  final j = jsonDecode(f.readAsStringSync()) as Map<String, dynamic>;
  return (j['cases'] as List).cast<Map<String, dynamic>>();
}

m.Money _m(Object? n) => m.money(n! as int);
List<int> _ints(Object? l) => (l! as List<Object?>).cast<int>();

// Independent BigInt oracle.
BigInt _pct(int a, int bp) =>
    (BigInt.from(a) * BigInt.from(bp) + BigInt.from(5000)) ~/ BigInt.from(10000);

List<int> _alloc(int total, List<int> w) {
  final t = BigInt.from(total);
  final ws = w.map(BigInt.from).toList();
  final s = ws.fold(BigInt.zero, (x, y) => x + y);
  final base = ws.map((x) => (t * x) ~/ s).toList();
  final rem = ws.map((x) => (t * x) % s).toList();
  var left = t - base.fold(BigInt.zero, (x, y) => x + y);
  final order = List.generate(ws.length, (i) => i)
    ..sort((i, j) => rem[j] != rem[i] ? rem[j].compareTo(rem[i]) : i.compareTo(j));
  for (final i in order) {
    if (left <= BigInt.zero) break;
    base[i] += BigInt.one;
    left -= BigInt.one;
  }
  return base.map((x) => x.toInt()).toList();
}

String _fmt(int a, String grouping, String symbol) {
  final s = a.toString().padLeft(3, '0');
  final ip = s.substring(0, s.length - 2), fp = s.substring(s.length - 2);
  String g;
  if (ip.length <= 3) {
    g = ip;
  } else if (grouping == 'international') {
    g = ip.replaceAllMapped(RegExp(r'\B(?=(\d{3})+(?!\d))'), (_) => ',');
  } else {
    g = ip.substring(0, ip.length - 3).replaceAllMapped(RegExp(r'\B(?=(\d{2})+(?!\d))'), (_) => ',') +
        ',' + ip.substring(ip.length - 3);
  }
  return '$symbol $g.$fp';
}

// Deterministic PRNG so failures reproduce.
int _state = 0x7a0a07;
double _rnd() {
  _state = (_state + 0x6d2b79f5) & 0xffffffff;
  var t = _state;
  t = ((t ^ (t >> 15)) * (t | 1)) & 0xffffffff;
  t ^= (t + (((t ^ (t >> 7)) * (t | 61)) & 0xffffffff)) & 0xffffffff;
  return ((t ^ (t >> 14)) & 0xffffffff) / 4294967296;
}

int _rbig(int maxBits) {
  final bits = (_rnd() * (maxBits + 1)).floor();
  var v = BigInt.zero;
  for (var i = 0; i < bits; i++) {
    v = (v << 1) | (_rnd() < 0.5 ? BigInt.one : BigInt.zero);
  }
  return (v > maxSafeN ? maxSafeN : v).toInt();
}

void main() {
  group('AC-0A-4.1 guards', () {
    test('money rejects values beyond the safe-integer range (CV §4.9 schema bounds)', () {
      expect(() => m.money(maxSafe + 1), throwsA(anything));
      expect(() => m.money(-maxSafe - 1), throwsA(anything));
      expect(m.money(maxSafe).amountPaisa, maxSafe);
      expect(m.money(12345).amountPaisa, 12345);
      expect(m.money(12345).currency, 'NPR');
      expect(() => m.paisa(maxSafe + 1), throwsA(anything));
    });
    test('mulQty / percentOf / add / allocate reject bad input', () {
      expect(() => m.mulQty(_m(1000), -1), throwsA(anything));
      expect(() => m.mulQty(_m(maxSafe), 2), throwsA(anything));
      expect(() => m.percentOf(_m(10000), -1), throwsA(anything));
      expect(() => m.add([_m(maxSafe), _m(1)]), throwsA(anything));
      expect(() => m.sub(_m(-maxSafe), _m(1)), throwsA(anything));
      expect(m.add([]).amountPaisa, 0);
      for (final w in [<int>[], [0, 0], [-1, 2]]) {
        expect(() => m.allocate(_m(100), w), throwsA(anything), reason: '$w');
      }
      expect(() => m.allocate(_m(-1), [1, 1]), throwsA(anything));
    });
    test('compare / isZero', () {
      expect(m.compare(_m(1), _m(2)), -1);
      expect(m.compare(_m(2), _m(2)), 0);
      expect(m.compare(_m(3), _m(2)), 1);
      expect(m.isZero(_m(0)), isTrue);
      expect(m.isZero(_m(1)), isFalse);
    });
  });

  group('AC-0A-4.2 golden (Dart side)', () {
    test('fixture has >= 200 cases', () => expect(_cases().length, greaterThanOrEqualTo(200)));

    test('impl reproduces every golden case exactly', () {
      for (final c in _cases()) {
        final id = c['id'];
        switch (c['op']) {
          case 'percentOf':
            expect(m.percentOf(_m(c['amountPaisa']!), c['bp'] as int).amountPaisa, c['expected'], reason: '$id');
          case 'mulQty':
            expect(m.mulQty(_m(c['amountPaisa']!), c['qty'] as int).amountPaisa, c['expected'], reason: '$id');
          case 'add':
            expect(m.add(_ints(c['amounts']!).map(m.money).toList()).amountPaisa, c['expected'], reason: '$id');
          case 'sub':
            expect(m.sub(_m(c['a']!), _m(c['b']!)).amountPaisa, c['expected'], reason: '$id');
          case 'compare':
            expect(m.compare(_m(c['a']!), _m(c['b']!)), c['expected'], reason: '$id');
          case 'allocate':
            expect(m.allocate(_m(c['totalPaisa']!), _ints(c['weights']!)).map((x) => x.amountPaisa).toList(),
                _ints(c['expected']!), reason: '$id');
          case 'format':
            expect(
                m.format(_m(c['amountPaisa']!),
                    grouping: (c['grouping'] as String?) ?? 'lakh', symbol: (c['symbol'] as String?) ?? 'Rs.'),
                c['expected'],
                reason: '$id');
          default:
            fail('unknown op ${c['op']}');
        }
      }
    });

    test('spec examples', () {
      expect(m.percentOf(_m(10000), 1300).amountPaisa, 1300);
      expect(m.percentOf(_m(1), 5000).amountPaisa, 1);
      expect(m.percentOf(_m(3), 1666).amountPaisa, 0);
      expect(m.format(_m(123456789)), 'Rs. 12,34,567.89');
      expect(m.format(_m(123456789), grouping: 'international'), 'Rs. 1,234,567.89');
      expect(m.format(_m(5)), 'Rs. 0.05');
      expect(m.allocate(_m(100), [1, 1, 1]).map((x) => x.amountPaisa).toList(), [34, 33, 33]);
      expect(m.allocate(_m(5), [1, 0, 1]).map((x) => x.amountPaisa).toList(), [3, 0, 2]);
    });
  });

  group('AC-0A-4.3 fuzz vs BigInt oracle (same seeds/shape as TS)', () {
    test('percentOf over the whole safe range', () {
      for (var i = 0; i < 3000; i++) {
        final a = _rbig(53), bp = (_rnd() * 20001).floor();
        final want = _pct(a, bp);
        if (want > maxSafeN) {
          expect(() => m.percentOf(_m(a), bp), throwsA(anything), reason: '$a x $bp');
        } else {
          expect(BigInt.from(m.percentOf(_m(a), bp).amountPaisa), want, reason: '$a x $bp');
        }
      }
      for (final bp in [1, 1300, 5000, 9999, 10000]) {
        expect(BigInt.from(m.percentOf(_m(maxSafe), bp).amountPaisa), _pct(maxSafe, bp), reason: 'bp $bp');
      }
    });
    test('mulQty / add', () {
      for (var i = 0; i < 3000; i++) {
        final a = _rbig(53), q = _rbig(30), want = BigInt.from(a) * BigInt.from(q);
        if (want > maxSafeN) {
          expect(() => m.mulQty(_m(a), q), throwsA(anything), reason: '$a x $q');
        } else {
          expect(BigInt.from(m.mulQty(_m(a), q).amountPaisa), want, reason: '$a x $q');
        }
        final xs = List.generate(2 + (_rnd() * 5).floor(), (_) => _rbig(50));
        final sum = xs.fold(BigInt.zero, (s, x) => s + BigInt.from(x));
        if (sum > maxSafeN) {
          expect(() => m.add(xs.map(m.money).toList()), throwsA(anything));
        } else {
          expect(BigInt.from(m.add(xs.map(m.money).toList()).amountPaisa), sum);
        }
      }
    });
    test('allocate: oracle equal and sum preserved', () {
      for (var i = 0; i < 3000; i++) {
        final total = _rbig(i % 3 == 0 ? 53 : 40);
        final w = List.generate(1 + (_rnd() * 8).floor(), (_) => _rbig(i % 2 == 1 ? 53 : 12));
        if (w.every((x) => x == 0)) w[0] = 1;
        final got = m.allocate(_m(total), w).map((x) => x.amountPaisa).toList();
        expect(got.fold<BigInt>(BigInt.zero, (s, x) => s + BigInt.from(x)), BigInt.from(total));
        expect(got, _alloc(total, w), reason: 'total $total weights $w');
      }
    });
    test('format matches oracle', () {
      for (var i = 0; i < 1000; i++) {
        final a = _rbig(53), g = i.isOdd ? 'lakh' : 'international';
        expect(m.format(_m(a), grouping: g), _fmt(a, g, 'Rs.'));
      }
    });
  });
}
