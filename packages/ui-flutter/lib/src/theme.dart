// 04-UI-UX §8 "Theme" / "Fonts": ThemeData from tokens.g.dart (same tokens.json as @lims/ui), Material 3 [CONV].
import 'package:flutter/material.dart';

import 'tokens.g.dart';

/// Tone colours (04 §1.2), keyed by the same tone names as the web kit.
typedef LimsToneColors = ({Color fg, Color bg, Color border});

const limsTones = <String, LimsToneColors>{
  'neutral': (fg: LimsTokens.colorToneNeutralFg, bg: LimsTokens.colorToneNeutralBg, border: LimsTokens.colorToneNeutralBorder),
  'info': (fg: LimsTokens.colorToneInfoFg, bg: LimsTokens.colorToneInfoBg, border: LimsTokens.colorToneInfoBorder),
  'success': (fg: LimsTokens.colorToneSuccessFg, bg: LimsTokens.colorToneSuccessBg, border: LimsTokens.colorToneSuccessBorder),
  'warning': (fg: LimsTokens.colorToneWarningFg, bg: LimsTokens.colorToneWarningBg, border: LimsTokens.colorToneWarningBorder),
  'danger': (fg: LimsTokens.colorToneDangerFg, bg: LimsTokens.colorToneDangerBg, border: LimsTokens.colorToneDangerBorder),
  'critical': (fg: LimsTokens.colorToneCriticalFg, bg: LimsTokens.colorToneCriticalBg, border: LimsTokens.colorToneCriticalBorder),
};

LimsToneColors limsTone(String tone) => limsTones[tone] ?? limsTones['neutral']!;

abstract final class LimsTheme {
  /// LD-140 (10-DESIGN-SYSTEM s5): Plus Jakarta Sans first, Devanagari fallback. Fonts are bundled package assets
  /// (no runtime download, 04 §11). Inside this package they resolve as '<family>'; from an app they resolve as
  /// 'packages/lims_ui/<family>', hence both spellings in the fallback list [CONV]. Noto Sans stays as last Latin fallback.
  static const fontFamily = 'Plus Jakarta Sans';
  static const fontFamilyFallback = [
    'Noto Sans Devanagari',
    'packages/lims_ui/Plus Jakarta Sans',
    'packages/lims_ui/Noto Sans Devanagari',
    'Noto Sans',
    'packages/lims_ui/Noto Sans',
  ];

  /// 10-DESIGN-SYSTEM s5: pill buttons, >= 44 targets (Flutter token 48).
  static const _buttonShape = WidgetStatePropertyAll<OutlinedBorder>(StadiumBorder());
  static const _buttonMin = WidgetStatePropertyAll(Size(LimsTokens.touchTargetFlutter, LimsTokens.touchTargetFlutter));
  static const monoFamily = 'packages/lims_ui/Noto Sans Mono';

  static ThemeData light({Color? accent}) {
    final primary = accent ?? LimsTokens.colorAccentDefault;
    final scheme = ColorScheme.fromSeed(seedColor: primary).copyWith(
      primary: primary,
      onPrimary: LimsTokens.colorAccentFg,
      error: LimsTokens.colorToneDangerFg,
      onError: LimsTokens.colorNeutral0,
      surface: LimsTokens.colorNeutral0,
      onSurface: LimsTokens.colorNeutral900,
      outline: LimsTokens.colorNeutral300,
    );
    return ThemeData(
      useMaterial3: true,
      brightness: Brightness.light,
      colorScheme: scheme,
      fontFamily: fontFamily,
      fontFamilyFallback: fontFamilyFallback,
      materialTapTargetSize: MaterialTapTargetSize.padded, // 48 dp (04 §8 Accessibility)
      visualDensity: VisualDensity.standard,
      scaffoldBackgroundColor: LimsTokens.colorNeutral50, // LD-140: page #F3F7F4
      // LD-140: white cards, radius.lg (16), flat on the page colour.
      cardTheme: const CardThemeData(
        color: LimsTokens.colorNeutral0,
        surfaceTintColor: LimsTokens.colorNeutral0,
        elevation: 0,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.all(Radius.circular(LimsTokens.radiusLg))),
      ),
      filledButtonTheme: const FilledButtonThemeData(style: ButtonStyle(shape: _buttonShape, minimumSize: _buttonMin)),
      outlinedButtonTheme: const OutlinedButtonThemeData(style: ButtonStyle(shape: _buttonShape, minimumSize: _buttonMin)),
      textButtonTheme: const TextButtonThemeData(style: ButtonStyle(shape: _buttonShape, minimumSize: _buttonMin)),
    );
  }
}
