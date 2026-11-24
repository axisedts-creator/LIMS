// My Health Now look: colours, radii and the small widgets every screen of the prototype is built from.
// Values are the prototype's own (deep green #0E4B3B, lime #D9EE8C, pale green page), font is the app's bundled Poppins.
import 'package:flutter/material.dart';
import 'package:lims_ui/lims_ui.dart';

abstract final class Mhn {
  static const green = Color(0xFF0E4B3B);
  static const greenDeep = Color(0xFF0A3328);
  static const page = Color(0xFFF3F7F4);
  static const ink = Color(0xFF13241D);
  static const muted = Color(0xFF4D6359);
  static const mutedSoft = Color(0xFF6B8076);
  static const lime = Color(0xFFD9EE8C);
  static const limeStrong = Color(0xFF9DBE2E);
  static const limeSoft = Color(0xFFF2F9EC);
  static const limeLine = Color(0xFFD7E8C8);
  static const line = Color(0xFFDCE8E0);
  static const lineStrong = Color(0xFFCFDDD4);
  static const rowLine = Color(0xFFEEF3EF);
  static const tint = Color(0xFFE6F2EA);
  static const tintFg = Color(0xFF2F5D4C);
  static const white = Color(0xFFFFFFFF);
  static const warnBg = Color(0xFFFFF1DE);
  static const warnFg = Color(0xFF7A4300);
  static const dangerBg = Color(0xFFFBEAEA);
  static const dangerFg = Color(0xFF8A2E2E);
  static const danger = Color(0xFFC24141);
  static const star = Color(0xFFE2A100);
  static const shadow = Color(0x0F0E4B3B);
  static const shadow3D = Color(0x180E4B3B);

  static const rCard = 18.0;
  static const rField = 14.0;
  static const rChip = 12.0;

  static const btnGradient = LinearGradient(
    begin: Alignment.centerLeft,
    end: Alignment.centerRight,
    colors: [Color(0xFF8BB535), Color(0xFF0E4B3B)],
  );

  static TextStyle t(double size, {FontWeight w = FontWeight.w500, Color c = ink, double? h}) =>
      TextStyle(fontFamily: 'Poppins', fontSize: size, fontWeight: w, color: c, height: h);

  static TextStyle get h1 => t(22, w: FontWeight.w700);
  static TextStyle get h2 => t(17, w: FontWeight.w700);
  static TextStyle get body => t(14, c: muted, h: 1.35);
  static TextStyle get small => t(12, c: mutedSoft);
}

/// 3D tactile card with soft elevation, subtle specular rim and responsive border.
class MhnCard extends StatelessWidget {
  const MhnCard({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.all(16),
    this.color = Mhn.white,
    this.borderColor = Mhn.line,
    this.radius = Mhn.rCard,
    this.elevation = true,
  });

  final Widget child;
  final EdgeInsetsGeometry padding;
  final Color color;
  final Color borderColor;
  final double radius;
  final bool elevation;

  @override
  Widget build(BuildContext context) => Container(
        padding: padding,
        decoration: BoxDecoration(
          color: color,
          borderRadius: BorderRadius.circular(radius),
          border: Border.all(color: borderColor, width: 1.0),
          boxShadow: elevation
              ? const [
                  BoxShadow(color: Color(0x0F0E4B3B), blurRadius: 16, offset: Offset(0, 6)),
                  BoxShadow(color: Color(0x050E4B3B), blurRadius: 4, offset: Offset(0, 1)),
                ]
              : null,
        ),
        child: child,
      );
}

/// Realistic portrait avatar with graceful initials fallback.
class MhnAvatar extends StatelessWidget {
  const MhnAvatar({
    super.key,
    this.name = '',
    this.imagePath,
    this.radius = 22,
    this.borderColor,
    this.borderWidth = 1.5,
  });

  final String name;
  final String? imagePath;
  final double radius;
  final Color? borderColor;
  final double borderWidth;

  String _resolveAsset(String n) {
    if (imagePath != null && imagePath!.isNotEmpty) return imagePath!;
    final lower = n.toLowerCase();
    if (lower.contains('aarav')) return 'assets/images/avatars/aarav.png';
    if (lower.contains('sita')) return 'assets/images/avatars/sita.png';
    if (lower.contains('anika')) return 'assets/images/avatars/anika.png';
    if (lower.contains('doctor') || lower.contains('dr.')) return 'assets/images/avatars/doctor.png';
    if (lower.contains('dietitian')) return 'assets/images/avatars/dietitian.png';
    if (lower.contains('ramesh')) return 'assets/images/avatars/ramesh.png';
    if (lower.contains('sunita')) return 'assets/images/avatars/sunita.png';
    if (lower.contains('women')) return 'assets/images/avatars/women.png';
    if (lower.contains('men')) return 'assets/images/avatars/men.png';
    if (lower.contains('senior')) return 'assets/images/avatars/senior.png';
    return '';
  }

  @override
  Widget build(BuildContext context) {
    final asset = _resolveAsset(name);
    final initial = name.isNotEmpty ? name.trim().split(' ').map((p) => p.isNotEmpty ? p[0] : '').take(2).join() : 'U';

    Widget content;
    if (asset.isNotEmpty) {
      content = ClipOval(
        child: Image.asset(
          asset,
          width: radius * 2,
          height: radius * 2,
          fit: BoxFit.cover,
          errorBuilder: (_, __, ___) => _initialsWidget(initial),
        ),
      );
    } else {
      content = _initialsWidget(initial);
    }

    if (borderColor != null) {
      return Container(
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          border: Border.all(color: borderColor!, width: borderWidth),
          boxShadow: const [
            BoxShadow(color: Color(0x120E4B3B), blurRadius: 6, offset: Offset(0, 2)),
          ],
        ),
        child: content,
      );
    }
    return content;
  }

  Widget _initialsWidget(String initial) => CircleAvatar(
        radius: radius,
        backgroundColor: Mhn.green,
        child: Text(
          initial,
          style: Mhn.t(radius * 0.8, w: FontWeight.w700, c: Mhn.white),
        ),
      );
}

/// Filled gradient button (primary), lime button, or white outlined button (secondary); full width by default.
class MhnButton extends StatelessWidget {
  const MhnButton({
    super.key,
    required this.label,
    required this.onPressed,
    this.secondary = false,
    this.lime = false,
    this.busy = false,
    this.gradient = true,
    this.icon,
  });

  final String label;
  final VoidCallback? onPressed;
  final bool secondary;
  final bool lime;
  final bool busy;
  final bool gradient;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    final fg = secondary
        ? Mhn.green
        : (lime ? Mhn.green : (onPressed == null ? Mhn.mutedSoft : Mhn.white));

    final isGradient = gradient && !secondary && !lime && onPressed != null;

    final decoration = BoxDecoration(
      color: secondary
          ? Mhn.white
          : (lime
              ? Mhn.lime
              : (onPressed == null ? const Color(0xFFE5EDE8) : Mhn.green)),
      gradient: isGradient ? Mhn.btnGradient : null,
      borderRadius: BorderRadius.circular(16),
      border: secondary ? Border.all(color: Mhn.green, width: 1.2) : null,
      boxShadow: (isGradient || lime) && onPressed != null
          ? const [
              BoxShadow(
                color: Color(0x180E4B3B),
                blurRadius: 10,
                offset: Offset(0, 4),
              ),
            ]
          : null,
    );

    return SizedBox(
      width: double.infinity,
      height: 52,
      child: Material(
        color: Colors.transparent,
        child: Ink(
          decoration: decoration,
          child: InkWell(
            borderRadius: BorderRadius.circular(16),
            onTap: busy ? null : onPressed,
            child: Center(
              child: busy
                  ? Row(mainAxisSize: MainAxisSize.min, children: [
                      SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(strokeWidth: 2.4, color: fg),
                      ),
                      const SizedBox(width: 10),
                      Flexible(
                        child: Text(
                          label,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: Mhn.t(15, w: FontWeight.w700, c: fg),
                        ),
                      ),
                    ])
                  : Row(mainAxisSize: MainAxisSize.min, children: [
                      if (icon != null) ...[Icon(icon, size: 18, color: fg), const SizedBox(width: 8)],
                      Flexible(
                        child: Text(
                          label,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: Mhn.t(15, w: FontWeight.w700, c: fg),
                        ),
                      ),
                    ]),
            ),
          ),
        ),
      ),
    );
  }
}

/// Selectable chip: green when selected, white with a border otherwise.
class MhnChip extends StatelessWidget {
  const MhnChip({super.key, required this.label, required this.selected, required this.onTap, this.sub, this.padding = const EdgeInsets.symmetric(horizontal: 16, vertical: 12), this.radius = Mhn.rChip, this.enabled = true});
  final String label;
  final String? sub;
  final bool selected;
  final VoidCallback onTap;
  final EdgeInsets padding;
  final double radius;
  final bool enabled;

  @override
  Widget build(BuildContext context) {
    final fg = selected ? Mhn.white : Mhn.ink;
    return Semantics(
      button: true,
      selected: selected,
      child: Material(
        color: selected ? Mhn.green : Mhn.white,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(radius), side: BorderSide(color: selected ? Mhn.green : Mhn.lineStrong)),
        child: InkWell(
          borderRadius: BorderRadius.circular(radius),
          onTap: enabled ? onTap : null,
          child: Padding(
            padding: padding,
            child: sub == null
                ? Text(label, textAlign: TextAlign.center, style: Mhn.t(14, w: FontWeight.w600, c: fg))
                : Column(mainAxisSize: MainAxisSize.min, children: [
                    Text(label, style: Mhn.t(14, w: FontWeight.w700, c: fg)),
                    Text(sub!, style: Mhn.t(11, c: selected ? Mhn.white.withValues(alpha: .8) : Mhn.mutedSoft)),
                  ]),
          ),
        ),
      ),
    );
  }
}

/// Small rounded tag (fasting / report time / status).
class MhnTag extends StatelessWidget {
  const MhnTag(this.text, {super.key, this.bg = Mhn.tint, this.fg = Mhn.tintFg});
  final String text;
  final Color bg;
  final Color fg;

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
        decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(8)),
        child: Text(text, style: Mhn.t(12, w: FontWeight.w600, c: fg)),
      );
}

/// Rounded icon tile used in lists (profile rows, quick actions, categories).
class MhnIconTile extends StatelessWidget {
  const MhnIconTile(this.icon, {super.key, this.size = 40, this.bg = Mhn.tint});
  final IconData icon;
  final double size;
  final Color bg;

  @override
  Widget build(BuildContext context) => Container(
        width: size,
        height: size,
        decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(12)),
        child: Icon(icon, size: size * .5, color: Mhn.green),
      );
}

/// Screen title bar for pushed screens: rounded back button + title (prototype header).
class MhnTopBar extends StatelessWidget implements PreferredSizeWidget {
  const MhnTopBar(this.title, {super.key, this.showBack = true});
  final String title;
  final bool showBack;

  @override
  Size get preferredSize => const Size.fromHeight(64);

  @override
  Widget build(BuildContext context) => SafeArea(
        bottom: false,
        child: Container(
          height: 64,
          padding: const EdgeInsets.symmetric(horizontal: 12),
          decoration: const BoxDecoration(color: Mhn.page, border: Border(bottom: BorderSide(color: Mhn.line))),
          child: Row(children: [
            if (showBack) ...[
              Semantics(
                button: true,
                label: 'Back',
                child: Material(
                  color: Mhn.white,
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12), side: const BorderSide(color: Mhn.line)),
                  child: InkWell(
                    borderRadius: BorderRadius.circular(12),
                    onTap: () => Navigator.of(context).maybePop(),
                    child: const SizedBox(width: 44, height: 44, child: Icon(Icons.chevron_left, size: 26, color: Mhn.ink)),
                  ),
                ),
              ),
              const SizedBox(width: 12),
            ],
            Expanded(child: Text(title, maxLines: 1, overflow: TextOverflow.ellipsis, style: Mhn.t(18, w: FontWeight.w700))),
          ]),
        ),
      );
}

/// Page scaffold for pushed screens and embedded tabs.
class MhnPage extends StatelessWidget {
  const MhnPage({super.key, required this.title, required this.child, this.bottom, this.showBack = true});
  final String title;
  final Widget child;
  final Widget? bottom;
  final bool showBack;

  @override
  Widget build(BuildContext context) => Scaffold(
        backgroundColor: Mhn.page,
        appBar: MhnTopBar(title, showBack: showBack),
        body: child,
        bottomNavigationBar: bottom == null ? null : SafeArea(child: Padding(padding: const EdgeInsets.fromLTRB(16, 8, 16, 12), child: bottom)),
      );
}

/// Dark-green toast with a check, like the prototype.
void mhnToast(BuildContext context, String message) => mhnToastOn(ScaffoldMessenger.of(context), message);

/// Same toast on an already-captured messenger (use it when the calling route is about to be popped).
void mhnToastOn(ScaffoldMessengerState m, String message) {
  m.hideCurrentSnackBar();
  m.showSnackBar(SnackBar(
    behavior: SnackBarBehavior.floating,
    backgroundColor: Mhn.green,
    margin: const EdgeInsets.fromLTRB(16, 0, 16, 90),
    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
    duration: const Duration(milliseconds: 2600),
    content: Row(children: [
      const Icon(Icons.check, size: 18, color: Mhn.lime),
      const SizedBox(width: 10),
      Expanded(child: Text(message, style: Mhn.t(13, w: FontWeight.w600, c: Mhn.white))),
    ]),
  ));
}

/// White rounded text field with the prototype's label above it.
class MhnField extends StatelessWidget {
  const MhnField({super.key, required this.label, required this.controller, this.hint, this.keyboardType, this.error, this.onChanged, this.prefix, this.maxLines = 1, this.readOnly = false, this.fill = Mhn.white});
  final String label;
  final TextEditingController controller;
  final String? hint;
  final TextInputType? keyboardType;
  final String? error;
  final ValueChanged<String>? onChanged;
  final String? prefix;
  final int maxLines;
  final bool readOnly;
  final Color fill;

  @override
  Widget build(BuildContext context) {
    final bd = error != null ? Mhn.danger : Mhn.lineStrong;
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text(label, style: Mhn.t(12, w: FontWeight.w600, c: Mhn.muted)),
      const SizedBox(height: 6),
      LimsTextField(
        label: label,
        maxLength: 300,
        controller: controller,
        keyboardType: keyboardType,
        onChanged: onChanged,
        maxLines: maxLines,
        readOnly: readOnly,
        style: Mhn.t(15, w: FontWeight.w600),
        decoration: InputDecoration(
          counterText: '',
          hintText: hint,
          hintStyle: Mhn.t(15, c: Mhn.mutedSoft),
          prefixText: prefix,
          prefixStyle: Mhn.t(15, w: FontWeight.w600, c: Mhn.muted),
          filled: true,
          fillColor: fill,
          contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
          enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(Mhn.rField), borderSide: BorderSide(color: bd)),
          focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(Mhn.rField), borderSide: BorderSide(color: error != null ? Mhn.danger : Mhn.green, width: 1.6)),
          border: OutlineInputBorder(borderRadius: BorderRadius.circular(Mhn.rField), borderSide: BorderSide(color: bd)),
        ),
      ),
      if (error != null) Padding(padding: const EdgeInsets.only(top: 6), child: Text(error!, style: Mhn.t(12, w: FontWeight.w600, c: Mhn.danger))),
    ]);
  }
}

/// Interactive 3D tilt card that responds to user touch/hover with realtime perspective transformation.
class Mhn3DTiltCard extends StatefulWidget {
  const Mhn3DTiltCard({
    super.key,
    required this.child,
    this.maxTilt = 0.08,
    this.borderRadius = Mhn.rCard,
    this.onTap,
  });

  final Widget child;
  final double maxTilt;
  final double borderRadius;
  final VoidCallback? onTap;

  @override
  State<Mhn3DTiltCard> createState() => _Mhn3DTiltCardState();
}

class _Mhn3DTiltCardState extends State<Mhn3DTiltCard> {
  double _rotX = 0;
  double _rotY = 0;
  bool _isPressed = false;

  void _onPointerMove(PointerMoveEvent e, BoxConstraints constraints) {
    final cx = constraints.maxWidth / 2;
    final cy = constraints.maxHeight / 2;
    if (cx == 0 || cy == 0) return;
    final dx = (e.localPosition.dx - cx) / cx;
    final dy = (e.localPosition.dy - cy) / cy;
    setState(() {
      _rotY = dx * widget.maxTilt;
      _rotX = -dy * widget.maxTilt;
    });
  }

  void _reset() {
    setState(() {
      _rotX = 0;
      _rotY = 0;
      _isPressed = false;
    });
  }

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        return Listener(
          onPointerDown: (_) => setState(() => _isPressed = true),
          onPointerMove: (e) => _onPointerMove(e, constraints),
          onPointerUp: (_) => _reset(),
          onPointerCancel: (_) => _reset(),
          child: GestureDetector(
            onTap: widget.onTap,
            child: TweenAnimationBuilder<double>(
              tween: Tween<double>(begin: 1.0, end: _isPressed ? 0.98 : 1.0),
              duration: const Duration(milliseconds: 150),
              builder: (context, scale, child) {
                return Transform(
                  alignment: FractionalOffset.center,
                  transform: Matrix4.identity()
                    ..setEntry(3, 2, 0.001)
                    ..rotateX(_rotX)
                    ..rotateY(_rotY)
                    ..scaleByDouble(scale, scale, 1.0, 1.0),
                  child: widget.child,
                );
              },
            ),
          ),
        );
      },
    );
  }
}

/// Realtime 3D HealthScore arc gauge (HealthKarma 72/100).
class Mhn3DHealthScoreGauge extends StatelessWidget {
  const Mhn3DHealthScoreGauge({
    super.key,
    required this.score,
    this.maxScore = 100,
    this.size = 110,
  });

  final int score;
  final int maxScore;
  final double size;

  @override
  Widget build(BuildContext context) {
    final pct = (score / maxScore).clamp(0.0, 1.0);
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        gradient: RadialGradient(
          colors: [
            const Color(0xFF1B6B52).withValues(alpha: 0.15),
            Colors.transparent,
          ],
        ),
      ),
      child: Stack(
        alignment: Alignment.center,
        children: [
          CustomPaint(
            size: Size(size, size),
            painter: _3DGaugePainter(pct: pct),
          ),
          Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                '$score',
                style: Mhn.t(size * 0.28, w: FontWeight.w800, c: Mhn.ink),
              ),
              Text(
                '/$maxScore',
                style: Mhn.t(size * 0.13, w: FontWeight.w600, c: Mhn.muted),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _3DGaugePainter extends CustomPainter {
  _3DGaugePainter({required this.pct});
  final double pct;

  @override
  void paint(Canvas canvas, Size size) {
    final center = Offset(size.width / 2, size.height / 2);
    final radius = (size.width - 16) / 2;
    const startAngle = 0.75 * 3.14159265;
    const sweepAngle = 1.5 * 3.14159265;

    // Background track
    final bgPaint = Paint()
      ..color = const Color(0xFFE0EAE3)
      ..style = PaintingStyle.stroke
      ..strokeWidth = 10
      ..strokeCap = StrokeCap.round;
    canvas.drawArc(
      Rect.fromCircle(center: center, radius: radius),
      startAngle,
      sweepAngle,
      false,
      bgPaint,
    );

    // Active 3D gradient arc
    final rect = Rect.fromCircle(center: center, radius: radius);
    final activePaint = Paint()
      ..shader = const SweepGradient(
        startAngle: startAngle,
        endAngle: startAngle + sweepAngle,
        colors: [Color(0xFF8BB535), Color(0xFF0E4B3B)],
      ).createShader(rect)
      ..style = PaintingStyle.stroke
      ..strokeWidth = 10
      ..strokeCap = StrokeCap.round;

    canvas.drawArc(
      rect,
      startAngle,
      sweepAngle * pct,
      false,
      activePaint,
    );
  }

  @override
  bool shouldRepaint(_3DGaugePainter old) => old.pct != pct;
}

/// 3D Isometric rendered supplement box.
class Mhn3DProductBox extends StatelessWidget {
  const Mhn3DProductBox({
    super.key,
    required this.name,
    required this.primaryColor,
    this.width = 110,
    this.height = 130,
  });

  final String name;
  final Color primaryColor;
  final double width;
  final double height;

  @override
  Widget build(BuildContext context) {
    final textScale = (MediaQuery.textScalerOf(context).scale(1) - 1.0).clamp(0.0, 1.0);
    return MediaQuery.withClampedTextScaling(
      maxScaleFactor: 1.15,
      child: Container(
        width: width,
        height: height + textScale * 30,
        decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(10),
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [
            primaryColor.withValues(alpha: 0.9),
            primaryColor,
            primaryColor.withValues(alpha: 0.8),
          ],
        ),
        boxShadow: [
          BoxShadow(
            color: primaryColor.withValues(alpha: 0.35),
            blurRadius: 14,
            offset: const Offset(4, 8),
          ),
          const BoxShadow(
            color: Color(0x12000000),
            blurRadius: 4,
            offset: Offset(-2, -2),
          ),
        ],
        border: Border.all(
          color: Colors.white.withValues(alpha: 0.3),
          width: 1.2,
        ),
      ),
      padding: const EdgeInsets.all(10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Container(
                width: 16,
                height: 16,
                decoration: const BoxDecoration(
                  color: Colors.white,
                  shape: BoxShape.circle,
                ),
                child: Center(
                  child: Icon(Icons.spa, size: 10, color: primaryColor),
                ),
              ),
              Text(
                'HERBVED',
                style: Mhn.t(9, w: FontWeight.w800, c: Colors.white70),
              ),
            ],
          ),
          const Spacer(),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 2),
            decoration: BoxDecoration(
              color: Colors.white.withValues(alpha: 0.2),
              borderRadius: BorderRadius.circular(4),
            ),
            child: Text(
              '100% ORGANIC',
              style: Mhn.t(8, w: FontWeight.w700, c: Colors.white),
            ),
          ),
          const SizedBox(height: 4),
          Text(
            name,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: Mhn.t(12, w: FontWeight.w800, c: Colors.white, h: 1.15),
          ),
          const SizedBox(height: 2),
          Text(
            '60 Tablets',
            style: Mhn.t(9, c: Colors.white70),
          ),
        ],
      ),
    ),
  );
}
}
