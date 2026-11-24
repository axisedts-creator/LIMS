// Real Bluetooth LE scanning and connection service for Fitness Bands and Smartwatches.
import 'dart:async';
import 'package:flutter_blue_plus/flutter_blue_plus.dart';

class MhnBleService {
  /// Stream of scan results.
  static Stream<List<ScanResult>> get scanResults => FlutterBluePlus.scanResults;

  /// Stream of scanning active state.
  static Stream<bool> get isScanning => FlutterBluePlus.isScanning;

  /// Check whether Bluetooth is supported and enabled on the device.
  static Future<bool> isBluetoothReady() async {
    try {
      if (!await FlutterBluePlus.isSupported) return false;
      final state = await FlutterBluePlus.adapterState.first;
      return state == BluetoothAdapterState.on;
    } catch (_) {
      return false;
    }
  }

  /// Request Bluetooth to be turned on if supported.
  static Future<void> turnOn() async {
    try {
      await FlutterBluePlus.turnOn();
    } catch (_) {}
  }

  /// Start scanning for nearby Bluetooth LE smartwatches, bands, and monitors.
  static Future<void> startScan({Duration timeout = const Duration(seconds: 15)}) async {
    try {
      if (await FlutterBluePlus.isScanning.first) {
        await FlutterBluePlus.stopScan();
      }
      await FlutterBluePlus.startScan(
        timeout: timeout,
        androidUsesFineLocation: true,
      );
    } catch (_) {}
  }

  /// Stop active scanning.
  static Future<void> stopScan() async {
    try {
      if (await FlutterBluePlus.isScanning.first) {
        await FlutterBluePlus.stopScan();
      }
    } catch (_) {}
  }

  /// Connect to a specific Bluetooth LE device.
  /// Returns true only on verified successful connection.
  static Future<bool> connectToDevice(BluetoothDevice device) async {
    try {
      await stopScan();
      await device.connect(
        license: License.nonprofit,
        timeout: const Duration(seconds: 12),
        autoConnect: false,
      );
      final state = await device.connectionState.first;
      return state == BluetoothConnectionState.connected;
    } catch (_) {
      return false;
    }
  }

  /// Disconnect a connected device.
  static Future<void> disconnectDevice(BluetoothDevice device) async {
    try {
      await device.disconnect();
    } catch (_) {}
  }
}
