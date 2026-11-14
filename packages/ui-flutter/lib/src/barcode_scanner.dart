// 04-UI-UX §8 LimsBarcodeScanner: camera scan via the pinned mobile_scanner 7.5.0 (T0-03). Value semantics match the
// web BarcodeInput (§2.4): trimmed, uppercased, accepted only if it matches `pattern` (default ^[A-Z0-9]{1,20}$).
import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

class LimsBarcodeScanner extends StatefulWidget {
  LimsBarcodeScanner({super.key, required this.onScanned, RegExp? pattern, this.onRejected, this.semanticLabel = 'Barcode scanner'})
      : pattern = pattern ?? RegExp(r'^[A-Z0-9]{1,20}$');

  final ValueChanged<String> onScanned;
  final RegExp pattern;
  final ValueChanged<String>? onRejected;
  final String semanticLabel;

  /// Shared validation (unit-testable without a camera). Returns the accepted value or null.
  static String? accept(String raw, RegExp pattern) {
    final v = raw.trim().toUpperCase();
    return pattern.hasMatch(v) ? v : null;
  }

  @override
  State<LimsBarcodeScanner> createState() => _LimsBarcodeScannerState();
}

class _LimsBarcodeScannerState extends State<LimsBarcodeScanner> {
  String? _last; // the camera reports the same code many times per second: emit once per distinct value

  void _onDetect(BarcodeCapture c) {
    for (final b in c.barcodes) {
      final raw = b.rawValue;
      if (raw == null || raw == _last) continue;
      _last = raw;
      final v = LimsBarcodeScanner.accept(raw, widget.pattern);
      if (v != null) {
        widget.onScanned(v);
      } else {
        widget.onRejected?.call(raw.trim());
      }
    }
  }

  @override
  Widget build(BuildContext context) => Semantics(label: widget.semanticLabel, child: MobileScanner(onDetect: _onDetect));
}
