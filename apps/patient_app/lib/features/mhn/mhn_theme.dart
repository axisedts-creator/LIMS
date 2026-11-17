// My Health Now look: colours, radii and the small widgets every screen of the prototype is built from.
// Values are the prototype's own (deep green #0E4B3B, lime #D9EE8C, pale green page), font is the app's bundled Poppins.
import 'package:flutter/material.dart';

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

  static const rCard = 18.0;
  static const rField = 14.0;
  static const rChip = 12.0;

  static TextStyle t(double size, {FontWeight w = FontWeight.w500, Color c = ink, double? h}) =>
      TextStyle(fontSize: size, fontWeight: w, color: c, height: h);

  static TextStyle get h1 => t(22, w: FontWeight.w700);
  static TextStyle get h2 => t(17, w: FontWeight.w700);
  static TextStyle get body => t(14, c: muted, h: 1.35);
  static TextStyle get small => t(12, c: mutedSoft);
}

/// White card with the prototype's 1 px green-grey border and soft shadow.
class MhnCard extends StatelessWidget {
  const MhnCard({super.key, required this.child, this.padding = const EdgeInsets.all(16), this.color = Mhn.white, this.borderColor = Mhn.line, this.radius = Mhn.rCard});
  final Widget child;
  final EdgeInsetsGeometry padding;
  final Color color;
  final Color borderColor;
  final double radius;

  @override
  Widget build(BuildContext context) => Container(
        padding: padding,
        decoration: BoxDecoration(
          color: color,
          borderRadius: BorderRadius.circular(radius),
          border: Border.all(color: borderColor),
          boxShadow: const [BoxShadow(color: Mhn.shadow, blurRadius: 18, offset: Offset(0, 6))],
        ),
        child: child,
      );
}

/// Filled green button (primary) or white outlined button (secondary); full width by default.
class MhnButton extends StatelessWidget {
  const MhnButton({super.key, required this.label, required this.onPressed, this.secondary = false, this.lime = false, this.busy = false, this.icon});
  final String label;
  final VoidCallback? onPressed;
  final bool secondary;
  final bool lime;
  final bool busy;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    final bg = secondary ? Mhn.white : (lime ? Mhn.lime : Mhn.green);
    final fg = secondary ? Mhn.green : (lime ? Mhn.green : Mhn.white);
    return SizedBox(
      width: double.infinity,
      height: 52,
      child: Material(
        color: bg,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16), side: secondary ? const BorderSide(color: Mhn.green, width: 1.2) : BorderSide.none),
        child: InkWell(
          borderRadius: BorderRadius.circular(16),
          onTap: busy ? null : onPressed,
          child: Center(
            child: busy
                ? Row(mainAxisSize: MainAxisSize.min, children: [
                    SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2.4, color: fg)),
                    const SizedBox(width: 10),
                    Flexible(child: Text(label, maxLines: 1, overflow: TextOverflow.ellipsis, style: Mhn.t(15, w: FontWeight.w700, c: fg))),
                  ])
                : Row(mainAxisSize: MainAxisSize.min, children: [
                    if (icon != null) ...[Icon(icon, size: 18, color: fg), const SizedBox(width: 8)],
                    Flexible(child: Text(label, maxLines: 1, overflow: TextOverflow.ellipsis, style: Mhn.t(15, w: FontWeight.w700, c: fg))),
                  ]),
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
  const MhnTopBar(this.title, {super.key});
  final String title;

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
            Expanded(child: Text(title, maxLines: 1, overflow: TextOverflow.ellipsis, style: Mhn.t(18, w: FontWeight.w700))),
          ]),
        ),
      );
}

/// Page scaffold for pushed screens.
class MhnPage extends StatelessWidget {
  const MhnPage({super.key, required this.title, required this.child, this.bottom});
  final String title;
  final Widget child;
  final Widget? bottom;

  @override
  Widget build(BuildContext context) => Scaffold(
        backgroundColor: Mhn.page,
        appBar: MhnTopBar(title),
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
      TextField(
        controller: controller,
        keyboardType: keyboardType,
        onChanged: onChanged,
        maxLines: maxLines,
        readOnly: readOnly,
        style: Mhn.t(15, w: FontWeight.w600),
        decoration: InputDecoration(
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
