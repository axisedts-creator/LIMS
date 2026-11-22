// Foreground device location acquisition (CR-C17-010, REQ-SEC).
// Purely foreground-only: acquires a single discrete reading at milestone moments
// (arrival, specimen collection, failure). No background tracking daemon.
import 'package:geolocator/geolocator.dart';

typedef GpsReader = Future<Map<String, Object?>> Function();

class DeviceGps {
  const DeviceGps();

  /// Reads current GPS position adhering strictly to the homecollection OpenAPI contract:
  /// status in {'ok', 'off', 'denied', 'unavailable'}, latitude, longitude, accuracy_m, captured_at.
  Future<Map<String, Object?>> readGps({
    Duration timeLimit = const Duration(seconds: 8),
  }) async {
    try {
      final serviceEnabled = await Geolocator.isLocationServiceEnabled();
      if (!serviceEnabled) {
        return const {'status': 'off'};
      }

      var permission = await Geolocator.checkPermission();
      if (permission == LocationPermission.denied) {
        permission = await Geolocator.requestPermission();
        if (permission == LocationPermission.denied ||
            permission == LocationPermission.deniedForever) {
          return const {'status': 'denied'};
        }
      }
      if (permission == LocationPermission.deniedForever) {
        return const {'status': 'denied'};
      }

      final position = await Geolocator.getCurrentPosition(
        locationSettings: LocationSettings(
          accuracy: LocationAccuracy.high,
          timeLimit: timeLimit,
        ),
      );

      return {
        'status': 'ok',
        'latitude': position.latitude.toStringAsFixed(7),
        'longitude': position.longitude.toStringAsFixed(7),
        'accuracy_m': position.accuracy.round().clamp(0, 10000),
        'captured_at': position.timestamp.toUtc().toIso8601String(),
      };
    } catch (_) {
      try {
        final last = await Geolocator.getLastKnownPosition();
        if (last != null &&
            DateTime.now().difference(last.timestamp).inMinutes < 5) {
          return {
            'status': 'ok',
            'latitude': last.latitude.toStringAsFixed(7),
            'longitude': last.longitude.toStringAsFixed(7),
            'accuracy_m': last.accuracy.round().clamp(0, 10000),
            // Retains original capture timestamp from device cache
            'captured_at': last.timestamp.toUtc().toIso8601String(),
            'cached': true,
          };
        }
      } catch (_) {}
      return const {'status': 'unavailable'};
    }
  }
}
