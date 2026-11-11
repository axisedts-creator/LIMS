// UUIDv7 (02-TRD §3.3 / §3.4; RFC 9562 §5.7). Same algorithm as packages/shared-ts/src/uuidv7.
import 'dart:math';

final _re = RegExp(
    r'^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$');
const _maxMs = 0xffffffffffff; // 2^48 - 1

/// Pure layout: 48-bit ms + 10 random bytes (rand[0] low nibble + rand[1] = rand_a;
/// rand[2..9] = rand_b, high bits masked).
String buildUuidv7(int unixMs, List<int> rand) {
  if (unixMs < 0 || unixMs > _maxMs) {
    throw RangeError('unixMs out of 48-bit range');
  }
  if (rand.length != 10) throw RangeError('rand must be 10 bytes');
  final b = List<int>.filled(16, 0);
  for (var i = 5, t = unixMs; i >= 0; i--, t >>= 8) {
    b[i] = t & 0xff;
  }
  b[6] = 0x70 | (rand[0] & 0x0f);
  b[7] = rand[1] & 0xff;
  b[8] = 0x80 | (rand[2] & 0x3f);
  for (var i = 0; i < 7; i++) {
    b[9 + i] = rand[3 + i] & 0xff;
  }
  final h = b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();
  return '${h.substring(0, 8)}-${h.substring(8, 12)}-${h.substring(12, 16)}-'
      '${h.substring(16, 20)}-${h.substring(20)}';
}

/// Monotonic generator: rand_a is a 12-bit counter, randomly seeded per new ms;
/// overflow advances the ms.
String Function() _makeGenerator(
    int Function() clock, void Function(List<int>) fill) {
  var lastMs = -1;
  var counter = 0;
  final rand = List<int>.filled(10, 0);
  return () {
    fill(rand);
    final now = clock();
    if (now > lastMs) {
      lastMs = now;
      counter = ((rand[0] & 0x0f) << 8) | rand[1];
    } else if (++counter > 0xfff) {
      lastMs++;
      counter = ((rand[0] & 0x0f) << 8) | rand[1];
    }
    rand[0] = counter >> 8;
    rand[1] = counter & 0xff;
    return buildUuidv7(lastMs, rand);
  };
}

// REQ-SEC-028: CSPRNG only.
final _secure = Random.secure();
final _defaultGen = _makeGenerator(
  () => DateTime.now().millisecondsSinceEpoch,
  (b) {
    for (var i = 0; i < b.length; i++) {
      b[i] = _secure.nextInt(256);
    }
  },
);

String uuidv7() => _defaultGen();

const _m32 = 0xffffffff;
int _imul(int a, int b) => (a * b) & _m32;
int _rotl(int v, int k) => ((v << k) | (v >> (32 - k))) & _m32;

/// xoshiro128** [CONV], state expanded from `seed` with splitmix32 (matches TS).
int Function() _xoshiro128ss(int seed) {
  var x = seed & _m32;
  int sm() {
    x = (x + 0x9e3779b9) & _m32;
    var z = x;
    z = _imul(z ^ (z >> 16), 0x21f0aaad);
    z = _imul(z ^ (z >> 15), 0x735a2d97);
    return (z ^ (z >> 15)) & _m32;
  }

  var s0 = sm(), s1 = sm(), s2 = sm(), s3 = sm();
  return () {
    final r = _imul(_rotl(_imul(s1, 5), 7), 9);
    final t = (s1 << 9) & _m32;
    s2 ^= s0;
    s3 ^= s1;
    s1 ^= s2;
    s0 ^= s3;
    s2 ^= t;
    s3 = _rotl(s3, 11);
    return r;
  };
}

/// Deterministic fake (CV §8.3): seeded PRNG + clock `startMs + i * stepMs`;
/// never reads the wall clock.
String Function() createSeededUuidv7(
    {required int seed, required int startMs, int stepMs = 1}) {
  final next = _xoshiro128ss(seed);
  var i = 0;
  return _makeGenerator(
    () => startMs + i++ * stepMs,
    (b) {
      for (var j = 0; j < b.length; j += 4) {
        final r = next();
        for (var k = 0; k < 4 && j + k < b.length; k++) {
          b[j + k] = (r >> (8 * k)) & 0xff;
        }
      }
    },
  );
}

int uuidv7Timestamp(String id) =>
    int.parse(id.substring(0, 8) + id.substring(9, 13), radix: 16);

bool isUuidv7(String s) => _re.hasMatch(s);
