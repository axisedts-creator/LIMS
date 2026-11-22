import 'package:flutter_test/flutter_test.dart';
import 'package:geolocator_platform_interface/geolocator_platform_interface.dart';
import 'package:phlebo_app/core/platform/device_gps.dart';

class FakeGeolocatorPlatform extends GeolocatorPlatform {
  bool serviceEnabled = true;
  LocationPermission checkPerm = LocationPermission.whileInUse;
  LocationPermission requestPerm = LocationPermission.whileInUse;
  Position? currentPos;
  Position? lastKnownPos;
  bool shouldThrowOnCurrent = false;

  @override
  Future<bool> isLocationServiceEnabled() async => serviceEnabled;

  @override
  Future<LocationPermission> checkPermission() async => checkPerm;

  @override
  Future<LocationPermission> requestPermission() async => requestPerm;

  @override
  Future<Position> getCurrentPosition({
    LocationSettings? locationSettings,
  }) async {
    if (shouldThrowOnCurrent) throw Exception('Location timed out');
    if (currentPos != null) return currentPos!;
    return Position(
      longitude: 85.3240,
      latitude: 27.7172,
      timestamp: DateTime.utc(2026, 3, 1, 6, 0),
      accuracy: 12.5,
      altitude: 1400.0,
      altitudeAccuracy: 1.0,
      heading: 0.0,
      headingAccuracy: 1.0,
      speed: 0.0,
      speedAccuracy: 1.0,
    );
  }

  @override
  Future<Position?> getLastKnownPosition({
    bool forceLocationManager = false,
  }) async =>
      lastKnownPos;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late FakeGeolocatorPlatform fake;
  const gps = DeviceGps();

  setUp(() {
    fake = FakeGeolocatorPlatform();
    GeolocatorPlatform.instance = fake;
  });

  test('DeviceGps returns status ok with coordinates, accuracy and timestamp', () async {
    final res = await gps.readGps();
    expect(res['status'], 'ok');
    expect(res['latitude'], '27.7172000');
    expect(res['longitude'], '85.3240000');
    expect(res['accuracy_m'], 13); // 12.5 rounded
    expect(res['captured_at'], '2026-03-01T06:00:00.000Z');
  });

  test('DeviceGps returns status off when location service is disabled', () async {
    fake.serviceEnabled = false;
    final res = await gps.readGps();
    expect(res, {'status': 'off'});
  });

  test('DeviceGps returns status denied when permission denied and request rejected', () async {
    fake.checkPerm = LocationPermission.denied;
    fake.requestPerm = LocationPermission.denied;
    final res = await gps.readGps();
    expect(res, {'status': 'denied'});
  });

  test('DeviceGps returns status denied when permission is deniedForever', () async {
    fake.checkPerm = LocationPermission.deniedForever;
    final res = await gps.readGps();
    expect(res, {'status': 'denied'});
  });

  test('DeviceGps returns status unavailable when acquisition fails and no fresh fallback exists', () async {
    fake.shouldThrowOnCurrent = true;
    fake.lastKnownPos = null;
    final res = await gps.readGps();
    expect(res, {'status': 'unavailable'});
  });

  test('DeviceGps clamps accuracy to [0, 10000] meters', () async {
    fake.currentPos = Position(
      latitude: 27.7,
      longitude: 85.3,
      timestamp: DateTime.utc(2026, 3, 1, 6, 0),
      accuracy: 25000.0,
      altitude: 0,
      altitudeAccuracy: 0,
      heading: 0,
      headingAccuracy: 0,
      speed: 0,
      speedAccuracy: 0,
    );
    final res = await gps.readGps();
    expect(res['status'], 'ok');
    expect(res['accuracy_m'], 10000);
  });

  test('DeviceGps fallback to cached position retains original capture timestamp', () async {
    fake.shouldThrowOnCurrent = true;
    final cachedTime = DateTime.now().subtract(const Duration(minutes: 2));
    fake.lastKnownPos = Position(
      latitude: 27.7175,
      longitude: 85.3245,
      timestamp: cachedTime,
      accuracy: 15.0,
      altitude: 1400.0,
      altitudeAccuracy: 1.0,
      heading: 0.0,
      headingAccuracy: 1.0,
      speed: 0.0,
      speedAccuracy: 1.0,
    );
    final res = await gps.readGps();
    expect(res['status'], 'ok');
    expect(res['latitude'], '27.7175000');
    expect(res['longitude'], '85.3245000');
    expect(res['cached'], true);
    expect(res['captured_at'], cachedTime.toUtc().toIso8601String());
  });
}
