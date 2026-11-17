// Money (02-TRD §3.3 / §3.4; CV §4.9). `int` paisa within ±(2^53 - 1); intermediates are BigInt
// so results match the TS side on every platform.

const int _maxSafe = 9007199254740991;
final BigInt _max = BigInt.from(_maxSafe);

class Money {
  const Money._(this.amountPaisa);
  final int amountPaisa;
  String get currency => 'NPR';

  @override
  bool operator ==(Object other) => other is Money && other.amountPaisa == amountPaisa;
  @override
  int get hashCode => amountPaisa.hashCode;
  @override
  String toString() => 'Money($amountPaisa $currency)';
}

/// Throws unless [n] is within the safe-integer range (CV §4.9 schema bounds).
int paisa(int n) {
  if (n > _maxSafe || n < -_maxSafe) throw RangeError('paisa: not a safe integer: $n');
  return n;
}

Money money(int amountPaisa) => Money._(paisa(amountPaisa));

BigInt _nonNeg(int n, String what) {
  if (n < 0 || n > _maxSafe) throw RangeError('$what: must be a safe integer >= 0: $n');
  return BigInt.from(n);
}

BigInt _big(Money m) => BigInt.from(m.amountPaisa);

Money _out(BigInt v) {
  if (v > _max || v < -_max) throw RangeError('money: result outside the safe-integer range: $v');
  return money(v.toInt());
}

/// Floor division (`~/` truncates toward zero).
BigInt _floorDiv(BigInt a, BigInt b) {
  final q = a ~/ b;
  return a.remainder(b) != BigInt.zero && a.isNegative != b.isNegative ? q - BigInt.one : q;
}

Money add(List<Money> m) => _out(m.fold(BigInt.zero, (s, x) => s + _big(x)));

Money sub(Money a, Money b) => _out(_big(a) - _big(b));

/// [qty] integer >= 0.
Money mulQty(Money m, int qty) => _out(_big(m) * _nonNeg(qty, 'qty'));

/// Half-up to the paisa: floor((a * bp + 5000) / 10000). 1300 bp = 13% VAT (04 L14).
Money percentOf(Money m, int basisPoints) => _out(
    _floorDiv(_big(m) * _nonNeg(basisPoints, 'basisPoints') + BigInt.from(5000), BigInt.from(10000)));

/// Largest remainder; sum(result) == total; remainder ties go to the lowest index [CONV].
List<Money> allocate(Money total, List<int> weights) {
  final t = _big(total);
  if (t.isNegative) throw RangeError('allocate: total must be >= 0');
  if (weights.isEmpty) throw RangeError('allocate: weights must be non-empty');
  final w = weights.map((x) => _nonNeg(x, 'weight')).toList();
  final s = w.fold(BigInt.zero, (a, b) => a + b);
  if (s == BigInt.zero) throw RangeError('allocate: weights must not all be zero');
  final base = w.map((x) => (t * x) ~/ s).toList();
  final rem = w.map((x) => (t * x) % s).toList();
  var left = t - base.fold(BigInt.zero, (a, b) => a + b);
  final order = List.generate(w.length, (i) => i)
    ..sort((i, j) => rem[j] != rem[i] ? rem[j].compareTo(rem[i]) : i.compareTo(j));
  for (final i in order) {
    if (left == BigInt.zero) break;
    base[i] += BigInt.one;
    left -= BigInt.one;
  }
  return base.map(_out).toList();
}

int compare(Money a, Money b) => a.amountPaisa.compareTo(b.amountPaisa).sign;

bool isZero(Money m) => m.amountPaisa == 0;

String _group(String s, String grouping) {
  if (s.length <= 3) return s;
  if (grouping == 'international') return s.replaceAllMapped(RegExp(r'\B(?=(\d{3})+(?!\d))'), (_) => ',');
  return '${s.substring(0, s.length - 3).replaceAllMapped(RegExp(r'\B(?=(\d{2})+(?!\d))'), (_) => ',')},'
      '${s.substring(s.length - 3)}';
}

/// Display only (wire stays integer paisa). Default `lakh` grouping and `Rs.` [CONV]; negatives as `-Rs. 1.00` [CONV].
String format(Money m, {String grouping = 'lakh', String symbol = 'Rs.'}) {
  if (grouping != 'lakh' && grouping != 'international') throw ArgumentError.value(grouping, 'grouping');
  if (symbol != 'Rs.' && symbol != 'NPR') throw ArgumentError.value(symbol, 'symbol');
  final v = m.amountPaisa;
  final s = v.abs().toString().padLeft(3, '0');
  return '${v < 0 ? '-' : ''}$symbol ${_group(s.substring(0, s.length - 2), grouping)}.${s.substring(s.length - 2)}';
}
