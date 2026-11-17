// Package card (Bronze..Elite): coloured, hatched, price and parameters, "Includes" accordion and "Add". Used on Home and Health packages.
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

class MhnPackageCard extends ConsumerWidget {
  const MhnPackageCard({super.key, required this.pkg, required this.open, required this.onToggleOpen, this.width});
  final MhnPackage pkg;
  final bool open;
  final VoidCallback onToggleOpen;
  final double? width;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final inCart = ref.watch(mhnProvider.select((s) => s.cart.contains(pkg.id)));
    return Container(
      width: width,
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(color: pkg.color, borderRadius: BorderRadius.circular(Mhn.rCard)),
      child: CustomPaint(
        painter: const MhnHatch(),
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
            Text(pkg.name.toUpperCase(), style: Mhn.t(12, w: FontWeight.w700, c: const Color(0xCCFFFFFF)).copyWith(letterSpacing: 1.2)),
            const SizedBox(height: 6),
            Text(rs(pkg.price), style: Mhn.t(24, w: FontWeight.w800, c: Mhn.white)),
            Text(pkg.params, style: Mhn.t(13, c: const Color(0xCCFFFFFF))),
            if (open) ...[
              const SizedBox(height: 10),
              for (final f in pkg.feats)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 2),
                  child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    const Padding(padding: EdgeInsets.only(top: 3), child: Icon(Icons.check, size: 15, color: Mhn.lime)),
                    const SizedBox(width: 8),
                    Expanded(child: Text(f, style: Mhn.t(13, c: Mhn.white))),
                  ]),
                ),
            ],
            const SizedBox(height: 14),
            Row(children: [
              Expanded(child: _PkgBtn(label: open ? 'Hide' : 'Includes', filled: false, onTap: onToggleOpen)),
              const SizedBox(width: 8),
              Expanded(
                child: _PkgBtn(
                  label: inCart ? 'Added ✓' : 'Add',
                  filled: true,
                  color: pkg.color,
                  onTap: () {
                    ref.read(mhnProvider.notifier).toggleCart(pkg.id);
                    mhnToast(context, inCart ? '${pkg.name} removed from cart' : '${pkg.name} package added to cart');
                  },
                ),
              ),
            ]),
          ]),
        ),
      ),
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
