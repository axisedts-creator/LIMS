// Package card (Bronze..Elite): animated gradient banners, sheen sweep, price and parameters, "Includes" accordion and "Add". Used on Home and Health packages.
import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'mhn_data.dart';
import 'mhn_state.dart';
import 'mhn_theme.dart';

class MhnHatch extends CustomPainter {
  const MhnHatch();
  @override
  void paint(Canvas canvas, Size size) {
    final p = Paint()
      ..color = const Color(0x14FFFFFF)
      ..strokeWidth = 1.2;
    for (double x = -size.height; x < size.width; x += 7) {
      canvas.drawLine(Offset(x, size.height), Offset(x + size.height, 0), p);
    }
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}

class MhnPackageCard extends ConsumerStatefulWidget {
  const MhnPackageCard({
    super.key,
    required this.pkg,
    this.open = false,
    this.onToggleOpen,
    this.width,
  });

  final MhnPackage pkg;
  final bool open;
  final VoidCallback? onToggleOpen;
  final double? width;

  @override
  ConsumerState<MhnPackageCard> createState() => _MhnPackageCardState();
}

class _MhnPackageCardState extends ConsumerState<MhnPackageCard>
    with SingleTickerProviderStateMixin {
  late final AnimationController _ctrl;
  bool _isTest = false;

  @override
  void initState() {
    super.initState();
    _isTest = WidgetsBinding.instance.runtimeType.toString().contains('Test');
    _ctrl = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 3200),
    );
    if (!_isTest) {
      _ctrl.repeat();
    } else {
      _ctrl.value = 0.5;
    }
  }

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  String _bannerTag(String id) {
    switch (id.toLowerCase()) {
      case 'bronze':
        return 'POPULAR · 70% OFF';
      case 'silver':
        return 'RECOMMENDED · 75% OFF';
      case 'gold':
        return 'BEST VALUE · 80% OFF';
      case 'platinum':
        return 'COMPREHENSIVE · 82% OFF';
      case 'elite':
        return 'VIP FULL BODY · 85% OFF';
      default:
        return 'RECOMMENDED';
    }
  }

  @override
  Widget build(BuildContext context) {
    final pkg = widget.pkg;
    final open = widget.open;
    final onToggleOpen = widget.onToggleOpen;
    final width = widget.width;
    final inCart = ref.watch(mhnProvider.select((s) => s.cart.contains(pkg.id)));

    final hsl = HSLColor.fromColor(pkg.color);
    final lighter = hsl.withLightness((hsl.lightness + 0.10).clamp(0.0, 1.0)).toColor();
    final darker = hsl.withLightness((hsl.lightness - 0.08).clamp(0.0, 1.0)).toColor();

    return AnimatedBuilder(
      animation: _ctrl,
      builder: (context, child) {
        final val = _ctrl.value;
        final angle = val * 2 * math.pi;
        final shiftX = 0.3 * math.sin(angle);
        final shiftY = 0.3 * math.cos(angle);

        return Container(
          width: width,
          clipBehavior: Clip.antiAlias,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(Mhn.rCard),
            boxShadow: const [
              BoxShadow(
                color: Color(0x1A000000),
                blurRadius: 10,
                offset: Offset(0, 4),
              ),
            ],
            gradient: LinearGradient(
              begin: Alignment(-1.0 + shiftX, -1.0 + shiftY),
              end: Alignment(1.0 - shiftX, 1.0 - shiftY),
              colors: [darker, pkg.color, lighter, pkg.color],
              stops: const [0.0, 0.45, 0.75, 1.0],
            ),
          ),
          child: Stack(
            children: [
              // Shimmer sheen beam
              Positioned.fill(
                child: IgnorePointer(
                  child: Container(
                    decoration: BoxDecoration(
                      gradient: LinearGradient(
                        begin: Alignment(-2.5 + 5.0 * val, -1.0),
                        end: Alignment(-1.0 + 5.0 * val, 1.0),
                        colors: const [
                          Colors.transparent,
                          Color(0x10FFFFFF),
                          Color(0x28FFFFFF),
                          Color(0x10FFFFFF),
                          Colors.transparent,
                        ],
                        stops: const [0.0, 0.4, 0.5, 0.6, 1.0],
                      ),
                    ),
                  ),
                ),
              ),
              // Hatch pattern
              const Positioned.fill(
                child: IgnorePointer(
                  child: CustomPaint(painter: MhnHatch()),
                ),
              ),
              // Card content
              Padding(
                padding: const EdgeInsets.all(14),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    // Animated top banner
                    Container(
                      margin: const EdgeInsets.only(bottom: 8),
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                      decoration: BoxDecoration(
                        color: const Color(0x38000000),
                        borderRadius: BorderRadius.circular(6),
                        border: Border.all(color: const Color(0x40FFFFFF)),
                      ),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Icon(
                            Icons.auto_awesome,
                            size: 12,
                            color: Color.lerp(Mhn.lime, Colors.white, (math.sin(angle) + 1) / 2),
                          ),
                          const SizedBox(width: 4),
                          Flexible(
                            child: Text(
                              _bannerTag(pkg.id),
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: Mhn.t(9, w: FontWeight.w800, c: Mhn.white),
                            ),
                          ),
                        ],
                      ),
                    ),
                    Text(
                      pkg.name.toUpperCase(),
                      style: Mhn.t(12, w: FontWeight.w700, c: const Color(0xCCFFFFFF))
                          .copyWith(letterSpacing: 1.2),
                    ),
                    const SizedBox(height: 4),
                    Text(rs(pkg.price), style: Mhn.t(22, w: FontWeight.w800, c: Mhn.white)),
                    Text(pkg.params, style: Mhn.t(12, c: const Color(0xCCFFFFFF))),
                    if (open) ...[
                      const SizedBox(height: 10),
                      for (final f in pkg.feats)
                        Padding(
                          padding: const EdgeInsets.symmetric(vertical: 2),
                          child: Row(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              const Padding(
                                padding: EdgeInsets.only(top: 3),
                                child: Icon(Icons.check, size: 15, color: Mhn.lime),
                              ),
                              const SizedBox(width: 8),
                              Expanded(child: Text(f, style: Mhn.t(13, c: Mhn.white))),
                            ],
                          ),
                        ),
                    ],
                    const SizedBox(height: 12),
                    Row(
                      children: [
                        Expanded(
                          child: _PkgBtn(
                            label: open ? 'Hide' : 'Includes',
                            filled: false,
                            onTap: onToggleOpen ?? () {},
                          ),
                        ),
                        const SizedBox(width: 8),
                        Expanded(
                          child: _PkgBtn(
                            label: inCart ? 'Added ✓' : 'Add',
                            filled: true,
                            color: pkg.color,
                            onTap: () {
                              ref.read(mhnProvider.notifier).toggleCart(pkg.id);
                              mhnToast(
                                context,
                                inCart
                                    ? '${pkg.name} removed from cart'
                                    : '${pkg.name} package added to cart',
                              );
                            },
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}

class _PkgBtn extends StatelessWidget {
  const _PkgBtn({required this.label, required this.filled, required this.onTap, this.color});
  final String label;
  final bool filled;
  final VoidCallback onTap;
  final Color? color;

  @override
  Widget build(BuildContext context) => Material(
        color: filled ? Mhn.white : const Color(0x22FFFFFF),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12), side: filled ? BorderSide.none : const BorderSide(color: Color(0x88FFFFFF))),
        child: InkWell(
          borderRadius: BorderRadius.circular(12),
          onTap: onTap,
          child: SizedBox(height: 40, child: Center(child: Text(label, style: Mhn.t(13, w: FontWeight.w700, c: filled ? (color ?? Mhn.green) : Mhn.white)))),
        ),
      );
}
