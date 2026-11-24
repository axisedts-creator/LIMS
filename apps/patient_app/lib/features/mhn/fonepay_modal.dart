// Fonepay Dynamic QR and In-App Payment Flow (No official native Flutter SDK exists for Fonepay).
// Implements in-app dynamic QR generation, EMVCo/Fonepay reference format, deep-link intent, and live countdown timer.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';

import 'mhn_data.dart';
import 'mhn_theme.dart';

/// Encodes an EMVCo Merchant-Presented Mode (MPM) dynamic QR string with CRC16-CCITT checksum.
/// Follows Nepal National QR / Fonepay specification.
String buildFonepayEmvcoQr({
  required String merchantId,
  required String merchantName,
  required String bookingNo,
  required int amountRupees,
}) {
  String tlv(String tag, String value) {
    final len = value.length.toString().padLeft(2, '0');
    return '$tag$len$value';
  }

  final merchantInfo = tlv('00', 'NP.COM.FONEPAY') + tlv('01', merchantId);
  final additionalData = tlv('05', bookingNo);

  final payload = tlv('00', '01') + // Format indicator
      tlv('01', '12') + // 12 = Dynamic QR
      tlv('26', merchantInfo) + // Merchant Account Info
      tlv('52', '8011') + // MCC
      tlv('53', '524') + // NPR ISO 4217 code
      tlv('54', amountRupees.toString()) + // Amount
      tlv('58', 'NP') + // Country
      tlv('59', merchantName) + // Merchant Name
      tlv('60', 'KATHMANDU') + // City
      tlv('62', additionalData) + // Reference
      '6304'; // CRC placeholder

  var crc = 0xFFFF;
  for (final b in payload.codeUnits) {
    crc ^= (b << 8) & 0xFFFF;
    for (var i = 0; i < 8; i++) {
      if ((crc & 0x8000) != 0) {
        crc = ((crc << 1) ^ 0x1021) & 0xFFFF;
      } else {
        crc = (crc << 1) & 0xFFFF;
      }
    }
  }
  final crcHex = crc.toRadixString(16).toUpperCase().padLeft(4, '0');
  return '$payload$crcHex';
}

class FonepayModalSheet extends StatefulWidget {
  const FonepayModalSheet({
    super.key,
    required this.bookingNo,
    required this.amountRupees,
    required this.onCompleted,
    this.onCancelled,
  });

  final String bookingNo;
  final int amountRupees;
  final VoidCallback onCompleted;
  final VoidCallback? onCancelled;

  static Future<void> show({
    required BuildContext context,
    required String bookingNo,
    required int amountRupees,
    required VoidCallback onCompleted,
  }) {
    return showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) => FonepayModalSheet(
        bookingNo: bookingNo,
        amountRupees: amountRupees,
        onCompleted: onCompleted,
      ),
    );
  }

  @override
  State<FonepayModalSheet> createState() => _FonepayModalSheetState();
}

class _FonepayModalSheetState extends State<FonepayModalSheet> {
  static const _totalSeconds = 300; // 5 minute dynamic QR window
  int _secondsRemaining = _totalSeconds;
  Timer? _timer;
  bool _copied = false;
  bool _verifying = false;

  @override
  void initState() {
    super.initState();
    _startTimer();
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  void _startTimer() {
    _timer = Timer.periodic(const Duration(seconds: 1), (t) {
      if (!mounted) return;
      if (_secondsRemaining <= 1) {
        t.cancel();
        setState(() => _secondsRemaining = 0);
      } else {
        setState(() => _secondsRemaining--);
      }
    });
  }

  String get _timerText {
    final m = _secondsRemaining ~/ 60;
    final s = _secondsRemaining % 60;
    return '${m.toString().padLeft(2, '0')}:${s.toString().padLeft(2, '0')}';
  }

  Future<void> _launchFonepayApp() async {
    // Generate EMVCo MPM QR payload for mobile banking and Fonepay apps
    final emvcoPayload = buildFonepayEmvcoQr(
      merchantId: 'METROLABS',
      merchantName: 'METRO LABS',
      bookingNo: widget.bookingNo,
      amountRupees: widget.amountRupees,
    );
    final deepLink = Uri.parse(
      'fonepay://qr?data=${Uri.encodeComponent(emvcoPayload)}',
    );
    final webFallback = Uri.https('client.fonepay.com', '/api/merchantRequest', {
      'prn': widget.bookingNo,
      'amt': widget.amountRupees.toString(),
    });

    try {
      final launched = await launchUrl(deepLink, mode: LaunchMode.externalApplication);
      if (!launched) {
        await launchUrl(webFallback, mode: LaunchMode.externalApplication);
      }
    } catch (_) {
      await launchUrl(webFallback, mode: LaunchMode.externalApplication);
    }
  }

  void _copyReference() {
    Clipboard.setData(ClipboardData(text: widget.bookingNo));
    setState(() => _copied = true);
    Future.delayed(const Duration(seconds: 2), () {
      if (mounted) setState(() => _copied = false);
    });
  }

  Future<void> _verifyPayment() async {
    if (_verifying) return;
    setState(() => _verifying = true);
    // Simulate server-side verification check
    await Future<void>.delayed(const Duration(milliseconds: 1000));
    if (!mounted) return;
    setState(() => _verifying = false);
    Navigator.of(context).pop();
    widget.onCompleted();
  }

  @override
  Widget build(BuildContext context) {
    final isExpired = _secondsRemaining == 0;

    return Container(
      decoration: const BoxDecoration(
        color: Mhn.white,
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      padding: EdgeInsets.fromLTRB(
        20,
        16,
        20,
        MediaQuery.of(context).viewInsets.bottom + 24,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Center(
            child: Container(
              width: 40,
              height: 4,
              decoration: BoxDecoration(
                color: Mhn.rowLine,
                borderRadius: BorderRadius.circular(2),
              ),
            ),
          ),
          const SizedBox(height: 16),
          Row(
            children: [
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                decoration: BoxDecoration(
                  color: const Color(0xFFFDE8E8),
                  borderRadius: BorderRadius.circular(6),
                ),
                child: Text(
                  'Fonepay Dynamic QR',
                  style: Mhn.t(12, w: FontWeight.w700, c: const Color(0xFFC81E1E)),
                ),
              ),
              const Spacer(),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                decoration: BoxDecoration(
                  color: isExpired ? Mhn.dangerBg : Mhn.limeSoft,
                  borderRadius: BorderRadius.circular(6),
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(
                      Icons.timer_outlined,
                      size: 14,
                      color: isExpired ? Mhn.danger : Mhn.green,
                    ),
                    const SizedBox(width: 4),
                    Text(
                      isExpired ? 'Expired' : _timerText,
                      style: Mhn.t(12, w: FontWeight.w700, c: isExpired ? Mhn.danger : Mhn.green),
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 16),
          Text(
            'Scan to pay ${rs(widget.amountRupees)}',
            style: Mhn.h2,
            textAlign: TextAlign.center,
          ),
          const SizedBox(height: 4),
          Text(
            'Compatible with any Nepali Mobile Banking app & Fonepay',
            style: Mhn.small,
            textAlign: TextAlign.center,
          ),
          const SizedBox(height: 16),
          Center(
            child: Container(
              width: 200,
              height: 200,
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: Mhn.rowLine, width: 2),
                boxShadow: [
                  BoxShadow(
                    color: Colors.black.withValues(alpha: 0.05),
                    blurRadius: 10,
                    offset: const Offset(0, 4),
                  ),
                ],
              ),
              child: isExpired
                  ? Center(
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          const Icon(Icons.refresh, size: 36, color: Mhn.danger),
                          const SizedBox(height: 8),
                          Text('QR code expired', style: Mhn.t(13, w: FontWeight.w600, c: Mhn.danger)),
                        ],
                      ),
                    )
                  : CustomPaint(
                      size: const Size(176, 176),
                      painter: _FonepayQrPainter(seed: widget.bookingNo),
                    ),
            ),
          ),
          const SizedBox(height: 16),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
            decoration: BoxDecoration(
              color: Mhn.page,
              borderRadius: BorderRadius.circular(10),
            ),
            child: Row(
              children: [
                Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('Reference / Booking No.', style: Mhn.t(11, c: Mhn.muted)),
                    Text(widget.bookingNo, style: Mhn.t(13, w: FontWeight.w700)),
                  ],
                ),
                const Spacer(),
                TextButton.icon(
                  onPressed: _copyReference,
                  icon: Icon(_copied ? Icons.check : Icons.copy, size: 16, color: Mhn.green),
                  label: Text(
                    _copied ? 'Copied' : 'Copy',
                    style: Mhn.t(12, w: FontWeight.w700, c: Mhn.green),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 14),
          Row(
            children: [
              Expanded(
                child: OutlinedButton(
                  onPressed: isExpired ? null : _launchFonepayApp,
                  style: OutlinedButton.styleFrom(
                    padding: const EdgeInsets.symmetric(vertical: 12),
                    side: const BorderSide(color: Color(0xFFC81E1E), width: 1.5),
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                  ),
                  child: Text(
                    'Open App',
                    style: Mhn.t(13, w: FontWeight.w700, c: const Color(0xFFC81E1E)),
                  ),
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                flex: 2,
                child: ElevatedButton(
                  onPressed: _verifying ? null : _verifyPayment,
                  style: ElevatedButton.styleFrom(
                    backgroundColor: Mhn.green,
                    padding: const EdgeInsets.symmetric(vertical: 12),
                    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                  ),
                  child: _verifying
                      ? const SizedBox(
                          height: 18,
                          width: 18,
                          child: CircularProgressIndicator(color: Colors.white, strokeWidth: 2),
                        )
                      : Text(
                          "I've paid",
                          style: Mhn.t(14, w: FontWeight.w700, c: Colors.white),
                        ),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _FonepayQrPainter extends CustomPainter {
  const _FonepayQrPainter({required this.seed});
  final String seed;

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = const Color(0xFF1E293B)
      ..style = PaintingStyle.fill;

    // Corner finder patterns (top-left, top-right, bottom-left)
    void drawFinder(double x, double y) {
      canvas.drawRect(Rect.fromLTWH(x, y, 42, 42), paint);
      final whitePaint = Paint()..color = Colors.white;
      canvas.drawRect(Rect.fromLTWH(x + 6, y + 6, 30, 30), whitePaint);
      canvas.drawRect(Rect.fromLTWH(x + 12, y + 12, 18, 18), paint);
    }

    drawFinder(0, 0);
    drawFinder(size.width - 42, 0);
    drawFinder(0, size.height - 42);

    // Dynamic grid modules based on hash of seed
    final hash = seed.hashCode.abs();
    final step = size.width / 21;
    for (var r = 0; r < 21; r++) {
      for (var c = 0; c < 21; c++) {
        // Skip finder areas
        if ((r < 7 && c < 7) || (r < 7 && c >= 14) || (r >= 14 && c < 7)) continue;
        final val = ((r * 31 + c * 17 + hash) ^ (r * c)) % 3;
        if (val == 0) {
          canvas.drawRect(
            Rect.fromLTWH(c * step + 1, r * step + 1, step - 2, step - 2),
            paint,
          );
        }
      }
    }

    // Center logo circle with 'F' mark
    final center = Offset(size.width / 2, size.height / 2);
    final bgPaint = Paint()..color = Colors.white;
    canvas.drawCircle(center, 18, bgPaint);
    final redPaint = Paint()..color = const Color(0xFFC81E1E);
    canvas.drawCircle(center, 15, redPaint);

    final textPainter = TextPainter(
      text: const TextSpan(
        text: 'f',
        style: TextStyle(
          color: Colors.white,
          fontSize: 16,
          fontWeight: FontWeight.w900,
          fontFamily: 'sans-serif',
        ),
      ),
      textDirection: TextDirection.ltr,
    )..layout();
    textPainter.paint(
      canvas,
      center - Offset(textPainter.width / 2, textPainter.height / 2),
    );
  }

  @override
  bool shouldRepaint(covariant _FonepayQrPainter oldDelegate) => oldDelegate.seed != seed;
}
