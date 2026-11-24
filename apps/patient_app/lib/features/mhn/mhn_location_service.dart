// Location permission handler and GPS positioning service for My Health Now.
import 'package:geolocator/geolocator.dart';

class MhnLocationService {
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

  /// Match nearest Nepal service area or return coordinate string.
  static String formatLocation(Position pos) {
    if ((pos.latitude - 27.6915).abs() < 0.03 && (pos.longitude - 85.3420).abs() < 0.03) {
      return 'Baneshwor, Kathmandu';
    } else if ((pos.latitude - 27.6710).abs() < 0.03 && (pos.longitude - 85.3250).abs() < 0.03) {
      return 'Patan, Lalitpur';
    } else if ((pos.latitude - 27.7215).abs() < 0.03 && (pos.longitude - 85.3305).abs() < 0.03) {
      return 'Baluwatar, Kathmandu';
    } else if ((pos.latitude - 27.6755).abs() < 0.04 && (pos.longitude - 85.3190).abs() < 0.04) {
      return 'Jawalakhel, Lalitpur';
    }
    return '${pos.latitude.toStringAsFixed(4)}, ${pos.longitude.toStringAsFixed(4)} (GPS)';
  }
}
