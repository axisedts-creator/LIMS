// HC-T24: monotonic channel (TRD §7.5). Android = SystemClock.elapsedRealtime() (counts deep sleep — UNVERIFIED, see
// .orchestra/notes/HC-T24-spike.md). Never the wall clock and never Dart's own stopwatch: neither is known to include suspend.
import 'platform_channel.dart';

/// Milliseconds on a clock that keeps running while the phone sleeps and is unaffected by the user changing the date.
abstract interface class MonotonicClock {
  int nowMs();
}

/// A [MonotonicClock] whose value must be fetched from the platform first (a channel call is asynchronous).
/// Code that needs a fresh reading calls [sample] and then [nowMs] (see [freshMonotonicMs]).
abstract interface class SampledMonotonicClock implements MonotonicClock {
  Future<void> sample();
}

/// Samples [clock] when it needs it, then reads it.
Future<int> freshMonotonicMs(MonotonicClock clock) async {
  if (clock is SampledMonotonicClock) await clock.sample();
  return clock.nowMs();
}

/// Reads elapsedRealtime over the platform channel; [nowMs] returns the last [sample].
class PlatformMonotonicClock implements SampledMonotonicClock {
  int? _last;

  @override
  Future<void> sample() async {
    final v = await limsPlatformChannel.invokeMethod<int>('monotonicMs');
    if (v == null || v < 0) throw StateError('monotonic clock unavailable');
    _last = v;
  }

  @override
  int nowMs() => _last ?? (throw StateError('monotonic clock not sampled yet'));
}
