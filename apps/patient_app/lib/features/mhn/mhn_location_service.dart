// Location permission handler and GPS positioning service for My Health Now.
import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;
import 'package:geolocator/geolocator.dart';

class MhnLocationService {
  /// Known Nepal service locations for accurate offline nearest area resolution.
  static const _kNepalKnownAreas = <(String, double, double, String)>[
    ('Tinthana, Kirtipur', 27.6910, 85.2765, 'Kathmandu'),
    ('Kalanki Chowk', 27.6938, 85.2820, 'Kathmandu'),
    ('Kirtipur Area', 27.6790, 85.2780, 'Kathmandu'),
    ('Balkhu', 27.6840, 85.2980, 'Kathmandu'),
    ('Sanepa', 27.6850, 85.3100, 'Lalitpur'),
    ('Jawalakhel', 27.6755, 85.3190, 'Lalitpur'),
    ('Patan Durbar Area', 27.6710, 85.3250, 'Lalitpur'),
    ('Pulchowk', 27.6780, 85.3150, 'Lalitpur'),
    ('Tripureshwor', 27.6960, 85.3140, 'Kathmandu'),
    ('New Road', 27.7032, 85.3125, 'Kathmandu'),
    ('Thamel Marg', 27.7150, 85.3110, 'Kathmandu'),
    ('Maitighar Mandala', 27.6930, 85.3210, 'Kathmandu'),
    ('Baneshwor Heights', 27.6915, 85.3420, 'Kathmandu'),
    ('Koteshwor', 27.6820, 85.3465, 'Kathmandu'),
    ('Baluwatar', 27.7215, 85.3305, 'Kathmandu'),
    ('Maharajgunj', 27.7370, 85.3320, 'Kathmandu'),
    ('Chabahil', 27.7170, 85.3470, 'Kathmandu'),
    ('Bouddha', 27.7215, 85.3620, 'Kathmandu'),
    ('Suryabinayak', 27.6715, 85.4290, 'Bhaktapur'),
    ('Lakeside', 28.2096, 83.9856, 'Pokhara'),
    ('Traffic Chowk', 27.7000, 83.4500, 'Butwal'),
    ('Main Road', 26.4525, 87.2718, 'Biratnagar'),
  ];

  /// Request location permissions and obtain real GPS coordinates.
  static Future<Position?> getCurrentPosition({
    required void Function(String message) onError,
  }) async {
    try {
      // 1. Always check and trigger Android system permission dialog first!
      LocationPermission permission = await Geolocator.checkPermission();
      if (permission == LocationPermission.denied) {
        permission = await Geolocator.requestPermission();
        if (permission == LocationPermission.denied) {
          onError('Location permission was denied. Please allow to detect your doorstep.');
          return null;
        }
      }

      if (permission == LocationPermission.deniedForever) {
        onError('Location permissions are permanently denied. Opening App Settings…');
        await Geolocator.openAppSettings();
        return null;
      }

      // 2. Check if device location service (GPS) is turned on
      final serviceEnabled = await Geolocator.isLocationServiceEnabled();
      if (!serviceEnabled) {
        onError('Please enable GPS / Location in Android Quick Settings.');
        await Geolocator.openLocationSettings();
        return null;
      }

      // 3. Obtain real GPS coordinates
      return await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(
          accuracy: LocationAccuracy.high,
          timeLimit: Duration(seconds: 12),
        ),
      );
    } catch (e) {
      onError('Unable to detect GPS position: $e');
      return null;
    }
  }

  /// Resolve real human-readable named address from coordinates.
  /// Uses OpenStreetMap Nominatim reverse geocoder with fast timeout,
  /// falling back to nearest known Nepal locality so raw numbers are never shown.
  static Future<String> getNamedAddress(Position pos) async {
    try {
      final client = HttpClient()..connectionTimeout = const Duration(seconds: 3);
      final uri = Uri.parse(
        'https://nominatim.openstreetmap.org/reverse?format=json&lat=${pos.latitude}&lon=${pos.longitude}&zoom=18&addressdetails=1&accept-language=en',
      );
      final req = await client.getUrl(uri);
      req.headers.set('User-Agent', 'LIMS-PatientApp/1.0 (Mobile; Android)');
      final resp = await req.close().timeout(const Duration(seconds: 3));
      if (resp.statusCode == 200) {
        final bodyStr = await resp.transform(utf8.decoder).join();
        final data = jsonDecode(bodyStr) as Map<String, dynamic>?;
        if (data != null && data['address'] is Map) {
          final addr = data['address'] as Map<String, dynamic>;
          final neighborhood = addr['suburb'] ??
              addr['neighbourhood'] ??
              addr['residential'] ??
              addr['village'] ??
              addr['road'] ??
              addr['city_district'];
          final city = addr['city'] ?? addr['town'] ?? addr['municipality'] ?? addr['county'] ?? 'Kathmandu';
          if (neighborhood != null && neighborhood.toString().trim().isNotEmpty) {
            return '${neighborhood.toString().trim()}, $city';
          }
        }
      }
    } catch (_) {
      // Fallback to offline matcher
    }
    return matchNearestLocality(pos.latitude, pos.longitude);
  }

  /// Offline nearest Nepal locality resolver. Always returns a real named place.
  static String matchNearestLocality(double lat, double lng) {
    var closest = _kNepalKnownAreas.first;
    var minD = double.infinity;
    for (final area in _kNepalKnownAreas) {
      final d = math.sqrt(math.pow(area.$2 - lat, 2) + math.pow(area.$3 - lng, 2));
      if (d < minD) {
        minD = d;
        closest = area;
      }
    }
    return '${closest.$1}, ${closest.$4}';
  }

  /// Format location as human-readable name. Never outputs bare coordinates.
  static String formatLocation(Position pos) {
    return matchNearestLocality(pos.latitude, pos.longitude);
  }
}
