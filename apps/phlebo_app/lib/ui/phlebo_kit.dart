// Phlebotomist UI kit: small presentational widgets shared by every screen. Token-only (13-M-SERIES s6.3), no state of
// their own beyond what is drawn, no data access. The board (M5) and the MyHealthNow wireframe pack are the references.
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:lims_ui/lims_ui.dart';

import 'phlebo_theme.dart';

const double _segment = LimsTokens.space1 + LimsTokens.space0x5;
const double _ringSize = LimsTokens.space16 + LimsTokens.space1;

/// "SK" from "Sunita Khadka": at most two initials, never the whole name.
String initialsOf(String name) {
  final parts = name.trim().split(RegExp(r'\s+')).where((p) => p.isNotEmpty).toList();
  if (parts.isEmpty) return '?';
  return parts.take(2).map((p) => p.substring(0, 1).toUpperCase()).join();
}

/// Round avatar with initials (board `.avatar`).
class PhleboAvatar extends StatelessWidget {
  const PhleboAvatar({super.key, required this.name, this.size = LimsTokens.space12, this.onDark = false});

  final String name;
  final double size;
  final bool onDark;

  @override
  Widget build(BuildContext context) => Semantics(
        excludeSemantics: true,
        child: Container(
          width: size,
          height: size,
          alignment: Alignment.center,
          decoration: BoxDecoration(shape: BoxShape.circle, color: onDark ? LimsTokens.colorAccentFg.withValues(alpha: 0.18) : LimsTokens.colorAccentSubtle),
          child: Text(
            initialsOf(name),
            style: Theme.of(context).textTheme.titleMedium?.copyWith(color: onDark ? LimsTokens.colorAccentFg : LimsTokens.colorAccentDefault, fontWeight: FontWeight.w700),
          ),
        ),
      );
}

/// Section heading with an optional trailing count or link ("Up next   3").
class PhleboSectionTitle extends StatelessWidget {
  const PhleboSectionTitle(this.title, {super.key, this.trailing});

  final String title;
  final String? trailing;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return Padding(
      padding: const EdgeInsets.fromLTRB(LimsTokens.space1, LimsTokens.space2, LimsTokens.space1, LimsTokens.space1),
      child: Row(crossAxisAlignment: CrossAxisAlignment.baseline, textBaseline: TextBaseline.alphabetic, children: [
        Expanded(child: Semantics(header: true, child: Text(title, style: t.titleSmall?.copyWith(fontWeight: FontWeight.w700)))),
        if (trailing != null) Text(trailing!, style: t.labelMedium?.copyWith(color: LimsTokens.colorNeutral600)),
      ]),
    );
  }
}

/// Tone panel: icon, bold title, text and an optional action (board "Fasting sample" strip, PDF "A urine sample is still needed").
class PhleboNotice extends StatelessWidget {
  const PhleboNotice({super.key, required this.tone, required this.text, this.title, this.icon, this.action, this.actionLabel});

  final String tone;
  final String text;
  final String? title;
  final IconData? icon;
  final VoidCallback? action;
  final String? actionLabel;

  static IconData _iconFor(String tone) => switch (tone) {
        'success' => Icons.check_circle_outline,
        'warning' => Icons.warning_amber_rounded,
        'danger' || 'critical' => Icons.error_outline,
        'info' => Icons.info_outline,
        _ => Icons.info_outline,
      };

  @override
  Widget build(BuildContext context) {
    final c = limsTone(tone);
    final t = Theme.of(context).textTheme;
    return Semantics(
      container: true,
      liveRegion: tone == 'danger' || tone == 'critical',
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.all(LimsTokens.space4),
        decoration: BoxDecoration(color: c.bg, borderRadius: const BorderRadius.all(Radius.circular(LimsTokens.radiusLg))),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Icon(icon ?? _iconFor(tone), color: c.fg),
          const SizedBox(width: LimsTokens.space3),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              if (title != null) Text(title!, style: t.titleSmall?.copyWith(color: c.fg, fontWeight: FontWeight.w700)),
              Text(text, style: t.bodyMedium?.copyWith(color: LimsTokens.colorNeutral900)),
              if (action != null && actionLabel != null)
                TextButton(onPressed: action, style: TextButton.styleFrom(foregroundColor: c.fg, padding: EdgeInsets.zero, alignment: Alignment.centerLeft), child: Text(actionLabel!)),
            ]),
          ),
        ]),
      ),
    );
  }
}

/// Tappable card row: leading, two text lines, trailing, chevron. At least 48 dp high (touch.target.flutter).
class PhleboRow extends StatelessWidget {
  const PhleboRow({super.key, required this.title, this.subtitle, this.leading, this.trailing, this.onTap, this.chevron = true, this.titleColor, this.semanticLabel});

  final String title;
  final String? subtitle;
  final Widget? leading;
  final Widget? trailing;
  final VoidCallback? onTap;
  final bool chevron;
  final Color? titleColor;
  final String? semanticLabel;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final row = ConstrainedBox(
      constraints: const BoxConstraints(minHeight: LimsTokens.touchTargetFlutter),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: LimsTokens.space4, vertical: LimsTokens.space3),
        child: Row(children: [
          if (leading != null) ...[leading!, const SizedBox(width: LimsTokens.space3)],
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(title, style: t.titleSmall?.copyWith(fontWeight: FontWeight.w600, color: titleColor)),
              if (subtitle != null) Text(subtitle!, style: t.bodySmall?.copyWith(color: LimsTokens.colorNeutral600)),
            ]),
          ),
          if (trailing != null) ...[const SizedBox(width: LimsTokens.space2), trailing!],
          if (onTap != null && chevron) const Icon(Icons.chevron_right, color: LimsTokens.colorNeutral600),
        ]),
      ),
    );
    if (onTap == null) return row;
    return Semantics(button: true, label: semanticLabel, child: InkWell(onTap: onTap, child: row));
  }
}

/// White card that holds [PhleboRow]s with hairlines between (board "Up next" list, profile list).
class PhleboListCard extends StatelessWidget {
  const PhleboListCard({super.key, required this.children});

  final List<Widget> children;

  @override
  Widget build(BuildContext context) => Card(
        clipBehavior: Clip.antiAlias,
        margin: EdgeInsets.zero,
        child: Column(children: [
          for (var i = 0; i < children.length; i++) ...[
            if (i > 0) const Divider(),
            children[i],
          ],
        ]),
      );
}

/// Round tinted icon tile used as the leading element of settings and support rows.
class PhleboIconTile extends StatelessWidget {
  const PhleboIconTile(this.icon, {super.key, this.tone = 'neutral'});

  final IconData icon;
  final String tone;

  @override
  Widget build(BuildContext context) {
    final c = tone == 'neutral' ? (fg: LimsTokens.colorAccentDefault, bg: LimsTokens.colorAccentSubtle, border: LimsTokens.colorAccentSubtle) : limsTone(tone);
    return Container(
      width: LimsTokens.space10,
      height: LimsTokens.space10,
      decoration: BoxDecoration(color: c.bg, borderRadius: const BorderRadius.all(Radius.circular(LimsTokens.radiusMd))),
      child: Icon(icon, color: c.fg),
    );
  }
}

/// Value over label (history totals, profile stats).
class PhleboStat extends StatelessWidget {
  const PhleboStat({super.key, required this.value, required this.label, this.tone});

  final String value;
  final String label;
  final String? tone;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return Semantics(
      label: '$label $value',
      excludeSemantics: true,
      child: Card(
        margin: EdgeInsets.zero,
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: LimsTokens.space4, horizontal: LimsTokens.space2),
          child: Column(children: [
            Text(value, style: t.headlineSmall?.copyWith(fontWeight: FontWeight.w700, color: tone == null ? LimsTokens.colorNeutral900 : limsTone(tone!).fg)),
            Text(label, style: t.labelMedium?.copyWith(color: LimsTokens.colorNeutral600), textAlign: TextAlign.center),
          ]),
        ),
      ),
    );
  }
}

/// Gradient summary card (board hero). Children are drawn in white / accent.subtle on the gradient.
class PhleboHero extends StatelessWidget {
  const PhleboHero({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) => Container(
        width: double.infinity,
        padding: const EdgeInsets.all(LimsTokens.space5),
        decoration: BoxDecoration(gradient: PhleboGradients.hero, borderRadius: const BorderRadius.all(Radius.circular(LimsTokens.radiusXl))),
        child: DefaultTextStyle.merge(style: const TextStyle(color: LimsTokens.colorAccentFg), child: child),
      );
}

/// Day progress ring: [done] of [total], label in the middle.
class PhleboProgressRing extends StatelessWidget {
  const PhleboProgressRing({super.key, required this.done, required this.total, this.label});

  final int done;
  final int total;
  final String? label;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final frac = total == 0 ? 0.0 : (done / total).clamp(0.0, 1.0);
    return Semantics(
      label: '$done of $total done',
      excludeSemantics: true,
      child: SizedBox.square(
        dimension: _ringSize,
        child: CustomPaint(
          painter: _RingPainter(frac),
          child: Center(child: Text(label ?? '${(frac * 100).round()}%', style: t.titleMedium?.copyWith(color: LimsTokens.colorAccentFg, fontWeight: FontWeight.w700))),
        ),
      ),
    );
  }
}

class _RingPainter extends CustomPainter {
  _RingPainter(this.frac);

  final double frac;

  @override
  void paint(Canvas canvas, Size size) {
    final stroke = LimsTokens.space2;
    final rect = (Offset.zero & size).deflate(stroke / 2);
    final track = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = stroke
      ..color = LimsTokens.colorAccentFg.withValues(alpha: 0.22);
    canvas.drawArc(rect, 0, math.pi * 2, false, track);
    if (frac <= 0) return;
    final bar = Paint()
      ..style = PaintingStyle.stroke
      ..strokeCap = StrokeCap.round
      ..strokeWidth = stroke
      ..color = LimsTokens.colorAccentHighlight;
    canvas.drawArc(rect, -math.pi / 2, math.pi * 2 * frac, false, bar);
  }

  @override
  bool shouldRepaint(_RingPainter old) => old.frac != frac;
}

enum PhleboSegment { done, missed, current, todo }

/// One thin segment per stop (board `segs`): done lime, missed danger tint, current white, todo faint.
class PhleboSegmentBar extends StatelessWidget {
  const PhleboSegmentBar({super.key, required this.segments});

  final List<PhleboSegment> segments;

  Color _color(PhleboSegment s) => switch (s) {
        PhleboSegment.done => LimsTokens.colorAccentHighlight,
        PhleboSegment.missed => LimsTokens.colorToneDangerBorder,
        PhleboSegment.current => LimsTokens.colorAccentFg,
        PhleboSegment.todo => LimsTokens.colorAccentFg.withValues(alpha: 0.25),
      };

  @override
  Widget build(BuildContext context) => ExcludeSemantics(
        child: Row(children: [
          for (var i = 0; i < segments.length; i++) ...[
            if (i > 0) const SizedBox(width: LimsTokens.space1),
            Expanded(child: Container(height: _segment, decoration: BoxDecoration(color: _color(segments[i]), borderRadius: const BorderRadius.all(Radius.circular(LimsTokens.radiusSm))))),
          ],
        ]),
      );
}

/// Tube cap kind. The design tokens carry no tube-cap colours (token gap, recorded in the CR note), so the chip uses the
/// nearest tone and ALWAYS prints the container name: colour is never the only cue.
String tubeToneFor(String text) {
  final s = text.toLowerCase();
  if (s.contains('edta') || s.contains('purple') || s.contains('lavender')) return 'info';
  if (s.contains('plain') || s.contains('red') || s.contains('serum')) return 'danger';
  if (s.contains('sst') || s.contains('gel') || s.contains('gold') || s.contains('urine') || s.contains('yellow')) return 'warning';
  return 'neutral';
}

class PhleboTubeChip extends StatelessWidget {
  const PhleboTubeChip({super.key, required this.label, this.tone, this.done = false});

  final String label;
  final String? tone;
  final bool done;

  @override
  Widget build(BuildContext context) {
    final c = limsTone(tone ?? tubeToneFor(label));
    final t = Theme.of(context).textTheme;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: LimsTokens.space3, vertical: LimsTokens.space1),
      decoration: BoxDecoration(color: c.bg, borderRadius: const BorderRadius.all(Radius.circular(LimsTokens.radiusFull)), border: Border.all(color: c.border)),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        Icon(done ? Icons.check_circle : Icons.science_outlined, size: LimsTokens.fontSizeMdSize, color: c.fg),
        const SizedBox(width: LimsTokens.space1),
        Flexible(child: Text(label, style: t.labelMedium?.copyWith(color: c.fg, fontWeight: FontWeight.w600), overflow: TextOverflow.ellipsis)),
      ]),
    );
  }
}

/// Connection pill for the header: green dot when online, "Offline" with the waiting count otherwise. Opens the outbox.
class PhleboNetChip extends StatelessWidget {
  const PhleboNetChip({super.key, required this.offline, this.waiting = 0, this.onTap});

  final bool offline;
  final int waiting;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final label = offline ? (waiting > 0 ? 'Offline · $waiting waiting' : 'Offline') : (waiting > 0 ? 'Online · $waiting waiting' : 'Online');
    return Semantics(
      button: onTap != null,
      label: label,
      excludeSemantics: true,
      child: InkWell(
        onTap: onTap,
        borderRadius: const BorderRadius.all(Radius.circular(LimsTokens.radiusFull)),
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: LimsTokens.touchTargetFlutter),
          child: Center(
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: LimsTokens.space3, vertical: LimsTokens.space1),
              decoration: BoxDecoration(
                color: offline ? LimsTokens.colorToneWarningBg : LimsTokens.colorAccentFg.withValues(alpha: 0.16),
                borderRadius: const BorderRadius.all(Radius.circular(LimsTokens.radiusFull)),
              ),
              child: Row(mainAxisSize: MainAxisSize.min, children: [
                if (offline)
                  const Icon(Icons.cloud_off, size: LimsTokens.fontSizeBaseSize, color: LimsTokens.colorToneWarningFg)
                else
                  const Icon(Icons.circle, size: LimsTokens.space2, color: LimsTokens.colorAccentHighlight),
                const SizedBox(width: LimsTokens.space1),
                Text(label, style: t.labelMedium?.copyWith(color: offline ? LimsTokens.colorToneWarningFg : LimsTokens.colorAccentFg, fontWeight: FontWeight.w600)),
              ]),
            ),
          ),
        ),
      ),
    );
  }
}

/// Brand mark from the app's own assets (copied from the M-series logos folder).
class PhleboBrandMark extends StatelessWidget {
  const PhleboBrandMark({super.key, this.landscape = false, this.height = LimsTokens.space10});

  final bool landscape;
  final double height;

  @override
  Widget build(BuildContext context) => Image.asset(
        landscape ? 'assets/brand/ml-logo-landscape-white.png' : 'assets/brand/ml-logo-white.png',
        height: height,
        fit: BoxFit.contain,
        excludeFromSemantics: true,
        errorBuilder: (_, __, ___) => SizedBox(height: height),
      );
}

/// Pins the primary actions to the bottom of a screen on a white bar (board footer / wireframe "View booking" bar).
class PhleboActionBar extends StatelessWidget {
  const PhleboActionBar({super.key, required this.children});

  final List<Widget> children;

  @override
  Widget build(BuildContext context) => Material(
        color: LimsTokens.colorNeutral0,
        child: SafeArea(
          top: false,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(LimsTokens.space4, LimsTokens.space3, LimsTokens.space4, LimsTokens.space3),
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              for (var i = 0; i < children.length; i++) ...[
                if (i > 0) const SizedBox(height: LimsTokens.space2),
                SizedBox(width: double.infinity, child: children[i]),
              ],
            ]),
          ),
        ),
      );
}

/// Floating tab bar of the shell (wireframe pack: rounded bar floating over the page, lime pill under the active tab).
class PhleboFloatingNav extends StatelessWidget {
  const PhleboFloatingNav({super.key, required this.items, required this.index, required this.onTap});

  final List<LimsNavItem> items;
  final int index;
  final ValueChanged<int> onTap;

  @override
  Widget build(BuildContext context) => SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(LimsTokens.space4, LimsTokens.space1, LimsTokens.space4, LimsTokens.space3),
          child: DecoratedBox(
            decoration: BoxDecoration(
              borderRadius: const BorderRadius.all(Radius.circular(LimsTokens.radiusXl)),
              boxShadow: [BoxShadow(color: LimsTokens.colorAccentDefault.withValues(alpha: 0.18), blurRadius: LimsTokens.space6, offset: const Offset(0, LimsTokens.space1))],
            ),
            child: ClipRRect(
              borderRadius: const BorderRadius.all(Radius.circular(LimsTokens.radiusXl)),
              child: LimsBottomNav(items: items, index: index, onTap: onTap),
            ),
          ),
        ),
      );
}

/// Standard modal sheet (rounded top, drag handle from the theme). Returns what the sheet pops.
Future<T?> showPhleboSheet<T>(BuildContext context, {required WidgetBuilder builder}) => showModalBottomSheet<T>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (c) => Padding(
        padding: EdgeInsets.fromLTRB(LimsTokens.space4, 0, LimsTokens.space4, LimsTokens.space4 + MediaQuery.viewInsetsOf(c).bottom),
        child: SingleChildScrollView(child: builder(c)),
      ),
    );

/// Pushes a screen on the nearest navigator (sub-screens of the shell: they have no deep link, so no go_router path).
Future<T?> pushScreen<T>(BuildContext context, WidgetBuilder builder) => Navigator.of(context).push<T>(MaterialPageRoute<T>(builder: builder));

/// Eyebrow label above a value ("NEXT STOP · 9:20 AM"). Small caps feel without a literal size.
class PhleboEyebrow extends StatelessWidget {
  const PhleboEyebrow(this.text, {super.key, this.color});

  final String text;
  final Color? color;

  @override
  Widget build(BuildContext context) => Text(
        text.toUpperCase(),
        style: Theme.of(context).textTheme.labelSmall?.copyWith(color: color ?? LimsTokens.colorAccentDefault, fontWeight: FontWeight.w700, letterSpacing: 0.6),
      );
}

/// Big round icon on a tone tint (wireframe S32 "Collection completed" / S32a "partly completed", device notices).
class PhleboStatusDisc extends StatelessWidget {
  const PhleboStatusDisc({super.key, required this.icon, required this.tone});

  final IconData icon;
  final String tone;

  @override
  Widget build(BuildContext context) {
    final c = limsTone(tone);
    return Container(
      padding: const EdgeInsets.all(LimsTokens.space5),
      decoration: BoxDecoration(color: c.bg, shape: BoxShape.circle),
      child: Icon(icon, size: LimsTokens.space10, color: c.fg),
    );
  }
}
