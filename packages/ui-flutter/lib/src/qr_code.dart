// CR-C16-016 LimsQrCode: offline QR rendering with the pinned `qr` package (CR-C16-017), painted locally.
import 'package:flutter/material.dart';
import 'package:qr/qr.dart';

class LimsQrCode extends StatelessWidget {
  const LimsQrCode({super.key, required this.data, required this.size, required this.semanticLabel});

  final String data;
  final double size;
  final String semanticLabel;

  @override
  Widget build(BuildContext context) => Semantics(
        label: semanticLabel,
        image: true,
        child: SizedBox.square(
          dimension: size,
          child: ColoredBox(color: Colors.white, child: CustomPaint(painter: _QrPainter(data))),
        ),
      );
}

class _QrPainter extends CustomPainter {
  _QrPainter(String data) : _img = _build(data);

  final QrImage? _img;

  static QrImage? _build(String data) {
    if (data.isEmpty) return null;
    try {
      return QrImage(QrCode(payload: QrPayload.fromString(data), errorCorrectLevel: QrErrorCorrectLevel.medium));
    } catch (_) {
      return null; // too long for a QR code: blank square, never a crash
    }
  }

  @override
  void paint(Canvas canvas, Size size) {
    final img = _img;
    if (img == null) return;
    const quiet = 4; // quiet-zone modules
    final n = img.moduleCount;
    final m = size.shortestSide / (n + 2 * quiet);
    final p = Paint()..color = Colors.black;
    for (var y = 0; y < n; y++) {
      for (var x = 0; x < n; x++) {
        if (img.isDark(y, x)) canvas.drawRect(Rect.fromLTWH((x + quiet) * m, (y + quiet) * m, m, m), p);
      }
    }
  }

  @override
  bool shouldRepaint(_QrPainter old) => old._img != _img;
}
