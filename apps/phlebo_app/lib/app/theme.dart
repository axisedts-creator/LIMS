// PHLEBO-UI-FULL-1: the phlebotomist look (forest header with rounded bottom, lime pill primary button, teal hero card,
// floating tab bar) and the few shared pieces the screens use. Colours, radii and sizes come from lims_ui tokens only.
import 'dart:math';

import 'package:flutter/material.dart';
import 'package:lims_ui/lims_ui.dart';

const _logoWide = 'assets/brand/ml-logo-landscape-white.png';
const _logoMark = 'assets/brand/ml-logo-white.png';

ThemeData phleboTheme() {
  final base = LimsTheme.light();
  final text = base.textTheme;
  return base.copyWith(
    textTheme: text.copyWith(
      headlineSmall: text.headlineSmall?.copyWith(fontWeight: FontWeight.w700),
      titleLarge: text.titleLarge?.copyWith(fontWeight: FontWeight.w700),
      titleMedium: text.titleMedium?.copyWith(fontWeight: FontWeight.w600),
    ),
    appBarTheme: AppBarTheme(
      backgroundColor: LimsTokens.colorAccentDefault,
      foregroundColor: LimsTokens.colorAccentFg,
      surfaceTintColor: LimsTokens.colorAccentDefault,
      centerTitle: false,
      titleTextStyle: base.textTheme.titleMedium?.copyWith(color: LimsTokens.colorAccentFg, fontWeight: FontWeight.w600),
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(bottom: Radius.circular(LimsTokens.radiusXl))),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: base.filledButtonTheme.style?.copyWith(
        backgroundColor: WidgetStateProperty.resolveWith(
            (s) => s.contains(WidgetState.disabled) ? LimsTokens.colorNeutral100 : LimsTokens.colorAccentHighlight),
        // Dark text on lime (white on lime fails contrast).
        foregroundColor: WidgetStateProperty.resolveWith(
            (s) => s.contains(WidgetState.disabled) ? LimsTokens.colorNeutral500 : LimsTokens.colorNeutral900),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: base.outlinedButtonTheme.style?.copyWith(foregroundColor: const WidgetStatePropertyAll(LimsTokens.colorNeutral900)),
    ),
  );
}

/// Teal-to-green summary card; text inside is white.
class HeroCard extends StatelessWidget {
  const HeroCard({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) => Container(
        width: double.infinity,
        padding: const EdgeInsets.all(LimsTokens.space4),
        decoration: const BoxDecoration(
          borderRadius: BorderRadius.all(Radius.circular(LimsTokens.radiusXl)),
          gradient: LinearGradient(
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
            colors: [LimsTokens.colorAccentHover, LimsTokens.colorAccentDefault, LimsTokens.colorToneSuccessFg],
          ),
        ),
        child: DefaultTextStyle.merge(
          style: const TextStyle(color: LimsTokens.colorAccentFg),
          child: IconTheme.merge(data: const IconThemeData(color: LimsTokens.colorAccentFg), child: child),
        ),
      );
}

/// Full-screen brand gradient (splash, sign-in, lock).
class BrandBackground extends StatelessWidget {
  const BrandBackground({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) => DecoratedBox(
        decoration: const BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.topCenter,
            end: Alignment.bottomCenter,
            stops: [0, 0.45, 1],
            colors: [LimsTokens.colorAccentHover, LimsTokens.colorAccentDefault, LimsTokens.colorAccentBrand],
          ),
        ),
        child: DefaultTextStyle.merge(style: const TextStyle(color: LimsTokens.colorAccentFg), child: child),
      );
}

class BrandMark extends StatelessWidget {
  const BrandMark({super.key, this.wide = true});

  final bool wide;

  @override
  Widget build(BuildContext context) => Image.asset(
        wide ? _logoWide : _logoMark,
        height: wide ? LimsTokens.space10 : LimsTokens.space16,
        semanticLabel: 'Lab logo',
        errorBuilder: (_, __, ___) => const SizedBox(height: LimsTokens.space16),
      );
}

/// Ring with the percentage in the middle (hero card).
class ProgressRing extends StatelessWidget {
  const ProgressRing({super.key, required this.done, required this.total});

  final int done, total;

  @override
  Widget build(BuildContext context) {
    final v = total == 0 ? 0.0 : done / total;
    final percent = '${(v * 100).round()}%';
    return Semantics(
      label: '$percent done',
      excludeSemantics: true,
      child: SizedBox.square(
        dimension: LimsTokens.space16,
        child: Stack(alignment: Alignment.center, fit: StackFit.expand, children: [
          CircularProgressIndicator(
            value: v,
            strokeWidth: LimsTokens.space2,
            color: LimsTokens.colorAccentHighlight,
            backgroundColor: LimsTokens.colorNeutral500,
          ),
          Center(child: FittedBox(child: Padding(padding: const EdgeInsets.all(LimsTokens.space3), child: Text(percent)))),
        ]),
      ),
    );
  }
}

String initialsOf(String name) {
  final parts = name.trim().split(RegExp(r'\s+')).where((p) => p.isNotEmpty).toList();
  if (parts.isEmpty) return '?';
  final first = parts.first.characters.first;
  return (parts.length == 1 ? first : '$first${parts.last.characters.first}').toUpperCase();
}

class PersonAvatar extends StatelessWidget {
  const PersonAvatar({super.key, required this.name});

  final String name;

  @override
  Widget build(BuildContext context) => ExcludeSemantics(
        child: CircleAvatar(
          radius: LimsTokens.space6,
          backgroundColor: LimsTokens.colorAccentSubtle,
          foregroundColor: LimsTokens.colorAccentDefault,
          child: Text(initialsOf(name), textScaler: TextScaler.noScaling),
        ),
      );
}

class Pill extends StatelessWidget {
  const Pill(this.label, {super.key, this.tone = 'neutral'});

  final String label, tone;

  @override
  Widget build(BuildContext context) => LimsStatusChip(kind: 'generic', status: label, tone: tone, label: label);
}

class SectionHeader extends StatelessWidget {
  const SectionHeader(this.title, {super.key, this.trailing});

  final String title;
  final String? trailing;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.fromLTRB(LimsTokens.space1, LimsTokens.space4, LimsTokens.space1, LimsTokens.space2),
        child: Row(children: [
          Expanded(child: Semantics(header: true, child: Text(title, style: Theme.of(context).textTheme.titleSmall))),
          if (trailing != null) Text(trailing!, style: Theme.of(context).textTheme.bodySmall),
        ]),
      );
}

/// Icon in a soft square, title, one line of help, chevron.
class MenuRow extends StatelessWidget {
  const MenuRow({super.key, required this.icon, required this.title, required this.subtitle, required this.onTap});

  final IconData icon;
  final String title, subtitle;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => LimsListTile(
        leading: IconBadge(icon: icon),
        title: title,
        subtitle: subtitle,
        trailing: const Icon(Icons.chevron_right),
        onTap: onTap,
      );
}

class IconBadge extends StatelessWidget {
  const IconBadge({super.key, required this.icon, this.tone});

  final IconData icon;
  final String? tone;

  @override
  Widget build(BuildContext context) {
    final c = tone == null ? null : limsTone(tone!);
    return CircleAvatar(
      radius: LimsTokens.space5,
      backgroundColor: c?.bg ?? LimsTokens.colorAccentSubtle,
      foregroundColor: c?.fg ?? LimsTokens.colorAccentDefault,
      child: Icon(icon),
    );
  }
}

/// Rounded tone box with a title, text and an optional action.
class NoticeCard extends StatelessWidget {
  const NoticeCard({super.key, required this.tone, required this.text, this.title, this.icon, this.action});

  final String tone, text;
  final String? title;
  final IconData? icon;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    final c = limsTone(tone);
    final t = Theme.of(context).textTheme;
    return Semantics(
      container: true,
      liveRegion: true,
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.all(LimsTokens.space4),
        decoration: BoxDecoration(color: c.bg, borderRadius: const BorderRadius.all(Radius.circular(LimsTokens.radiusLg))),
        child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Icon(icon ?? (tone == 'warning' || tone == 'danger' ? Icons.warning_amber_outlined : Icons.info_outline), color: c.fg),
          const SizedBox(width: LimsTokens.space3),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              if (title != null) Text(title!, style: t.titleSmall?.copyWith(color: c.fg)),
              Text(text, style: t.bodyMedium),
              if (action != null) ...[const SizedBox(height: LimsTokens.space2), action!],
            ]),
          ),
        ]),
      ),
    );
  }
}

/// A centred icon, title and explanation with at most one button at the bottom (device states, not-available pages).
class StatePage extends StatelessWidget {
  const StatePage({super.key, required this.icon, required this.title, required this.message, this.tone = 'neutral', this.children = const []});

  final IconData icon;
  final String title, message, tone;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final c = limsTone(tone);
    return Center(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(LimsTokens.space6),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          CircleAvatar(radius: LimsTokens.space8, backgroundColor: c.bg, foregroundColor: c.fg, child: Icon(icon, size: LimsTokens.space8)),
          const SizedBox(height: LimsTokens.space4),
          Text(title, style: t.titleLarge, textAlign: TextAlign.center),
          const SizedBox(height: LimsTokens.space2),
          Text(message, style: t.bodyLarge, textAlign: TextAlign.center),
          for (final w in children) ...[const SizedBox(height: LimsTokens.space4), w],
        ]),
      ),
    );
  }
}

/// A feature drawn in the design that the system cannot provide yet (see .orchestra/cr/PHLEBO-UI-FULL-1.md).
/// Nothing is faked: no sample data is ever shown as real.
class NotAvailable extends StatelessWidget {
  const NotAvailable({super.key, required this.what, required this.instead, this.icon = Icons.hourglass_empty});

  final String what, instead;
  final IconData icon;

  @override
  Widget build(BuildContext context) => StatePage(icon: icon, title: 'Not available yet', message: '$what $instead');
}

/// Buttons pinned to the bottom of a screen.
class BottomActions extends StatelessWidget {
  const BottomActions({super.key, required this.children});

  final List<Widget> children;

  @override
  Widget build(BuildContext context) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(LimsTokens.space4, LimsTokens.space2, LimsTokens.space4, LimsTokens.space3),
          // Large text can make the buttons taller than the screen: they then scroll instead of overflowing.
          child: ConstrainedBox(
            constraints: BoxConstraints(maxHeight: MediaQuery.sizeOf(context).height * 0.45),
            child: SingleChildScrollView(
              child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                for (var i = 0; i < children.length; i++) ...[if (i > 0) const SizedBox(height: LimsTokens.space2), children[i]],
              ]),
            ),
          ),
        ),
      );
}

const _visitSteps = ['Arrive', 'Identity', 'Consent', 'Collect', 'Payment', 'Finish'];

/// "Step n of 6" dots on the visit-flow screens (C02-C06).
class StepBar extends StatelessWidget {
  const StepBar(this.step, {super.key});

  /// 1-based.
  final int step;

  @override
  Widget build(BuildContext context) {
    final total = _visitSteps.length;
    final current = max(1, min(step, total));
    final label = 'Step $current of $total · ${_visitSteps[current - 1]}';
    return Semantics(
      label: label,
      excludeSemantics: true,
      child: Padding(
        padding: const EdgeInsets.only(bottom: LimsTokens.space3),
        child: Column(children: [
          Row(children: [
            for (var i = 1; i <= total; i++) ...[
              if (i > 1)
                Expanded(child: Divider(thickness: LimsTokens.space0x5, color: i <= current ? LimsTokens.colorAccentDefault : LimsTokens.colorNeutral200)),
              CircleAvatar(
                radius: LimsTokens.space3,
                backgroundColor: i < current
                    ? LimsTokens.colorAccentDefault
                    : (i == current ? LimsTokens.colorAccentHighlight : LimsTokens.colorNeutral0),
                foregroundColor: i < current ? LimsTokens.colorAccentFg : LimsTokens.colorNeutral900,
                child: i < current
                    ? const Icon(Icons.check, size: LimsTokens.space4)
                    : Text('$i', textScaler: TextScaler.noScaling, style: Theme.of(context).textTheme.labelSmall),
              ),
            ],
          ]),
          const SizedBox(height: LimsTokens.space1),
          Text(label, style: Theme.of(context).textTheme.bodySmall),
        ]),
      ),
    );
  }
}
